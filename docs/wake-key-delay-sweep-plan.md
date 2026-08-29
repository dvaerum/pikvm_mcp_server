# Plan: wake-key delay sweep (2s/4s/8s idle-delay, controlled)

**Status: DRAFT, for review by pikvm-mcp-server@nixos-developer-system
before any implementation.** Follow-up to
`docs/wake-key-isolated-experiment-plan.md`'s RESULTS section
(2026-08-29) — this plan does NOT re-litigate that experiment's own
scope or recovery ladder, only the controlled follow-up it recommended.

## The question this isolates

Today's isolated wake-key experiment found a genuinely MIXED result
(A/B/inconclusive/A/A across 4 trials + 2 ad-hoc checks) and falsified
its own opening framing ("1st press wakes clean, 2nd press escalates") —
trial 1's very first isolated press already gave outcome B (Touch ID).
Looking at what actually varied across those 6 data points, a real
candidate variable emerged: **how long the lock screen's backlight had
been sitting idle at the moment of the `Space` press**, not press count.
Concretely:

- Two SHORT-elapsed presses (~3-4s after a lock/wake action) leaned B
  (Touch ID escalation).
- Two LONG-elapsed presses (after a genuine ~65s+ dark period, and again
  after tens of idle seconds on an already-lit lock screen) both gave A
  (plain lock screen, the hoped-for outcome).

This is circumstantial — N=4 informal, not a controlled sweep, and the
"tens of idle seconds" data point had no measured delay at all (it was
however long an unrelated tool-call round-trip happened to take). This
plan is the controlled version: hold every other variable fixed, vary
ONLY the elapsed delay before the `Space` press, across a small number of
concrete values, and see whether the A-vs-B split tracks delay
cleanly enough to trust as a real mechanism (vs. genuinely random, which
the original plan's own contingency section already anticipated as a
real possibility).

## Two distinct starting conditions — do not conflate them

Re-reading today's own trials precisely, there are actually TWO different
scenarios that got tangled together, and this sweep should test the
scenario that's actually uncertain, not both:

- **(a) Screen genuinely OFF (no video signal) → `Space` → wakes to a
  plain lock screen.** This happened reliably 2/2 times today (both
  ad-hoc dark-state checks). Not the open question — no evidence of
  failure here, not worth spending sweep trials on.
- **(b) Screen already ON, showing a plain lock screen → `Space` →
  sometimes Touch ID (B), sometimes plain lock again (A).** This is the
  genuinely uncertain case, and the one the delay sweep should target:
  hold the screen-already-lit precondition constant, vary only how long
  it's been lit before the press.

## Exact sequence, per trial

One continuous process per trial (matching this session's own
established "don't split a wake-then-observe sequence across a process
boundary" finding), reusing `wake_key_experiment.rs`'s existing structure
with ONE new parameter (the delay) inserted between lock-confirm and the
`Space` press:

1. Screenshot #1 (baseline) — best-effort, informational only.
2. Send `Ctrl+Cmd+Q` (lock).
3. Sleep ~2.5s (matches the tool's documented "screen should turn off
   within 2s" and today's harness).
4. Screenshot #2 — confirm a genuine plain lock screen (ground truth is
   the image itself, not any flag). If this capture fails after 3
   retries, ABORT the trial without sending `Space` — same fail-closed
   behavior as today's harness, already live-verified once.
5. **NEW: sleep exactly `DELAY_S` seconds** (the swept parameter: 2, 4,
   or 8) — this is condition (b) above: the screen is confirmed lit and
   locked, and now sits idle for a controlled, known duration before the
   press.
6. Send **exactly one** `Space` press.
7. Sleep 1.5s (today's live-confirmed settle time).
8. Screenshot #3 — the result, classified by eye (A/B/C, same
   definitions as the original plan), same 3x/1s capture-only retry.
9. **STOP.** No slam, no `anchor_cursor`, no corner anywhere near this,
   regardless of outcome.
10. Recovery per outcome, same ladder as before: A needs nothing extra;
    B needs `unlock_ipad()` first, escalating to
    `unlock_ipad_with_code()` with the stored `PIKVM_IPAD_PASSCODE` if
    that doesn't clear it (proven necessary 2/2 times today — this
    rig has Touch ID + a real passcode, corrected from the original
    plan's wrong "no-passcode" premise); C needs no corrective action.
    Always re-screenshot after recovery to confirm, never trust the
    tool's own return value alone (already caught being insufficient
    once today).

## Trial count and ordering

3 trials per delay value (2s, 4s, 8s) = 9 trials total, matching today's
established "3-5 trials is the right scale for a binary classification
question, not 20+" judgment, split three ways. Run delays in this order:
**8s, 4s, 2s** (longest first) — if 8s already shows a clean A/A/A, the
shorter values are the more informative ones to spend remaining trials
on (confirming where the split actually sits, not re-confirming the
long-delay end which today's ad-hoc data already leans A on). If 8s does
NOT show a clean A/A/A, that's itself an important, cheap-to-learn result
(the real threshold, if one exists, is longer than 8s — don't keep
guessing further doubling values in the same session without checking
back in, since this is meant to be a small, low-risk follow-up, not an
open-ended search).

## Outcome classification and what a clean vs. messy result means

Same A/B/C definitions as the original plan (plain lock screen / Touch
ID prompt / fully unlocked), classified by eye from the saved screenshot,
never inferred from log text.

- **Clean threshold** (e.g., 2s and 4s lean B, 8s leans A, or similar):
  supports the timing-confound hypothesis. Next step: the combined
  guard/slam gate (categories 2/5) should insert a deliberate delay past
  the observed threshold before its own `Space` press, rather than
  defaulting to the mouse-move fallback.
- **All three delays give the same outcome** (all B or all A): the
  8s ceiling either isn't long enough to reach the threshold (if all B)
  or the threshold is shorter than 2s / doesn't exist and something else
  explains today's split (if all A, which would contradict trial 1's
  short-delay B and deserves a closer look at what else differed in
  trial 1, e.g. it followed immediately after a `Ctrl+Cmd+Q` lock command
  itself, not a separate prior wake). Either way: don't conclude "random"
  from 9 trials at 3 discrete points — report the shape honestly and
  let a human decide whether a wider/different sweep is worth it.
- **Genuinely mixed within a single delay value** (e.g., 8s gives 2×A,
  1×B): real evidence the mechanism ISN'T purely delay-determined, or
  that some other uncontrolled variable (exact idle time before the
  ORIGINAL lock command, e.g.) still matters. Report as such, don't
  force a clean story onto noisy data.

## What this answers vs. doesn't

**Answers**: whether the A-vs-B split for condition (b) (`Space` on an
already-lit lock screen) is a function of elapsed idle time, in a way
precise enough to either (a) recommend a specific minimum delay for the
combined guard/slam gate's wake step, or (b) conclude the delay
hypothesis doesn't hold cleanly and the mouse-move fallback should become
the default wake mechanism instead, full stop.

**Does NOT answer**: condition (a) (waking from a genuinely dark
screen) — already looks reliable, not re-tested here beyond incidental
confirmation. Does not re-litigate `AnchorGuard`, `CallerAsserted`,
`slam_calls`, or any guard/slam-adjacent logic — out of scope, same as
the original experiment.

## Implementation scope

Small, additive change to the existing `wake_key_experiment.rs`: add a
`DELAY_S` CLI argument (or a second positional arg alongside the
existing trial number), inserted as step 5 above. No new dependencies,
no changes to `ipad_unlock.rs`/`cursor_anchor.rs`/any guard logic. Not
running live until this plan is reviewed, matching every other design
change this session.

## What I'm asking nixos-dev to review

1. Is 3 trials × 3 delay values (9 total) the right scale, or does the
   "don't stack more live contact than needed" concern from earlier
   today argue for fewer (e.g., 2 per value, 6 total) as a first pass,
   escalating only if the result is ambiguous?
2. Is the 8s-first ordering the right call, or is there a reason to
   randomize/vary order to avoid a systematic confound (e.g., cumulative
   iPad state drifting across the whole run regardless of delay)?
3. Anything about distinguishing condition (a) vs (b) that's underspecified
   — in particular, is "screen confirmed lit via screenshot #2" a
   reliable enough proxy for "the lock-screen's own backlight-dim timer
   hasn't fired yet," or could screenshot #2 itself succeed even after
   the backlight has already started dimming (i.e., is there a risk this
   sweep's DELAY_S=0 baseline is already past some threshold, making the
   whole 2/4/8s range moot)?
