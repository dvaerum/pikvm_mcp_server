# Plan: targeted live re-confirmation of the stationary-guard widening (K=4)

**Status: DRAFT, for review by pikvm-mcp-server@nixos-developer-system
before any execution.** Follow-up to
`docs/would-reject-as-stationary-widening-plan.md` (implemented,
committed `097e4ec`) — that plan's own live re-validation attempt
(2026-08-29, via a generic `legacy_move_smoke.rs` re-run) came back
inconclusive: it exercised the legacy path genuinely, but surfaced a
DIFFERENT failure mode (a motion-diff pairing failure), not the specific
2-passes-back stale-cluster match the K=4 widening was built to catch.
This plan is the deliberate, targeted version georg asked for — not
"run the mover and hope," but a real attempt to land on the exact
conditions that produced the original bug.

## The exact original bug, read from its own ground truth

From `docs/rust-port-plan.md`'s §8 item 7 finding (2026-08-29,
`legacy_move_smoke.rs`, target `(1050,850)`,
`strategy=detect-then-move`, `forbidSlamFallback=true`), reproduced here
precisely since this plan depends on it:

- The run went through multiple correction passes before exhausting its
  budget.
- One EARLIER correction pass's motion-diff `post`-cluster centroid
  landed at **(1085,981)** — visually, this is in the dock-icon area
  (Notes/Settings/app-drawer row).
- A LATER pass, in between, genuinely observed a different, real
  ML-recovered position at **(1020,662)** — this became
  `CursorBelief`'s single most-recent observation under the OLD
  (pre-widening) design.
- The FINAL correction pass's motion-diff then picked a candidate at
  **(1092,979)** — nearly identical to the (1085,981) dock-icon cluster
  from several passes earlier, NOT to the (1020,662) most-recent one.
  `wouldRejectAsStationary`'s old single-slot check compared only
  against (1020,662), found it clearly different, and accepted the
  stale (1092,979) candidate as the final "verified" position — which
  was wrong (the real cursor, confirmed visually, was at ~(1045,690),
  nowhere near either dock-icon reading).

**Why this specific spot is the mechanism, not a coincidence**: a dock
icon cluster is a plausible repeat offender because it's a real,
static, high-contrast, cursor-sized-looking feature sitting in a fixed
screen location — exactly the kind of achromatic motion-diff false
positive this guard exists to catch when it recurs across NON-adjacent
passes. This is a real, evidence-grounded starting point, not an
arbitrary new target.

## Reproduction approach

**Re-run the SAME scenario**: same target `(1050,850)`, same
`strategy=detect-then-move` + `forbidSlamFallback=true`, same real home
screen (the dock-icon layout hasn't changed). This is the one scenario
already known — not hoped, KNOWN — to produce a multi-pass correction
loop that revisits a static dock-icon-area cluster. Re-running it is a
real attempt at the exact conditions, not "run the mover on an arbitrary
target and see what happens."

**Honest caveat, stated up front**: correction-loop behavior is
genuinely somewhat run-dependent (real detector/timing variance means
the exact same target won't necessarily reproduce the identical pass
sequence every time). This plan does NOT claim a repeat run is
guaranteed to re-hit the exact stale-cluster scenario — it claims this
is the best-evidenced attempt available, and the new instrumentation
below (not just the final position) is what actually lets a run be
judged, whichever way it goes.

## New instrumentation: make the guard's own firing directly observable

The real gap in the previous attempt wasn't the target choice alone —
it's that `legacy_move.rs` never LOGS whether `would_reject_as_stationary`
fired, only its downstream effect (does the final position look right).
Without direct visibility into the guard's own decision, a run can only
ever be judged indirectly (was the ending position correct), which is
exactly why the previous attempt's "different failure mode" reading was
ambiguous to interpret.

**Fix**: add one `eprintln!` (gated behind the existing `verbose: bool`
already threaded through `legacy_move.rs`, so this is zero-cost/silent
in production) at BOTH existing `would_reject_as_stationary` call sites
(`legacy_move.rs`'s open-loop-phase check around line 382, and its
correction-pass check around line 746), printing the candidate point and
the boolean result. This turns "did the K=4 ring catch a stale cluster"
into something directly readable from the run's own log, independent of
whether the final landing happens to look right or wrong — e.g., a run
could have the guard correctly fire (`true`) on a stale candidate BUT
still end up somewhere imperfect for an unrelated reason (matching the
"legacy path is lower-reliability generally" caveat this plan doesn't
re-litigate), and the log would make that distinction visible instead of
conflating "guard fired correctly" with "the whole pass looked clean."

## Exact sequence

1. Health-check: confirm the real, unlocked home screen via screenshot,
   same discipline as every other live gate this session.
2. Add the two `eprintln!` lines described above to `legacy_move.rs`
   (code-only, reviewed before running).
3. Run `legacy_move_smoke.rs -- 1050 850` (the exact original target),
   `verbose: true` (already the harness's default), capturing full
   stdout.
4. **Regardless of outcome**, screenshot-confirm the real final cursor
   position (this project's own established discipline — never trust
   the algorithm's self-report alone).
5. Read the log for every `would_reject_as_stationary` line:
   - If the log shows `true` for a candidate near a previously-seen
     position that ISN'T the single most-recent one (the exact 2+-
     passes-back pattern) → the K=4 fix is DIRECTLY confirmed firing on
     its own target scenario. Cross-check the final position is correct
     (or at least not the specific stale-cluster position) to confirm
     it had the intended effect.
   - If the log shows no rejections at all, and the final position is
     correct → the specific bug scenario simply didn't recur this run
     (honest non-event, not a failure of the guard — report as such, not
     as a "pass").
   - If the log shows a rejection but the final position is STILL wrong
     (for an unrelated reason, e.g. the motion-diff pairing failure the
     previous attempt hit) → the guard fired correctly but something
     else in the legacy path failed independently; report both facts
     separately, don't let one obscure the other.
6. No slam risk: `forbidSlamFallback=true` makes this structurally
   incapable of reaching `slam_to_corner`, same safety profile as the
   original v18 run and the previous re-validation attempt — this is
   LOWER risk than categories 2/5, not comparable to the corner-control
   gate.

## What this answers vs. doesn't

**Answers**: whether the K=4 widening's own target failure mode (a
candidate matching an observation 2+ passes back, not the single most
recent one) can be directly observed firing on the real hardware, using
the exact scenario already known to have produced it once.

**Does NOT answer**: the legacy path's overall reliability (already
known lower vs. `curve-one-shot`, out of scope, not what this guard is
for) or anything about `curve-one-shot`/categories 2/5/the corner-control
gate — entirely separate code paths, no shared mechanism (already
confirmed via `grep`, see the sign-off plan's own §5).

## What I'm asking nixos-dev to review

1. Is re-using the exact original target/strategy the right call, or is
   there a reason to suspect the home screen layout or detection
   behavior has drifted enough since the original incident that this
   specific repro is no longer likely to recur, making a different
   approach more promising?
2. Is logging at both call sites (open-loop AND correction-pass) the
   right scope, or should this be narrower/wider?
3. Anything about the "guard fired but final position still wrong for
   an unrelated reason" outcome class that needs a different reporting
   treatment than proposed above?
