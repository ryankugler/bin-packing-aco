# 2D Rectangle Packing with Ant Colony Optimization

**Try it live: [bin-packing-aco.vercel.app](https://bin-packing-aco.vercel.app)**

![Veed Video Aug 27](https://github.com/user-attachments/assets/dc8677fc-9078-491f-9f0f-9c7b103019e7)


## Overview

This project packs rectangles onto fixed-size sheets with Ant Colony Optimization (ACO). It finds layouts that use the fewest, fullest sheets. It comes in two forms that share one algorithm:

- **`web/`**: a browser app (Antcut). You set the sheet size, the boxes, the kerf and the units (mm, cm, m, in, ft), and it shows how the colony reached its layout.
- **`main.py`**: a Python script that packs random rectangles and animates the result with matplotlib.

## Web app

Live at **https://bin-packing-aco.vercel.app**. To run it locally, serve `web/` with any static server (Web Workers don't run from `file://`):

```bash
python3 -m http.server 8000 --directory web
```

Then visit http://localhost:8000.

- **Inputs:** sheet width and height, kerf (the gap left between parts), and a list of boxes with name, size, quantity, and whether each may rotate. Imperial accepts fractions (`23 1/4`, `3-1/2`). Any field takes a unit suffix that overrides the current unit (`600mm`, `4ft`, `12"`).
- **Results:** sheets used, material used, the layout for each sheet, any boxes too big for the sheet, and the gain over a greedy baseline.
- **Insight:**
  - *Convergence* plots the best-so-far score, each iteration's best ant and the average ant against the greedy baseline. Ticks mark pheromone resets.
  - *Decisiveness* plots the entropy of the ants' choices over time.
  - *Pheromone map* is a heatmap of "after box A, place box B" trails at any iteration.
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
5. When nothing else fits, the sheet is closed and a new one is opened.

### Fitness

Falkenauer's bin-packing score, higher is better:

$$
f = \frac{1}{N}\sum_{i=1}^{N} \text{fill}_i^2 \; + \; \frac{0.1 \cdot \text{largest offcut on last sheet}}{N}
$$

Squaring the fill rewards packing early sheets full and leaving the last one nearly empty. That beats spreading the boxes evenly, and it is what lets the search drop a sheet. The offcut bonus breaks ties toward a usable leftover piece.

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
