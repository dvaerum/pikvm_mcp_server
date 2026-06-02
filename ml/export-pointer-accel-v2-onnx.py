"""Export a pointer-accel-v2 checkpoint (.pt) to ONNX.

The v2 trainer (`ml/train-pointer-accel-v2.py`) iterated through several
architectures + feature counts in 1.10:

    v2 original   : 32x3, 8 features
    v2-wider      : 64x4, 8 features
    v2-hw500      : 64x4, 8 features  (HISTORY_WINDOW_MS=500)
    v2-lastemit   : 64x4, 10 features (added last_emit_dx, last_emit_dy)

Each .pt is its own architecture. This script accepts the relevant dims
on the CLI so any of them can be exported without editing source.

Usage:
  python ml/export-pointer-accel-v2-onnx.py
      --ckpt ml/pointer-accel-v2-wider.pt
      --out  ml/pointer-accel-v2-wider.onnx
      --hidden-dim 64 --hidden-layers 4 --feature-dim 8
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn


class PointerAccelMLP(nn.Module):
    def __init__(self, feature_dim: int, hidden_dim: int, hidden_layers: int):
        super().__init__()
        layers: list[nn.Module] = [nn.Linear(feature_dim, hidden_dim), nn.ReLU()]
        for _ in range(hidden_layers - 1):
            layers += [nn.Linear(hidden_dim, hidden_dim), nn.ReLU()]
        layers.append(nn.Linear(hidden_dim, 2))
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        return self.net(x)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ckpt", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--feature-dim", type=int, required=True)
    p.add_argument("--hidden-dim", type=int, required=True)
    p.add_argument("--hidden-layers", type=int, required=True)
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--atol", type=float, default=1e-4)
    args = p.parse_args()

    if not args.ckpt.exists():
        print(f"ERROR: checkpoint not found: {args.ckpt}", file=sys.stderr)
        return 2

    device = torch.device("cpu")
    model = PointerAccelMLP(
        feature_dim=args.feature_dim,
        hidden_dim=args.hidden_dim,
        hidden_layers=args.hidden_layers,
    ).to(device)
    state = torch.load(args.ckpt, map_location=device)
    model.load_state_dict(state)
    model.eval()

    dummy = torch.zeros(1, args.feature_dim, dtype=torch.float32, device=device)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        args.out,
        input_names=["features"],
        output_names=["dxdy"],
        dynamic_axes={"features": {0: "batch"}, "dxdy": {0: "batch"}},
        opset_version=args.opset,
    )
    print(
        f"exported -> {args.out} "
        f"(feat={args.feature_dim}, hidden={args.hidden_dim}x{args.hidden_layers}, "
        f"opset={args.opset})"
    )

    rng = np.random.default_rng(2026_06_02)
    X = rng.standard_normal((32, args.feature_dim)).astype(np.float32)
    with torch.no_grad():
        Y_pt = model(torch.from_numpy(X)).numpy()

    import onnxruntime as ort  # local import keeps trainer-deps light
    sess = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    Y_ort = sess.run(["dxdy"], {"features": X})[0]

    max_abs_diff = float(np.abs(Y_pt - Y_ort).max())
    print(f"round-trip max |pt - onnx| = {max_abs_diff:.2e} (threshold {args.atol:.0e})")
    if max_abs_diff > args.atol:
        print("ERROR: round-trip mismatch exceeds tolerance", file=sys.stderr)
        return 3
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
