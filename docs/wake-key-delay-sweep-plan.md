# Plan: wake-key delay sweep (2s/4s/8s idle-delay, controlled)

## RESULTS (2026-08-29, run live)

**Status: RUN LIVE — genuinely informative, though d4 came back
unresolved.** Interleaved round-robin per the reviewed design: 2/1,
4/1, 2/1's own escalations as needed, ending at 8 trials total (2 each
for d2, 3 each for d4 and d8 after escalation).

**Final tally**:
- **d2 (2s delay): 2/2 clean B** (Touch ID prompt), no disagreement, no
  escalation needed.
- **d8 (8s delay): 2 clean A + 1 inconclusive** (torn capture on
  screenshot #3; circumstantial cleanup evidence leaned B, but see the
  methodology note below on why that's now known unreliable) — escalated
  to a 3rd trial per the disagreement rule, both round-2 and round-3
  trials came back clean A. Leans A.
- **d4 (4s delay): 3/3 INCONCLUSIVE** — every single attempt's
  screenshot #3 came back torn (the documented capture-race artifact:
  correct partial fragment + solid colour fill), including after
  escalating to a 3rd trial. Genuinely unresolved after the plan's own
  escalation budget; not chasing a 4th attempt today (open-ended
  retrying isn't what "escalate once on disagreement" means). Whether
  this is small-sample bad luck or something real about the 4s mark
  landing on a capture-fragile moment is an open question, not resolved
  here — reporting the shape honestly rather than forcing a guess.

**Shape of the result**: short delay (2s) → clean B every time; long
delay (8s) → clean A both times it could be classified; middle delay
(4s) → uninformative (torn every time). This is CONSISTENT with the
timing-confound hypothesis (a real threshold somewhere between 2s and
8s) but does not pin down the threshold precisely, since the one value
that could have narrowed it down (4s) never produced a classifiable
result.

**Free signal check (nixos-dev's Q3 answer, reviewed)**: screenshot #2
(the confirm-lock shot) showed the SAME full-brightness, crisp
appearance across every single trial, d2/d4/d8 alike — no visible
relative dimming difference was ever observed at nominal t=0. This is a
real (negative) data point: whatever the backlight-dim timer's real
threshold is, it hadn't visibly started by the time screenshot #2 was
captured in ANY trial, at least not detectably by eye.

**Real methodology finding, not anticipated in the plan**: `unlock_ipad()`'s
own cleanup step can ITSELF escalate a genuine plain-lock-screen (A) into
the Touch ID prompt (B) — observed directly in d8's 3rd trial: screenshot
#3 was unambiguously A (confirmed by eye), but the cleanup screenshot
taken moments later (after `unlock_ipad()`'s own Escape→Enter→Space
sequence ran) showed Touch ID. This means the cleanup/circumstantial
screenshot is NOT a reliable stand-in for a torn screenshot #3 — a
torn result must be reported as genuinely inconclusive, full stop, not
inferred from what the cleanup step incidentally shows afterward (this
plan's own earlier informal circumstantial reads on d8-r1/d4-r1/d4-r2
should be read with this caveat — they were reasonable guesses at the
time but are now known to rest on an unreliable signal).

**Recommendation**: the shape (2s→B, 8s→A) is suggestive enough to
recommend the combined guard/slam gate's wake step use a delay closer to
8s than 2s before its `Space` press, but NOT to treat this as a fully
pinned-down threshold — the 4s data point that would have narrowed it
down never resolved. If the combined gate needs a precise value rather
than "closer to 8s," a follow-up sweep at finer granularity (e.g. 5s/6s/
7s) with a LONGER post-press settle before screenshot #3 (to reduce the
torn-frame rate that sank d4 here) would be the next real step — not
required before deciding "use something like 8s, not 2s" as an interim
default.

Committed alongside the harness at `<pending>` (see
`docs/rust-port-plan.md`'s journal for the exact commit).

---

*(Below: the original reviewed plan, preserved as the historical record
of what was designed and why — superseded by the RESULTS section above,
not rewritten.)*

Follow-up to
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

**Measured vs. nominal delay (nixos-dev review, incorporated)**: the true
elapsed idle time from lock to press is ~2.5s (step 3) + variable
screenshot #2 capture time (near-zero to several seconds on a retried
capture) + `DELAY_S` — and since the swept values are only 2s apart,
capture jitter could be the same order of magnitude as the effect being
measured. Record real timestamps (not `Instant`/wall-clock read via
`Date.now()`-equivalent is fine here, this isn't the workflow-script
`Date.now()` restriction) at "screenshot #2 capture succeeded" and
"`Space` sent," and log the ACTUAL measured gap per trial alongside the
nominal `DELAY_S` label — so if jitter matters, it's visible in the data,
not silently smeared into a bucket.
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

**Trial count (nixos-dev review, incorporated)**: start smaller — 2
trials per delay value (6 total), escalating to a 3rd only for a value
whose 2 trials disagree (A vs B) — matching this project's own
established "escalate only if ambiguous" pattern (category 1's
N≥20→N≥80 rule), and appropriate given the rig's documented wear pattern
from today's session.

**Ordering (nixos-dev review, incorporated — reversed from the original
draft)**: NOT blocked by delay value. Testing 8s-then-4s-then-2s as
three separate blocks confounds "delay value" with "how far into this
session's cumulative live-hardware contact we are" — the same SHAPE of
problem that produced this whole follow-up (press-count vs elapsed-idle-
time got tangled in the original experiment). A clean 8s→A/A followed by
a messy 2s block could mean "2s is below threshold" OR just "the rig
drifted partway through." Fixed: **interleave/round-robin** —
8,4,2,8,4,2(,8,4,2 if escalating) — so delay and session-progression
aren't collinear. Same trial budget, no extra cost.

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

## Review (nixos-dev, incorporated above) — status: REVIEWED, ready to build

All 4 original questions resolved:

1. **Trial count**: start at 2/value (6 total), escalate to 3 only on
   disagreement — incorporated above.
2. **Ordering**: interleaved/round-robin, not blocked by delay value —
   incorporated above (this was the concern nixos-dev pushed back on
   hardest; fully agreed, costs nothing extra).
3. **Is capture-succeeding a reliable dim-timer proxy?** No — but no new
   mechanism is needed to check it. The by-eye classification already
   being done on every screenshot should ALSO note visible relative
   dimming in screenshot #2 (the confirm-lock shot, right before the
   `DELAY_S` sleep starts) across trials — free signal from data already
   being collected. If screenshot #2 already looks visibly dimmer in some
   trials than others at nominally-t=0, that answers whether the
   backlight timer had already started before the sweep's own clock
   begins. Incorporate into the by-eye review step (§ "Outcome
   classification"): classify screenshot #2's OWN brightness qualitatively
   (full-brightness / visibly dimmed) alongside screenshot #3's A/B/C,
   not just the latter.
4. **Delay precision**: log actual measured wall-clock gap, not just the
   nominal label — incorporated above.

Ready to build per this revised version. No open questions remaining.
