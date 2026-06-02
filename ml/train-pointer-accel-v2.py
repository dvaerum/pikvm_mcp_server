"""
Train pointer-accel-v2 — MLP that predicts cursor displacement (logical
px) from recent HID emit history.

v2 vs v1: same architecture, same features, just trained on multiple
trajectory collections concatenated. Specifically: 1.3's
`cursor-trajectory-2026-05-31T02-43-11/` (linearity + burst + direction)
PLUS the 2026-06-01 collection (1.9) that adds chunkedBurst +
randomWalk coverage. The v1 model failed live (1.6) because it had
zero training data in the chunkedBurst regime that move-to actually
uses — see docs/troubleshooting/2026-05-31-pointer-accel-1.6-fails.md.

Per-family val MAE is reported so we can verify the new families
(`chunkedBurst:*`, `randomWalk:*`) clear the 3 px-per-axis target —
that's the actual pass criterion for v2.

CLI:
  python train-pointer-accel-v2.py <traj_dir> [<traj_dir>...]
                                  [--epochs 200]
                                  [--output ml/pointer-accel-v2.pt]
"""
import argparse
import json
import math
import sys
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset

# --- Module-level constants (easy to tune) -----------------------------------

HORIZON_MS = 50.0          # predict cursor displacement over the next N ms
# 2026-06-02: tried 500 ms (long chunkedBurst chains) — made things worse.
# Plain cumulative-sum over 500 ms adds inter-chain noise without
# temporal structure. Reverted to 100 ms (same as v1). Lesson recorded:
# if richer history is needed, change the feature SHAPE (e.g. per-bucket
# emit sums, time-since-last-burst), not just the window length.
HISTORY_WINDOW_MS = 100.0  # cumulative emit window for context features
VAL_FRACTION = 0.2
SEED = 1337
BATCH_SIZE = 128
LR = 1e-3
EPOCHS_DEFAULT = 100
# 2026-06-02: widened from 32×3 (~2.5k params) → 64×4 (~13k params) after
# the first v2 attempt fit val_mse=828 best at epoch 50 then overfit.
# Hypothesis: insufficient capacity for the 3.5× larger + more diverse
# 5-family training distribution. If this still plateaus high, try
# per-family loss weighting (option c) before adding more capacity.
HIDDEN_DIM = 64
HIDDEN_LAYERS = 4
FEATURE_DIM = 10  # 2026-06-02: was 8; added last_emit_dx, last_emit_dy
OUTPUT_DIM = 2

DEVICE = (
    torch.device("cuda") if torch.cuda.is_available()
    else torch.device("mps") if torch.backends.mps.is_available()
    else torch.device("cpu")
)


# --- I/O ---------------------------------------------------------------------

def load_trajectory(traj_dir: Path) -> Tuple[List[dict], List[dict], dict]:
    """Load the three trajectory artifacts. Returns ([], [], {}) if missing."""
    emits_path = traj_dir / "emits.jsonl"
    cursor_path = traj_dir / "cursor.jsonl"
    manifest_path = traj_dir / "manifest.json"

    if not emits_path.exists() or not cursor_path.exists():
        return [], [], {}

    emits: List[dict] = []
    with open(emits_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            emits.append(json.loads(line))

    cursor: List[dict] = []
    with open(cursor_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            cursor.append(json.loads(line))

    manifest: dict = {}
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)

    # Sort defensively; collectors are usually ordered but don't assume.
    emits.sort(key=lambda r: r["t"])
    cursor.sort(key=lambda r: r["t"])
    return emits, cursor, manifest


# --- Cursor interpolation ----------------------------------------------------

def interp_cursor(cursor: List[dict], t: float) -> Optional[Tuple[float, float]]:
    """Linear-in-time interpolation of the logical cursor at wall-clock t (ms).

    Returns None if t is outside the observed cursor range.
    """
    if not cursor:
        return None
    if t < cursor[0]["t"] or t > cursor[-1]["t"]:
        return None

    # Binary search for the bracketing pair.
    lo, hi = 0, len(cursor) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cursor[mid]["t"] <= t:
            lo = mid
        else:
            hi = mid
    a, b = cursor[lo], cursor[hi]
    span = b["t"] - a["t"]
    if span <= 0:
        return float(a["x_logical"]), float(a["y_logical"])
    u = (t - a["t"]) / span
    x = a["x_logical"] + u * (b["x_logical"] - a["x_logical"])
    y = a["y_logical"] + u * (b["y_logical"] - a["y_logical"])
    return float(x), float(y)


def instantaneous_velocity(
    cursor: List[dict], t: float
) -> Tuple[float, float]:
    """Estimate cursor velocity (logical px / ms) at time t from the previous
    two cursor events strictly before t. Returns (0.0, 0.0) if unavailable."""
    if len(cursor) < 2:
        return 0.0, 0.0
    # Find the latest cursor event with c["t"] <= t.
    lo, hi = 0, len(cursor) - 1
    if cursor[0]["t"] > t:
        return 0.0, 0.0
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cursor[mid]["t"] <= t:
            lo = mid
        else:
            hi = mid
    # Walk back one step so we have two strictly-prior events.
    idx_b = lo if cursor[lo]["t"] <= t else lo - 1
    idx_a = idx_b - 1
    if idx_a < 0 or idx_b < 0:
        return 0.0, 0.0
    a, b = cursor[idx_a], cursor[idx_b]
    dt = b["t"] - a["t"]
    if dt <= 0:
        return 0.0, 0.0
    vx = (b["x_logical"] - a["x_logical"]) / dt
    vy = (b["y_logical"] - a["y_logical"]) / dt
    return float(vx), float(vy)


# --- Feature / label construction --------------------------------------------

def build_examples(
    emits: List[dict], cursor: List[dict]
) -> Tuple[np.ndarray, np.ndarray, int]:
    """Build (X, Y, skipped) for all emits with a valid cursor window."""
    X: List[List[float]] = []
    Y: List[List[float]] = []
    skipped = 0

    # Pre-extract emit timestamps for the rolling-window search.
    emit_ts = [e["t"] for e in emits]

    for i, e in enumerate(emits):
        t_emit = float(e["t"])
        raw_dx = float(e["dx"])
        raw_dy = float(e["dy"])

        # --- target: cursor displacement over the next HORIZON_MS ms ---
        p0 = interp_cursor(cursor, t_emit)
        p1 = interp_cursor(cursor, t_emit + HORIZON_MS)
        if p0 is None or p1 is None:
            skipped += 1
            continue
        target_dx = p1[0] - p0[0]
        target_dy = p1[1] - p0[1]

        # --- cumulative emit sum in last HISTORY_WINDOW_MS ms ---
        sum_dx = 0.0
        sum_dy = 0.0
        count = 0
        j = i - 1
        while j >= 0 and (t_emit - emit_ts[j]) <= HISTORY_WINDOW_MS:
            sum_dx += float(emits[j]["dx"])
            sum_dy += float(emits[j]["dy"])
            count += 1
            j -= 1

        # --- time since previous emit + the previous emit itself ---
        # 2026-06-02: added last_emit_dx/dy as explicit features. Cumulative
        # sum + cursor velocity capture *some* chain context, but mid-chain
        # the model previously had no explicit "what was the last emit"
        # signal. The last emit's dx/dy plus dt_prev gives the model exact
        # information about whether we're mid-chain and the immediate
        # predecessor's direction/magnitude.
        if i > 0:
            dt_prev = t_emit - emit_ts[i - 1]
            last_dx = float(emits[i - 1]["dx"])
            last_dy = float(emits[i - 1]["dy"])
        else:
            dt_prev = 0.0
            last_dx = 0.0
            last_dy = 0.0

        # --- cursor velocity at t_emit (logical px / ms) ---
        vx, vy = instantaneous_velocity(cursor, t_emit)

        X.append([
            raw_dx, raw_dy,
            sum_dx, sum_dy, float(count),
            float(dt_prev),
            vx, vy,
            last_dx, last_dy,
        ])
        Y.append([target_dx, target_dy])

    if not X:
        return (
            np.zeros((0, FEATURE_DIM), dtype=np.float32),
            np.zeros((0, OUTPUT_DIM), dtype=np.float32),
            skipped,
        )
    return (
        np.asarray(X, dtype=np.float32),
        np.asarray(Y, dtype=np.float32),
        skipped,
    )


# --- Dataset / model ---------------------------------------------------------

class TrajectoryDataset(Dataset):
    def __init__(self, X: np.ndarray, Y: np.ndarray) -> None:
        self.X = X
        self.Y = Y

    def __len__(self) -> int:
        return len(self.X)

    def __getitem__(self, idx: int):
        return self.X[idx], self.Y[idx]


class PointerAccelMLP(nn.Module):
    def __init__(
        self,
        in_dim: int = FEATURE_DIM,
        hidden: int = HIDDEN_DIM,
        out_dim: int = OUTPUT_DIM,
        hidden_layers: int = HIDDEN_LAYERS,
    ) -> None:
        super().__init__()
        layers: List[nn.Module] = []
        layers.append(nn.Linear(in_dim, hidden))
        layers.append(nn.ReLU())
        for _ in range(hidden_layers - 1):
            layers.append(nn.Linear(hidden, hidden))
            layers.append(nn.ReLU())
        layers.append(nn.Linear(hidden, out_dim))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# --- Training loop -----------------------------------------------------------

def train(
    X: np.ndarray, Y: np.ndarray, epochs: int, output_path: Path
) -> Tuple[float, float]:
    """Train the MLP. Returns (val_mae_x, val_mae_y) in logical pixels."""
    rng = np.random.default_rng(SEED)
    idx = np.arange(len(X))
    rng.shuffle(idx)
    val_n = max(1, int(len(idx) * VAL_FRACTION))
    val_idx = idx[:val_n]
    train_idx = idx[val_n:]

    train_ds = TrajectoryDataset(X[train_idx], Y[train_idx])
    val_ds = TrajectoryDataset(X[val_idx], Y[val_idx])
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE)

    model = PointerAccelMLP().to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.MSELoss()

    best_val = math.inf
    best_mae_x = math.inf
    best_mae_y = math.inf

    for epoch in range(epochs):
        model.train()
        tr_loss = 0.0
        tr_n = 0
        for xb, yb in train_loader:
            xb = xb.to(DEVICE)
            yb = yb.to(DEVICE)
            pred = model(xb)
            loss = loss_fn(pred, yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tr_loss += loss.item() * xb.size(0)
            tr_n += xb.size(0)
        tr_loss /= max(1, tr_n)

        model.eval()
        val_loss = 0.0
        abs_err_x = 0.0
        abs_err_y = 0.0
        vn = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                xb = xb.to(DEVICE)
                yb = yb.to(DEVICE)
                pred = model(xb)
                val_loss += loss_fn(pred, yb).item() * xb.size(0)
                err = (pred - yb).abs()
                abs_err_x += err[:, 0].sum().item()
                abs_err_y += err[:, 1].sum().item()
                vn += xb.size(0)
        val_loss /= max(1, vn)
        mae_x = abs_err_x / max(1, vn)
        mae_y = abs_err_y / max(1, vn)

        if val_loss < best_val:
            best_val = val_loss
            best_mae_x = mae_x
            best_mae_y = mae_y
            output_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), output_path)

        if epoch % 10 == 0 or epoch == epochs - 1:
            print(
                f"epoch {epoch:3d} train_mse={tr_loss:.4f} "
                f"val_mse={val_loss:.4f} val_mae_x={mae_x:.2f}px "
                f"val_mae_y={mae_y:.2f}px"
            )

    # --- Optional ONNX export (disabled by default) ---
    # dummy = torch.zeros(1, FEATURE_DIM, device=DEVICE)
    # onnx_path = output_path.with_suffix(".onnx")
    # torch.onnx.export(
    #     model, dummy, onnx_path,
    #     input_names=["features"], output_names=["dxdy"],
    #     dynamic_axes={"features": {0: "batch"}, "dxdy": {0: "batch"}},
    #     opset_version=17,
    # )
    # print(f"exported ONNX -> {onnx_path}")

    return best_mae_x, best_mae_y


# --- CLI ---------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "trajectory_dirs",
        type=Path,
        nargs="+",
        help="One or more data/cursor-trajectory-{TS}/ directories. Each "
        "directory is loaded independently (timestamps are scope-local) and "
        "the resulting (X, Y) example arrays are concatenated for training.",
    )
    p.add_argument("--epochs", type=int, default=EPOCHS_DEFAULT)
    p.add_argument(
        "--output",
        type=Path,
        default=Path("ml/pointer-accel-v2.pt"),
        help="Output checkpoint path (default: ml/pointer-accel-v2.pt)",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    print(f"device: {DEVICE}")

    Xs: List[np.ndarray] = []
    Ys: List[np.ndarray] = []
    # Parallel array of family labels per (X, Y) row, for per-family eval.
    # The label is the prefix before the first colon in the emit's
    # sequenceLabel (e.g. "chunkedBurst:+x:m20:n8:p30" -> "chunkedBurst").
    families: List[str] = []
    total_skipped = 0
    for traj_dir in args.trajectory_dirs:
        if not traj_dir.exists():
            print(f"ERROR: trajectory directory does not exist: {traj_dir}", file=sys.stderr)
            return 2
        emits, cursor, manifest = load_trajectory(traj_dir)
        if not emits or not cursor:
            print(f"WARN: no trajectory data in {traj_dir}; skipping.", file=sys.stderr)
            continue
        print(
            f"[{traj_dir.name}] emits={len(emits)} cursor_events={len(cursor)} "
            f"manifest_keys={sorted(manifest.keys())}"
        )
        # Build examples for this dir, then record family per row in parallel.
        # We need the per-emit family BEFORE build_examples discards skipped
        # rows, so do the family mapping inline via a sorted emit sequence.
        emits_sorted = sorted(emits, key=lambda r: r["t"])
        X_dir, Y_dir, skipped = build_examples(emits, cursor)
        # build_examples internally re-sorts emits and skips rows with no
        # cursor window. To attach the right family to each kept row, walk
        # the same loop a second time mirroring its skip logic.
        emit_ts = [e["t"] for e in emits_sorted]
        cursor_sorted = sorted(cursor, key=lambda r: r["t"])
        kept_count = 0
        for i, e in enumerate(emits_sorted):
            t_emit = float(e["t"])
            p0 = interp_cursor(cursor_sorted, t_emit)
            p1 = interp_cursor(cursor_sorted, t_emit + HORIZON_MS)
            if p0 is None or p1 is None:
                continue
            seqlabel = str(e.get("sequenceLabel", ""))
            family = seqlabel.split(":", 1)[0] if seqlabel else "(unknown)"
            families.append(family)
            kept_count += 1
        assert kept_count == X_dir.shape[0], (
            f"family-tag mirror loop kept {kept_count}, build_examples kept "
            f"{X_dir.shape[0]} — internal bug"
        )
        Xs.append(X_dir)
        Ys.append(Y_dir)
        total_skipped += skipped
        print(
            f"[{traj_dir.name}] usable examples: {X_dir.shape[0]} "
            f"(skipped {skipped} emits with no +{HORIZON_MS:.0f}ms window)"
        )

    if not Xs:
        print("ERROR: no usable trajectory data across any input dir.", file=sys.stderr)
        return 2

    X = np.concatenate(Xs, axis=0)
    Y = np.concatenate(Ys, axis=0)
    print()
    print(f"combined: examples={len(X)} skipped_total={total_skipped}")
    family_counts: dict = {}
    for f in families:
        family_counts[f] = family_counts.get(f, 0) + 1
    print(f"per-family counts: {dict(sorted(family_counts.items()))}")

    if len(X) < 10:
        print(
            "ERROR: fewer than 10 usable examples; collect more trajectory "
            "data before training.",
            file=sys.stderr,
        )
        return 2

    mae_x, mae_y = train(X, Y, args.epochs, args.output)
    print()
    print(f"best checkpoint -> {args.output}")
    print(f"val MAE x: {mae_x:.2f} logical px")
    print(f"val MAE y: {mae_y:.2f} logical px")

    # Per-family MAE on the same val split as train() used (SEED=1337, 80/20).
    # The val rows are the last VAL_FRACTION of the deterministically-shuffled
    # combined array — replicate that here so the per-family numbers match.
    print()
    print("--- per-family MAE on val split ---")
    rng = np.random.RandomState(SEED)
    perm = rng.permutation(len(X))
    val_size = max(1, int(len(X) * VAL_FRACTION))
    val_idx = perm[-val_size:]
    val_families = [families[i] for i in val_idx]
    val_X = X[val_idx]
    val_Y = Y[val_idx]

    model = PointerAccelMLP()
    model.load_state_dict(torch.load(args.output, map_location="cpu", weights_only=True))
    model.eval()
    with torch.no_grad():
        preds = model(torch.from_numpy(val_X)).numpy()
    abs_err = np.abs(preds - val_Y)
    by_family: dict = {}
    for i, f in enumerate(val_families):
        by_family.setdefault(f, []).append((abs_err[i, 0], abs_err[i, 1]))
    print(f"{'family':<16} {'n':>5} {'mae_x':>7} {'mae_y':>7} {'p95_x':>7} {'p95_y':>7}")
    for f in sorted(by_family.keys()):
        rows = by_family[f]
        n = len(rows)
        ex = np.array([r[0] for r in rows])
        ey = np.array([r[1] for r in rows])
        print(
            f"{f:<16} {n:>5d} "
            f"{float(np.mean(ex)):>7.2f} {float(np.mean(ey)):>7.2f} "
            f"{float(np.percentile(ex, 95)):>7.2f} {float(np.percentile(ey, 95)):>7.2f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
