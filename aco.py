"""
Ant Colony Optimization for 2D rectangle packing onto one or more sheets.

This is the same algorithm as web/solver.js (the web app), written in plain Python.

Model
-----
* Boxes are grouped into *types* (same size + rotation rule). Ants choose which type
  to place next, so identical boxes share what the colony learns.
* Pheromone ``tau[prev][next]``: how good it has been to place type ``next`` right
  after type ``prev`` on the same sheet. Row ``n_types`` is the "new sheet" row.
* Heuristic ``eta = (area / largest area) * (0.2 + 0.8 * snugness)`` where snugness is
  box area / area of the free rectangle it would land in.
* Decoder: MaxRects with Best-Short-Side-Fit, both orientations when allowed.
  Positions are continuous, so decimal sizes and kerf work.
* Fitness (higher is better): sum(fill_i^2 - scrap_weight * scrap_i) / N plus a small
  bonus for a large offcut on the last sheet. scrap_i is leftover on sheet i that is not
  part of its biggest empty rectangle (scattered gaps that are hard to reuse).
* Compaction: when a sheet is full, every box slides up and left (or left and up,
  whichever keeps the bigger leftover rectangle) so the leftover gathers in a corner.
* Update: MAX-MIN Ant System. Evaporate, let only the iteration best (or the global
  best every 5th iteration) deposit, clamp to [tau_min, tau_max], restart on stagnation.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

EPS = 1e-7


@dataclass
class BoxSpec:
    w: float
    h: float
    qty: int = 1
    rotate: bool = True
    label: str = ""


@dataclass
class Part:
    t: int          # type index
    x: float
    y: float
    w: float        # real (non-kerf) size as placed
    h: float
    rot: bool


@dataclass
class Free:
    x: float
    y: float
    w: float
    h: float


@dataclass
class Sheet:
    W: float
    H: float
    free: list[Free] = field(default_factory=list)
    parts: list[Part] = field(default_factory=list)

    def __post_init__(self):
        if not self.free:
            self.free = [Free(0.0, 0.0, self.W, self.H)]

    def fit(self, w: float, h: float):
        """Best-short-side-fit position for a w x h rectangle, or None."""
        best = None
        for f in self.free:
            if w > f.w + EPS or h > f.h + EPS:
                continue
            lw, lh = f.w - w, f.h - h
            key = (round(min(lw, lh), 6), round(max(lw, lh), 6), round(f.y, 6), round(f.x, 6))
            if best is None or key < best[0]:
                best = (key, f)
        if best is None:
            return None
        (s1, s2, _, _), f = best
        return {"x": f.x, "y": f.y, "w": w, "h": h, "s1": s1, "s2": s2, "free_area": f.w * f.h}

    def place(self, x: float, y: float, w: float, h: float) -> None:
        out: list[Free] = []
        for f in self.free:
            if x >= f.x + f.w - EPS or x + w <= f.x + EPS or y >= f.y + f.h - EPS or y + h <= f.y + EPS:
                out.append(f)
                continue
            if x > f.x + EPS:
                out.append(Free(f.x, f.y, x - f.x, f.h))
            if x + w < f.x + f.w - EPS:
                out.append(Free(x + w, f.y, f.x + f.w - (x + w), f.h))
            if y > f.y + EPS:
                out.append(Free(f.x, f.y, f.w, y - f.y))
            if y + h < f.y + f.h - EPS:
                out.append(Free(f.x, y + h, f.w, f.y + f.h - (y + h)))
        keep = []
        for i, a in enumerate(out):
            contained = False
            for j, b in enumerate(out):
                if i == j:
                    continue
                if (a.x >= b.x - EPS and a.y >= b.y - EPS and
                        a.x + a.w <= b.x + b.w + EPS and a.y + a.h <= b.y + b.h + EPS):
                    same = (abs(a.x - b.x) <= EPS and abs(a.y - b.y) <= EPS and
                            abs(a.w - b.w) <= EPS and abs(a.h - b.h) <= EPS)
                    if not same or j < i:
                        contained = True
                        break
            if not contained:
                keep.append(a)
        self.free = keep

    def largest_free(self) -> float:
        return max((f.w * f.h for f in self.free), default=0.0)

    def offcut(self, kerf: float) -> Free | None:
        """Biggest leftover rectangle in real (non-kerf) size."""
        if not self.free:
            return None
        f = max(self.free, key=lambda r: r.w * r.h)
        w, h = f.w - kerf, f.h - kerf
        return Free(f.x, f.y, w, h) if w > EPS and h > EPS else None


def _slide(parts: list[Part], k: float, up_first: bool) -> list[list[float]]:
    """Slide parts toward the top-left until nothing moves. Returns [x, y, w, h, part]."""
    R = [[p.x, p.y, p.w + k, p.h + k, p] for p in parts]

    def up(r):
        ny = max((o[1] + o[3] for o in R if o is not r and o[1] + o[3] <= r[1] + EPS
                  and o[0] < r[0] + r[2] - EPS and o[0] + o[2] > r[0] + EPS), default=0.0)
        moved = r[1] - ny > EPS
        r[1] = ny
        return moved

    def left(r):
        nx = max((o[0] + o[2] for o in R if o is not r and o[0] + o[2] <= r[0] + EPS
                  and o[1] < r[1] + r[3] - EPS and o[1] + o[3] > r[1] + EPS), default=0.0)
        moved = r[0] - nx > EPS
        r[0] = nx
        return moved

    for _ in range(20):
        moved = False
        R.sort(key=(lambda r: (r[1], r[0])) if up_first else (lambda r: (r[0], r[1])))
        for r in R:
            first, second = (up, left) if up_first else (left, up)
            moved = first(r) | moved
            moved = second(r) | moved
        if not moved:
            break
    return R


def compact(sheet: Sheet, kerf: float) -> Sheet:
    best = None
    for up_first in (True, False):
        R = _slide(sheet.parts, kerf, up_first)
        sh = Sheet(sheet.W, sheet.H)
        for x, y, w, h, _ in R:
            sh.place(x, y, w, h)
        if best is None or sh.largest_free() > best[1].largest_free() + EPS:
            best = (R, sh)
    R, sh = best
    if sh.largest_free() + EPS < sheet.largest_free():
        return sheet
    for x, y, _, _, p in R:
        p.x, p.y = x, y
    sh.parts = sheet.parts
    return sh


@dataclass
class Solution:
    sheets: list[Sheet]
    transitions: list[tuple[int, int]]
    fitness: float
    fills: list[float]
    utilization: float
    scraps: list[float] = field(default_factory=list)


@dataclass
class Params:
    ants: int = 20
    iterations: int = 80
    alpha: float = 1.0
    beta: float = 2.0
    evaporation: float = 0.1
    seed: int = 7
    restart_after: int = 25
    scrap_weight: float = 2.0
    compact: bool = True


class Packer:
    def __init__(self, sheet_w: float, sheet_h: float, boxes: list[BoxSpec], kerf: float = 0.0,
                 params: Params | None = None):
        self.sheet_w, self.sheet_h, self.kerf = sheet_w, sheet_h, max(0.0, kerf)
        self.W, self.H = sheet_w + self.kerf, sheet_h + self.kerf  # kerf trick
        self.P = params or Params()
        self.types: list[dict] = []
        self.unplaceable: list[BoxSpec] = []
        for b in boxes:
            if b.qty <= 0 or b.w <= 0 or b.h <= 0:
                continue
            ew, eh = b.w + self.kerf, b.h + self.kerf
            fits = (ew <= self.W + EPS and eh <= self.H + EPS) or (b.rotate and eh <= self.W + EPS and ew <= self.H + EPS)
            if not fits:
                self.unplaceable.append(b)
                continue
            self.types.append({"spec": b, "ew": ew, "eh": eh, "rotate": b.rotate and abs(b.w - b.h) > EPS})
        self.n = len(self.types)
        self.max_area = max((t["ew"] * t["eh"] for t in self.types), default=1.0)
        self.history: list[dict] = []

    # --- one ant ---------------------------------------------------------
    def _placement(self, sheet: Sheet, t: int):
        ty = self.types[t]
        p = sheet.fit(ty["ew"], ty["eh"])
        if p:
            p["rot"] = False
        if ty["rotate"]:
            q = sheet.fit(ty["eh"], ty["ew"])
            if q and (p is None or (q["s1"], q["s2"]) < (p["s1"], p["s2"])):
                q["rot"] = True
                p = q
        return p

    def _eta(self, t: int, p) -> float:
        area = self.types[t]["ew"] * self.types[t]["eh"]
        return (area / self.max_area) * (0.2 + 0.8 * area / p["free_area"])

    def construct(self, tau, rng: random.Random | None, greedy: bool = False) -> Solution:
        n = self.n
        cnt = [t["spec"].qty for t in self.types]
        left = sum(cnt)
        sheets: list[Sheet] = []
        cur = Sheet(self.W, self.H)
        prev = n
        transitions = []
        while left > 0:
            cands = []
            for t in range(n):
                if not cnt[t]:
                    continue
                p = self._placement(cur, t)
                if p is None:
                    continue
                eta = self._eta(t, p)
                w = eta if greedy else (tau[prev][t] ** self.P.alpha) * (eta ** self.P.beta)
                cands.append((t, p, w))
            if not cands:
                sheets.append(compact(cur, self.kerf) if self.P.compact else cur)
                cur = Sheet(self.W, self.H)
                prev = n
                continue
            if greedy:
                t, p, _ = max(cands, key=lambda c: c[2])
            else:
                r = rng.random() * sum(c[2] for c in cands)
                acc = 0.0
                t, p, _ = cands[-1]
                for c in cands:
                    acc += c[2]
                    if r < acc:
                        t, p, _ = c
                        break
            spec = self.types[t]["spec"]
            cur.place(p["x"], p["y"], p["w"], p["h"])
            cur.parts.append(Part(t, p["x"], p["y"], spec.h if p["rot"] else spec.w, spec.w if p["rot"] else spec.h, p["rot"]))
            transitions.append((prev, t))
            cnt[t] -= 1
            left -= 1
            prev = t
        if cur.parts:
            sheets.append(compact(cur, self.kerf) if self.P.compact else cur)
        return self._evaluate(sheets, transitions)

    def _evaluate(self, sheets, transitions) -> Solution:
        area = self.sheet_w * self.sheet_h
        if not sheets:
            return Solution([], transitions, 0.0, [], 0.0)
        fills = [sum(p.w * p.h for p in s.parts) / area for s in sheets]
        A = self.W * self.H
        offcut = min(1.0, sheets[-1].largest_free() / A)
        k = self.kerf
        scraps = [max(0.0, (A - sum((p.w + k) * (p.h + k) for p in s.parts) - s.largest_free()) / A) for s in sheets]
        N = len(sheets)
        f = sum(x * x - self.P.scrap_weight * c for x, c in zip(fills, scraps)) / N + 0.1 * offcut / N
        return Solution(sheets, transitions, f, fills, sum(fills) / N, scraps)

    # --- the colony ------------------------------------------------------
    def solve(self, verbose: bool = True) -> tuple[Solution, Solution]:
        """Returns (best, greedy_baseline)."""
        P, n = self.P, self.n
        greedy = self.construct(None, None, greedy=True)
        if n == 0:
            return greedy, greedy
        rng = random.Random(P.seed)
        tau_max = greedy.fitness / P.evaporation
        tau_min = tau_max / (2 * n + 2)
        tau = [[tau_max] * n for _ in range(n + 1)]
        best, last_improve = greedy, 0

        for it in range(1, P.iterations + 1):
            sols = [self.construct(tau, random.Random(rng.getrandbits(32))) for _ in range(P.ants)]
            it_best = max(sols, key=lambda s: s.fitness)
            if it_best.fitness > best.fitness + 1e-12:
                best, last_improve = it_best, it
                tau_max = best.fitness / P.evaporation
                tau_min = tau_max / (2 * n + 2)
                if verbose:
                    print(f"iter {it:3d}: new best {best.fitness:.4f} "
                          f"({len(best.sheets)} sheets, {best.utilization:.1%} used)")
            rho = 1 - P.evaporation
            for row in tau:
                for j in range(n):
                    row[j] *= rho
            depositor = best if it % 5 == 0 else it_best
            for a, b in set(depositor.transitions):
                tau[a][b] += depositor.fitness
            for row in tau:
                for j in range(n):
                    row[j] = min(tau_max, max(tau_min, row[j]))
            restarted = False
            if it - last_improve >= P.restart_after and it < P.iterations:
                tau = [[tau_max] * n for _ in range(n + 1)]
                last_improve, restarted = it, True
            self.history.append({
                "it": it, "best": best.fitness, "iter_best": it_best.fitness,
                "mean": sum(s.fitness for s in sols) / len(sols), "restarted": restarted,
            })
        self.tau = tau
        return best, greedy
