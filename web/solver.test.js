// Run with: node web/solver.test.js
const assert = require('assert');
const M = require('./solver.js')();

// True if the rects can be separated by recursive straight cuts that run edge to edge.
function isGuillotine(rects) {
  if (rects.length <= 1) return true;
  for (const [axis, size] of [['x', 'w'], ['y', 'h']]) {
    for (const c of new Set(rects.map((r) => r[axis] + r[size]))) {
      if (rects.some((r) => r[axis] < c - 1e-7 && r[axis] + r[size] > c + 1e-7)) continue;
      const a = rects.filter((r) => r[axis] + r[size] <= c + 1e-7), b = rects.filter((r) => r[axis] >= c - 1e-7);
      if (a.length && b.length) return isGuillotine(a) && isGuillotine(b);
    }
  }
  return false;
}

function check(input, res) {
  const k = input.kerf || 0, W = input.sheetW, H = input.sheetH;
  let n = 0;
  for (const s of res.best.sheets) {
    const ps = s.parts;
    n += ps.length;
    for (const p of ps) assert(p.x > -1e-6 && p.y > -1e-6 && p.x + p.w < W + 1e-6 && p.y + p.h < H + 1e-6, 'part outside sheet');
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        assert(a.x + a.w + k <= b.x + 1e-6 || b.x + b.w + k <= a.x + 1e-6 || a.y + a.h + k <= b.y + 1e-6 || b.y + b.h + k <= a.y + 1e-6, 'overlap or kerf violation');
      }
  }
  const want = input.items.reduce((s, i) => s + i.qty, 0) - res.ctx.unplaceable.reduce((s, u) => s + u.qty, 0);
  assert.strictEqual(n, want, 'every placeable box is placed exactly once');
  assert(res.replayMatches, 'traced replay reproduces the best layout');
  assert.deepStrictEqual(res.trace.map((s) => s.part.t), res.best.sheets.flatMap((s) => s.parts.map((p) => p.t)), 'replay places the same boxes in the same order');
  for (const s of res.best.sheets) {
    const o = s.offcutRect;
    if (!o) continue;
    assert(o.x > -1e-6 && o.y > -1e-6 && o.x + o.w < W + 1e-6 && o.y + o.h < H + 1e-6, 'offcut inside sheet');
    for (const p of s.parts) assert(o.x + o.w + k <= p.x + 1e-6 || p.x + p.w + k <= o.x + 1e-6 || o.y + o.h + k <= p.y + 1e-6 || p.y + p.h + k <= o.y + 1e-6, 'offcut overlaps a box');
  }
  assert(res.best.fitness >= res.greedy.fitness, 'never worse than greedy');
  assert(res.best.grouping >= 0 && res.best.grouping <= 1, 'grouping score is a share');
  if (input.params && input.params.cutMode === 'guillotine') {
    for (const s of res.best.sheets) {
      assert(isGuillotine(s.parts.map((p) => ({ x: p.x, y: p.y, w: p.w + k, h: p.h + k }))), 'layout can be cut with edge-to-edge cuts');
      assert(Array.isArray(s.cuts), 'cuts are reported');
      for (const c of s.cuts) {
        assert(c.x1 === c.x2 || c.y1 === c.y2, 'cuts are straight');
        assert(Math.min(c.x1, c.x2) > -1e-6 && Math.max(c.x1, c.x2) < W + 1e-6 && Math.min(c.y1, c.y2) > -1e-6 && Math.max(c.y1, c.y2) < H + 1e-6, 'cuts stay on the sheet');
        for (const p of s.parts) {
          // a cut line must never pass through the inside of a box
          if (c.y1 === c.y2) assert(!(c.y1 > p.y + 1e-6 && c.y1 < p.y + p.h - 1e-6 && Math.max(c.x1, c.x2) > p.x + 1e-6 && Math.min(c.x1, c.x2) < p.x + p.w - 1e-6), 'cut crosses a box');
          else assert(!(c.x1 > p.x + 1e-6 && c.x1 < p.x + p.w - 1e-6 && Math.max(c.y1, c.y2) > p.y + 1e-6 && Math.min(c.y1, c.y2) < p.y + p.h - 1e-6), 'cut crosses a box');
        }
      }
    }
  } else {
    assert(res.best.sheets.every((s) => s.cuts === null), 'free mode reports no cuts');
  }
}

const rng = M.mulberry32(42), ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
const cases = {
  'cabinet, inches, kerf': { sheetW: 48, sheetH: 96, kerf: 0.125, items: [{ w: 23.25, h: 30, qty: 4, rotate: true }, { w: 22.5, h: 11.25, qty: 6, rotate: true }, { w: 30, h: 34.5, qty: 2, rotate: true }, { w: 15, h: 6, qty: 8, rotate: false }, { w: 50, h: 50, qty: 1, rotate: true }] },
  'random multi-sheet': { sheetW: 100, sheetH: 60, kerf: 0.3, items: Array.from({ length: 10 }, () => ({ w: ri(5, 40), h: ri(5, 40), qty: ri(1, 12), rotate: rng() < 0.7 })) },
  'single type': { sheetW: 10, sheetH: 10, kerf: 0, items: [{ w: 3, h: 2, qty: 30, rotate: true }] },
};
const modes = {
  free: { cutMode: 'free' },
  guillotine: { cutMode: 'guillotine' },
  'free + grouping': { cutMode: 'free', groupWeight: 1 },
  'guillotine + fewest cuts + grouping': { cutMode: 'guillotine', cutWeight: 1, groupWeight: 1 },
};
for (const [name, base] of Object.entries(cases)) for (const [label, mode] of Object.entries(modes)) {
  const cutMode = label;
  const input = { ...base, params: { iterations: 30, ants: 20, ...mode } };
  const res = M.solve(input);
  check(input, res);
  console.log(`ok  ${name} [${cutMode}]: ${res.best.sheets.length} sheet(s), ${(res.best.utilization * 100).toFixed(1)}% used (greedy score ${res.greedy.fitness.toFixed(4)} -> ACO ${res.best.fitness.toFixed(4)})`);
}
