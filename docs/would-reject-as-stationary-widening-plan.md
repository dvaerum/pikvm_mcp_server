# Plan: widen `wouldRejectAsStationary` beyond single-prior-observation

**Status: DRAFT, for review by pikvm-mcp-server@nixos-developer-system before
any implementation.** Not started. Georg asked for this to be actually
designed now (task_a341720594ad), given the finding is a real production
mover-behavior change, not just a new check bolted on.

## The problem, precisely

`CursorBelief` (TS: `cursor-belief.ts`; Rust: `cursor-belief` crate,
`belief/estimator.rs`) keeps exactly **one** piece of history relevant to
this guard: `last_observation: Option<Point>`, overwritten on every accepted
`observe()` call (and unconditionally on `reset()`). `would_reject_as_stationary`
compares a new candidate ONLY against that single value:

```rust
pub fn would_reject_as_stationary(&self, measurement: Point, opts: Option<WouldRejectOptions>) -> bool {
    let Some(last) = self.last_observation else { return false };
    let opts = opts.unwrap_or_default();
    let drift_px = opts.drift_px.unwrap_or(5.0);
    let min_emit = opts.min_emit_mickeys.unwrap_or(30.0);
    let drift = ((measurement.x - last.x).powi(2) + (measurement.y - last.y).powi(2)).sqrt();
    drift < drift_px && self.emit_mag_since_last_observation >= min_emit
}
```

(`rust/cursor-belief/src/belief/estimator.rs:106-119`; identical logic in
`cursor-belief.ts`.)

**Live-confirmed failure mode** (`legacy_move_smoke.rs`, 2026-08-29,
`docs/rust-port-plan.md` §8 item 7): a correction pass's motion-diff picked a
cluster matching an EARLIER pass's post-cluster (2 passes back), not the
immediately-preceding one. Because a genuinely different, real ML-recovered
position (1020, 662) was observed in between, the single-slot check saw
`last = (1020, 662)`, the new candidate `(1092, 979)` was far from THAT, and
the guard correctly (per its own narrow contract) did NOT reject it — even
though `(1092, 979)` was itself a stale repeat of a cluster from *two* passes
back, sitting on dock icons with no cursor there. Ground truth (screenshot):
the real cursor was on the App Store icon at ~(1045, 690).

## Callers, both currently single-slot-limited

Two call sites in `legacy_move.rs` (`rust/mover/src/move_to/legacy_move.rs:382,
746`), both inside the same per-`move_to_pixel`-call correction loop, both
passing `None` for options (i.e. using the 5px / 30-mickey defaults). Both
call `client.would_reject_as_stationary(...)` on the SAME `CursorBelief`
instance that persists across every correction pass of one `move_to_pixel`
call — meaning the belief object already has natural access to the full
pass history for that call, if it kept it. This is TS-identical
(`move-to.ts`'s correction loop calls `client.wouldRejectAsStationary` the
same way).

## Design question 1: should it check more than the single most-recent observation?

**Yes.** The live-confirmed bug is a direct, reproduced instance of exactly
the gap a single-slot check has: it can never catch a repeat of anything
other than the immediately-preceding observation. A 2-pass-old repeat (this
bug), or any N-pass-old repeat, sails through undetected. Widening to a
short window is the only way to close this specific, demonstrated failure
mode.

## Design question 2: how much history?

Proposal: a **small, bounded ring buffer** of the last `K` accepted
observations (not unbounded — this guard runs on a hot path inside a
tight correction loop with a real per-call budget). Recommend **K = 4**:

- The live bug needed exactly 2-back to catch; K=4 gives real margin
  without unbounded growth.
- `legacy_move.rs`'s own correction loop is itself bounded (gross +
  linear correction passes, circuit-breaker on blind-pass exhaustion —
  see `move-to.rs`'s own pass budget), so a 4-slot window covers a
  meaningful fraction of a single call's realistic pass count without
  needing to be "the whole call's history."
- **K=4 is untied to `legacy_move.rs`'s actual max-pass budget** — a
  fixed constant, not derived from it (nixos-dev's review point). Leave
  an explicit comment on the constant noting this, so if that pass
  budget ever changes materially, someone checks whether K's intended
  coverage silently under/over-shoots rather than assuming it still does.
- Cheap: `[Point; 4]` (or a `VecDeque<Point>` capped at 4) with O(K)
  comparison per `would_reject_as_stationary` call — negligible next to
  the actual detection/screenshot cost per pass.

**Not proposing**: unbounded per-call history, or history that persists
ACROSS separate `move_to_pixel` calls (`reset()` already clears
`last_observation` for exactly this reason — a fresh call shouldn't be
haunted by the previous call's clusters; the same reasoning applies to
the widened window — `reset()` must clear the whole ring, not just the
head).

## Design question 3: what's the actual behavior change?

`would_reject_as_stationary(measurement, opts)` changes from:

> reject if `measurement` is within `drift_px` of the single last accepted
> observation AND enough emit has occurred since then

to:

> reject if `measurement` is within `drift_px` of **any** of the last `K`
> accepted observations AND enough emit has occurred since **the most
> recent** of the matching ones (see the emit-accounting question below)

Concretely:
- New field: `recent_observations: VecDeque<Point>` (or a fixed-size
  ring), capacity `K`, pushed on every accepted `observe()` (replacing/
  supplementing `last_observation` — could keep `last_observation` as a
  convenience alias for `recent_observations.back()`, or drop it in favor
  of the ring; TBD during implementation, doesn't change the public
  contract either way).
- `would_reject_as_stationary` iterates the ring; rejects if the new
  measurement is within `drift_px` of **any** entry.
- **Open sub-question, needs explicit resolution before implementing**:
  the `min_emit_mickeys` gate currently measures emit since the SINGLE
  last observation (`emit_mag_since_last_observation`, reset on every
  accepted `observe()`). With a K-deep window, does "enough emit
  occurred" mean since the single most-recent observation (current
  semantics, cheap, but could reject on a real return-to-position after
  a long emit sequence even if that specific historical entry was
  observed at low emit-since-preceding), or since whichever ring entry
  matched? Recommend keeping the CURRENT semantics (emit since the most
  recent observation, unchanged) for the first cut — it's simpler,
  matches the existing tests' mental model, and the live bug this fixes
  was about the DISTANCE comparison being too narrow, not the emit gate.
  Revisit only if a real case shows the emit gate itself needs widening
  too.
- `reset()` must clear the ENTIRE ring, not just push a new single value
  — otherwise a fresh ground-truth anchor could still "reject" a
  measurement against a stale multi-pass-old cluster from before the
  reset, which would be a regression the current single-slot design
  doesn't have (today, `reset()` fully replaces the one slot it has).

## Design question 4: what existing tests could break?

All 13 tests in `rust/cursor-belief/src/belief/estimator.rs`'s
`stationary_cluster_rejection` module (lines ~888-1010) exercise
single-observation semantics directly or indirectly:

1. `observe_returns_true_on_first_acceptance_and_updates_belief` —
   unaffected (no rejection path involved).
2. `would_reject_as_stationary_returns_false_before_any_observation` —
   unaffected (empty ring behaves like empty `Option`).
3. `would_reject_as_stationary_returns_false_when_no_emit_happened_between_observations`
   — unaffected if emit semantics stay "since most recent" as proposed above.
4. `would_reject_as_stationary_returns_true_when_same_pixel_returned_after_a_real_emit`
   — unaffected (ring with 1 entry behaves identically to `Option`).
5. `would_reject_as_stationary_respects_drift_px_threshold` — unaffected
   (single-entry case).
6. `would_reject_as_stationary_respects_min_emit_mickeys_threshold` —
   unaffected (single-entry case, emit semantics unchanged).
7. `observe_with_reject_stationary_false_default_does_not_gate` —
   unaffected (gate disabled entirely).
8. `observe_with_reject_stationary_true_returns_false_on_lock_in_and_does_not_update_belief`
   — unaffected (single-entry case).
9. `observe_accepts_a_measurement_that_has_clearly_moved_after_an_emit` —
   unaffected, UNLESS the test's "clearly moved" position happens to
   coincide with an OLDER ring entry the current single-slot test never
   exercised — needs a real re-run, not just reasoning, but reading the
   test (single accept + single re-observe) suggests no such collision.
10. `emit_accumulator_resets_on_accepted_observation` — unaffected if
    emit semantics stay "since most recent" as proposed.
11. `reset_clears_the_stationary_cluster_history` — **must be
    re-verified explicitly**: this test's whole point is that `reset()`
    clears history so a subsequent measurement isn't rejected. If the
    widened implementation forgets to clear the FULL ring (not just one
    slot) on `reset()`, this exact test should catch it — but only if
    the test itself pushes >1 entry into the ring before resetting.
    Currently it likely only exercises 1 prior observation (matching
    today's single-slot design) — **this test needs a NEW variant added**
    that pushes K>1 observations, resets, and confirms none of them can
    still trigger a rejection, not just the most recent one.
12. `configurable_thresholds_via_options` — unaffected (option plumbing,
    not history depth).
13. (helper/harness functions, not tests themselves) — unaffected.

**Net assessment**: none of the 13 existing tests are expected to fail
from the widening AS LONG AS the single-observation case (K=1 effectively)
remains byte-for-byte behaviorally identical — which the design above
preserves (a ring with ≤1 entry behaves exactly like the current
`Option<Point>`). The one gap is #11: the existing test doesn't actually
prove multi-entry history clears correctly, because there's no multi-entry
history to clear today. **A new test is required**, not just a passing old
suite, to actually prove the widened behavior does what it's supposed to
— this is exactly the "don't treat a green ported-test-suite as sufficient
on its own" discipline this whole session has been built around, applied
to a NEW capability, not just a port.

## New tests required (not exhaustive, minimum bar)

1. `would_reject_as_stationary_catches_a_repeat_of_an_entry_2_passes_back`
   — the direct regression test for the live-confirmed bug: observe A,
   observe B (different position), then a candidate matching A (not B)
   should be rejected. This is the ONE test that proves the fix actually
   fixes the bug, not just "the code compiles differently."
2. `reset_clears_the_full_multi_entry_ring` — observe several distinct
   positions (K of them), reset, then confirm a measurement matching ANY
   of the pre-reset positions is NOT rejected — strengthens #11 above for
   the actual multi-entry case.
3. `ring_capacity_is_bounded` — observe more than K distinct positions,
   confirm the OLDEST ones fall off (a candidate matching the very first
   observation, now evicted, is NOT rejected) — proves the "bounded, not
   unbounded" design decision is real, not aspirational.
4. Re-run all 13 existing tests unmodified (K=1-equivalent behavior) to
   directly demonstrate the widening is backward-compatible, not just
   argued to be.
5. **`does_not_reject_legitimate_observations_during_a_converging_pass_sequence`
   — required, flagged by nixos-dev's review, not originally in this
   plan.** The opposite failure mode K=4 introduces that K=1 structurally
   cannot: near the end of a genuinely successful correction sequence, the
   cursor is REPEATEDLY observed within a few px of the target as it
   converges — "close to a reading from a few passes back" is also
   exactly what real convergence looks like, not just a stale-cluster
   repeat. K=1 can't false-positive this way (only ever compares to the
   single immediately-preceding reading, and a converging sequence is
   monotonically approaching, not literally repeating a point); K=4 can.
   None of tests 1-4 above exercise this — they prove the guard catches
   the bug and stays bounded, not that it leaves legitimate convergence
   alone. No real recorded multi-pass legacy-path trace was found in this
   repo to build this from directly (checked: no saved
   `legacy_move_smoke.rs` diagnostics/verbose log survives past its
   original live run; the N=80 bench used curve-one-shot, which doesn't
   call this guard at all, so it has no relevant intermediate-observation
   data either) — build from a realistic SYNTHETIC converging trace
   instead, e.g. target ~(500, 500) with passes at (550, 540) → (510,
   505) → (502, 501) → (498, 499) → (500.5, 500.2), each pass separated
   by a real emit ≥30 mickeys (the default `min_emit_mickeys`) so the
   emit gate doesn't trivially suppress the check. By the last 2-3
   passes, consecutive AND non-consecutive readings are legitimately
   within `drift_px` (5px default) of each other purely because the
   trajectory has converged — assert every one of these observations is
   ACCEPTED (not rejected) by `observe(..., ObserveOptions{reject_stationary:
   true, ..})`. This is the test that actually proves "changes real
   behavior" doesn't mean "regresses currently-successful convergence,"
   which was this plan's real gap, not just an unproven bug fix.

## Scope boundary — explicitly NOT touched

- `curve-one-shot` (the validated, production iPad path) does not use
  this correction loop or this guard at all (CLAUDE.md: "the MOVER is
  SOLVED — do NOT touch it"). This change only affects
  `legacy_move.rs`'s detect-then-move/slam-then-move path, already
  documented as materially less reliable than curve-one-shot (~73px vs
  ~9px median). Zero risk to the iPad-critical path.
- No change to the TS original in this pass — this is scoped to the
  Rust port only, per the task's own framing ("a genuine pre-existing
  reliability gap," not a porting regression to silently fix mid-port).
  Whether to backport the same widening to `cursor-belief.ts` is a
  separate call for whoever owns that side, flagged here but not decided.

## Live-hardware validation, once built

Per this session's own standing discipline, an offline-green test suite
does not alone qualify this as done. Once implemented and reviewed:
re-run `legacy_move_smoke.rs` (or an equivalent multi-pass correction
scenario) against the real iPad and confirm the SAME class of stale-pair
bug (a correction pass locking onto an N-pass-old cluster) no longer
reproduces — ideally by deliberately engineering a scenario similar to
the original bug's trace (a real ML-recovery detour between two similar
clusters), not just trusting the new unit tests.

## What I'm asking nixos-dev to review

1. Is K=4 the right window size, or should it be derived from
   `legacy_move.rs`'s actual max correction-pass count instead of a fixed
   constant?
2. Is keeping the emit-gate semantics unchanged (since-most-recent, not
   since-the-matched-entry) the right call for this first cut, or does
   that leave a real gap worth closing in the same pass?
3. Any additional existing test (beyond the 13 enumerated) that could be
   affected, that a fresh read might catch that I missed?
4. Any concern about ring-buffer overhead on this hot path (it's O(K)
   per call, K=4, but a fresh set of eyes on "is this actually
   negligible" is worth having before committing to it).
