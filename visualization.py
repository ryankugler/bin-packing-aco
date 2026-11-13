import matplotlib.patches as patches
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

COLORS = plt.get_cmap("tab10").colors


def run_animation(packer, best, greedy):
    """Animate the best layout the colony found, part by part, next to its convergence curve."""
    sheets = best.sheets
    n = len(sheets)
    fig = plt.figure(figsize=(4 * n + 5, 5))
    axes = [fig.add_subplot(1, n + 1, i + 1) for i in range(n)]
    conv = fig.add_subplot(1, n + 1, n + 1)

    for i, ax in enumerate(axes):
        ax.set_xlim(0, packer.sheet_w)
        ax.set_ylim(packer.sheet_h, 0)  # y grows downward, matching the solver
        ax.set_aspect("equal")
        ax.set_title(f"Sheet {i + 1} ({best.fills[i]:.0%} full)")
        ax.add_patch(patches.Rectangle((0, 0), packer.sheet_w, packer.sheet_h, fill=False, edgecolor="black"))
        oc = sheets[i].offcut(packer.kerf)
        if oc:
            ax.add_patch(patches.Rectangle((oc.x, oc.y), oc.w, oc.h, fill=False, hatch="//",
                                           edgecolor="grey", linestyle="--", label="reusable offcut"))

    h = packer.history
    its = [x["it"] for x in h]
    conv.plot(its, [x["mean"] for x in h], ":", color="grey", label="average ant")
    conv.plot(its, [x["iter_best"] for x in h], color="tab:blue", lw=1, label="best ant this iteration")
    conv.plot(its, [x["best"] for x in h], color="tab:green", lw=2.5, label="best so far")
    conv.axhline(greedy.fitness, color="goldenrod", ls="--", label="greedy baseline")
    lo = min(greedy.fitness, min((x["iter_best"] for x in h), default=greedy.fitness))
    hi = max((x["best"] for x in h), default=greedy.fitness)
    pad = (hi - lo) * 0.1 or 0.01
    conv.set_ylim(lo - pad, hi + pad)
    conv.set_xlabel("iteration")
    conv.set_ylabel("score (higher is better)")
    conv.set_title("Convergence")
    conv.legend(fontsize=8, loc="lower right")

    order = [(si, p) for si, s in enumerate(sheets) for p in s.parts]

    def update(frame):
        si, p = order[frame]
        axes[si].add_patch(patches.Rectangle((p.x, p.y), p.w, p.h, edgecolor="black",
                                             facecolor=COLORS[p.t % len(COLORS)]))
        return []

    anim = FuncAnimation(fig, update, frames=len(order), interval=120, repeat=False)
    fig.tight_layout()
    plt.show()
    return anim
