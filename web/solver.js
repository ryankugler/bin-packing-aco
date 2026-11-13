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
    return { W, H, free: [{ x: 0, y: 0, w: W, h: H }], parts: [], cuts: [] };
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

  /*
   * Guillotine placement. Free rects never overlap. The box goes in the top-left corner of
   * free rect f, and the rest of f is split by one straight cut across f and a second cut
   * across the strip holding the box. Every cut runs edge to edge through the piece it
   * divides, so the whole sheet can be cut on a guillotine, panel saw or table saw.
   * Cuts are recorded in order; that order is a valid cutting sequence.
   */
  function placeGuillotine(ctx, sheet, p, rng) {
    const f = sheet.free[p.fi];
    sheet.free.splice(p.fi, 1);
    const { w, h } = p;
    const lw = f.w - w, lh = f.h - h;
    // A: cut across the full width first. B: cut down the full height first.
    const A = [{ x: f.x, y: f.y + h, w: f.w, h: lh }, { x: f.x + w, y: f.y, w: lw, h }];
    const B = [{ x: f.x + w, y: f.y, w: lw, h: f.h }, { x: f.x, y: f.y + h, w, h: lh }];
    const area = (r) => (r.w > EPS && r.h > EPS ? r.w * r.h : 0);
    let horizFirst;
    switch (ctx.P.splitRule) {
      case 'shorter': horizFirst = lw < lh; break;
      case 'longer': horizFirst = lw >= lh; break;
      case 'maxarea': horizFirst = Math.max(area(A[0]), area(A[1])) >= Math.max(area(B[0]), area(B[1])); break;
      default: horizFirst = Math.max(area(A[0]), area(A[1])) <= Math.max(area(B[0]), area(B[1])); // 'minarea'
    }
    // ants choose the cut direction: the split rule's pick is favoured, pheromone learns per box type
    if (rng && ctx.splitTau) {
      // pheromone per (box type, direction): [cut-across-first, cut-down-first]
      const tH = ctx.splitTau[2 * p.t], tV = ctx.splitTau[2 * p.t + 1];
      const wH = tH * (horizFirst ? 1 : ctx.P.splitBias), wV = tV * (horizFirst ? ctx.P.splitBias : 1);
      horizFirst = rng() * (wH + wV) < wH;
    }
    if (p.splitLog) p.splitLog.push(2 * p.t + (horizFirst ? 0 : 1));
    const pieces = horizFirst ? A : B;
    for (const r of pieces) if (r.w > EPS && r.h > EPS) sheet.free.push(r);
    // record cut lines in real coordinates (middle of the kerf), clipped to the sheet
    const k = ctx.kerf, SW = ctx.sheetW, SH = ctx.sheetH;
    const clipX = (v) => Math.max(0, Math.min(SW, v)), clipY = (v) => Math.max(0, Math.min(SH, v));
    const hcut = (y, x1, x2) => sheet.cuts.push({ x1: clipX(x1), y1: clipY(y), x2: clipX(x2), y2: clipY(y) });
    const vcut = (x, y1, y2) => sheet.cuts.push({ x1: clipX(x), y1: clipY(y1), x2: clipX(x), y2: clipY(y2) });
    const cy = f.y + h - k / 2, cx = f.x + w - k / 2;
    if (horizFirst) {
      if (lh > EPS && cy < SH - EPS) hcut(cy, f.x - k / 2, f.x + f.w - k / 2);
      if (lw > EPS && cx < SW - EPS) vcut(cx, f.y - k / 2, f.y + h - k / 2);
    } else {
      if (lw > EPS && cx < SW - EPS) vcut(cx, f.y - k / 2, f.y + f.h - k / 2);
      if (lh > EPS && cy < SH - EPS) hcut(cy, f.x - k / 2, f.x + w - k / 2);
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
    let p = fitBSSF(sheet, ty.ew, ty.eh);
    if (p) p.rot = false;
    if (ty.rotate) {
      const q = fitBSSF(sheet, ty.eh, ty.ew);
      if (q && (!p || q.s1 < p.s1 - EPS || (Math.abs(q.s1 - p.s1) <= EPS && q.s2 < p.s2 - EPS))) { q.rot = true; p = q; }
    }
    return p;
  }

  function heuristic(ctx, t, p) {
    const ty = ctx.types[t];
    const area = ty.ew * ty.eh;
    const snug = area / p.freeArea;
    return (area / ctx.maxArea) * (0.2 + 0.8 * snug);
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
    const mu = ctx.P.scrapWeight || 0;
    let f = 0;
    for (let i = 0; i < N; i++) f += fills[i] * fills[i] - mu * scraps[i];
    f = f / N + (0.1 * offcut) / N;
    const utilization = fills.reduce((a, b) => a + b, 0) / N;
    return { fitness: f, fills, utilization, offcut, scraps, scrap: scraps.reduce((a, b) => a + b, 0) / N };
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
    let cur = newSheet(ctx.W, ctx.H);
    let prev = nT;
    const transitions = [];
    const splits = [];
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
        const eta = heuristic(ctx, t, p);
        const tv = tau ? tau[prev * nT + t] : 1;
        const w = mode === 'greedy' ? eta : Math.pow(tv, P.alpha) * Math.pow(eta, P.beta);
        cands.push({ t, p, eta, tau: tv, w });
        sumW += w;
      }
      if (!cands.length) {
        sheets.push(P.compact && !guillotine ? compact(ctx, cur) : cur);
        cur = newSheet(ctx.W, ctx.H);
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
    if (cur.parts.length) sheets.push(P.compact && !guillotine ? compact(ctx, cur) : cur);

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

  const DEFAULTS = { ants: 20, iterations: 80, alpha: 1, beta: 2, evaporation: 0.1, seed: 7, restartAfter: 25, tauSpread: 2, scrapWeight: 2, compact: true, cutMode: 'free', splitRule: 'minarea', learnSplit: true, splitBias: 0.6 };

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
    return { sheets: sol.sheets, fitness: sol.fitness, fills: sol.fills, utilization: sol.utilization, offcut: sol.offcut, scraps: sol.scraps, scrap: sol.scrap };
  }
  function publicCtx(ctx) {
    return { sheetW: ctx.sheetW, sheetH: ctx.sheetH, kerf: ctx.kerf, types: ctx.types, nT: ctx.nT, total: ctx.total, unplaceable: ctx.unplaceable };
  }

  return { solve, buildContext, construct, mulberry32, DEFAULTS, _internal: { newSheet, fitBSSF, placeRect } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = ACOSolverModule;
