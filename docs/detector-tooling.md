# Detector tooling — reproducible pipeline & analysis tools

Index of the tools built for the cursor-detector work (the CASCADE: full-frame
proposer + 96px crop-verifier). Everything here is committed; the models (`ml/*.onnx`,
`ml/*.pt`) and datasets (`data/synth-crops`, `data/synth-v14`, `data/bg-real`) are
**gitignored but fully regenerable** from these scripts — that's the reproducibility
contract (don't commit big binaries, commit the code that makes them).

Runtimes: **Python tools use `.venv/bin/python`** (has numpy+torch, MPS). **TS tools
use `npx tsx`**. Live tools need `PIKVM_PROXY=http://127.0.0.1:8888` + the iPad
environment (tinyproxy, iPadCollector).

## The pipeline (regenerate everything from scratch)

1. **Extract the cursor sprite** (once; needs the iPad):
   `npx tsx scratch/extract-cursor-sprite.ts` → `ml/cursor-sprite.png`
   (2-background alpha matting; the getCursor label point = sprite centre.)
2. **Capture real cursor-free backgrounds** (needs the iPad):
   `npx tsx scratch/capture-bg-real.ts` → `data/bg-real/*.jpg`
   (launches ~15 apps without moving the mouse so the cursor stays faded.)
3. **Generate training data** (procedural + real backgrounds; offline):
   - Proposer: `.venv/bin/python ml/composite-cursor.py 4000` → `data/synth-v14/`
   - Verifier: `.venv/bin/python ml/composite-crops.py 15000` → `data/synth-crops/`
     (96px crops. Positives = cursor over diverse bg; negatives = icons/buttons/
     nav-arrows/map-terrain/smooth/noise WITHOUT the arrow — see the file header for
     the failure-driven negative classes.)
4. **Train**:
   - Proposer (cursor-v14): `.venv/bin/python ml/train-cursor-v14.py` (V14_EPOCHS env)
   - **Crop detector (CURRENT — dual-head presence+heatmap):**
     `HEATMAP_EPOCHS=20 .venv/bin/python ml/train-crop-heatmap.py` → `crop-heatmap.pt`.
     Presence head = offset-invariant accept/reject; heatmap head = sub-pixel tip. This
     is what the cascade uses. (Legacy binary verifier `ml/train-crop-verifier.py` →
     `crop-verifier.pt` is offset-sensitive; superseded — kept for reference.)
5. **Export ONNX**:
   - `.venv/bin/python ml/export-v14-onnx.py [in.pt] [out.onnx]`
   - `.venv/bin/python ml/export-crop-heatmap-onnx.py [in.pt] [out.onnx]` (dual-head)
   - `.venv/bin/python ml/export-verifier-onnx.py [in.pt] [out.onnx]` (legacy binary)

## Analysis / eval tools (offline unless noted)

- `scratch/cascade-eval.ts [proposer.onnx] [verifier.onnx]` — end-to-end cascade on the
  held-out home frames (proposer top-K → verifier per crop → detect/null). The main
  offline gate.
- `scratch/grid-test.ts [verifier.onnx]` — GRID+batched-verifier over the iPad region on
  no-cursor + cursor frames (the robust candidate source; ~110ms for ~230 crops).
- `scratch/heatmap-gate.ts [crop-heatmap.onnx]` — **production-faithful** gate for the
  CURRENT dual-head detector (sharp/ONNX presence at each real gate point). The trustworthy
  selection signal (the Python trainer gate is PIL and disagreed with production).
- `scratch/offset-falloff-dual.ts` — presence vs crop offset (proves offset-robustness).
- `scratch/verifier-gate.ts [onnx]` — same, for the legacy binary verifier.
- `scratch/v14-holdout-eval.ts [verifier-onnx]` — single-stage proposer hold-out
  (presence + heatmap-peak on the home-FP frames + Books/clean positives).
- `scratch/detection-ab-gt.ts` — **LIVE** detection-accuracy A/B vs getCursor ground
  truth (v13 vs cascade error + gross-miss rate on the failure surface). The sensitive
  proof; needs the iPad.
- `scratch/test-cascade-integration.ts` — runs the PRODUCTION path
  (`findCursorByV8FullFrame` + `PIKVM_ML_CASCADE=1`) on the hold-out frames.
- `scratch/diag-miss-frame.ts <frame> <cx> <cy>` — why did the cascade miss? Prints
  proposer peaks + verifier scores + the score at a given point.
- `scratch/annotate-peak.ts <frame>` — draw labelled markers on a frame to LOOK at what
  the detector fired on (→ `scratch/peak-annotated.jpg`).
- `scratch/healthcheck-shot.ts` — **LIVE** screenshot to `scratch/health.jpg` (run the
  mandatory look-at-the-screen health check).
- `scratch/click-bench80-retry3.ts` — **LIVE** N=80 click bench (maxRetries=3). No-
  regression / integration check for the live loop.

## Production cascade (opt-in)

`src/pikvm/cursor-ml-detect.ts` → `findCursorByV8FullFrame`, gated by env:
- `PIKVM_ML_CASCADE=1` — enable the cascade branch
- `PIKVM_ML_V8_MODEL=ml/cursor-v14-ep05.onnx` — proposer
- `PIKVM_ML_VERIFIER_MODEL=ml/crop-verifier.onnx` — verifier
- `PIKVM_ML_CASCADE_K`, `PIKVM_ML_VERIFY_THRESH` — tuning

Example (live bench with the cascade):
```
PIKVM_PROXY=http://127.0.0.1:8888 PIKVM_ML_CASCADE=1 \
  PIKVM_ML_V8_MODEL=ml/cursor-v14-ep05.onnx \
  PIKVM_ML_VERIFIER_MODEL=ml/crop-verifier.onnx \
  npx tsx scratch/click-bench80-retry3.ts
```

## nix run

The detector tools are exposed as flake apps (flake.nix). Run from anywhere in the
checkout (or set `PIKVM_MCP_REPO`). TS tools use the repo's node_modules; ML tools use
the repo's `.venv` (torch/MPS is not nixified). Live tools default `PIKVM_PROXY` to the
loopback tinyproxy.

- Offline eval:  `nix run .#heatmap-gate` · `nix run .#cascade-eval` · `nix run .#integration-test`
- Live (iPad):   `nix run .#health` · `nix run .#live-bench` · `nix run .#maps-precision` ·
                 `nix run .#explore -- click 951 985`
- ML pipeline:   `nix run .#gen-crops -- 15000` · `nix run .#train-heatmap` · `nix run .#export-heatmap`

`nix eval .#apps.<system> --apply builtins.attrNames` lists them.
