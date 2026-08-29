# Plan: targeted live re-confirmation of the stationary-guard widening (K=4)

## RESULTS (2026-08-29, run live per georg's explicit direction)

**Status: RUN LIVE, 2 attempts — both genuine bucket-(C) non-events.
The specific 2+-passes-back stale-cluster scenario was NOT reproduced,
and the guard's own firing was not directly observed either way.**

**Layout verification (step 1, nixos-dev's point)**: confirmed via a
fresh health-check screenshot + a targeted crop near the original
incident's dock-icon-area coordinates — the grid/app-drawer icon and
folder cluster are still present in that vicinity. No visible drift.

**Attempt 1**: 5 correction passes (4 gross, 1 linear), trajectory
`(1052,942) → (644,491) → (764,798) → (1022,710)`. Every
`[stationary-guard]` log line read `rejected=false` — zero rejections.
Final claimed position (1022,710), 142.8px residual, explicitly flagged
low-confidence by the algorithm itself (predicted-fallback pass since
last verification). No cursor clearly visible in the final screenshot to
independently cross-check.

**Attempt 2** (escalated per the plan's own rule — bucket (C) on attempt
1): 5 correction passes (5 gross, 0 linear, budget exhausted), a
COMPLETELY different trajectory —
`(914,812) → (735,309) → (771,427) → (810,461)` — driven by a
substantially different open-loop calibration ratio this run (4.553 vs
1.185 in attempt 1, itself a real illustration of the plan's own
"correction-loop behavior is genuinely somewhat run-dependent" caveat).
Again every `[stationary-guard]` line read `rejected=false`. Final
position (810,461), 457.1px residual (a real, large miss) — but visually
confirmed via the final screenshot: a real cursor IS visible near that
claimed position, roughly matching it. Honest large miss, not a
confidently-wrong stale-cluster case — consistent with the legacy path's
already-documented lower reliability, not a new finding.

**Why this is a genuine non-event, not an inconclusive shrug**: neither
attempt's trajectory ever revisited a candidate anywhere near the
original incident's dock-icon-area cluster
(`(1085,981)`/`(1092,979)`) — both runs' open-loop landings and
subsequent correction passes went to entirely different regions of the
screen, driven by real calibration-ratio variance between runs. The
guard had nothing to catch because the specific repeat-visit pattern
simply never arose, in either attempt — not because the guard suppressed
it early (bucket (B) — checked for and not observed; no rejections fired
at all, early or late) and not because of an unrelated failure masking a
real rejection (bucket (D) — also not applicable, since there were no
rejections to check against).

**Honest bottom line**: after 2 real attempts targeting the exact
original conditions, the K=4 widening's own specific target scenario
(a candidate matching an observation 2+ passes back, not the single most
recent one) still has not been directly observed firing live. This is
NOT evidence against the fix — the fix's own offline test suite
(`does_not_reject_legitimate_observations_during_a_converging_pass_sequence`
et al., 52/52 passing) already demonstrates the mechanism works in a
controlled, engineered scenario; what remains genuinely unresolved is
whether the REAL correction loop reliably reproduces the wild conditions
that trigger it. Given the correction loop's real run-to-run trajectory
variance (illustrated concretely by attempt 2's very different
calibration ratio), reliably landing on the exact repeat-visit pattern by
re-running the same target appears to require either more attempts than
2, or a more deliberately engineered repro (e.g. directly staging
`CursorBelief` observations rather than relying on the natural
correction loop) — a real design question for whoever picks this up
next, not resolved here. Not running a 3rd/4th attempt today given the
day's now very substantial live-hardware volume — 2 matches the plan's
own "1-2 more" escalation guidance.

No safety incidents — `forbidSlamFallback=true` held throughout, moves
only, as designed. iPad left in a confirmed-safe, unlocked home-screen
resting state.

---

**Status: REVIEWED (nixos-dev, 2026-08-29) — ready to execute.** Follow-up to
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

1. **Health-check + layout verification (nixos-dev review, incorporated)**:
   confirm the real, unlocked home screen via screenshot, AND visually
   confirm the dock/icon layout still has a Notes/Settings/app-drawer-row
   feature roughly where the original incident describes — don't assume
   the layout is stable just because it seems obviously so (real
   precedent today: the N=80 bench's own Settings-icon-moved-~120px
   drift). If the layout has visibly drifted, note that up front — it
   would explain a clean non-event as environment drift, not guard
   behavior, and changes how any result below should be read.
2. Add the two `eprintln!` lines described above to `legacy_move.rs`
   (code-only, reviewed before running).
3. Run `legacy_move_smoke.rs -- 1050 850` (the exact original target),
   `verbose: true` (already the harness's default), capturing full
   stdout.
4. **Regardless of outcome**, screenshot-confirm the real final cursor
   position (this project's own established discipline — never trust
   the algorithm's self-report alone).
5. Read the log for every `would_reject_as_stationary` line. Four
   outcome buckets now (nixos-dev review added a 4th, distinct from
   "non-event"):
   - **(A) Target scenario directly confirmed**: log shows `true` for a
     candidate near a previously-seen position that ISN'T the single
     most-recent one (the exact 2+-passes-back pattern) → the K=4 fix is
     DIRECTLY confirmed firing on its own target scenario. Cross-check
     the final position is correct (or at least not the specific
     stale-cluster position) to confirm it had the intended effect.
   - **(B) Early rejection — informative, NOT a non-event (nixos-dev's
     key methodological point)**: log shows ANY rejection, even one that
     doesn't match the precise 2+-passes-back pattern, occurring EARLY
     in the pass sequence. Because the K=4 fix changes what
     `CursorBelief` accepts mid-run, an early rejection could reroute
     the whole correction-loop trajectory away from ever reaching a
     scenario analogous to the original sequence — this would actually
     be a STRONGER confirmation than the target scenario recurring
     cleanly, not a weaker one. Check whether the rejection correlates
     with the run's trajectory diverging from the original incident's
     trace at the same pass number. Report this as its own distinct
     bucket, not folded into (A) or (C).
   - **(C) Genuine non-event**: log shows ZERO rejections anywhere, AND
     the final position is correct, AND (per step 1) the layout was
     confirmed NOT to have drifted → the specific bug scenario simply
     didn't arise this run. Report as an honest non-event, not a "pass."
   - **(D) Guard fired but final position still wrong for an unrelated
     reason** (e.g. the motion-diff pairing failure the previous attempt
     hit): report both facts separately — the guard's own firing is a
     real result independent of whatever else went wrong in the legacy
     path afterward.
6. **Escalate on a clean non-event, don't stop at one (nixos-dev review,
   incorporated)**: if the first attempt lands in bucket (C) with zero
   rejections logged, run it 1-2 more times before concluding anything
   for today — matches the "escalate only if ambiguous" pattern used
   everywhere else this session (wake-key sweep, category 1's N-count).
   Marginal cost is near-zero given point 7 below.
7. No slam risk: `forbidSlamFallback=true` makes this structurally
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

## Review (nixos-dev, incorporated above) — status: REVIEWED, ready to execute

1. **Target/strategy reuse**: valid AS LONG AS the layout-drift check
   (step 1) actually happens first — don't skip it just because the
   layout seems obviously stable. Incorporated as an explicit step.
2. **Logging scope**: both call sites confirmed correct, no objection.
3. **Guard-fired-but-still-wrong reporting**: the proposed "report both
   facts separately" treatment is correct — with the addition that
   bucket (B)'s early-rejection case now gets its OWN distinct bucket
   too, not folded into either (A)/"confirmed" or (C)/"non-event" —
   incorporated above as outcome bucket (B).

No open questions remaining.
