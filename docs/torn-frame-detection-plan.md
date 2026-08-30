# Plan: automatic torn/corrupted-capture-frame detection + retry

## Problem

`cursor_anchor_corner_control_smoke.rs`'s confirmation step (wake key →
1.5s settle → one screenshot) has produced a torn/corrupted capture frame
twice this session (2026-08-30, ~07:01 and ~07:04 — see
`docs/rust-port-plan.md` §11), on top of one earlier occurrence the
harness's own header comment already documents (2026-08-29). In both
2026-08-30 cases, the underlying device state was fine (confirmed via a
follow-up screenshot moments later showing a clean, genuine lock screen)
— only the CAPTURE at that exact moment was corrupted: large flat-filled
regions (a flood-fill placeholder colour and/or black bars) instead of
real frame content.

Today this was always caught by the human veto (never confirmed a torn
frame), so no safety incident resulted. But relying solely on a human
correctly recognizing "this is garbage, don't confirm it" is fragile —
it works, but it wastes the whole 30s confirm window on a frame that was
never going to be judgeable, and a busier/less attentive reviewer could
plausibly misjudge a partially-torn frame that still has SOME real
content in it (as the 07:04 sample did — a correct top strip alongside
corrupted regions). The fix is to catch this automatically, before ever
presenting the frame to a human, and retry the capture.

## Evidence: what a torn frame actually looks like (real samples, this
session)

Cropped to the tight iPad content region (`{x:610, y:58, w:692,
h:956}` — full-frame analysis is invalid, see below), dominant-colour
histograms:

| Sample | Dominant colours | Uniform-row fraction |
|---|---|---|
| Clean home screen (`health-resume.jpg`, 06:56) | `(16,16,16)` 18.3%, `(54,105,88)` 1.6% | **1.5%** (14/956 rows) |
| Clean baseline (`corner_control_smoke_baseline.jpg`, pre-lock) | `(16,16,16)` 18.4%, `(54,105,88)` 1.6% | **1.5%** (14/956 rows) |
| Torn confirm frame (`corner_control_smoke_confirm.jpg`, 07:04) | `(16,16,16)` 17.6%, `(0,136,0)` 17.4% | **22.4%** (214/956 rows) |

Two findings that shaped the design, both from real measurement, not
assumption:

1. **A naive "does one colour dominate the frame" check is invalid on
   its own.** The FULL 1680×1050 KVM frame is ~63% `(16,16,16)` black
   letterbox in every sample, clean or torn (the iPad content is only
   the inner tight region). Even restricted to the tight region, a
   *legitimate* dark widget background already accounts for ~18% of a
   normal frame. A flat-colour-fraction threshold anywhere near the
   torn frame's 17.4% green would false-positive on ordinary content.
2. **Full-row uniformity is a clean, structural discriminator.** A row
   is "uniform" if every pixel in it is byte-identical. Real
   photographic/gradient/UI content — even a solid-looking dark widget
   background — essentially never produces a full-width row where all
   692 pixels are exactly equal, because of icon edges, text, subtle
   gradients, and JPEG's own per-block noise. A flood-fill corruption
   band does, for every row it covers. Measured: **1.5% vs 22.4%**, a
   ~15x separation on the one real corrupted sample available. This
   generalizes better than a colour-specific check (it doesn't need to
   know "green is suspicious" — it would equally catch a solid-black or
   solid-white flood-fill band, or the black side-bars seen in the same
   sample).

**Caveat, honestly flagged**: this is ONE real corrupted sample (the
07:01 attempt's frame — solid green fill under a thin dark strip — was
not saved before being overwritten by the next run; only described
qualitatively in the report, not measured). The 1.5%/22.4% split is a
real, measured data point, not a general survey. It should be treated as
a reasonable starting threshold, not a final-calibrated one — the
implementation should log the measured fraction on every capture
(clean and torn alike) so real-world calibration data accumulates from
future runs before the threshold is tightened or loosened.

## Design

New module `rust/detection-vision/src/torn_frame.rs`, following the
existing `brightness.rs` convention exactly (same crate, same
`Region`-cropping pattern, same doc-comment-cites-calibration-data
style, same `#[cfg(test)]` structure with synthetic-JPEG test helpers):

```rust
pub struct TornFrameReport {
    pub uniform_row_fraction: f64,
    pub is_torn: bool,
}

/// Rows where every pixel is byte-identical, as a fraction of total rows.
/// See torn-frame-detection-plan.md for the real-sample calibration
/// (clean: 1.5%, torn: 22.4%).
pub const UNIFORM_ROW_FRACTION_THRESHOLD: f64 = 0.08;

pub fn analyze_torn_frame(
    buffer: &[u8],
    options: AnalyzeTornFrameOptions, // { region: Option<Region>, reuse brightness::Region }
) -> anyhow::Result<TornFrameReport>
```

Threshold placed roughly midway (log-ish) between 1.5% and 22.4%, biased
toward the clean side since a false negative (missed torn frame, human
catches it) is much cheaper than a false positive (needless recapture
loop) — 8% is ~5x the clean sample's 1.5% and leaves comfortable margin
under the torn sample's 22.4%. Open to adjustment in review.

**Integration point**: `cursor_anchor_corner_control_smoke.rs`'s existing
wake+screenshot loop (the `for attempt in 1..=5` block). Currently a
successful `Ok(shot)` breaks immediately. New behavior: run
`analyze_torn_frame` on the shot (tight-region-cropped); if
`is_torn`, log it and loop again — but WITHOUT re-sending the wake key
(the device is presumably already awake; only the capture was bad),
just an extra ~500ms settle before re-fetching. This mirrors the
already-established `capture_until_bright_enough()` pattern added to
`ipad_collector_ground_truth_bench.rs` this session (retry the capture
step specifically, not the whole upstream action). Budget: reuse the
existing 5-attempt loop rather than adding a second nested retry count,
to keep the control flow simple — a torn frame counts against the same 5
attempts as a screenshot `Err`. If all 5 attempts are exhausted still
torn, present the best (least-torn, i.e. lowest measured fraction) frame
to the human anyway with a `[torn-frame-check] WARNING: still flagged
torn after N attempts` note — never silently loop forever, and never
withhold a frame from the human veto entirely.

## Test plan

- Unit tests in `torn_frame.rs`, following `brightness.rs`'s pattern:
  synthetic uniform-colour JPEG → `is_torn: true`; synthetic
  checkerboard/noise JPEG → `is_torn: false`; a synthetic "half normal
  noise, half flood-filled" image approximating the real torn sample's
  shape → `is_torn: true`.
- A regression test loading the two real saved samples if they're
  committed as fixtures (`health-resume.jpg`-equivalent clean baseline,
  and the 07:04 torn sample) — TBD whether to commit binary fixtures or
  keep this to synthetic-only tests; open question for review.
- No live-rig test needed for the module itself (pure function over
  bytes). The harness integration should get one supervised live
  confirmation run once merged, to see it actually catch a real torn
  frame if one recurs — not required before merging the code change
  itself.

## Review (nixos-dev) — resolved

1. **Threshold: 6%, not 8%.** The 8% framing's "biased toward clean"
   math was wrong (geometric mean of 1.5%/22.4% is ~5.8%, arithmetic
   ~12% — 8% sits closer to the torn end than claimed). Also: the two
   clean samples were both settled/static shots, not the screen-just-
   woke moment this check actually runs at (more likely to carry some
   transitional artifact) — reason to lean lower, not higher. Resolved
   to **6%** (`UNIFORM_ROW_FRACTION_THRESHOLD = 0.06`), near the
   geometric mean.
2. **Never re-send the wake key on a torn-frame retry — hard constraint,
   not a judgment call.** `ipad-unlock.ts:591-614`'s documented
   mechanic: a FIRST `Space` wakes the screen still-locked; a SECOND
   `Space` DISMISSES the lock screen into the Touch ID/passcode prompt —
   the exact escalation this whole categories-2/5 saga has been fighting
   all day, reinforced by the wake-key-delay-sweep's own finding that
   `unlock_ipad()`'s recovery keys do this. A torn-frame retry re-fetches
   the capture only (with a short extra settle), never re-presses the
   wake key.
3. **Don't hardcode the crop-region literal — pass real per-frame
   detected bounds.** `AnalyzeTornFrameOptions.region` is populated from
   `orientation::detect_ipad_bounds_from_buffer` on the SAME captured
   frame, not the literal `{x:610,y:58,...}` rectangle — per-frame
   bounds drift (auto_crop.rs's calibration work measured ~4.6%
   edge-delta across captures). A bounds-detection failure just skips
   the torn-frame check for that attempt (never blocks); the human veto
   remains the backstop either way.
4. **Fixture: synthetic-only, no committed binary.** The one real torn
   sample was an incidental artifact, not a purpose-built calibration
   corpus — a synthetic "half-noise, half-flood-fill" test covers the
   same shape without adding a binary fixture to the repo.

## Implementation

Done — `rust/detection-vision/src/torn_frame.rs` (new module, mirrors
`brightness.rs`'s conventions exactly, 6 unit tests), wired into
`cursor_anchor_corner_control_smoke.rs`'s existing wake+screenshot retry
loop (v9). 345/345 mover tests, 198/198 detection-vision tests, clippy
`-D warnings` and fmt clean. Not yet exercised live (code-only per the
manager's direction — no live rig contact needed for this change); the
next live categories-2/5 attempt will be its first real test.
