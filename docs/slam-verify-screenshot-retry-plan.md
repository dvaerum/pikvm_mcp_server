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

**Hypothesis, since WEAKENED by later evidence (see the addendum
below)**: the `after` screenshot fires right after ~1.5s of continuous
slam HID traffic (25 rapid calls) — plausibly more sustained load on
ustreamer's idle-stop/restart cycle than a single wake keypress, the
scenario the existing 1500ms grace window was calibrated against. One
retry may not always be enough specifically here. This was a plausible
mechanism, not a measured one, when first written — and the addendum's
new evidence (the `before` screenshot, with NO preceding slam traffic,
failing with the identical signature) is real counter-evidence against
"slam-load-specific" as the mechanism. More consistent with a general,
not-specifically-slam-triggered ustreamer flakiness that can hit any
screenshot call in this vicinity, not a load effect. Left standing here
for the historical record of what motivated the original `after`-only
fix, but should not be read as still-current reasoning — see the
addendum for the corrected picture. Doesn't change the fix itself
(retrying more is still the right response either way), just what
mechanism it's actually working around.

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

Apply to the `after` call only, not `before`. All 3 live 503 occurrences
were on `after`, never `before` — no evidence-based need to touch it.
More importantly (nixos-dev's review): `before` sits between the guard's
CONFIRMED precondition (the human-reviewed lock-screen check upstream)
and the actual slam — every retry-with-settle attempt there would widen
that specific gap, and this whole day's sessions have repeatedly shown
this rig's screen state can shift within single-digit seconds (re-dimming,
Touch ID escalation, torn frames). Minimizing that gap matters more than
treating both calls symmetrically. `before` stays a bare `.await?`,
unchanged, fail-fast as today.

This only adds resilience to `after`: a call that succeeds on the first
attempt (the overwhelming majority) behaves identically to today — same
latency, same code path, no observable change. Logs the actual attempt
count on every real run (same calibration-continues-from-real-data
discipline as the torn-frame threshold), since neither 1500ms nor the
new 1000ms/3-attempts has real measured backing — `STREAMER_RESTART_GRACE_MS`'s
own history (checked by nixos-dev) has no richer number to borrow either,
so this is consistent with the existing precedent, not under-grounded
relative to it. Not exposed as a new `SlamOptions` field for now (no
caller has asked to tune it); can be added later if real-world
calibration data says the defaults are wrong for some caller.

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

## Review (nixos-dev) — resolved

1. **3 attempts / 1000ms are reasonable, no better number exists.**
   `STREAMER_RESTART_GRACE_MS`'s own history has no direct measurement
   behind its 1500ms either — same qualitative "give it margin"
   reasoning. Not under-grounded relative to the precedent it extends.
2. **Apply to `after` only, NOT `before` — decided, not symmetric.**
   `before` sits between the guard's confirmed precondition and the
   slam; retrying there would widen that specific gap, and this rig's
   screen state has repeatedly shifted within single-digit seconds this
   session. `before` stays a bare, fail-fast `.await?`, unchanged.
3. **Deferred — no `SlamOptions` field for now**, straightforward YAGNI.

## Implementation

Done — `take_screenshot_with_retry` helper in `slam/motion.rs`, applied
to the `after` screenshot only (`before` explicitly left unretried, with
a comment explaining why). Logs attempt count via `verbose` for future
calibration. 349/349 mover tests (4 new: succeeds-first-try,
recovers-on-second-outer-attempt, exhausts-max-attempts,
slam_to_corner-recovers-from-a-transient-after-failure), clippy
`-D warnings` and fmt clean.

## Addendum: `before` needs a lighter-touch version too

**New evidence (2026-08-30, `docs/rust-port-plan.md` §15)**: the very
next live attempt after shipping the `after`-only fix hit the SAME
transient 503 again — but `take_screenshot_with_retry`'s own log line
(fires on every attempt, success or failure) never appeared in the log
(`grep -c` confirmed zero occurrences). The failure happened upstream of
`after`, almost certainly at the un-retried `before` screenshot. Q2's
"no evidence-based need to touch `before`" no longer holds — both calls
have now independently shown the same failure. The safety concern behind
leaving `before` unretried (widening the confirmed-precondition-to-slam
gap) is still real and still matters — the fix is a LIGHTER-touch retry
on `before`, not the same treatment as `after`.

Proposed: reuse `take_screenshot_with_retry` (same helper, no new code
needed) with smaller values — `max_attempts = 2` (one extra try, not
two), `settle_ms = 300` (vs `after`'s 1000ms). Worst-case added latency
on a genuinely down streamer: 1 extra attempt × (client's own ~1.5s
internal retry + 300ms settle) ≈ 1.8s, vs `after`'s ~5s — meaningfully
lighter, while still handling the demonstrated transient case (the
`after` fix's own test data shows recovery typically happens by the
2nd outer attempt). Same `verbose`-gated logging as `after`, so real
runs keep building calibration data for both.

Open question for review: is 2 attempts / 300ms the right "lighter"
values, or should `before` get an even smaller budget (e.g. 1 extra
attempt with no settle at all, relying purely on the client's own
built-in 1500ms grace already baked into each attempt)?

## Review (nixos-dev) — resolved

Keep the asymmetric treatment — the safety reasoning doesn't depend on
WHY `before` failed, only on tolerable delay before the slam fires.
2 attempts / 300ms confirmed reasonable (mild preference for a small
non-zero settle over 0ms, not a blocking concern). Also flagged: the
original "slam-load-specific" hypothesis is now weakened by this same
evidence (`before` has no preceding slam traffic and failed identically)
— corrected in the Design section above rather than left standing
unchallenged.

## Implementation (addendum)

Done — reused `take_screenshot_with_retry` for `before` with its own
lighter constants (`BEFORE_SCREENSHOT_RETRY_MAX_ATTEMPTS = 2`,
`BEFORE_SCREENSHOT_RETRY_SETTLE_MS = 300`), added a `label` parameter
("before"/"after") so calibration logs distinguish which call recovered.
New test: `slam_to_corner` recovers `verify_motion` from a transient
`before`-screenshot failure (mirrors the existing `after` test). 350/350
mover tests, clippy `-D warnings` and fmt clean. Not yet exercised live.
