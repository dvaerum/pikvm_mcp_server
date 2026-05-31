"""Export ml/pointer-accel-v1.pt to ONNX for use from onnxruntime-node.

The model is an MLP (8-dim input -> 2-dim output, see
``ml/train-pointer-accel.py``). One ``torch.onnx.export`` is enough; the
script also round-trips through ``onnxruntime`` and asserts the exported
graph matches the PyTorch checkpoint to within 1e-4 across a small batch
of random inputs.

Usage:
  python ml/export-pointer-accel-onnx.py
      [--ckpt ml/pointer-accel-v1.pt] [--out ml/pointer-accel-v1.onnx]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_pointer_accel_shim import (  # type: ignore  # noqa: E402
    FEATURE_DIM,
    OUTPUT_DIM,
    PointerAccelMLP,
)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ckpt", type=Path, default=Path("ml/pointer-accel-v1.pt"))
    p.add_argument("--out", type=Path, default=Path("ml/pointer-accel-v1.onnx"))
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--atol", type=float, default=1e-4)
    args = p.parse_args()

    if not args.ckpt.exists():
        print(f"ERROR: checkpoint not found: {args.ckpt}", file=sys.stderr)
        return 2

    # Build on CPU for export — ONNX export works cleanly there and avoids
    # the MPS-CPU mismatch class of bugs noted in the feedback memory.
    device = torch.device("cpu")
    model = PointerAccelMLP().to(device)
    state = torch.load(args.ckpt, map_location=device)
    model.load_state_dict(state)
    model.eval()

    dummy = torch.zeros(1, FEATURE_DIM, dtype=torch.float32, device=device)
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
    print(f"exported -> {args.out} (opset={args.opset})")

    # Round-trip: compare ONNX vs PyTorch on a fixed random batch.
    rng = np.random.default_rng(2026_05_31)
    X = rng.standard_normal((32, FEATURE_DIM)).astype(np.float32)
    with torch.no_grad():
        Y_pt = model(torch.from_numpy(X)).numpy()

    # onnxruntime is required only at export-time for verification; the
    # TS runtime uses onnxruntime-node.
    import onnxruntime as ort  # local import keeps the trainer-deps light
    sess = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    Y_ort = sess.run(["dxdy"], {"features": X})[0]

    max_abs_diff = float(np.abs(Y_pt - Y_ort).max())
    print(
        f"round-trip max |pt - onnx| = {max_abs_diff:.2e} "
        f"(threshold {args.atol:.0e})"
    )
    if max_abs_diff > args.atol:
        print("ERROR: round-trip mismatch exceeds tolerance", file=sys.stderr)
        return 3
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
