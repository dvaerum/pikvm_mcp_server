"""Fit math + MLP to consensus-clean emit data. Compare to constant-ratio baseline.

Inputs:  data/pilot-clean.jsonl (n~23)
Outputs: console report
"""
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent.parent
CLEAN = ROOT / "data" / "pilot-clean.jsonl"


def load():
    rows = []
    for line in CLEAN.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def fit_linear_per_axis(rows):
    """Fit observed = a*emit + b per axis, least squares."""
    ex = np.array([r["emit_dx"] for r in rows])
    ey = np.array([r["emit_dy"] for r in rows])
    ox = np.array([r["cons_dx"] for r in rows])
    oy = np.array([r["cons_dy"] for r in rows])

    # X-axis fit, ignore samples with emit_dx == 0
    mask_x = ex != 0
    ax, bx = np.polyfit(ex[mask_x], ox[mask_x], 1) if mask_x.sum() > 1 else (1.3, 0.0)
    mask_y = ey != 0
    ay, by = np.polyfit(ey[mask_y], oy[mask_y], 1) if mask_y.sum() > 1 else (1.3, 0.0)
    return ax, bx, ay, by


def fit_powerlaw_per_axis(rows):
    """Fit |observed| = a * |emit|^b per axis, log-log least squares."""
    ex = np.array([r["emit_dx"] for r in rows])
    ey = np.array([r["emit_dy"] for r in rows])
    ox = np.array([r["cons_dx"] for r in rows])
    oy = np.array([r["cons_dy"] for r in rows])

    mask_x = (np.abs(ex) >= 5) & (np.abs(ox) >= 1)
    if mask_x.sum() > 2:
        lx = np.log(np.abs(ex[mask_x]))
        lo = np.log(np.abs(ox[mask_x]))
        slope, intercept = np.polyfit(lx, lo, 1)
        ax_pow, bx_pow = math.exp(intercept), slope
    else:
        ax_pow, bx_pow = 1.3, 1.0

    mask_y = (np.abs(ey) >= 5) & (np.abs(oy) >= 1)
    if mask_y.sum() > 2:
        ly = np.log(np.abs(ey[mask_y]))
        lo = np.log(np.abs(oy[mask_y]))
        slope, intercept = np.polyfit(ly, lo, 1)
        ay_pow, by_pow = math.exp(intercept), slope
    else:
        ay_pow, by_pow = 1.3, 1.0

    return ax_pow, bx_pow, ay_pow, by_pow


def eval_model(rows, predict):
    """Run predict(emit_dx, emit_dy) -> (pred_dx, pred_dy) across rows.
    Return mean/median/max L2 error.
    """
    errs = []
    for r in rows:
        pred_dx, pred_dy = predict(r["emit_dx"], r["emit_dy"])
        err = math.hypot(pred_dx - r["cons_dx"], pred_dy - r["cons_dy"])
        errs.append(err)
    errs.sort()
    n = len(errs)
    return {
        "mean": sum(errs) / n,
        "median": errs[n // 2],
        "max": errs[-1],
        "n": n,
    }


def main():
    rows = load()
    print(f"Clean samples: {len(rows)}")
    print()

    # Baseline: constant ratio 1.3
    def baseline(dx, dy):
        return dx * 1.3, dy * 1.3
    base_res = eval_model(rows, baseline)
    print(f"Baseline (constant 1.3):")
    print(f"  mean={base_res['mean']:.1f} px  median={base_res['median']:.1f} px  max={base_res['max']:.1f} px")
    print()

    # Linear per axis
    ax, bx, ay, by = fit_linear_per_axis(rows)
    print(f"Linear fit per axis:")
    print(f"  dx_pred = {ax:.3f} * emit_dx + {bx:.2f}")
    print(f"  dy_pred = {ay:.3f} * emit_dy + {by:.2f}")
    def linear(dx, dy):
        return ax * dx + bx, ay * dy + by
    lin_res = eval_model(rows, linear)
    print(f"  mean={lin_res['mean']:.1f} px  median={lin_res['median']:.1f} px  max={lin_res['max']:.1f} px")
    print(f"  lift over baseline: {(base_res['mean'] - lin_res['mean']) / base_res['mean'] * 100:+.0f}%")
    print()

    # Power law per axis
    ax_p, bx_p, ay_p, by_p = fit_powerlaw_per_axis(rows)
    print(f"Power-law fit per axis (|dx|_pred = a*|emit|^b * sign(emit)):")
    print(f"  X:  a={ax_p:.3f}  b={bx_p:.3f}")
    print(f"  Y:  a={ay_p:.3f}  b={by_p:.3f}")
    def powerlaw(dx, dy):
        sx = 1 if dx >= 0 else -1
        sy = 1 if dy >= 0 else -1
        px = ax_p * (abs(dx) ** bx_p) * sx if dx != 0 else 0
        py = ay_p * (abs(dy) ** by_p) * sy if dy != 0 else 0
        return px, py
    pow_res = eval_model(rows, powerlaw)
    print(f"  mean={pow_res['mean']:.1f} px  median={pow_res['median']:.1f} px  max={pow_res['max']:.1f} px")
    print(f"  lift over baseline: {(base_res['mean'] - pow_res['mean']) / base_res['mean'] * 100:+.0f}%")
    print()

    # Per-sample inspection: where is residual biggest?
    print("Per-sample errors (constant-1.3 baseline):")
    errs_with_idx = []
    for r in rows:
        pd, pd_y = baseline(r["emit_dx"], r["emit_dy"])
        err = math.hypot(pd - r["cons_dx"], pd_y - r["cons_dy"])
        errs_with_idx.append((err, r))
    errs_with_idx.sort(key=lambda x: -x[0])
    for err, r in errs_with_idx[:5]:
        print(
            f"  idx={r['pilot_idx']:2d}  emit=({r['emit_dx']:+4d},{r['emit_dy']:+4d})  "
            f"cons=({r['cons_dx']:+.0f},{r['cons_dy']:+.0f})  err={err:.0f}px  "
            f"pre_agree={r['pre_agree']} post_agree={r['post_agree']}"
        )

    # Save fit
    fit = {
        "n": len(rows),
        "baseline_const_ratio_1.3_mean_err_px": base_res["mean"],
        "linear_fit": {
            "ax": ax, "bx": bx, "ay": ay, "by": by,
            "mean_err_px": lin_res["mean"],
            "median_err_px": lin_res["median"],
        },
        "powerlaw_fit": {
            "ax": ax_p, "bx": bx_p, "ay": ay_p, "by": by_p,
            "mean_err_px": pow_res["mean"],
            "median_err_px": pow_res["median"],
        },
    }
    (ROOT / "data" / "pilot-fit-result.json").write_text(json.dumps(fit, indent=2))


if __name__ == "__main__":
    main()
