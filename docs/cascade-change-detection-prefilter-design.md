# Cheap change-detection pre-filter before the cascade AI check — design (task_3a0440a91a05)

**RESULT (2026-08-31): SHIPPED and CLOSED, real positive win.** Implemented
(`crop_cache.rs`, commit `9ca1a5a`), reviewed twice (design +
post-implementation code review), correctness-gated and timed on real
Pi4 hardware (it-03400) across all three named scenarios — zero
discrepancies between filtered and unfiltered output on any scenario
(position, presence, and the None-vs-Some decision all match exactly).
Real speedups: **idle 4860.1ms→45.1ms (107.85x)**, **moving
5488.9ms→1106.4ms (5x** — better than this doc's own conservative
worst-case framing, since most crops still cover shared background),
**busy/animating 12989.1ms→4795.5ms (2.7x**, real live `top` refreshing
on a real terminal — savings persist because the terminal doesn't
cover the whole frame). A real, positive, monotonic result across the
whole realistic spectrum, not just the best case. See §"Real result"
below for full methodology notes, including a harness pitfall it-03400
correctly avoided (tied directly to this doc's own known v1 gap).

georg's instruction: every prior speed lever (INT8, Vulkan/ncnn, XNNPACK,
thread-count) tried to run the SAME amount of AI work faster and hit the
same "overhead eats the gain" wall on this small model (confirmed:
`ml/crop-heatmap.onnx` is already a tiny 4-conv-layer CNN, ~195KB —
task_b35c14463898). This is architecturally different: reduce HOW OFTEN
the model runs, not how fast each run is. No new hardware allowed.

## 0. The real cost being cut

The production no-hint scan builds a grid of up to 352 96×96 crops
covering the detected region (`build_cascade_grid`/`cascade_axis`,
`GRID_STRIDE=48`) and batches ALL of them into one `run_cascade_inference`
call. Confirmed earlier this session (`docs/rust-cascade-thread-count-sweep-design.md`,
`scratch/cpu-inference-speedup/README.md` §4): this batched inference is
95-97% of total wall-clock on real Pi4 hardware. A pre-filter that
excludes crops from the batch — rather than accelerating the batch
itself — cuts cost linearly with however many crops it correctly
excludes.

## 1. Mechanism

Maintain a per-crop cache keyed by crop bounds (the same `(x, y)` grid
the cascade already computes via `build_cascade_grid`, deterministic for
a given region/stride):

```
CropCache: { bounds → { last_frame_bytes: Vec<u8>, last_verdict: (presence, position) } }
```

For each new no-hint scan, per crop:
1. Extract this crop's raw pixel bytes from the new frame.
2. Compare byte-for-byte against the cached `last_frame_bytes` for the
   same bounds.
3. **Identical → skip the AI call, reuse `last_verdict`.**
4. **Any difference at all → run the real AI call**, update the cache
   with the new bytes + new verdict.

**Deliberately NOT a percentage/threshold-based diff.** The absolute-
move verification work earlier this session (`task_07bfe499e2d9`) found
a real false-negative from exactly this class of mistake: a global
0.5%-of-frame change threshold was too coarse to register a thin,
real, one-line text-selection highlight. A pre-filter gating an AI
model's own presence decision cannot afford that failure mode — a
false-negative here means genuinely losing track of the cursor, not
just a misleading verification message. Byte-exact per-crop comparison
has zero threshold to get wrong: literally any change, however small,
forces a real AI check. This sacrifices some potential savings (JPEG
re-encode noise, sub-pixel compression artifacts on an otherwise-static
crop could force an unnecessary re-check) in exchange for correctness
certainty — matching requirement (2)'s "any candidate the filter is
uncertain about must still go to the real AI check" by construction,
not by tuning a threshold and hoping it's conservative enough.

## 2. False-negative risk analysis (required by the task, not optional)

**The risk this design specifically eliminates**: a naive version of
this idea ("if a crop's region looks unchanged, assume no cursor there")
would be wrong — a *stationary* cursor produces an unchanged crop too,
and skipping it would silently lose a real, present cursor. This design
avoids that failure mode entirely by caching and replaying the **last
real AI verdict** for an unchanged crop, not defaulting to "absent."
An unchanged crop's cursor-presence answer is carried forward
unchanged — correct by construction, not by assumption, as long as the
cache itself is trustworthy (see cache-invalidation below).

**The risk that remains, and how it's bounded**: correctness now
depends on the cache being valid — i.e., genuinely reflecting what was
last confirmed by a real AI call, with nothing having happened since
that could have silently changed a crop's true content without also
changing its pixels (not possible for a raster frame — any real change
in the appliance's video output changes at least one pixel) or without
the cache having been told about a state change it can't see from
pixels alone (a real risk: nothing prevents the cursor from having been
programmatically moved via a code path this pre-filter isn't wired
into). **Mitigation: any HID mouse emit invalidates the ENTIRE cache**
(not per-crop reasoning about which crops an emit could have touched —
conservative and simple, avoiding a whole class of "did I correctly
compute the affected region" bugs). Concretely: hook the cache's
validity into `emit_clock::last_emit_ms()` (`rust/kvmd-client/src/emit_clock.rs:32`
— the real, public, timestamp-based API; compare against a stored
cache-build timestamp). **Correction (georgs-mac-mini's review, verified
against source):** the originally-proposed hooks are wrong as stated.
`CursorBelief.emit_mag_since_last_observation` is a *private* field
(zero `pub fn` accessors) — not directly hookable at all, use
`emit_clock::last_emit_ms()` instead, as above. More importantly:
`emit_clock::record_emit()` and `belief.predict()` are currently called
*only* inside `mouse_move_relative` (`mouse.rs:73,76`) — **not** inside
`mouse_move`, the absolute REST endpoint `move_to_pixel_absolute` (PR
#96, live-confirmed today) actually uses. As designed, this
invalidation trigger would silently NOT fire for any absolute-mode
move — exactly the mode this session just spent real effort proving
works. **This design explicitly scopes the emit-invalidation guarantee
as relative-mode-only for now**, rather than ship a false sense of
safety for absolute-mode moves. Before this pre-filter is enabled for
any absolute-mode target, `client.mouse_move()` needs its own
`emit_clock::record_emit()` call wired in (a small, separate,
independently-reviewable change — belief-prediction may not even
semantically apply to absolute coordinates, a separate question not
assumed here). Also invalidate on: resolution change (mirrors the
existing `calibration_invalidated` pattern already returned by
`client.mouse_move`).

**Region-change invalidation is currently a no-op, not a working
trigger — flagged, not silently assumed.** `REGION_CACHE`
(`cursor_ml_detect.rs:223`) is a process-global static set exactly ONCE
(`if cache.is_none() { detect... }`) and never refreshed or cleared
anywhere in that file — confirmed via direct grep, exactly 2
references total. There is currently no live "the detected region
changed" signal for this pre-filter to compare against; the region is
never re-detected after a process's first scan. Either a future
revision forces a fresh region re-detection on some cadence (its own
real cost, working against this design's whole goal) to make this
trigger real, or — the honest position for now — this invalidation
path is **not implemented in v1**, relying instead on the emit-based
invalidation (which, for relative-mode targets, already covers "the
cursor/context could have moved") and cold-start-per-process as the
safety net.

**Cold start**: no cache yet (first scan, or a fresh invalidation) →
every crop is treated as "changed" → full AI on all crops, identical to
today's behavior. Zero regression risk on the first scan of any
session; the pre-filter can only ever reduce work on subsequent scans
within a validated cache window, never change the first-scan result.

## 3. What this does NOT change

- The AI model itself, its accuracy, or its output for any crop that
  actually gets evaluated — this sits entirely upstream of the existing
  `run_cascade_inference` call, filtering the crop LIST passed into it,
  not touching the model or its interpretation.
- The hint-narrowing path (PR #93) — orthogonal and stacks: hint-
  narrowing already reduces the CANDIDATE COUNT before the grid is even
  built; this pre-filter reduces it further, per-crop, on whatever grid
  results (narrowed or full).

## 4. Real measurement plan (correctness-first, per the task's own requirement)

1. **Correctness gate before any speed number**: on real captured
   frame sequences (consecutive frames from real usage — idle screen,
   cursor moving, UI animating), run BOTH the filtered and unfiltered
   scan and diff the final cursor-position/presence result. Zero
   discrepancies required before trusting any timing number — same
   discipline as the XNNPACK parity check earlier this session.
2. **Real Pi4 timing**, multiple realistic scenarios, not a single
   contrived case:
   - Idle screen, no cursor motion between consecutive scans (best
     case — expect most crops skipped).
   - Cursor moving between scans (worst case for savings — expect the
     crops along the motion path all show real change).
   - A busy/animating screen (clock widget, video, scrolling content) —
     a real adversarial case where MOST crops legitimately change every
     frame regardless of the cursor, potentially eliminating most of
     the pre-filter's benefit. Worth measuring honestly rather than
     only reporting the best case.
3. Report real numbers for all three scenarios, not just the best one —
   an honest "this helps a lot when idle, barely at all when busy" is a
   valid and useful result, not a failure to report cleanly.

## 5. Byte-compare cost — reviewed, expected trivial, still to be measured

Byte-exact crop comparison means reading/hashing every pixel of every
crop on every scan — a real CPU cost of its own, paid even for crops
that end up being skipped. This needs to be cheap relative to the AI
call it's replacing to be worth it at all (a 96×96×3 byte-compare is
~27KB per crop, ~9.7MB total across 352 crops). Reviewed
(georgs-mac-mini): a memcmp-class operation on ~9.5MB is expected to be
genuinely negligible next to a batched ONNX call on any real target CPU
(likely sub-millisecond even on a Pi4 Cortex-A72) — a reasoned
expectation, not a measurement. Still needs the real number per §4
before resting on that alone.

## v1 scope, stated plainly (per review)

Two invalidation triggers described above are not both real yet:
- **Emit-based invalidation works for relative-mode targets only** —
  the required `emit_clock::record_emit()` wiring doesn't exist yet for
  `client.mouse_move()` (the absolute endpoint). Do not enable this
  pre-filter for absolute-mode targets until that's added and reviewed
  as its own small change.
- **Region-change invalidation is not implemented** — `REGION_CACHE`
  has no live refresh signal to compare against today. Rely on
  emit-based invalidation + cold-start-per-process as the safety net
  for v1.

## Sequencing

1. ~~This doc → review (georgs-mac-mini)~~ **Done.** Core mechanism
   sound, false-negative analysis confirmed thorough. Two real gaps
   found and folded in above: region-change invalidation was a no-op
   (now stated plainly, not silently assumed), emit-invalidation didn't
   cover absolute-mode moves (now explicitly v1-scoped to relative-mode
   only, with the real fix — wiring `client.mouse_move()` — named for a
   future change).
2. Implement (off-by-default flag, matching this session's established
   opt-in-gate pattern for anything not yet proven on real hardware).
   **v1 scope**: relative-mode targets only, per above.
3. Correctness gate (§4.1) before any speed claim.
4. Real Pi4 measurement across all three scenarios (§4.2-3) — needs
   real hardware access I don't have (OFFLINE-only); routed to whoever
   has it once implemented.
5. Report real, honest results — positive or negative, all three
   scenarios, not just the best case.
6. Follow-up, not blocking v1: wire `emit_clock::record_emit()` into
   `client.mouse_move()` to extend emit-based invalidation to
   absolute-mode targets; implement a real `REGION_CACHE` refresh
   signal if region-change invalidation is ever needed.

## Real result (2026-08-31, it-03400, real Pi4B) — CLOSED

**Correctness gate**: filtered vs. unfiltered output diffed on real
captured frames across all three scenarios — zero discrepancies
(position, presence, and the `None`-vs-`Some` verification decision all
matched exactly). No speed number below is trusted ahead of this.

| Scenario | Unfiltered | Filtered | Speedup |
|---|---|---|---|
| Idle (same frame scanned twice) | 4860.1ms | 45.1ms | **107.85x** |
| Cursor moving (genuinely different real frame) | 5488.9ms | 1106.4ms | **5x** |
| Busy/animating (real live `top` refreshing on-screen) | 12989.1ms | 4795.5ms | **2.7x** |

The moving-scenario result (5x) beats this doc's own conservative
worst-case framing (§4.2 expected the motion-path crops to dominate) —
most crops still cover shared, unchanged background even during real
cursor motion. The busy scenario (2.7x) confirms savings persist even
under real, continuous on-screen animation, since the animating region
(a terminal) doesn't cover the whole frame — exactly the honest,
non-best-case scenario this doc's §4.3 asked to have measured and
reported regardless of outcome.

**Methodology note worth preserving**: it-03400 ran the busy scenario
in its own separate process specifically to avoid a harness artifact
tied to this doc's own known v1 gap (`REGION_CACHE` never refreshes) —
mixing an iPad-shaped frame and a full-desktop frame in one process
would have computed ground truth against a stale region rather than
the one the cached path would actually use. Correctly identified and
avoided as a measurement artifact, not a pre-filter bug.

**Disposition: shipped, correctness-verified, real positive win across
the whole realistic spectrum.** No further action required on this
task; the two named v1-scope follow-ups (absolute-mode emit wiring,
`REGION_CACHE` refresh) remain open as separate, non-blocking future
work per the Sequencing step 6 above.
