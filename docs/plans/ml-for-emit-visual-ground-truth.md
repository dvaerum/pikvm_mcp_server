# ML-for-emit on visually-verified ground truth

Status: in progress (started 2026-05-15)

## Background

Prior emit-residual training (3 runs, 1728 frame pairs in
`data/emit-residuals*`) used the cursor detector to label both
pre-emit and post-emit cursor positions. From those labels we
computed `observed_dx/dy` and trained a forward-prediction MLP.

The detector has ~28% inter-rater disagreement on cursor presence
and 76-89% FP on cursor-absent frames (Phase 312 measurements).
That means a non-trivial fraction of our training labels for
`observed_dx/dy` are wrong. Training on noisy labels caps how well
any model — math fit or MLP — can do.

User's proposal (2026-05-15):
> "we can have it do a move where we manually verify ahead of
> time where the cursor is and where it goes, I expect that this
> can be done with some math function or the ML-for-emit and
> auto train that math formula"

I.e. replace detector-derived labels with visually-verified labels,
then retrain.

## Pilot plan (this iteration)

The pilot is small and falsifiable. If clean labels are similar to
detector labels we learn the detector was NOT the bottleneck and
stop. If they differ meaningfully we scale up.

### Phase 1 — sample + label (~30-40 min agent time)

1. Sample 30 random frame pairs from existing bench data
   (`data/emit-residuals*/NNNN/`). Each pair has `pre.jpg` and
   `post.jpg` and a JSON entry in `data/emit-residuals-combined.jsonl`.
2. Dispatch 3 independent labeling agents in parallel. Each agent
   sees the same 30 pairs and labels cursor position in `pre.jpg`
   and `post.jpg` independently. Output per frame: `{x, y}` if
   cursor visible at exact pixel, or `{visible: false}` if not.
3. Build consensus: for each frame, accept the label if 3/3 raters
   agree within 15 px on cursor presence/position. Otherwise mark
   the frame as ambiguous.

### Phase 2 — compare consensus vs detector

For each consensus-clean sample (3/3 raters agree on both pre and
post):
- detector displacement: `observed_dx/dy` from the JSONL
- consensus displacement: `post_consensus - pre_consensus`
- delta: how far apart they are

Decision rule:
- If 80%+ of consensus-clean samples have detector vs consensus
  delta < 20 px: the detector was reasonably accurate. ML-for-emit
  retraining on clean labels is unlikely to help. STOP.
- If a meaningful fraction (≥30%) of clean samples have delta
  ≥ 50 px: the detector was lying often. PROCEED to Phase 3.

### Phase 3 — train on clean subset

Only run if Phase 2 says detector was noisy.

Take all consensus-clean samples and:
1. Fit a simple per-axis power law:
   `displacement_x = a · sign(emit_x) · |emit_x|^b + c`
   (3 parameters per axis, fit via least squares).
2. Train the existing MLP (`ml/train-emit-mlp.py`) on the clean
   subset.
3. Compare BOTH against:
   - constant-ratio baseline (1.3)
   - MLP trained on noisy labels (our current best)

If math fit is competitive with MLP, prefer math fit (one number
per axis, easy to integrate, no inference cost).

### Phase 4 — scale (only if Phase 3 shows clear lift)

Relabel several hundred more samples, retrain, then integrate
into `move-to.ts:1422` (the emit-mickeys closed-form).

## Files involved

- `data/emit-residuals-combined.jsonl` — 1728 samples
- `data/emit-residuals/NNNN/{pre,post}.jpg` — frames
- `ml/train-emit-mlp.py` — current forward model
- `docs/plans/ml-for-emit-visual-ground-truth.md` — this plan
- (new) `data/emit-residuals-consensus.jsonl` — output of pilot
  labeling
- (new) `scripts/sample-pilot-frames.ts` — pick 30 frame pairs
- (new) `scripts/build-consensus.ts` — merge 3 rater outputs into
  consensus

## When user help is needed

- Probably not in Phase 1. Agents handle the bulk.
- Phase 2: if I see a frame where consensus and detector disagree
  by a lot AND the consensus position looks ambiguous to me, I'll
  point you to the file and ask which is right.
- Phase 4: if we end up with a small set of borderline cases.

## Tracking

This file is the plan. Status: Phase 1-3 complete (2026-05-15).

## Results

### Phase 1 — labeling

3 raters labeled 30 pilot frame pairs. Pre-emit cursor: 17/30 had 3/3
agreement, 8 had 2/3, 2 no consensus, 3 all said invisible. Post-emit:
18/30 3/3, 6 2/3, 2 no consensus, 4 all-invisible.

### Phase 2 — detector vs consensus

Of 23 samples where consensus could be built on both pre+post:
- Median detector vs consensus displacement delta: 37 px
- 43% of samples have delta ≥ 50 px
- Max delta: 187 px (idx=12: emit was 5 mickeys, detector hallucinated
  183 px of motion)
- Multiple frames where all 3 raters said no cursor visible but detector
  reported a position at ~(837, 894) — that's the home-screen
  page-indicator dot row.

Decision: detector is materially wrong; proceed to Phase 3.

### Phase 3 — math fits on clean data

Trained linear and power-law fits on the 23 consensus-clean samples:

| Model | Mean err | Median | Max |
| --- | --- | --- | --- |
| Constant 1.3 (current closed-form) | 17.9 px | 10.8 px | 75 px |
| Linear per axis | 18.2 px | 12.9 px | 57 px |
| Power-law per axis | 19.3 px | 7.7 px | 62 px |

No model meaningfully beats the constant-ratio baseline. The closed-form
math is already accurate to ~18 px mean error against visual ground
truth. The earlier MLP's reported 29% lift on noisy labels was fitting
detector noise, not improving real prediction.

## Conclusion

**There is no meaningful ML-for-emit improvement available** from this
data. The closed-form `emit · 1.3` is already near-optimal for predicting
cursor displacement. Phase 4 (scale up labeling) is not pursued.

The bottleneck for the ~50% live click rate is not emit prediction. It
is either start-position detection (we plan from the wrong place) or
click-time conditions (cursor not where we think when click fires).

