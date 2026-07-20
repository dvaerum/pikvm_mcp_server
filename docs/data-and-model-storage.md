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
  reproducibility seed is stable + tracked). **DONE** — `train-crop-heatmap.py` + `heatmap-gate.ts`
  now read these committed copies, so a from-scratch reproduce depends only on tracked data.
- `data/seeds/human-labels/` — the 40 preserved human-verified / inter-rater label jsonls (988 KB,
  irreplaceable human labour; frames deleted, labels kept).
- `data/seeds/REPRODUCE-MANIFEST.sha256` — sha256 of the shipped model + every seed, so a reproduce
  run can be checked against the exact committed ingredients.
- Everything else in `ml/*.onnx|*.pt` and `data/*` stays gitignored (regenerable / disposable).

## Executed 2026-07-20 (reproduce PROVEN, then retired data deleted)
Order enforced by the user: prove reproducibility BEFORE deleting anything.
1. **Reproduced the shipped detector from committed seeds only** (`bg-real` + `cursor-sprite.png` +
   `seeds/eval-frames` + scripts): `composite-crops.py 15000` → `train-crop-heatmap.py` (20 ep) →
   export. Reproduced model gate = **8/8, margin 0.97 — identical to the shipped model to 2 dp**.
2. **Live-tested the reproduced model**: N=80 click bench = **100% (80/80)**, matching the shipped
   model's validated rate. Reproduction is faithful.
3. **Proved the retired models are unused**: quarantined all 76 non-cascade models (cursor-v0..v14,
   crop-verifier*, emit-mlp*, pointer-accel*) leaving only `crop-heatmap.onnx`, then ran the full
   default pipeline N=80 = **100% (80/80), zero model-load errors**. The working detector+mover path
   loads nothing but `crop-heatmap.onnx`.
4. **Deleted** (~13.4 GB reclaimed): `data/scene-backgrounds/` (8.3 GB), all `cursor-collect-*`
   synthetic+real corpora, `emit-residuals*` / `phase*` / `v8-*` / benchmark output dirs, retired
   `cursor-templates.*` backups, ~2 MB loose experiment logs/screenshots, and 371 MB of retired
   on-disk models. Preserved: the seeds above + the 40 human-label jsonls.

## Reproduce vs use
- **Use (ready-to-go):** the committed `crop-heatmap.onnx` is loaded directly. Done.
- **Reproduce from scratch:** `make -f Makefile.detector data-crops train-heatmap export-heatmap`
  (or the `nix run .#gen-crops / .#train-heatmap / .#export-heatmap` apps) → regenerates
  `data/synth-crops` from the seeds → trains → exports `crop-heatmap.onnx`. A checksum manifest
  records the expected model hash so a reproduce run can be verified against the committed model.

## Decisions (all RESOLVED + executed 2026-07-20)
1. **Commit the reproducibility bundle** (T1 seeds + T2 model) to git — DONE (seeds + model tracked).
2. **Delete T4** (`scene-backgrounds` + benchmark dirs) — DONE (~13.4 GB reclaimed).
3. **Legacy full-frame corpora + models** — DONE: dropped the regenerable/legacy frames + 371 MB of
   models; preserved the human-label jsonls (`data/seeds/human-labels/`). The current cascade needs
   none of them (proven live at N=80 with everything else quarantined).
