# Cheap change-detection pre-filter before the cascade AI check — design (task_3a0440a91a05)

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
validity into the same emit-tracking mechanism `CursorBelief` already
uses (`predict()`'s `emit_mag_since_last_observation`,
`emit_clock::record_emit()` — both already exist and are already
called on every real mouse emit, `rust/kvmd-client/src/client/mouse.rs`).
Also invalidate on: resolution change (mirrors the existing
`calibration_invalidated` pattern already returned by `client.mouse_move`),
and detected-region change (a new `detect_ipad_region`/
`detect_ipad_bounds_from_buffer` result with different bounds than the
cache was built against — different crop grid entirely).

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

## 5. Open question for review

Byte-exact crop comparison means reading/hashing every pixel of every
crop on every scan — a real CPU cost of its own, paid even for crops
that end up being skipped. This needs to be cheap relative to the AI
call it's replacing to be worth it at all (a 96×96×3 byte-compare is
~27KB per crop, ~9.7MB total across 352 crops — trivial next to a
batched ONNX inference call, but worth confirming with a real
measurement, not assumed). Flagging for review rather than asserting
it's free.

## Sequencing

1. This doc → review (georgs-mac-mini, same discipline as every other
   design this session).
2. Implement (off-by-default flag, matching this session's established
   opt-in-gate pattern for anything not yet proven on real hardware).
3. Correctness gate (§4.1) before any speed claim.
4. Real Pi4 measurement across all three scenarios (§4.2-3) — needs
   real hardware access I don't have (OFFLINE-only); routed to whoever
   has it once the design is reviewed.
5. Report real, honest results — positive or negative, all three
   scenarios, not just the best case.
