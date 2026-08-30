# Plan: staged-observation live reproduction of the K=4 stationary-guard fix

**Status: DRAFT, for review by pikvm-mcp-server@georgs-mac-mini before
any execution.** Written per georg's direct instruction (relayed by the
manager) to close out item 6 of `docs/final-e2e-validation-sign-off-plan.md`
— the stationary-guard widening's own live confirmation, open after 3
real attempts, all inconclusive because the real detector cascade's
run-to-run variance is too high to reliably reproduce the exact original
scenario by re-running the same target (confirmed twice: two attempts'
calibration ratios differed 4x). This plan implements the already-agreed
next step: stage `CursorBelief` observations directly, instead of
hoping the natural correction loop organically wanders into the bug.

## What "staged" means precisely, and why it's still a live test

This is NOT a return to an offline unit test — the 5 offline tests for
this widening (including `would_reject_as_stationary_catches_a_repeat_
of_an_entry_2_passes_back`, `rust/cursor-belief/src/belief/estimator.rs`)
already prove the pure logic exhaustively. What those tests can't prove
is that the REAL production wiring — a real `PiKVMClient`'s real,
shared `belief: Mutex<CursorBelief>`, updated by real HID emits via the
real `mouse_move_relative` (which forward-predicts the SAME belief
object `legacy_move.rs`'s correction loop reads from) — behaves
identically when exercised end-to-end against the real device, not a
mock.

Concretely, "staged" means: the OBSERVATION VALUES fed into
`CursorBelief::observe()` are chosen directly by this harness (mirroring
the real 2026-08-29 incident's own documented coordinates), instead of
being extracted from a real camera detection. The EMIT ACCOUNTING between
observations is real: this harness issues real, small
`client.mouse_move_relative()` calls, which (confirmed by reading
`kvmd-client/src/client/mouse.rs` directly) automatically call
`self.belief.lock().unwrap().predict(Emit{dx, dy}, None)` on the SAME
shared belief object — exactly the mechanism `legacy_move.rs`'s real
correction passes rely on. So this test exercises the real client, the
real shared belief, and the real `would_reject_as_stationary` method —
only the CANDIDATE POSITIONS are supplied directly, which is precisely
what "staging" is meant to mean: bypass the unreliable step (getting the
real camera cascade to organically produce this exact 3-observation
shape), keep everything else real.

**Note, since it's a real change from the earlier (now-superseded)
targeted-reconfirmation attempts**: this plan does NOT need the
dock-layout-verification step those attempts required. That step existed
because those attempts needed the REAL CAMERA to detect a REAL static
feature at a specific screen location. This plan stages the observation
VALUES directly — `would_reject_as_stationary`'s own logic is pure
`Point` math, agnostic to what (if anything) is actually rendered at
those coordinates. The specific historical pixel values below are kept
for narrative continuity with the real documented incident, not because
anything needs to currently be visible there.

## Exact sequence

1. **Setup**: construct a real `PiKVMClient` (real host/credentials, same
   as every other live harness this session). One real health-check
   screenshot — confirms the device is reachable at all (this is what
   makes the harness genuinely "live," not a bare unit test) and gives an
   operator-visible starting-state record, same discipline as every
   other harness. No lock/slam/corner risk anywhere in this plan — this
   is `legacy_move.rs`'s stationary guard, a completely different,
   already-confirmed-zero-shared-code path from `cursor_anchor.rs`'s
   corner-control machinery (§5 of the sign-off doc).

2. **Reset the real shared belief to a clean slate**: `client.reset_belief(<any
   current point>)` — the existing public pass-through (confirmed real,
   `kvmd-client/src/client/core.rs`), clears `recent_observations` and
   `emit_mag_since_last_observation` so nothing from process startup or
   an earlier run leaks in.

3. **Stage pass 1 — accept the "A" observation** (the dock-icon-area
   cluster from the real incident, `(1092.0, 979.0)`):
   - Real HID: `client.mouse_move_relative(50.0, 0.0)` — small, safe,
     mouse-only, real emit accumulates on the real shared belief via its
     own internal `predict()` call.
   - Staged: `client.observe_cursor(Point{x:1092.0, y:979.0}, 0.9, None)`
     (the existing public pass-through to `belief.observe()`) —
     `reject_stationary` defaults to `false` in `ObserveOptions::default()`
     (confirmed by reading `estimator.rs`), so this first observation is
     unconditionally accepted, exactly mirroring the offline test's own
     pattern.

4. **Stage pass 2 — accept the "B" observation** (the real, genuinely
   different ML-recovery position from the incident, `(1020.0, 662.0)`):
   - Real HID: `client.mouse_move_relative(50.0, 0.0)` again — fresh real
     emit accumulation.
   - Staged: `client.observe_cursor(Point{x:1020.0, y:662.0}, 0.9, None)`
     — accepted.
     At this point the OLD (pre-widening) design would have forgotten A
     ever happened, remembering only B.

5. **The actual test — pass 3, a candidate matching A (2 passes back),
   not B**:
   - Real HID: `client.mouse_move_relative(50.0, 0.0)` — fresh real emit,
     satisfying `min_emit_mickeys` (default 30) same as the original
     incident's own trace.
   - Call `client.would_reject_as_stationary(Point{x:1092.0, y:979.0},
     None)` — the existing public pass-through, not `observe_cursor`,
     so this pass doesn't itself get pushed into history — mirrors the
     real correction loop's own call shape, which checks before
     deciding whether to accept). **Expected: `true`.** Log the actual
     boolean value directly — this IS the live confirmation item 6 asks
     for: the widened K=4 ring, in the real production type, wired to a
     real client, directly observed rejecting a real 2-passes-back
     candidate.

6. **The contrast, computed for real, not asserted**: construct a
   SEPARATE, bare `CursorBelief::new(...)` (no client needed — this side
   only exists to demonstrate what the OLD, pre-widening design would
   have concluded, not to test the real wiring). Replay ONLY the single
   most recent observation from step 4 (`observe(Point{x:1020.0,
   y:662.0}, 0.9, None)` + a matching `predict(Emit{dx:50.0, dy:0.0},
   None)`), then call `would_reject_as_stationary(Point{x:1092.0,
   y:979.0}, None)` on THIS instance. A belief that has only ever
   observed once behaves identically to the old single-slot design (this
   is the same "K=1-equivalent" property the widening's own offline
   tests already establish and rely on). **Expected: `false`** — directly
   demonstrating, with real running code on both sides, that the OLD
   design would have missed exactly what the NEW design catches.

7. **Report both results side by side**, verbose, in the harness's own
   log: candidate position, both booleans, and an explicit PASS/FAIL
   verdict (`widened=true && old_equivalent=false` is the only passing
   outcome; anything else is reported honestly as a real, informative
   failure, not silently reinterpreted).

## What this proves vs. doesn't

**Proves**: the real, production `CursorBelief`/`would_reject_as_
stationary` code, wired to a real `PiKVMClient` and driven by real HID
emits for its accounting, genuinely rejects a staged 2-passes-back
candidate — and a genuine old-shaped (single-observation) belief,
built from the same real code, would not have. This directly closes
item 6's ask: "directly observing the K=4 ring reject a 2+-passes-back
stale candidate."

**Does NOT prove**: that the real, natural, camera-driven correction
loop reliably reaches this exact scenario on its own — already known,
already accepted (3 real attempts, confirmed too much run-to-run
cascade variance). That's explicitly not what staging is for; it exists
specifically to bypass that unreliability, not resolve it. If a fully
organic reproduction is ever wanted later, it remains open as a much
harder, separate task.

## Safety

Real HID: three `mouse_move_relative(50.0, 0.0)` calls, all small,
horizontal-only, real but low-risk relative moves — the same primitive
already established as safe throughout this entire session (no keys, no
clicks, nowhere near a screen corner, no interaction with any lock/guard
logic at all). Zero interaction with `cursor_anchor.rs`/`slam_to_corner`
— confirmed zero shared code between this guard and that one earlier
this session (sign-off doc §5). This is meaningfully LOWER risk than
categories 2/5's own work, and lower risk than the 3 prior targeted-
reconfirmation attempts (which also risked the legacy correction loop's
own multi-pass budget running to exhaustion against a real, unpredictable
target; this plan's real HID is 3 fixed, small, known moves, nothing
open-ended).

## Implementation

New example: `rust/mover/examples/stationary_guard_staged_repro.rs`
(or similar). Reuses the existing `PiKVMClient` construction pattern
every other live example in this crate already uses. No new library
code needed and no raw `.belief.lock()` required — checked
`kvmd-client/src/client/core.rs` directly: `PiKVMClient` already exposes
`observe_cursor`, `would_reject_as_stationary`, and `reset_belief` as
public pass-throughs to the real shared belief, which is exactly the
idiomatic surface this plan should use (the client-side, non-client
comparison in step 6 uses `CursorBelief`'s own raw `observe`/`predict`/
`would_reject_as_stationary` directly, since that side deliberately has
no client at all). Every method this plan calls already exists and is
already public — genuinely zero new library code.

## Open questions for review

1. Is reusing the exact historical incident coordinates (`(1092,979)`,
   `(1020,662)`) the right call for narrative continuity, or would
   arbitrary/rounder values (e.g., mid-frame coordinates) make it
   clearer at a glance that this test doesn't depend on real screen
   content at those positions?
2. Is 3 real `mouse_move_relative(50.0, 0.0)` calls (each ~50 mickeys,
   comfortably over the 30-mickey `min_emit_mickeys` default) the right
   real-HID shape, or should the emit magnitudes more closely mirror the
   real incident's own actual emit trace if that's still available in
   the original run's log?
