> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 291-292 — far-target failure root cause (v0.5.227)

**Date:** 2026-05-12
**Status:** Diagnostic complete. Per standing rule 4 (don't pivot strategies without user direction), stopping here.

## What I tested

### Phase 291: per-pass diagnostic dump on far target (757, 832)

`test-phase291-far-target-diag.ts` — 5 trials. Each saves pre/post frames + full MoveToResult.diagnostics.

| Trial | Pass 0 mode | Pass 0 detected | Pass 0 reason | Pass 1 |
|---|---|---|---|---|
| 1 | motion | (882, 815) r=126px | live ratio 2.183 | predicted (no pre cand) |
| 2 | motion | (781, 956) r=126px | live ratio 2.744 | predicted (no pre cand) |
| 3 | motion | (852, 941) r=145px | live ratio 5.270 | predicted (no pre cand) |
| 4 | predicted | n/a | template below threshold | — |
| 5 | predicted | n/a | template below threshold | — |

Visually inspected post-frames:

| Trial | Algorithm reported | Visual cursor position | Δ |
|---|---|---|---|
| 1 | (882, 815) | ~(920, 990) — dock area | +180 px |
| 2 | (781, 956) | not visible (faded) | — |
| 3 | (852, 941) | ~(985, 880) — near Settings | ~140 px |
| 4 | (757, 832) predicted | ~(1085, 850) — right of Settings | ~330 px |
| 5 | (759, 832) predicted | similar | — |

### Phase 292: post-flight shape-detect, N=10

`test-phase292-postflight-shape.ts` — runs moveToPixel, waits 800 ms for inertia decay, then runs `findCursorByShape` with radius-400 locality from belief.position.

| Pattern | Count | Pick |
|---|---|---|
| Dock-area FP | 7/10 | (783, 961) score 0.54 |
| Clock-widget FP | 2/10 | (631, 140) score 2.5-3.0 |
| Calendar-widget FP | 1/10 | (618, 261) score 1.1 |

**Zero of 10 settled-frame shape-detect calls found the real cursor.**

## Root cause (RECLASSIFIED — both proposed causes are unverified hypotheses)

> NOTE 2026-05-16: This section's framing rests on two
> mechanisms now on the REJECTED_CLAIMS.md list — "input
> rate-limiting" as a confirmed cause and "iPad pointer-effect
> snap." The bench observations (cursor barely moves; detector
> picks wrong clusters) are real evidence. The mechanisms below
> are hypotheses the author asserted as fact; do not quote them
> as established.

The cursor often **barely moves** on the far-target trajectory. Two hypothesised mechanisms (both unverified):

1. **Input rate-limiting (hypothesis).** Phase 50 documented a pattern in emit data. The pattern is real; the causal claim "PiKVM's emit rate is capped, large chunked moves lose mickeys" is on the REJECTED_CLAIMS.md list as unproven.
2. **iPad pointer-effect snap (hypothesis).** Original framing: when the cursor approaches an app icon (Settings at (905, 810), TV at (773, 810)), iPadOS "snaps" the cursor to the icon center and morphs its appearance. This causal mechanism is on the REJECTED_CLAIMS.md list — never directly observed.

When the cursor:
- Barely moves (cause unknown), motion-diff catches some transient animation (widget pixel change, screen-update artefact) and reports a false position 100-330 px from the cursor's true location.
- Settles somewhere we don't predict, shape-detect can't find the cursor cluster and instead locks onto the nearest cursor-shaped dark feature — typically dock-row icon-label text at (783, 961) on this iPad layout.

Belief.position is now wrong (was updated by the false motion-diff reading). The locality gate now centers on the wrong place. shape-detect, even with its full Phase 290 improvements, has no path to the real cursor because the cursor is geographically far from the locality center.

## Why Phase 290's improvements didn't help

Phase 290 made shape-detect's scoring more principled — the clock-FP score dropped 74%. **But** the 7/10 dock-FP picks in Phase 292 score 0.54, the clock-FP picks score 2.5-3.0, both well above any plausible cursor score in the 400-radius locality from the (wrong) belief position. The cursor's true cluster:
- Is outside the 400-radius locality (when belief drifted to dock area)
- OR is visually morphed in some way we don't model (the "pointer-effect snap morph" framing is unverified — see REJECTED_CLAIMS.md)

The detector can't pick a candidate that isn't a candidate.

## Why this isn't a `cursor-shape-detect.ts` bug

The detector is doing the right thing: find the best dark-cluster candidate within the locality gate. The failures are upstream:
- Input rate-limiting (hypothesis, REJECTED_CLAIMS.md) → cursor doesn't reach target
- Belief drift from motion-diff false positives → locality gate looks in the wrong place
- Pointer-effect snap (hypothesis, REJECTED_CLAIMS.md) → cursor visually no longer matches the detector's prior

Fixing cursor-shape-detect's scoring doesn't address any of these.

## Constructive next steps (NOT pursued — would need user direction)

Per standing rule 4: stopping rather than pivoting. The following would all be "different detection approach" or non-detection fixes:

1. **Motion-diff false-positive filter.** Reject motion-diff results that report a position > 100 px from `belief.predict(emitDelta).position`. The cursor can only move so far per emit chunk; widget-animation FPs often exceed this. Code change in `move-to.ts:detectMotion` call sites.
2. **Belief poisoning protection.** Don't `observeCursor` a motion result that contradicts the post-emit prediction by > 1.5σ. Current belief variance is wide enough that bad observations slip through.
3. **Disable trackpad inertia / pointer effects.** Reduce Motion + Pointer Effect off in iPad Settings. Documented in Phase 115 but never applied. Would need user to toggle in iPad UI.
4. **Stable-FP rejection by motion test.** After locality-gated detect, emit a small wiggle and re-detect — if the candidate doesn't move, it's a widget FP. Code change in detection wrapper.
5. **Smaller emit chunks** (if the rate-limit hypothesis holds — itself on the REJECTED_CLAIMS.md list). Re-examine Phase 64 (micro-step) defaults for far-target moves.

## Honest current state

- Phase 290 v0.5.227 SHIPPED. Foundational refactor; no click-rate change.
- Far target (757, 832): 0% click rate. Root cause is upstream of cursor-shape-detect.
- Per rules, stopping here without pivoting.

## What the user can do

Pick one of the constructive next steps above, or:
- "Apply Reduce Motion lever first" — user manually toggles iPad accessibility settings via UI to disable pointer effects + inertia. Phase 115 attempted this via Spotlight but failed (Phase 117 hit-area asymmetry). May need physical interaction.
- "Continue cursor-shape-detect improvements" — but per this diagnostic, the leverage isn't in the scoring math.
- "Accept current click rate" — the near-target ~50-70% is workable for many use cases; far-target failures persist. (Original framing called it "an honest limitation of the PiKVM+iPad pointer-effect stack"; that causal claim is on the REJECTED_CLAIMS.md list.)
