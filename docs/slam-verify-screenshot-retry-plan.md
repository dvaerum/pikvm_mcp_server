# Plan: outer retry around `slam_to_corner`'s verification screenshots

## Correction first

My first message to the manager proposed the wrong fix: "the post-slam
verification screenshot needs the same held-`/api/ws`-stream-client
retry treatment the baseline screenshot already got." Checked the actual
code before writing anything further — **that's false**. `client
.screenshot()` already has a built-in retry-once-with-1500ms-grace
UNIFORMLY, for every caller (`kvmd-client/src/client/core.rs`'s
`fetch_snapshot_with_retry`, called from `screenshot.rs`'s
`screenshot()`). `slam::motion`'s `take_screenshot` calls `client
.screenshot(None)` directly — the exact same method, same retry, same
grace window. The error message itself says so: "even after a held
`/api/ws` stream client and **one retry**" — it already retried once
before failing. There was never a missing-treatment gap at this layer.

## The real gap

`slam_to_corner` (`rust/mover/src/slam/motion.rs`) takes a `before`
screenshot, runs the slam (25 rapid `mouse_move_relative` calls, ~1.5s
of continuous HID traffic at the default pace), then an `after`
screenshot for the `verify_motion` diff. Both screenshot calls are bare
`.await?` — if `client.screenshot()` fails (even after its own internal
retry), `slam_to_corner` returns `Err` immediately. There is no OUTER
retry loop at this layer.

Compare to two other places in this exact codebase that already retry
the CAPTURE itself (on top of, not instead of, the client's built-in
retry) when a screenshot attempt doesn't yield a usable frame:
- `cursor_anchor_corner_control_smoke.rs`'s wake+confirm loop — up to 5
  attempts, 1.5s settle between.
- `ipad_collector_ground_truth_bench.rs`'s `capture_until_bright_enough`
  — retries on a brightness-too-low signal, not an error, but the same
  "the client-level retry isn't always enough, retry the whole capture
  step at the call site" idiom.

`slam_to_corner`'s `verify_motion` path never got this treatment. Live
evidence (2026-08-30, `docs/rust-port-plan.md` §13): the `after`
screenshot 503'd on the FIRST real live exercise of the categories-2/5
guarded slam — the 3rd occurrence of this exact failure signature across
the harness's history (v1-v6, v7, now this), always right after the slam
motion, never at the `before` screenshot or elsewhere.

**Hypothesis, not yet proven**: the `after` screenshot fires right after
~1.5s of continuous slam HID traffic (25 rapid calls) — plausibly more
sustained load on ustreamer's idle-stop/restart cycle than a single wake
keypress, the scenario the existing 1500ms grace window was calibrated
against. One retry may not always be enough specifically here. This is a
plausible mechanism, not a measured one — no direct timing data on how
long the outage actually lasts post-slam exists yet.

## Design

Add a small outer-retry helper in `slam/motion.rs`, next to
`take_screenshot`, following the same idiom as the harness's wake loop:

```rust
/// Retries `take_screenshot` a few times with a short settle between
/// attempts, on top of `client.screenshot()`'s own built-in
/// retry-once. See docs/slam-verify-screenshot-retry-plan.md for why:
/// the `after` screenshot fires right after sustained slam HID traffic,
/// a heavier load than the single-retry grace window was calibrated
/// against (3 real live occurrences of this exact 503, all post-slam).
async fn take_screenshot_with_retry(
    client: &PiKVMClient,
    mode: ScreenshotMode,
    max_attempts: u32,
    settle_ms: u64,
) -> Result<Vec<u8>, ClientError> {
    let mut last_err = None;
    for attempt in 1..=max_attempts {
        match take_screenshot(client, mode).await {
            Ok(buf) => return Ok(buf),
            Err(e) => {
                last_err = Some(e);
                if attempt < max_attempts {
                    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
                }
            }
        }
    }
    Err(last_err.expect("loop runs at least once"))
}
```

Starting values: `max_attempts = 3`, `settle_ms = 1000`. Honestly
uncalibrated (no direct measurement of the real outage duration) — a
reasonable starting point given the existing 1500ms grace window is the
only real reference point available, not a final-tuned value. Worst-case
added latency on a genuinely down streamer: ~2 extra attempts × (client's
own ~1.5s internal retry + 1000ms settle) ≈ 5s — acceptable for a
verification step that isn't on the interactive-UI critical path (unlike
the harness's human-facing confirm loop).

Apply to BOTH the `before` and `after` calls in `slam_to_corner`, not
just `after` — for consistency and because the `before` shot isn't
provably immune (it follows whatever the caller did right before
invoking `slam_to_corner`, which this module has no visibility into).

This only adds resilience: a call that succeeds on the first attempt
(the overwhelming majority) behaves identically to today — same latency,
same code path, no observable change. Not exposed as a new
`SlamOptions` field for now (no caller has asked to tune it); can be
added later if real-world calibration data says the defaults are wrong
for some caller.

## Test plan

Extend `slam/motion.rs`'s existing `stub_client` test helper to support
returning an error for the first K calls to a given path before
succeeding (currently it always returns `Ok`). New tests:
- `take_screenshot_with_retry` succeeds on the first attempt when the
  client succeeds immediately (no behavior change, attempt count = 1).
- Succeeds on a later attempt when the client errors for the first N-1
  calls then succeeds (attempt count matches; settle sleep observed
  between attempts, or attempt count recorded — no reliance on wall-clock
  timing in the test).
- Exhausts `max_attempts` and returns the LAST error when the client
  never succeeds.
- A `slam_to_corner(verify_motion: true)` integration-style test where
  the `after` screenshot errors once then succeeds — confirms the whole
  verify_motion path recovers rather than propagating the transient
  error, using the existing `verify_motion_tests` module's patterns.

No live-rig test needed for the retry logic itself (pure control flow
over a mockable client). The next live categories-2/5 attempt is the
real test of whether the 3-attempt/1s-settle defaults are actually
enough — same as the torn-frame threshold, calibration continues from
real runs, not resolved here.

## Open questions for review

1. Are 3 attempts / 1000ms settle reasonable starting values, or is
   there a better-grounded number (e.g. from `STREAMER_RESTART_GRACE_MS`'s
   own original calibration history)?
2. Apply to both `before` and `after`, or only `after` (the one with
   actual live-evidence of failing) — is extending to `before` on
   symmetry-alone reasoning justified, or unnecessary scope creep?
3. Should this become a `SlamOptions` field (caller-tunable) now, or is
   deferring that until a real need appears the right call?
