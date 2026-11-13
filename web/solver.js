/*
 * Ant Colony Optimization for 2D rectangle packing (multi-sheet, guillotine-free).
 *
 * Everything lives inside one factory function so the page can turn its source
 * into a Web Worker (ACOSolverModule.toString()) and Node can require() it for tests.
 *
 * Model
 *  - Boxes are grouped into "types" (same size + rotation rule). Ants choose which
 *    TYPE to place next, so identical boxes share what the colony learns.
 *  - Pheromone tau[prev][next]: how good it has been to place type `next` right after
 *    type `prev` on the same sheet. Row `nT` is the "sheet start" row.
 *  - Heuristic eta: (box area / largest box area) * (0.2 + 0.8 * snugness), where
 *    snugness = box area / area of the free rectangle it would land in. Big boxes
 *    first, and boxes that fill a hole well get a boost.
 *  - Decoder: MaxRects with Best-Short-Side-Fit, tries both orientations when allowed.
 *    Positions are continuous, so any unit and any decimal size works.
 *  - A sheet is closed when no remaining box fits; then a new sheet is opened.
 *  - Fitness (higher is better): Falkenauer's sum(fill_i^2 - scrapWeight * scrap_i) / N,
 *    plus a small bonus for a large offcut on the last sheet. scrap_i is the leftover on
 *    sheet i that is NOT part of its biggest empty rectangle, i.e. scattered pieces that
 *    are hard to reuse. Rewards fewer, fuller sheets with leftovers kept in one piece.
 *  - Guillotine mode (cutMode: 'guillotine'): free rects never overlap and every placement
 *    splits its free rect with straight edge-to-edge cuts, so the result can be cut on a
 *    guillotine or panel saw. Ants also choose each split's direction; a second pheromone
 *    (per box type and direction) learns which direction works. Sliding is skipped there.
 *  - Update: MAX-MIN Ant System. Evaporate everything, only the iteration best (or the
 *    global best every 5th iteration) deposits, and tau is clamped to [tauMin, tauMax].
 *    If nothing improves for a while, pheromone is reset to tauMax (restart).
 */
function ACOSolverModule() {
  const EPS = 1e-7;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- MaxRects sheet ----------
  function newSheet(W, H) {
    return { W, H, free: [{ x: 0, y: 0, w: W, h: H }], parts: [], cuts: [], lines: new Set(), vPos: [], hPos: [] };
  }

  // Best-Short-Side-Fit for a w x h rectangle. Ties: long side, then top-most, then left-most.
  function fitBSSF(sheet, w, h) {
    let best = null;
    for (let i = 0; i < sheet.free.length; i++) {
      const f = sheet.free[i];
      if (w > f.w + EPS || h > f.h + EPS) continue;
      const lw = f.w - w, lh = f.h - h;
      const s1 = Math.min(lw, lh), s2 = Math.max(lw, lh);
      if (
        !best ||
        s1 < best.s1 - EPS ||
        (Math.abs(s1 - best.s1) <= EPS &&
          (s2 < best.s2 - EPS ||
            (Math.abs(s2 - best.s2) <= EPS &&
              (f.y < best.y - EPS || (Math.abs(f.y - best.y) <= EPS && f.x < best.x - EPS)))))
      ) {
        best = { x: f.x, y: f.y, w, h, s1, s2, freeArea: f.w * f.h, fi: i };
      }
    }
    return best;
  }

  function placeRect(sheet, x, y, w, h) {
    const out = [];
    for (const f of sheet.free) {
      if (x >= f.x + f.w - EPS || x + w <= f.x + EPS || y >= f.y + f.h - EPS || y + h <= f.y + EPS) {
        out.push(f);
        continue;
      }
      if (x > f.x + EPS) out.push({ x: f.x, y: f.y, w: x - f.x, h: f.h });
      if (x + w < f.x + f.w - EPS) out.push({ x: x + w, y: f.y, w: f.x + f.w - (x + w), h: f.h });
      if (y > f.y + EPS) out.push({ x: f.x, y: f.y, w: f.w, h: y - f.y });
      if (y + h < f.y + f.h - EPS) out.push({ x: f.x, y: y + h, w: f.w, h: f.y + f.h - (y + h) });
    }
    // drop free rects contained in another one
    const keep = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (a.w <= EPS || a.h <= EPS) continue;
      let contained = false;
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const b = out[j];
        if (a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS) {
          // identical rects: keep the one with the lower index
          const same = Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS && Math.abs(a.w - b.w) <= EPS && Math.abs(a.h - b.h) <= EPS;
          if (!same || j < i) { contained = true; break; }
        }
      }
      if (!contained) keep.push(a);
    }
    sheet.free = keep;
  }

  // Cuts on the same straight line can be made in one pass (pieces are stacked or kept
  // aligned on the cutter), so layouts are judged by distinct cut lines.
  const lineKey = (vertical, pos) => Math.round(pos * 1e4) * 2 + (vertical ? 1 : 0); // numeric: fast Set lookups
  function addCut(sheet, c) {
    sheet.cuts.push(c);
    const vertical = c.x1 === c.x2, pos = vertical ? c.x1 : c.y1, key = lineKey(vertical, pos);
    if (!sheet.lines.has(key)) { sheet.lines.add(key); (vertical ? sheet.vPos : sheet.hPos).push(pos); }
  }

  /*
   * Fewest-cuts placement for guillotine mode. A box may sit anywhere in a free rect, not
   * just its top-left corner, so its edges can line up with cut lines already on the sheet.
   * Each needed cut is scored as new (a fresh line) or free (lands on an existing line).
   * Left/right cuts depend only on x and top/bottom only on y, so they're chosen separately.
   */
  function fitAligned(ctx, sheet, w, h) {
    const k = ctx.kerf, SW = ctx.sheetW, SH = ctx.sheetH;
    const axis = (lo, len, size, lines, edge, vertical) => {
      const hi = lo + len - size;
      const cand = [lo, hi];
      for (const L of lines) { cand.push(L + k / 2, L - size + k / 2); }
      let best = null;
      for (const x of cand) {
        if (x < lo - EPS || x > hi + EPS) continue;
        const xx = Math.min(hi, Math.max(lo, x));
        let fresh = 0, segs = 0;
        if (xx - lo > EPS) { segs++; const c = xx - k / 2; if (c > EPS && !sheet.lines.has(lineKey(vertical, c))) fresh++; }
        if (lo + len - (xx + size) > EPS) { const c = xx + size - k / 2; if (c < edge - EPS) { segs++; if (!sheet.lines.has(lineKey(vertical, c))) fresh++; } }
        const cost = fresh * 10 + segs + (xx - lo) / (len + 1) * 0.01; // prefer the near edge on ties
        if (!best || cost < best.cost - 1e-12) best = { x: xx, fresh, segs, cost };
      }
      return best;
    };
    let best = null;
    for (let i = 0; i < sheet.free.length; i++) {
      const f = sheet.free[i];
      if (w > f.w + EPS || h > f.h + EPS) continue;
      const ax = axis(f.x, f.w, w, sheet.vPos, SW, true), ay = axis(f.y, f.h, h, sheet.hPos, SH, false);
      const fresh = ax.fresh + ay.fresh, segs = ax.segs + ay.segs;
      const s1 = Math.min(f.w - w, f.h - h), s2 = Math.max(f.w - w, f.h - h);
      const key = [fresh, segs, s1, s2, ay.x, ax.x];
      if (!best || key.some((v, j) => v !== best.key[j]) && lexLess(key, best.key)) {
        best = { key, x: ax.x, y: ay.x, w, h, s1, s2, freeArea: f.w * f.h, fi: i, cutsAdded: fresh, segs };
      }
    }
    return best;
  }
  function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-9) return true; if (a[i] > b[i] + 1e-9) return false; }
    return false;
  }

  /*
   * Guillotine placement. Free rects never overlap. The box goes in free rect f (top-left
   * corner normally, anywhere when lining up with existing cuts), and the rest of f is split
   * by straight cuts: first across f, then across the band or column holding the box.
   * Every cut runs edge to edge through the piece it divides, so the whole sheet can be cut on a guillotine, panel saw or table saw.
   * Cuts are recorded in order; that order is a valid cutting sequence.
   */
  function placeGuillotine(ctx, sheet, p, rng) {
    const f = sheet.free[p.fi];
    sheet.free.splice(p.fi, 1);
    const { x, y, w, h } = p;
    const dl = x - f.x, dr = f.x + f.w - (x + w), dt = y - f.y, db = f.y + f.h - (y + h);
    // A: cut across the full width first (bands above/below), then split the box's row.
    // B: cut down the full height first (columns left/right), then split the box's column.
    const A = [{ x: f.x, y: f.y, w: f.w, h: dt }, { x: f.x, y: y + h, w: f.w, h: db }, { x: f.x, y, w: dl, h }, { x: x + w, y, w: dr, h }];
    const B = [{ x: f.x, y: f.y, w: dl, h: f.h }, { x: x + w, y: f.y, w: dr, h: f.h }, { x, y: f.y, w, h: dt }, { x, y: y + h, w, h: db }];
    const area = (r) => (r.w > EPS && r.h > EPS ? r.w * r.h : 0);
    const big = (L) => Math.max(...L.map(area));
    let horizFirst;
    switch (ctx.P.splitRule) {
      case 'shorter': horizFirst = dl + dr < dt + db; break;
      case 'longer': horizFirst = dl + dr >= dt + db; break;
      case 'maxarea': horizFirst = big(A) >= big(B); break;
      default: horizFirst = big(A) <= big(B); // 'minarea'
    }
    // ants choose the cut direction: the split rule's pick is favoured, pheromone learns per box type
    if (rng && ctx.splitTau) {
      // pheromone per (box type, direction): [cut-across-first, cut-down-first]
      const tH = ctx.splitTau[2 * p.t], tV = ctx.splitTau[2 * p.t + 1];
      const wH = tH * (horizFirst ? 1 : ctx.P.splitBias), wV = tV * (horizFirst ? ctx.P.splitBias : 1);
      horizFirst = rng() * (wH + wV) < wH;
    }
    if (p.splitLog) p.splitLog.push(2 * p.t + (horizFirst ? 0 : 1));
    for (const r of horizFirst ? A : B) if (r.w > EPS && r.h > EPS) sheet.free.push(r);
    // record cut lines in real coordinates (middle of the kerf), clipped to the sheet, in a valid order
    const k = ctx.kerf, SW = ctx.sheetW, SH = ctx.sheetH, h2 = k / 2;
    const clipX = (v) => Math.max(0, Math.min(SW, v)), clipY = (v) => Math.max(0, Math.min(SH, v));
    const hcut = (cy, x1, x2) => { if (cy > EPS && cy < SH - EPS) addCut(sheet, { x1: clipX(x1), y1: clipY(cy), x2: clipX(x2), y2: clipY(cy) }); };
    const vcut = (cx, y1, y2) => { if (cx > EPS && cx < SW - EPS) addCut(sheet, { x1: clipX(cx), y1: clipY(y1), x2: clipX(cx), y2: clipY(y2) }); };
    if (horizFirst) {
      if (dt > EPS) hcut(y - h2, f.x - h2, f.x + f.w - h2);
      if (db > EPS) hcut(y + h - h2, f.x - h2, f.x + f.w - h2);
      if (dl > EPS) vcut(x - h2, y - h2, y + h - h2);
      if (dr > EPS) vcut(x + w - h2, y - h2, y + h - h2);
    } else {
      if (dl > EPS) vcut(x - h2, f.y - h2, f.y + f.h - h2);
      if (dr > EPS) vcut(x + w - h2, f.y - h2, f.y + f.h - h2);
      if (dt > EPS) hcut(y - h2, x - h2, x + w - h2);
      if (db > EPS) hcut(y + h - h2, x - h2, x + w - h2);
    }
  }

  function largestFree(sheet) {
    let m = 0;
    for (const f of sheet.free) m = Math.max(m, f.w * f.h);
    return m;
  }
  // biggest leftover rectangle, in real (non-kerf) size, or null if it's too small to matter
  function offcutRect(ctx, sheet) {
    let best = null;
    for (const f of sheet.free) if (!best || f.w * f.h > best.w * best.h) best = f;
    if (!best) return null;
    const w = best.w - ctx.kerf, h = best.h - ctx.kerf;
    if (w <= EPS || h <= EPS) return null;
    return { x: best.x, y: best.y, w, h };
  }

  // ---------- compaction ----------
  // Slide every part toward the top-left (dir 'ul': up then left; 'lu': left then up) until
  // nothing moves. Pushes leftover space toward the bottom/right so it ends up in one piece.
  function slide(parts, k, dir) {
    const R = parts.map((p) => ({ p, x: p.x, y: p.y, w: p.w + k, h: p.h + k }));
    const up = (r) => {
      let ny = 0;
      for (const o of R) if (o !== r && o.y + o.h <= r.y + EPS && o.x < r.x + r.w - EPS && o.x + o.w > r.x + EPS) ny = Math.max(ny, o.y + o.h);
      const moved = r.y - ny > EPS; r.y = ny; return moved;
    };
    const left = (r) => {
      let nx = 0;
      for (const o of R) if (o !== r && o.x + o.w <= r.x + EPS && o.y < r.y + r.h - EPS && o.y + o.h > r.y + EPS) nx = Math.max(nx, o.x + o.w);
      const moved = r.x - nx > EPS; r.x = nx; return moved;
    };
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      R.sort((a, b) => (dir === 'ul' ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
      for (const r of R) {
        if (dir === 'ul') { moved = up(r) | moved; moved = left(r) | moved; }
        else { moved = left(r) | moved; moved = up(r) | moved; }
      }
      if (!moved) break;
    }
    return R;
  }

  function rebuild(ctx, R) {
    const sh = newSheet(ctx.W, ctx.H);
    for (const r of R) placeRect(sh, r.x, r.y, r.w, r.h);
    return sh;
  }

  // Try both slide directions and keep the one with the biggest single leftover rectangle.
  function compact(ctx, sheet) {
    let best = null;
    for (const dir of ['ul', 'lu']) {
      const R = slide(sheet.parts, ctx.kerf, dir);
      const sh = rebuild(ctx, R);
      const big = largestFree(sh);
      if (!best || big > best.big + EPS) best = { R, sh, big };
    }
    if (best.big + EPS < largestFree(sheet)) return sheet; // never make it worse
    for (const r of best.R) { r.p.x = r.x; r.p.y = r.y; }
    best.sh.parts = sheet.parts;
    return best.sh;
  }

  // ---------- problem setup ----------
  // input: { sheetW, sheetH, kerf, items: [{ w, h, qty, rotate, label }], params }
  function buildContext(input) {
    const k = Math.max(0, input.kerf || 0);
    const W = input.sheetW + k, H = input.sheetH + k; // kerf trick: inflate sheet and parts by k
    const types = [];
    const unplaceable = [];
    input.items.forEach((it, idx) => {
      const qty = Math.max(0, Math.floor(it.qty || 0));
      if (!qty || !(it.w > 0) || !(it.h > 0)) return;
      const ew = it.w + k, eh = it.h + k;
      const fits = (ew <= W + EPS && eh <= H + EPS) || (it.rotate && eh <= W + EPS && ew <= H + EPS);
      if (!fits) { unplaceable.push({ item: idx, label: it.label, w: it.w, h: it.h, qty }); return; }
      types.push({ item: idx, label: it.label, w: it.w, h: it.h, ew, eh, qty, rotate: !!it.rotate && Math.abs(it.w - it.h) > EPS });
    });
    const maxArea = types.reduce((m, t) => Math.max(m, t.ew * t.eh), 0) || 1;
    const total = types.reduce((s, t) => s + t.qty, 0);
    return { W, H, sheetW: input.sheetW, sheetH: input.sheetH, kerf: k, types, nT: types.length, maxArea, total, unplaceable };
  }

  // best placement of type t on sheet (tries rotation)
  function placementFor(ctx, sheet, t) {
    const ty = ctx.types[t];
    if (ctx.P.cutMode === 'guillotine' && ctx.P.cutWeight && ctx.P.alignCuts !== false) {
      let p = fitAligned(ctx, sheet, ty.ew, ty.eh);
      if (p) p.rot = false;
      if (ty.rotate) {
        const q = fitAligned(ctx, sheet, ty.eh, ty.ew);
        if (q && (!p || lexLess(q.key, p.key))) { q.rot = true; p = q; }
      }
      return p;
    }
    let p = fitBSSF(sheet, ty.ew, ty.eh);
    if (p) p.rot = false;
    if (ty.rotate) {
      const q = fitBSSF(sheet, ty.eh, ty.ew);
      if (q && (!p || q.s1 < p.s1 - EPS || (Math.abs(q.s1 - p.s1) <= EPS && q.s2 < p.s2 - EPS))) { q.rot = true; p = q; }
    }
    return p;
  }

  // true if rects a and b (kerf-inflated) share part of an edge
  function touching(a, b) {
    const ov = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > EPS;
    return ((Math.abs(a.x + a.w - b.x) <= 1e-6 || Math.abs(b.x + b.w - a.x) <= 1e-6) && ov(a.y, a.y + a.h, b.y, b.y + b.h)) ||
      ((Math.abs(a.y + a.h - b.y) <= 1e-6 || Math.abs(b.y + b.h - a.y) <= 1e-6) && ov(a.x, a.x + a.w, b.x, b.x + b.w));
  }

  function heuristic(ctx, t, p, sheet, prev) {
    const ty = ctx.types[t];
    const area = ty.ew * ty.eh;
    const snug = area / p.freeArea;
    let eta = (area / ctx.maxArea) * (0.2 + 0.8 * snug);
    const P = ctx.P;
    // Guillotine: each placement needs 0, 1 or 2 new cuts depending on how flush it sits.
    // Flush placements keep boxes against edges and previous cuts, so they're favoured.
    if (P.cutMode === 'guillotine') {
      const cutsAdded = p.cutsAdded ?? ((p.s1 > EPS ? 1 : 0) + (p.s2 > EPS ? 1 : 0));
      eta /= 1 + (0.5 + (P.cutWeight || 0)) * cutsAdded;
    }
    // Grouping: favour repeating the last box type and landing next to a box of the same type.
    const g = P.groupWeight || 0;
    if (g) {
      let near = false;
      const k = ctx.kerf;
      for (const q of sheet.parts) {
        if (q.t !== t) continue;
        if (touching({ x: p.x, y: p.y, w: p.w, h: p.h }, { x: q.x, y: q.y, w: q.w + k, h: q.h + k })) { near = true; break; }
      }
      eta *= 1 + 2 * g * (near ? 1 : 0) + g * (t === prev ? 1 : 0);
    }
    return eta;
  }

  // Share of boxes (of types with 2+ copies) that touch another box of the same type.
  function groupScore(ctx, sheets) {
    let n = 0, good = 0;
    const k = ctx.kerf;
    for (const s of sheets) {
      const R = s.parts.map((q) => ({ t: q.t, x: q.x, y: q.y, w: q.w + k, h: q.h + k }));
      for (const a of R) {
        if (ctx.types[a.t].qty < 2) continue;
        n++;
        if (R.some((b) => b !== a && b.t === a.t && touching(a, b))) good++;
      }
    }
    return n ? good / n : 1;
  }

  function evaluate(ctx, sheets) {
    const sheetArea = ctx.sheetW * ctx.sheetH;
    const N = sheets.length;
    if (!N) return { fitness: 0, fills: [], utilization: 0, offcut: 1 };
    const fills = sheets.map((s) => s.parts.reduce((a, p) => a + p.w * p.h, 0) / sheetArea);
    const last = sheets[N - 1];
    const offcut = Math.min(1, largestFree(last) / (ctx.W * ctx.H));
    const A = ctx.W * ctx.H;
    const scraps = sheets.map((s) => {
      let used = 0;
      for (const p of s.parts) used += (p.w + ctx.kerf) * (p.h + ctx.kerf);
      return Math.max(0, (A - used - largestFree(s)) / A);
    });
    const P = ctx.P;
    const guillotine = P.cutMode === 'guillotine';
    const cw = guillotine ? P.cutWeight || 0 : 0;
    // when optimizing for easy cuts, leftover shape matters much less
    const mu = (P.scrapWeight || 0) * (cw ? 0.25 : 1);
    let f = 0;
    for (let i = 0; i < N; i++) f += fills[i] * fills[i] - mu * scraps[i];
    f = f / N + (0.1 * offcut) / N;
    const nParts = sheets.reduce((a, s) => a + s.parts.length, 0) || 1;
    const cuts = guillotine ? sheets.reduce((a, s) => a + s.cuts.length, 0) : 0;
    const cutLines = guillotine ? sheets.reduce((a, s) => a + s.lines.size, 0) : 0;
    if (cw) f -= 0.4 * cw * ((P.alignCuts === false ? cuts : cutLines) / nParts);
    const grouping = groupScore(ctx, sheets);
    if (P.groupWeight) f += 0.25 * P.groupWeight * grouping;
    const utilization = fills.reduce((a, b) => a + b, 0) / N;
    return { fitness: f, fills, utilization, offcut, scraps, scrap: scraps.reduce((a, b) => a + b, 0) / N, cuts, cutLines, grouping };
  }

  /*
   * One ant builds a full solution.
   * mode: 'aco' (roulette on tau^a * eta^b) or 'greedy' (argmax eta, no pheromone).
   */
  function construct(ctx, tau, P, rng, mode, trace) {
    const nT = ctx.nT;
    const guillotine = P.cutMode === 'guillotine';
    const cnt = ctx.types.map((t) => t.qty);
    let left = ctx.total;
    const sheets = [];
    const splits = [];
    const openSheet = () => newSheet(ctx.W, ctx.H);
    const closeSheet = (sh) => (P.compact && !guillotine ? compact(ctx, sh) : sh);
    let cur = openSheet();
    let prev = nT;
    const transitions = [];
    const steps = trace ? [] : null;
    let entropySum = 0, decisions = 0;

    const cands = [];
    while (left > 0) {
      cands.length = 0;
      let sumW = 0;
      for (let t = 0; t < nT; t++) {
        if (!cnt[t]) continue;
        const p = placementFor(ctx, cur, t);
        if (!p) continue;
        const eta = heuristic(ctx, t, p, cur, prev);
        const tv = tau ? tau[prev * nT + t] : 1;
        const w = mode === 'greedy' ? eta : Math.pow(tv, P.alpha) * Math.pow(eta, P.beta);
        cands.push({ t, p, eta, tau: tv, w });
        sumW += w;
      }
      if (!cands.length) {
        sheets.push(closeSheet(cur));
        cur = openSheet();
        prev = nT;
        continue;
      }

      let pick = 0, r = null;
      if (mode === 'greedy') {
        for (let i = 1; i < cands.length; i++) if (cands[i].w > cands[pick].w) pick = i;
      } else {
        r = rng() * sumW;
        let acc = 0;
        pick = cands.length - 1;
        for (let i = 0; i < cands.length; i++) { acc += cands[i].w; if (r < acc) { pick = i; break; } }
        if (cands.length > 1) {
          let H = 0;
          for (const c of cands) { const q = c.w / sumW; if (q > 0) H -= q * Math.log(q); }
          entropySum += H / Math.log(cands.length);
          decisions++;
        }
      }

      const c = cands[pick];
      const ty = ctx.types[c.t];
      if (guillotine) { c.p.t = c.t; c.p.splitLog = splits; placeGuillotine(ctx, cur, c.p, mode === 'greedy' ? null : rng); }
      else placeRect(cur, c.p.x, c.p.y, c.p.w, c.p.h);
      const part = { t: c.t, x: c.p.x, y: c.p.y, w: c.p.rot ? ty.h : ty.w, h: c.p.rot ? ty.w : ty.h, rot: c.p.rot };
      cur.parts.push(part);

      if (steps) {
        steps.push({
          sheet: sheets.length,
          prev,
          pick,
          r: r === null ? null : r / sumW,
          cands: cands.map((k) => ({ t: k.t, tau: k.tau, eta: k.eta, p: k.w / sumW, x: k.p.x, y: k.p.y, rot: k.p.rot })),
          part: { ...part },
        });
      }
      transitions.push(prev * nT + c.t);
      cnt[c.t]--;
      left--;
      prev = c.t;
    }
    if (cur.parts.length) sheets.push(closeSheet(cur));

    const ev = evaluate(ctx, sheets);
    return {
      sheets: sheets.map((s) => ({ parts: s.parts, offcut: largestFree(s), offcutRect: offcutRect(ctx, s), cuts: guillotine ? s.cuts : null })),
      transitions,
      splits,
      ...ev,
      entropy: decisions ? entropySum / decisions : 0,
      steps,
    };
  }

  const DEFAULTS = { ants: 30, iterations: 150, alpha: 1, beta: 2, evaporation: 0.1, seed: 7, restartAfter: 25, tauSpread: 2, scrapWeight: 2, compact: true, cutMode: 'free', splitRule: 'minarea', learnSplit: true, splitBias: 0.6, groupWeight: 0, cutWeight: 0 };

  function solve(input, onProgress) {
    const P = Object.assign({}, DEFAULTS, input.params || {});
    const ctx = buildContext(input);
    ctx.P = P;
    const nT = ctx.nT;
    const rng = mulberry32(P.seed >>> 0);
    const rho = 1 - P.evaporation;

    const greedy = construct(ctx, null, P, null, 'greedy', false);
    if (!nT) {
      return { ctx: publicCtx(ctx), params: P, greedy: strip(greedy), best: strip(greedy), history: [], snapshots: [], trace: [], bestIter: 0, restarts: [] };
    }

    let tauMax = greedy.fitness / P.evaporation;
    let tauMin = tauMax / (P.tauSpread * nT + 2);
    const size = (nT + 1) * nT;
    let tau = new Float64Array(size).fill(tauMax);
    const learnSplit = P.cutMode === 'guillotine' && P.learnSplit;
    if (learnSplit) ctx.splitTau = new Float64Array(2 * nT).fill(tauMax);
    let bestSplitTau = null;

    let best = greedy, bestSeed = null, bestTau = null, bestIter = 0, lastImprove = 0;
    const history = [];
    const snapshots = [Float32Array.from(tau)];
    const restarts = [];

    for (let it = 1; it <= P.iterations; it++) {
      let iterBest = null, sum = 0, worst = Infinity, entropy = 0;
      for (let a = 0; a < P.ants; a++) {
        const seed = (rng() * 4294967296) >>> 0;
        const sol = construct(ctx, tau, P, mulberry32(seed), 'aco', false);
        sum += sol.fitness;
        entropy += sol.entropy;
        worst = Math.min(worst, sol.fitness);
        if (!iterBest || sol.fitness > iterBest.fitness) iterBest = sol;
        if (sol.fitness > best.fitness + 1e-12) {
          best = sol; bestSeed = seed; bestTau = Float64Array.from(tau); bestIter = it; lastImprove = it;
          if (learnSplit) bestSplitTau = Float64Array.from(ctx.splitTau);
          tauMax = best.fitness / P.evaporation;
          tauMin = tauMax / (P.tauSpread * nT + 2);
        }
      }

      // evaporate
      for (let i = 0; i < size; i++) tau[i] *= rho;
      // deposit: iteration best normally, global best every 5th iteration
      const depositor = it % 5 === 0 ? best : iterBest;
      const seen = new Set(depositor.transitions);
      for (const idx of seen) tau[idx] += depositor.fitness;
      for (let i = 0; i < size; i++) tau[i] = Math.min(tauMax, Math.max(tauMin, tau[i]));
      if (learnSplit) {
        const st = ctx.splitTau;
        for (let i = 0; i < st.length; i++) st[i] *= rho;
        for (const idx of new Set(depositor.splits)) st[idx] += depositor.fitness;
        for (let i = 0; i < st.length; i++) st[i] = Math.min(tauMax, Math.max(tauMin, st[i]));
      }

      let restarted = false;
      if (it - lastImprove >= P.restartAfter && it < P.iterations) {
        tau.fill(tauMax);
        if (learnSplit) ctx.splitTau.fill(tauMax);
        lastImprove = it;
        restarts.push(it);
        restarted = true;
      }

      const h = {
        it,
        best: best.fitness,
        iterBest: iterBest.fitness,
        mean: sum / P.ants,
        worst,
        sheets: best.sheets.length,
        utilization: best.utilization,
        entropy: entropy / P.ants,
        restarted,
      };
      history.push(h);
      snapshots.push(Float32Array.from(tau));
      if (onProgress) onProgress({ h, best: strip(best), tau: Float32Array.from(tau), tauMax, tauMin });
    }

    // Replay the best ant with tracing so the UI can show every decision it made.
    let trace = [];
    let replayMatches = true;
    if (bestSeed !== null) {
      if (learnSplit) ctx.splitTau = bestSplitTau;
      const replay = construct(ctx, bestTau, P, mulberry32(bestSeed), 'aco', true);
      trace = replay.steps;
      replayMatches = JSON.stringify(replay.sheets.map((s) => s.parts)) === JSON.stringify(best.sheets.map((s) => s.parts));
    } else {
      trace = construct(ctx, null, P, null, 'greedy', true).steps;
    }

    return {
      ctx: publicCtx(ctx),
      params: P,
      greedy: strip(greedy),
      best: strip(best),
      bestFromGreedy: bestSeed === null,
      bestIter,
      history,
      snapshots,
      trace,
      replayMatches,
      restarts,
      tauMax,
      tauMin,
    };
  }

  function strip(sol) {
    return { sheets: sol.sheets, fitness: sol.fitness, fills: sol.fills, utilization: sol.utilization, offcut: sol.offcut, scraps: sol.scraps, scrap: sol.scrap, cuts: sol.cuts, cutLines: sol.cutLines, grouping: sol.grouping };
  }
  function publicCtx(ctx) {
    return { sheetW: ctx.sheetW, sheetH: ctx.sheetH, kerf: ctx.kerf, types: ctx.types, nT: ctx.nT, total: ctx.total, unplaceable: ctx.unplaceable };
  }

  return { solve, buildContext, construct, mulberry32, DEFAULTS, _internal: { newSheet, fitBSSF, placeRect } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = ACOSolverModule;
