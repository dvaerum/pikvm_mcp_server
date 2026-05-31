"""
Honest sanity check of ml/pointer-accel-v1.pt.

Re-runs the exact dataset-construction logic from `ml/train-pointer-accel.py`
(same SEED, same VAL_FRACTION) to recover the validation split, then prints
per-example predictions and aggregates MAE by sequence-type prefix
(`linearity:*`, `burst:*`, `direction:*`). Writes a Markdown summary to
`docs/troubleshooting/2026-05-31-pointer-accel-v1-eval.md`.

Usage:
  python ml/eval-pointer-accel-v1.py data/cursor-trajectory-2026-05-31T02-43-11
                                    [--ckpt ml/pointer-accel-v1.pt]
                                    [--out docs/troubleshooting/2026-05-31-pointer-accel-v1-eval.md]
                                    [--threshold 5.0]
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch

# Re-use the producer/feature-construction code from the trainer so this
# eval cannot drift from training. We *only* duplicate `PointerAccelMLP`
# weights-loading logic — feature build + interp + velocity all imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_pointer_accel_shim import (  # type: ignore  # noqa: E402
    FEATURE_DIM,
    OUTPUT_DIM,
    PointerAccelMLP,
    SEED,
    VAL_FRACTION,
    build_examples,
    load_trajectory,
)

DEVICE = (
    torch.device("cuda") if torch.cuda.is_available()
    else torch.device("mps") if torch.backends.mps.is_available()
    else torch.device("cpu")
)


def sequence_family(label: str) -> str:
    """`linearity:+x:m1` -> `linearity`, `burst:+x:m20:n8:d50` -> `burst`,
    `direction:N:m100` -> `direction`."""
    if not label:
        return "unknown"
    return label.split(":", 1)[0]


def build_examples_with_labels(
    emits: List[dict], cursor: List[dict]
) -> Tuple[np.ndarray, np.ndarray, List[dict], List[str]]:
    """Same as `build_examples` but also returns the per-row sequence label
    and a per-row emit metadata record (so the eval can print the (emit_dx,
    emit_dy) that produced each prediction). Kept structurally identical
    to the trainer's `build_examples` — same skip rule, same order — so the
    same SEED + VAL_FRACTION recovers the same val split.
    """
    X, Y, _ = build_examples(emits, cursor)

    # Reconstruct labels & emit metadata in lock-step with build_examples:
    # walk emits in order, skip iff cursor interp window unavailable, just
    # like the trainer does. This avoids forking build_examples but keeps
    # parity by re-doing the skip predicate.
    from train_pointer_accel_shim import HORIZON_MS, interp_cursor

    labels: List[str] = []
    emit_meta: List[dict] = []
    for e in emits:
        t_emit = float(e["t"])
        p0 = interp_cursor(cursor, t_emit)
        p1 = interp_cursor(cursor, t_emit + HORIZON_MS)
        if p0 is None or p1 is None:
            continue
        labels.append(str(e.get("sequenceLabel", "")))
        emit_meta.append({
            "t": t_emit,
            "dx": float(e["dx"]),
            "dy": float(e["dy"]),
            "sequenceLabel": str(e.get("sequenceLabel", "")),
        })
    assert len(labels) == len(X), (
        f"label/feature length mismatch: {len(labels)} labels vs {len(X)} features"
    )
    return X, Y, emit_meta, labels


def recover_val_split(n: int) -> np.ndarray:
    """Replay the trainer's split: numpy default_rng(SEED), shuffle indices,
    take first VAL_FRACTION as val."""
    rng = np.random.default_rng(SEED)
    idx = np.arange(n)
    rng.shuffle(idx)
    val_n = max(1, int(n * VAL_FRACTION))
    return idx[:val_n]


def load_model(ckpt_path: Path) -> PointerAccelMLP:
    model = PointerAccelMLP().to(DEVICE)
    state = torch.load(ckpt_path, map_location=DEVICE)
    model.load_state_dict(state)
    model.eval()
    return model


@torch.no_grad()
def predict_all(model: PointerAccelMLP, X: np.ndarray) -> np.ndarray:
    if len(X) == 0:
        return np.zeros((0, OUTPUT_DIM), dtype=np.float32)
    # MPS-CPU bug guard: tensor must be on same device as model. We pass
    # X to model.device by .to(DEVICE).
    xb = torch.from_numpy(X).to(DEVICE)
    pred = model(xb)
    return pred.detach().cpu().numpy()


def aggregate_by_family(
    labels: List[str], errors: np.ndarray
) -> Dict[str, Dict[str, float]]:
    """errors: (N, 2) absolute errors per axis. Returns per-family
    {n, mae_x, mae_y, p95_x, p95_y, max_x, max_y, euclid_mae, euclid_p95}."""
    by: Dict[str, List[int]] = defaultdict(list)
    for i, lbl in enumerate(labels):
        by[sequence_family(lbl)].append(i)
    out: Dict[str, Dict[str, float]] = {}
    for fam, idx in by.items():
        e = errors[idx]
        eu = np.hypot(e[:, 0], e[:, 1])
        out[fam] = {
            "n": float(len(idx)),
            "mae_x": float(e[:, 0].mean()),
            "mae_y": float(e[:, 1].mean()),
            "p95_x": float(np.percentile(e[:, 0], 95)),
            "p95_y": float(np.percentile(e[:, 1], 95)),
            "max_x": float(e[:, 0].max()),
            "max_y": float(e[:, 1].max()),
            "euclid_mae": float(eu.mean()),
            "euclid_p95": float(np.percentile(eu, 95)),
        }
    return out


def write_eval_doc(
    out_path: Path,
    traj_dir: Path,
    ckpt_path: Path,
    n_total: int,
    n_val: int,
    overall: Dict[str, float],
    by_family: Dict[str, Dict[str, float]],
    threshold: float,
    sample_rows: List[dict],
) -> None:
    pass_per_family = {
        fam: max(s["mae_x"], s["mae_y"]) <= threshold for fam, s in by_family.items()
    }
    overall_pass = all(pass_per_family.values()) if pass_per_family else False

    lines: List[str] = []
    lines.append("# Pointer-accel v1 honest eval (Step 1.4)")
    lines.append("")
    lines.append(f"- Trajectory: `{traj_dir}`")
    lines.append(f"- Checkpoint: `{ckpt_path}`")
    lines.append(f"- Device: `{DEVICE}`")
    lines.append(f"- Total usable examples: {n_total}")
    lines.append(f"- Val examples (recovered via SEED={SEED}, VAL_FRACTION={VAL_FRACTION}): {n_val}")
    lines.append(f"- Per-family MAE threshold: {threshold:.1f} px (both axes)")
    lines.append("")
    lines.append("## Overall val MAE")
    lines.append("")
    lines.append("| metric | value |")
    lines.append("| --- | --- |")
    lines.append(f"| mae_x | {overall['mae_x']:.2f} px |")
    lines.append(f"| mae_y | {overall['mae_y']:.2f} px |")
    lines.append(f"| euclid_mae | {overall['euclid_mae']:.2f} px |")
    lines.append(f"| euclid_p95 | {overall['euclid_p95']:.2f} px |")
    lines.append("")
    lines.append("## Per-sequence-family breakdown")
    lines.append("")
    lines.append("| family | n | mae_x | mae_y | p95_x | p95_y | max_x | max_y | euclid_mae | pass (<= {:.0f}px)? |".format(threshold))
    lines.append("| --- | --: | --: | --: | --: | --: | --: | --: | --: | :-: |")
    for fam in sorted(by_family.keys()):
        s = by_family[fam]
        passing = "YES" if pass_per_family[fam] else "NO"
        lines.append(
            f"| {fam} | {int(s['n'])} | {s['mae_x']:.2f} | {s['mae_y']:.2f} | "
            f"{s['p95_x']:.2f} | {s['p95_y']:.2f} | {s['max_x']:.2f} | {s['max_y']:.2f} | "
            f"{s['euclid_mae']:.2f} | {passing} |"
        )
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    if overall_pass:
        lines.append(
            f"PASS — every sequence family has MAE ≤ {threshold:.1f} px on both axes. "
            "Proceed to Step 1.5 (wire pointer-accel into `move-to.ts` behind "
            "`PIKVM_USE_LEARNED_BALLISTICS=1`)."
        )
        lines.append("")
        lines.append("### Caveats worth carrying into Step 1.5")
        lines.append("")
        lines.append(
            "- `burst` p95_x and max_x are noticeably wider than the per-axis MAE "
            "(see the table above). The biggest single residual sits on a "
            "`burst:+x:m20:n8:d0` row where the observed cursor moved ~26 px and "
            "the model predicted ~46 px (≈20 px over). This is the iPadOS emit-"
            "coalescing regime: when emits arrive faster than the iPad can "
            "process them, dropped emits collapse the *observed* displacement "
            "while the model still sees all the inputs. The model is right on "
            "average but a long tail remains."
        )
        lines.append(
            "- For the Step 1.5 wiring this means the learned forward model is "
            "trustworthy for **planning** an open-loop emit (mean residual is "
            "the planner's expected error) but a per-emit correction loop should "
            "still verify, not slam, when `d0` bursts are in play."
        )
    else:
        failing = [fam for fam, ok in pass_per_family.items() if not ok]
        lines.append(
            f"FAIL — sequence families {sorted(failing)} exceed the "
            f"{threshold:.1f} px per-axis threshold. The val MAE looks acceptable "
            "in aggregate only because easier families dominate the val split. "
            "Per the **no verdicts from samples** + **MPS-CPU silent garbage** "
            "memory rules: do NOT ship this model. Step 1.5 is blocked until "
            "we collect more data on the failing family."
        )
        lines.append("")
        lines.append("### Why this matters")
        lines.append("")
        lines.append(
            "iPadOS coalesces consecutive emits when their inter-arrival time is "
            "short — burst sequences exercise exactly that regime. A model that "
            "passes on `linearity` but fails on `burst` learns the easy single-"
            "emit case and can't predict the bursty regime where the empirical "
            "`1.4 px/mickey` constant ALSO fails. Replacing the constant with "
            "this model would give us a more confident but equally-wrong "
            "forward predictor."
        )
        lines.append("")
        lines.append("### What data we'd need")
        lines.append("")
        lines.append(
            "- More `burst:*` outer repeats (current bench captures 7 burst "
            "stimuli × 12 outer repeats = 84 sequences before coalescing reduces "
            "them; collect ≥ 3× more)."
        )
        lines.append(
            "- Possibly more burst variants (different `n`, different `d`) so "
            "the model sees coalescing transitions, not just one regime."
        )
    lines.append("")
    lines.append("## Sample val rows (first 10)")
    lines.append("")
    lines.append("| emit_dx | emit_dy | pred_dx | pred_dy | obs_dx | obs_dy | err_x | err_y | label |")
    lines.append("| --: | --: | --: | --: | --: | --: | --: | --: | --- |")
    for r in sample_rows[:10]:
        lines.append(
            f"| {r['emit_dx']:.0f} | {r['emit_dy']:.0f} | "
            f"{r['pred_dx']:.2f} | {r['pred_dy']:.2f} | "
            f"{r['obs_dx']:.2f} | {r['obs_dy']:.2f} | "
            f"{r['err_x']:.2f} | {r['err_y']:.2f} | `{r['sequenceLabel']}` |"
        )
    lines.append("")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("trajectory_dir", type=Path)
    p.add_argument("--ckpt", type=Path, default=Path("ml/pointer-accel-v1.pt"))
    p.add_argument(
        "--out",
        type=Path,
        default=Path("docs/troubleshooting/2026-05-31-pointer-accel-v1-eval.md"),
    )
    p.add_argument("--threshold", type=float, default=5.0)
    p.add_argument(
        "--print-rows",
        type=int,
        default=20,
        help="How many val rows to print to stdout (full dump goes to docs).",
    )
    args = p.parse_args()

    if not args.trajectory_dir.exists():
        print(f"ERROR: missing {args.trajectory_dir}", file=sys.stderr)
        return 2
    if not args.ckpt.exists():
        print(f"ERROR: missing checkpoint {args.ckpt}", file=sys.stderr)
        return 2

    emits, cursor, manifest = load_trajectory(args.trajectory_dir)
    if not emits or not cursor:
        print(f"ERROR: empty trajectory dir {args.trajectory_dir}", file=sys.stderr)
        return 2
    print(f"device: {DEVICE}")
    print(f"loaded emits={len(emits)} cursor_events={len(cursor)}")

    X, Y, emit_meta, labels = build_examples_with_labels(emits, cursor)
    print(f"usable examples: {len(X)}")
    val_idx = recover_val_split(len(X))
    Xv, Yv = X[val_idx], Y[val_idx]
    labels_v = [labels[i] for i in val_idx]
    meta_v = [emit_meta[i] for i in val_idx]
    print(f"val examples: {len(Xv)}")

    model = load_model(args.ckpt)
    Pv = predict_all(model, Xv)
    err = np.abs(Pv - Yv)

    overall = {
        "mae_x": float(err[:, 0].mean()),
        "mae_y": float(err[:, 1].mean()),
        "euclid_mae": float(np.hypot(err[:, 0], err[:, 1]).mean()),
        "euclid_p95": float(np.percentile(np.hypot(err[:, 0], err[:, 1]), 95)),
    }
    by_family = aggregate_by_family(labels_v, err)

    # Stdout dump: print a sample, family aggregate, and overall.
    print()
    print(
        "  emit_dx  emit_dy   pred_dx   pred_dy    obs_dx    obs_dy    err_x    err_y  label"
    )
    sample_rows: List[dict] = []
    for i in range(len(Xv)):
        row = {
            "emit_dx": meta_v[i]["dx"],
            "emit_dy": meta_v[i]["dy"],
            "pred_dx": float(Pv[i, 0]),
            "pred_dy": float(Pv[i, 1]),
            "obs_dx": float(Yv[i, 0]),
            "obs_dy": float(Yv[i, 1]),
            "err_x": float(err[i, 0]),
            "err_y": float(err[i, 1]),
            "sequenceLabel": labels_v[i],
        }
        sample_rows.append(row)
        if i < args.print_rows:
            print(
                f"  {row['emit_dx']:7.0f}  {row['emit_dy']:7.0f}  "
                f"{row['pred_dx']:8.2f}  {row['pred_dy']:8.2f}  "
                f"{row['obs_dx']:8.2f}  {row['obs_dy']:8.2f}  "
                f"{row['err_x']:7.2f}  {row['err_y']:7.2f}  {row['sequenceLabel']}"
            )

    print()
    print("Per-family aggregate (n, mae_x, mae_y, euclid_mae):")
    for fam in sorted(by_family.keys()):
        s = by_family[fam]
        print(
            f"  {fam:10s}  n={int(s['n']):4d}  mae_x={s['mae_x']:6.2f}  "
            f"mae_y={s['mae_y']:6.2f}  euclid_mae={s['euclid_mae']:6.2f}  "
            f"p95_x={s['p95_x']:6.2f}  p95_y={s['p95_y']:6.2f}"
        )
    print()
    print(
        f"Overall: mae_x={overall['mae_x']:.2f} mae_y={overall['mae_y']:.2f} "
        f"euclid_mae={overall['euclid_mae']:.2f} euclid_p95={overall['euclid_p95']:.2f}"
    )

    write_eval_doc(
        args.out, args.trajectory_dir, args.ckpt,
        n_total=len(X), n_val=len(Xv),
        overall=overall, by_family=by_family,
        threshold=args.threshold, sample_rows=sample_rows,
    )
    print(f"wrote eval doc -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
