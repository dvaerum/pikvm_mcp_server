"""
Shared substrate for pointer-accel trainers (v2, v3, …).

Extracted 2026-06-18 during the v3 retrain: the /simplify pass on the
v13 chain flagged CursorFullFrameNet being duplicated 6× across
ml/train-cursor-*.py; pointer-accel has the same emerging problem
(v2 has 250 lines that a v3 or v4 would want to copy verbatim).
This module owns the invariants:

  - Data loading (`load_trajectory`)
  - Cursor interpolation / velocity estimation
  - Feature construction (`build_examples_with_families`)
  - The MLP class (with optional dropout for regularization variants)

Anything a specific trainer wants to override (loss weighting, optimizer,
LR schedule, split strategy) stays in the trainer itself.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset

# --- Constants shared across all pointer-accel trainers ---------------

HORIZON_MS = 50.0
HISTORY_WINDOW_MS = 100.0
FEATURE_DIM = 10   # raw_dx, raw_dy, sum_dx, sum_dy, count, dt_prev, vx, vy, last_dx, last_dy
OUTPUT_DIM = 2

DEVICE = (
    torch.device("cuda") if torch.cuda.is_available()
    else torch.device("mps") if torch.backends.mps.is_available()
    else torch.device("cpu")
)


# --- I/O --------------------------------------------------------------

def load_trajectory(traj_dir: Path) -> Tuple[List[dict], List[dict], dict]:
    """Load the three trajectory artifacts. Returns ([], [], {}) if missing."""
    emits_path = traj_dir / "emits.jsonl"
    cursor_path = traj_dir / "cursor.jsonl"
    manifest_path = traj_dir / "manifest.json"
    if not emits_path.exists() or not cursor_path.exists():
        return [], [], {}

    def _read_jsonl(p: Path) -> List[dict]:
        rows: List[dict] = []
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    emits = _read_jsonl(emits_path)
    cursor = _read_jsonl(cursor_path)
    manifest: dict = {}
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
    emits.sort(key=lambda r: r["t"])
    cursor.sort(key=lambda r: r["t"])
    return emits, cursor, manifest


# --- Cursor interpolation --------------------------------------------

def interp_cursor(cursor: List[dict], t: float) -> Optional[Tuple[float, float]]:
    """Linear-in-time interpolation of the logical cursor at wall-clock t (ms)."""
    if not cursor:
        return None
    if t < cursor[0]["t"] or t > cursor[-1]["t"]:
        return None
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


def instantaneous_velocity(cursor: List[dict], t: float) -> Tuple[float, float]:
    """Cursor velocity (logical px / ms) from the previous two cursor events
    strictly before t. Returns (0.0, 0.0) if unavailable."""
    if len(cursor) < 2:
        return 0.0, 0.0
    if cursor[0]["t"] > t:
        return 0.0, 0.0
    lo, hi = 0, len(cursor) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cursor[mid]["t"] <= t:
            lo = mid
        else:
            hi = mid
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


# --- Feature / label construction ------------------------------------

def _family_of(emit: dict) -> str:
    """Family label = prefix before first colon in sequenceLabel."""
    seq = str(emit.get("sequenceLabel", ""))
    return seq.split(":", 1)[0] if seq else "(unknown)"


def build_examples_with_families(
    emits: List[dict], cursor: List[dict]
) -> Tuple[np.ndarray, np.ndarray, List[str], int]:
    """Build (X, Y, families, skipped) for all emits with a valid cursor window.

    `families` is parallel to X/Y — one label per kept example. Prior versions
    of the code reconstructed this by walking the emit list twice; this single-
    pass version guarantees families and X/Y can never desync.
    """
    X: List[List[float]] = []
    Y: List[List[float]] = []
    families: List[str] = []
    skipped = 0
    emit_ts = [e["t"] for e in emits]

    for i, e in enumerate(emits):
        t_emit = float(e["t"])
        p0 = interp_cursor(cursor, t_emit)
        p1 = interp_cursor(cursor, t_emit + HORIZON_MS)
        if p0 is None or p1 is None:
            skipped += 1
            continue

        raw_dx = float(e["dx"])
        raw_dy = float(e["dy"])
        target_dx = p1[0] - p0[0]
        target_dy = p1[1] - p0[1]

        # Cumulative emit sum in last HISTORY_WINDOW_MS ms.
        sum_dx = 0.0
        sum_dy = 0.0
        count = 0
        j = i - 1
        while j >= 0 and (t_emit - emit_ts[j]) <= HISTORY_WINDOW_MS:
            sum_dx += float(emits[j]["dx"])
            sum_dy += float(emits[j]["dy"])
            count += 1
            j -= 1

        # Previous emit + time since it.
        if i > 0:
            dt_prev = t_emit - emit_ts[i - 1]
            last_dx = float(emits[i - 1]["dx"])
            last_dy = float(emits[i - 1]["dy"])
        else:
            dt_prev = 0.0
            last_dx = 0.0
            last_dy = 0.0

        vx, vy = instantaneous_velocity(cursor, t_emit)

        X.append([
            raw_dx, raw_dy,
            sum_dx, sum_dy, float(count),
            float(dt_prev),
            vx, vy,
            last_dx, last_dy,
        ])
        Y.append([target_dx, target_dy])
        families.append(_family_of(e))

    if not X:
        return (
            np.zeros((0, FEATURE_DIM), dtype=np.float32),
            np.zeros((0, OUTPUT_DIM), dtype=np.float32),
            [],
            skipped,
        )
    return (
        np.asarray(X, dtype=np.float32),
        np.asarray(Y, dtype=np.float32),
        families,
        skipped,
    )


# --- Dataset / model -------------------------------------------------

class TrajectoryDataset(Dataset):
    """Holds (X, Y) numpy arrays; optional per-row `weights` for weighted MSE."""

    def __init__(
        self, X: np.ndarray, Y: np.ndarray, weights: Optional[np.ndarray] = None,
    ) -> None:
        self.X = X
        self.Y = Y
        self.W = weights if weights is not None else np.ones(len(X), dtype=np.float32)

    def __len__(self) -> int:
        return len(self.X)

    def __getitem__(self, idx: int):
        return self.X[idx], self.Y[idx], self.W[idx]


class PointerAccelMLP(nn.Module):
    """Fully-connected regression net. Dropout is optional; v2 used 0.0."""

    def __init__(
        self,
        in_dim: int = FEATURE_DIM,
        hidden: int = 64,
        out_dim: int = OUTPUT_DIM,
        hidden_layers: int = 4,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        layers: List[nn.Module] = [nn.Linear(in_dim, hidden), nn.ReLU()]
        if dropout > 0:
            layers.append(nn.Dropout(dropout))
        for _ in range(hidden_layers - 1):
            layers.append(nn.Linear(hidden, hidden))
            layers.append(nn.ReLU())
            if dropout > 0:
                layers.append(nn.Dropout(dropout))
        layers.append(nn.Linear(hidden, out_dim))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# --- Reporting -------------------------------------------------------

def per_family_report(
    model: nn.Module,
    val_X: np.ndarray,
    val_Y: np.ndarray,
    val_families: List[str],
    device: Optional[torch.device] = None,
) -> None:
    """Print the standard per-family MAE table used for pass criteria.

    Runs `model` in eval mode on the provided val split (already on-device
    if `device` is given, otherwise CPU). Table layout matches the v2
    trainer's output so the roadmap comparison stays consistent.
    """
    dev = device or torch.device("cpu")
    model.eval()
    with torch.no_grad():
        preds = model(torch.from_numpy(val_X).to(dev)).cpu().numpy()
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
