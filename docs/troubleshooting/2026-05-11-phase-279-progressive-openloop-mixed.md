# Phase 279 — progressiveOpenLoop A/B: MIXED, no-ship

**Date:** 2026-05-11
**Version:** v0.5.225 (no code change shipped — bench-only phase)
**Status:** Did NOT pass ship gate. progressiveOpenLoop kept at
default false on iPad.

## What was tested

Interleaved A/B bench of `MoveToOptions.progressiveOpenLoop`. When
true, `moveToPixel` skips the single big "blind" open-loop emit and
runs the full distance via small chunked moves (~26 px each, up to
12 passes) with cursor detection between each chunk. iPadOS's
per-command px/mickey ratio variance (9× spread on identical
commands per Phase 192 trajectory capture) should average out
across many short emissions instead of being amplified by one big
guess.

Phase 22 shipped the option default-false in 2025 but never live-
benched it at scale. This phase ran the bench.

## Methodology

- **Targets:** (905, 800) near + (757, 832) far
- **Arms:** progressiveOpenLoop=true vs false
- **Layout:** interleaved coin-flip per trial (fixed seed
  0x279abc Fisher-Yates) — drift between arms cancels out
- **N:** 40 trials per arm per target = 160 total
- **Captured per trial:** full debugDir frames + full
  `MoveToResult` JSON for offline analysis / future ML training
- **Bench script:** `test-phase279-progressive-bench.ts`
- **Data root:** `data/phase279-progressive-bench/2026-05-11_17-57-48/`

## Results

| Arm | Target | N  | Hits | Rate    | Median resid | Threw |
|-----|--------|----|------|---------|--------------|-------|
| on  | near   | 40 |   21 |  52.5%  |    24 px     |     0 |
| on  | far    | 40 |    0 |   0.0%  |   145 px     |     0 |
| off | near   | 40 |   19 |  47.5%  |    25 px     |     2 |
| off | far    | 40 |    0 |   0.0%  |   128 px     |     1 |

### Ship gate

- near: on 52.5% vs off 47.5% — Δ +5.0 pp (within Phase 237
  N=20 variance lesson — not a real signal)
- far: on 0.0% vs off 0.0% — both arms hit the same wall

Verdict: **MIXED. Do not ship.**

## What the data tells us

1. **Near-target rate is stable across arms.** ~50% — matches
   Phase 278's documented 55% within variance bands. The detector
   is doing what it can; progressive vs single-shot is noise at
   this layer.

2. **Far-target is broken regardless of emission strategy.** 0/80
   across both arms. Even progressive's 12-pass budget cannot
   converge on (757, 832). The cursor consistently lands at
   coordinates corresponding to wrong icons (Settings, dock TV,
   widget gap) and gets locked there.

3. **Recurring mis-landing positions:**
   - `(908, 786)` and `(906, 824)` — Settings icon vicinity, hit
     for near (residual 14-25 px) but wrong for far
   - `(852, 941)` and `(852, 942)` — TV icon / dock area
   - `(772, 951)` and `(773, 952)` — Books icon area but in the
     dock row, ~120 px below target (757, 832)
   - `(786, 676)` and `(786, 690)` — wallpaper gap above icons

4. **`shape` mode fires in many failed trials** but the picks
   are FPs on dock icons. Cursor-shape-detect is finding *something*
   in the frame; the discriminator just can't distinguish cursor
   from icons reliably at far-target geometry.

5. **3 trials threw** ("detect-then-move failed (motion-diff and
   templa…)"). Bench caught and continued.

## Why progressive didn't help at far

The chunked-emit theory was: small emits make motion-diff detect
each step accurately, accumulating to the target. The data shows
this collapses on the far target because:

- After `ipadGoHome(forceHomeViaSwipe)`, the cursor lands at far-
  right edge (~1180, 805 per Phase 277 diagnostic frames).
- First leftward chunk moves the cursor a real ~25 px left, into
  the visible area.
- Subsequent chunks SHOULD continue leftward, but motion-diff
  often picks up a dock-icon highlight or wallpaper artifact
  instead of the cursor displacement — picks a stale FP.
- Once the algorithm believes the cursor is at a wrong location
  (e.g. (852, 941) — TV icon), each new "correction" emit is
  computed from the wrong position, sending the cursor further
  off course.
- The 12-pass budget compounds these errors instead of converging.

This is consistent with the Phase 268 finding (correlated failure
modes across detectors) — the detectors agree on the wrong
answer rather than independently catching each other's mistakes.

## What was shipped this phase

- `test-phase279-progressive-bench.ts` — reusable interleaved A/B
  bench harness with debugDir + full-result JSON capture. Useful
  for future A/B experiments at different parameter settings.
- `docs/troubleshooting/2026-05-11-phase-279-...md` — this
  document.
- 160-trial dataset under
  `data/phase279-progressive-bench/2026-05-11_17-57-48/` —
  per-pass frames + diagnostic JSON for every trial. Suitable
  as training data for a future ML cursor classifier if/when we
  go that direction.
- NO production code change. progressiveOpenLoop stays default
  false on all targets.

## What this rules out

- **progressiveOpenLoop is not the lever** for the far-target
  failure class. The 12-pass small-chunk approach doesn't escape
  the same FP traps that single-shot mode falls into.
- The Phase 22 hypothesis ("ratio variance gets averaged out
  across many short emissions") is real BUT insufficient. Ratio
  variance is only one ingredient of far-target failure; FP
  template/shape matches are the dominant other ingredient.

## What this does NOT rule out (future user directions)

If/when the user gives explicit direction to pivot strategy,
candidates the data supports:

1. **Far-target-specific ballistic calibration** — Phase 272
   diagnosed Y-axis shortfall ~66 px. A Y-bias term for
   targets in the bottom 1/4 of screen might help.
2. **Mid-screen anchor primitive** — pre-position cursor at
   center, then move to target. Avoids the right-edge clamp
   that contaminates the far-target trajectory.
3. **ML cursor classifier** — the dataset captured this phase is
   ready to feed an offline trainer.
4. **Multi-arm verification** — emit a known displacement; if
   the detected cursor doesn't move correspondingly, REJECT
   the detector's answer and try a different mode.

None of these are being pursued this tick. Per the cron rule
("Do NOT pivot strategies without explicit user direction"), we
stop here and report the honest finding.

## Addendum — frame-by-frame diagnostic on a failing trial

Sampled trial `on/far/t001` (residual reported 44 px, classified MISS at
35 px threshold):

| Frame | Cursor visible? | Approx position |
|---|---|---|
| `01-shotAPre-preCalib` | YES | ~(1005, 805) — far right of Settings |
| `03-shotB-postOpenLoop` | YES | ~(1005, 805) — unchanged (progressive=on zeros big emit) |
| `04-G-pass-shotC` | YES | ~(810, 875) — between Books/TV in dock row, ~70 px from target |
| `08-L-pass-shotC` (final) | **NO** | cursor not visible anywhere on screen |

Algorithm reported a final residual of 44 px (cursor at ~(799, 829)).
But the visible cursor by the final pass is gone — there is nothing
visible on the iPad screen that resembles a cursor.

This implies the real failure mode is:

1. Chunked emits move the cursor close to target (within ~70 px by pass 4).
2. Subsequent emits push the cursor into a state where it disappears
   — possibly edge-clamped, possibly faded under a stationary-cursor
   timeout, or some other mechanism we have not verified. (Older
   framing included "dock-icon snap zone" here; that mechanism is on
   the REJECTED_CLAIMS.md list as unverified.)
3. The detector then locks onto whatever wallpaper/icon pattern looks
   cursor-ish in the final frame and reports an honest-looking but
   wrong residual.

**This is the Phase 211/212 stationary-cursor failure mode reasserting
itself across chunked passes, not a cursor-shape-detect discriminator
problem.** The detector module is doing its job; the cursor just
isn't present to be detected by the final pass.

Actionable directions (NOT pursued this phase — would require user
direction per cron rule "do not pivot strategies"):

1. Add a keepalive wiggle between chunked passes to prevent fade
2. Detect the "cursor visible at pass N, invisible at pass N+1"
   transition and bail with belief-from-pass-N
3. Diagnose specifically what makes the cursor disappear — edge
   clamp vs fade vs dock-icon occlusion
4. Move the same cursor-shape-detect to a different point in the
   pipeline (e.g., evaluate at every pass and keep best-scoring
   landing, not just the final pass)

## State at end of phase

- v0.5.225 (unchanged)
- 713/713 tests
- nix build green
- 160-trial dataset preserved
- This phase: bench harness + doc + frame-by-frame diagnostic only
