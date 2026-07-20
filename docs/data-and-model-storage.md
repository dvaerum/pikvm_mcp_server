# Data & model storage / reproducibility

Goal (user, 2026-07-20): store our data + models so we can (a) **reproduce/retrain from
scratch** and (b) have **models ready-to-go** without rerunning the pipeline. In-repo files,
not GitHub-hosted services.

## The core insight
The two goals only conflict for BIG artifacts. But **the shipped detector is tiny**:
- `ml/crop-heatmap.onnx` = **196 KB** (the only model the cascade loads at runtime — the grid
  cascade skips the full-frame proposer, `cursor-ml-detect.ts runCascade`).
- Its ENTIRE reproducibility seed = `ml/cursor-sprite.png` (8 KB) + `data/bg-real/` (1.3 MB) +
  the eval-gate frames (~few MB) + the committed scripts. **~5 MB total.**

So for the current detector, both goals are satisfied by **committing ~5 MB to git**. The 13 GB
in `data/` is almost entirely LEGACY (for the superseded single-stage v0–v14 models) and/or
re-fetchable, so it should NOT be stored in git — it's reclaimed/regenerated.

## Storage tiers (the policy)
Tier by (regenerability × irreplaceability):

- **T1 SEED — irreplaceable raw ingredients → COMMIT to git (all small):**
  `ml/cursor-sprite.png` (extracted from the iPad via 2-bg matting), `data/bg-real/` (15 real
  app backgrounds captured live), the eval-gate frames (`scratch/hc13/15/17/18.jpg`,
  `clean-cursor.jpg`, `instrumented-bench/MISS-*.jpg`), and the 23 `human-verified*.jsonl` LABELS
  (human labour, irreplaceable — labels only, small). Cannot be regenerated without the iPad /
  human relabelling.
- **T2 READY MODEL — the deployable, tiny → COMMIT to git:** `ml/crop-heatmap.onnx` (196 KB).
  Use without retraining. (Legacy v0–v14 models stay untracked on disk / archived.)
- **T3 DERIVED — regenerable from T1 + scripts → gitignore + document, safe to delete:**
  `data/synth-crops/` (regen: `composite-crops.py`), old synthetic corpora.
- **T4 EXTERNAL / DISPOSABLE → delete to reclaim disk:** `data/scene-backgrounds/` (8.3 GB of
  DOWNLOADED public images — picsum/wallhaven/openverse/wikimedia/nasa — re-fetchable, legacy
  full-frame only), benchmark outputs (`emit-residuals*`, `phase*`, `scratch/click-bench80-*`).

## Layout (committed)
- `ml/cursor-sprite.png`, `ml/crop-heatmap.onnx` — seed sprite + ready model (git-tracked exceptions).
- `data/bg-real/` — seed backgrounds (git-tracked exception).
- `data/seeds/eval-frames/` — the held-out eval-gate frames (relocated from scratch/ so the
  reproducibility seed is stable + tracked; scripts updated to point here). *(planned)*
- Everything else in `ml/*.onnx|*.pt` and `data/*` stays gitignored (regenerable / disposable).

## Reproduce vs use
- **Use (ready-to-go):** the committed `crop-heatmap.onnx` is loaded directly. Done.
- **Reproduce from scratch:** `make -f Makefile.detector data-crops train-heatmap export-heatmap`
  (or the `nix run .#gen-crops / .#train-heatmap / .#export-heatmap` apps) → regenerates
  `data/synth-crops` from the seeds → trains → exports `crop-heatmap.onnx`. A checksum manifest
  records the expected model hash so a reproduce run can be verified against the committed model.

## Decisions needed (destructive / policy — confirm before I do them)
1. **Commit the ~5 MB reproducibility bundle** (T1 seeds + T2 model) to git? [rec: YES — tiny,
   makes the detector fully self-contained + reproducible + ready-to-go].
2. **Delete T4** (`scene-backgrounds` 8.3 GB + benchmark dirs) to reclaim disk (93% full)? [rec:
   YES — re-fetchable / disposable; but destructive, hence confirm].
3. **Legacy full-frame corpora + models** (v0–v14, their GB of synthetic frames): keep on disk
   (untracked) for a possible legacy retrain, or drop the big frames while preserving the small
   human-label jsonl? [rec: preserve the labels, drop the regenerable frames].
