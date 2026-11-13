# 2D Rectangle Packing with Ant Colony Optimization

**Try it live: [bin-packing-aco.vercel.app](https://bin-packing-aco.vercel.app)**

![Veed Video Aug 27](https://github.com/user-attachments/assets/dc8677fc-9078-491f-9f0f-9c7b103019e7)


## Overview

This project packs rectangles onto fixed-size sheets with Ant Colony Optimization (ACO). It finds layouts that use the fewest, fullest sheets. It comes in two forms that share one algorithm:

- **`web/`**: a browser app (SheetFit). You set the sheet size, the boxes, the kerf and the units (mm, cm, m, in, ft), and it shows how the colony reached its layout.
- **`main.py`**: a Python script that packs random rectangles and animates the result with matplotlib.

## Web app

Live at **https://bin-packing-aco.vercel.app**. To run it locally, serve `web/` with any static server (Web Workers don't run from `file://`):

```bash
python3 -m http.server 8000 --directory web
```

Then visit http://localhost:8000.

The page has three tabs. **Free cut** and **Guillotine cut** share the same inputs; switching between them re-runs the job in that mode and says how many sheets the other mode needs.

- **Free cut** (the default): boxes can go anywhere, for laser, CNC router or plotter cutting. Pick units, enter the sheet size and the gap your saw blade leaves, list the boxes (name, size, how many, and a **Rotation** toggle: *Can turn* or *Fixed*), and press **Find best layout**. Each sheet is drawn with every box labelled, along with sheets needed, material used, and what goes on each sheet. Imperial accepts fractions (`23 1/4`, `3-1/2`). Any field takes a unit suffix that overrides the current unit (`600mm`, `4ft`, `12"`). A **How to use** guide opens on the first visit and from the header.
- **Guillotine cut**: every cut runs straight across the piece from edge to edge, so a guillotine cutter, panel saw or table saw can make it. Cut lines are drawn on each sheet, numbered in a valid cutting order, with a total cut count.
- **Advanced**: algorithm settings (ants, rounds, seed, α, β, evaporation) with a **Run again** button, the comparison against a greedy baseline, and the insight views:
  - *Convergence* plots the best-so-far score, each round's best ant and the average ant against the greedy baseline. Ticks mark pheromone resets.
  - *Decisiveness* plots the entropy of the ants' choices over time.
  - *Pheromone map* is a heatmap of "after box A, place box B" trails at any round.
  - *Replay the winning ant* steps through each decision the best ant made. It shows every candidate's pheromone τ, heuristic η and probability, the random draw, and where each candidate would have landed.

Run the solver tests with `node web/solver.test.js`.

### Deploy to Vercel

`vercel.json` serves `web/` as a static site with no build step. Import the repo at vercel.com/new and keep the defaults, or deploy from the CLI with `npx vercel` from the repo root.

## The algorithm

### Construction (one ant)

1. Boxes are grouped into **types** (same size and rotation rule), so identical boxes share what the colony learns.
2. With a sheet open, the ant finds the best spot for every remaining type using **MaxRects with best-short-side-fit**. It tries both orientations when rotation is allowed. Positions are continuous, so decimal sizes and kerf work.
3. Each candidate gets a weight τ<sup>α</sup>·η<sup>β</sup>:
   - **τ (pheromone)** = `tau[previous type][this type]`. A fresh sheet uses a special "new sheet" row.
   - **η (heuristic)** = `(area / largest area) × (0.2 + 0.8 × snugness)`, where snugness = box area ÷ area of the free rectangle it would land in. Large boxes go first, and boxes that fill a gap tightly get a boost.
4. The ant draws one candidate at random in proportion to its weight and places it.
5. When nothing else fits, the sheet is closed. Every box then slides up and to the left as far as it can (also tried left-then-up, keeping whichever leaves the bigger open rectangle). This gathers the leftover into one corner, where it can be cut off and reused. Then a new sheet is opened.

### Fitness

Higher is better:

$$
f = \frac{1}{N}\sum_{i=1}^{N} \left(\text{fill}_i^2 - 2 \cdot \text{scrap}_i\right) \; + \; \frac{0.1 \cdot \text{largest offcut on last sheet}}{N}
$$

- **fill²** is Falkenauer's bin-packing score. Squaring the fill rewards packing early sheets full and leaving the last one nearly empty, rather than spreading boxes evenly. That is what lets the search drop a sheet.
- **scrap** is the leftover on a sheet that isn't part of its biggest empty rectangle. These are the scattered gaps between boxes that are hard to reuse. Penalizing it pushes the colony to keep each sheet's leftover in one piece. The weight (default 2) is the *Scrap penalty* setting.
- The **offcut bonus** breaks ties toward a usable leftover piece on the last sheet.

On 21 test jobs, the scrap penalty plus sliding cut scattered scrap from 6.2% to 4.6% of each sheet on average, with no extra sheets. On the cabinet example it went from 6.3% to 3.5%. Changing where boxes are placed (packing toward a corner) used 3 more sheets, and a fragmentation term in the heuristic didn't help, so neither is included.

The app hatches each sheet's biggest leftover rectangle as the **reusable offcut** and reports material used, reusable offcuts and scrap separately.

### Guillotine mode

Guillotine cutters, panel saws and table saws can only make straight cuts that run all the way across the piece being cut. Guillotine mode only builds layouts that can be cut that way:

- **Placement:** free space is kept as non-overlapping rectangles. A box goes in the top-left corner of one, and the rest of that rectangle is split by two cuts. The first runs fully across the rectangle, and the second runs across the strip holding the box. Every cut divides one piece into two, so the cuts as recorded are already a valid cutting order.
- **Split direction:** for each box the ant chooses which cut comes first (across, or down). The default rule favours the split whose bigger leftover piece is smaller ("min area"), which leaves less scrap and needs fewer cuts. A second pheromone, per box type and direction, lets the colony learn when to go against the rule.
- **No sliding:** the slide step is skipped here, because sliding boxes would break the straight cuts.

On the 21 test jobs, guillotine layouts need 81 sheets against 79 for free cut. With a fixed split rule and no learning they needed 83. Every result is checked by an independent test that recursively splits the layout with edge-to-edge cuts. Guillotine mode is in the web app only; the Python solver supports free cut.

### Learning (MAX-MIN Ant System)

- All trails evaporate by `EVAPORATION` each iteration.
- Only the iteration's best ant deposits (the all-time best every 5th iteration), adding its score to each "A → B" transition it used.
- Trails are clamped to `[tau_min, tau_max]`, so no option disappears completely.
- After 25 iterations without improvement, trails reset to `tau_max` (a restart).

A greedy pass (always take the highest η, no pheromone) runs first. It seeds `tau_max` and serves as the baseline the colony has to beat.

## Changes from v1

- **Pheromone now reflects what each ant actually packed.** It lives on "after box A, place box B" pairs instead of one value per rectangle, so the colony can learn ordering.
- **Each ant builds its layout independently.** Ants no longer share rectangle objects, so a layout can't be changed by another ant mid-run.
- **The heuristic is balanced with pheromone.** v1 weighted by area⁸, which left little room for learning.
- **The visualization shows the layout the colony actually found.**
- **Continuous placement (MaxRects)** replaces the integer grid scan. This adds decimal sizes, kerf, metric and imperial units, and multiple sheets.

## Python usage

```bash
pip install -r requirements.txt
python main.py
```

Edit `constants.py` to change the sheet size, number and size of random rectangles, kerf, rotation, and colony settings (`NUM_ANTS`, `NUM_ITERATIONS`, `ALPHA`, `BETA`, `EVAPORATION`, `SEED`). `aco.py` holds the solver. To pack your own parts, use it directly:

```python
from aco import BoxSpec, Packer, Params

packer = Packer(48, 96, [BoxSpec(23.25, 30, 4, True, "Side"), BoxSpec(22.5, 11.25, 6, True, "Shelf")],
                kerf=0.125, params=Params(iterations=100))
best, greedy = packer.solve()
```
