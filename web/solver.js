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
 *  - Fitness (higher is better): Falkenauer's sum(fill_i^2) / N, plus a small bonus for
 *    a large leftover offcut on the last sheet. Rewards fewer, fuller sheets.
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
    return { W, H, free: [{ x: 0, y: 0, w: W, h: H }], parts: [] };
  }

  // Best-Short-Side-Fit for a w x h rectangle. Ties: long side, then top-most, then left-most.
  function fitBSSF(sheet, w, h) {
    let best = null;
    for (const f of sheet.free) {
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
        best = { x: f.x, y: f.y, w, h, s1, s2, freeArea: f.w * f.h };
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

  function largestFree(sheet) {
    let m = 0;
    for (const f of sheet.free) m = Math.max(m, f.w * f.h);
    return m;
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
    let f = 0;
    for (const x of fills) f += x * x;
    f = f / N + (0.1 * offcut) / N;
    const utilization = fills.reduce((a, b) => a + b, 0) / N;
    return { fitness: f, fills, utilization, offcut };
  }

  /*
   * One ant builds a full solution.
   * mode: 'aco' (roulette on tau^a * eta^b) or 'greedy' (argmax eta, no pheromone).
   */
  function construct(ctx, tau, P, rng, mode, trace) {
    const nT = ctx.nT;
    const cnt = ctx.types.map((t) => t.qty);
    let left = ctx.total;
    const sheets = [];
    let cur = newSheet(ctx.W, ctx.H);
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
        const eta = heuristic(ctx, t, p);
        const tv = tau ? tau[prev * nT + t] : 1;
        const w = mode === 'greedy' ? eta : Math.pow(tv, P.alpha) * Math.pow(eta, P.beta);
        cands.push({ t, p, eta, tau: tv, w });
        sumW += w;
      }
      if (!cands.length) {
        sheets.push(cur);
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
      placeRect(cur, c.p.x, c.p.y, c.p.w, c.p.h);
      const part = { t: c.t, x: c.p.x, y: c.p.y, w: c.p.rot ? ty.h : ty.w, h: c.p.rot ? ty.w : ty.h, rot: c.p.rot };
      cur.parts.push(part);

      if (steps) {
        steps.push({
          sheet: sheets.length,
          prev,
          pick,
          r: r === null ? null : r / sumW,
          cands: cands.map((k) => ({ t: k.t, tau: k.tau, eta: k.eta, p: k.w / sumW, x: k.p.x, y: k.p.y, rot: k.p.rot })),
          part,
        });
      }
      transitions.push(prev * nT + c.t);
      cnt[c.t]--;
      left--;
      prev = c.t;
    }
    if (cur.parts.length) sheets.push(cur);

    const ev = evaluate(ctx, sheets);
    return {
      sheets: sheets.map((s) => ({ parts: s.parts, offcut: largestFree(s) })),
      transitions,
      ...ev,
      entropy: decisions ? entropySum / decisions : 0,
      steps,
    };
  }

  const DEFAULTS = { ants: 20, iterations: 80, alpha: 1, beta: 2, evaporation: 0.1, seed: 7, restartAfter: 25, tauSpread: 2 };

  function solve(input, onProgress) {
    const P = Object.assign({}, DEFAULTS, input.params || {});
    const ctx = buildContext(input);
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

      let restarted = false;
      if (it - lastImprove >= P.restartAfter && it < P.iterations) {
        tau.fill(tauMax);
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
    if (bestSeed !== null) {
      const replay = construct(ctx, bestTau, P, mulberry32(bestSeed), 'aco', true);
      trace = replay.steps;
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
      restarts,
      tauMax,
      tauMin,
    };
  }

  function strip(sol) {
    return { sheets: sol.sheets, fitness: sol.fitness, fills: sol.fills, utilization: sol.utilization, offcut: sol.offcut };
  }
  function publicCtx(ctx) {
    return { sheetW: ctx.sheetW, sheetH: ctx.sheetH, kerf: ctx.kerf, types: ctx.types, nT: ctx.nT, total: ctx.total, unplaceable: ctx.unplaceable };
  }

  return { solve, buildContext, construct, mulberry32, DEFAULTS, _internal: { newSheet, fitBSSF, placeRect } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = ACOSolverModule;
