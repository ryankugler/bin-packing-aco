import random
from collections import Counter

from aco import BoxSpec, Packer, Params
from constants import (ALLOW_ROTATION, ALPHA, BETA, BIN_HEIGHT, BIN_WIDTH, COMPACT, EVAPORATION, KERF,
                       MAX_RECT_HEIGHT, MAX_RECT_WIDTH, NUM_ANTS, NUM_ITERATIONS, NUM_RECTANGLES, SCRAP_WEIGHT, SEED)
from visualization import run_animation


def random_boxes(seed: int) -> list[BoxSpec]:
    """Random rectangles, grouped by size. With rotation on, 3x4 and 4x3 are the same box."""
    rng = random.Random(seed)
    sizes = Counter()
    for _ in range(NUM_RECTANGLES):
        w, h = rng.randint(1, MAX_RECT_WIDTH), rng.randint(1, MAX_RECT_HEIGHT)
        if ALLOW_ROTATION:
            w, h = max(w, h), min(w, h)
        sizes[(w, h)] += 1
    return [BoxSpec(w, h, q, ALLOW_ROTATION, f"{w}x{h}") for (w, h), q in sizes.most_common()]


def main() -> None:
    boxes = random_boxes(SEED)
    params = Params(ants=NUM_ANTS, iterations=NUM_ITERATIONS, alpha=ALPHA, beta=BETA,
                    evaporation=EVAPORATION, seed=SEED, scrap_weight=SCRAP_WEIGHT, compact=COMPACT)
    packer = Packer(BIN_WIDTH, BIN_HEIGHT, boxes, kerf=KERF, params=params)
    best, greedy = packer.solve()

    print()
    print(f"Greedy baseline: {len(greedy.sheets)} sheet(s), score {greedy.fitness:.4f}")
    print(f"ACO best:        {len(best.sheets)} sheet(s), score {best.fitness:.4f}, "
          f"{best.utilization:.1%} of material used")
    for b in packer.unplaceable:
        print(f"  could not place {b.qty} x {b.label} ({b.w} x {b.h}): larger than the sheet")
    for i, s in enumerate(best.sheets, 1):
        oc = s.offcut(packer.kerf)
        oc_txt = f", offcut {oc.w:g} x {oc.h:g} at ({oc.x:g}, {oc.y:g})" if oc else ""
        print(f"Sheet {i}: {len(s.parts)} parts, {best.fills[i - 1]:.1%} full, "
              f"{best.scraps[i - 1]:.1%} scrap{oc_txt}")
        print("  ", [(p.x, p.y, p.w, p.h) for p in s.parts])

    run_animation(packer, best, greedy)


if __name__ == "__main__":
    main()
