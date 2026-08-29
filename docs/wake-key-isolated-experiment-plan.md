# Plan: isolated wake-key experiment (Space-once lock-screen behavior)

## RESULTS (2026-08-29, run live per manager's standing authorization)

**Status: RUN, genuinely mixed result — NOT a clean A/A/A or B/B/B. Two real
findings, one correcting this plan's own premise.**

Harness: `rust/mover/examples/wake_key_experiment.rs` (built per this plan,
clippy/fmt clean), plus 2 ad-hoc single-Space checks run directly via REST
when a genuine video-dark blocker (see below, unrelated root cause) made
the compiled harness's fixed retry timing not fit the situation.

**Correction to this plan's own premise**: the "no-passcode iPad" assumption
(stated above, sourced from `ipad-unlock.ts`'s docs) is WRONG for this rig.
Screenshots from every trial show a genuine Touch ID prompt with "Use
Passcode"/"Cancel", and `unlock_ipad_with_code()` with the stored
`PIKVM_IPAD_PASSCODE` recovered it cleanly twice, confirmed visually both
times (not just via the tool's return value). This device has Touch ID +
a real passcode configured. Flagging so this doesn't get re-asserted as
fact in a future session.

**Trial-by-trial**:
- Trial 1: baseline dark (503, informational-only per plan) -> `Ctrl+Cmd+Q`
  -> screenshot #2 confirmed a genuine plain lock screen (outcome A) ->
  single `Space` (~3-4s after the lock command) -> screenshot #3 showed a
  genuine Touch ID prompt (**outcome B**). Recovered via passcode, confirmed
  visually.
- Trial 2: screenshot #2 and #3 both came back solid-black (torn/capture-
  race frames per this session's own documented artifact class) — correctly
  logged as INCONCLUSIVE, not force-classified, per this plan's own rule.
  The cleanup screenshot afterward showed a Touch ID prompt, circumstantial
  (not proof) that the underlying trial-2 outcome was also B. Recovered via
  passcode again, confirmed visually.
- Trial 3: aborted correctly by the harness's fail-closed design — post-lock
  capture 503'd 3/3 retries, so NO Space was sent (exactly as designed).
  Manual polling afterward found video genuinely still dark for ~65s+ total
  (11+ retries) — a real, extended video-source dropout, same class as an
  earlier blocker this session (root-caused separately by nixos-dev as the
  iPad's screen going properly to sleep, not a hardware fault).
  - Sent one manual `Space` from that confirmed-dark state (not corner-
    adjacent, matches this plan's own low-risk framing) -> screen came back
    as a genuine **plain lock screen (outcome A)**.
  - To directly test whether "already-awake" vs "genuinely dark" is the
    real variable (not press count), sent a SECOND single `Space` from that
    just-confirmed plain-lock-screen state, tens of seconds later -> result
    was **plain lock screen again (outcome A)**, not Touch ID.

**Reading the results honestly**: this is genuinely MIXED (A, B/inconclusive-
leaning-B, A, A) — not a clean signal either way. The simple "1st press
always wakes-without-dismiss" framing this plan opened with is falsified
(trial 1 got B on what should have been the "wakes clean" case by that
framing). But it is NOT simply random either: the two short-elapsed-time
presses (trial 1's Space at ~3-4s after the lock command; trial 2 likely
similar) both leaned B, while the two long-elapsed-time presses (after a
~65s+ genuine dark period; and again after ~tens-of-seconds idle on an
already-lit lock screen) both gave A. This is circumstantial, N=4, not
proof — but it's consistent with nixos-dev's own flagged timing-confound
concern: the real variable may be **how long the lock screen's own
backlight had been sitting idle at the moment of the press** (a shorter
internal dim/re-sleep timer than the full device Auto-Lock), not "is this
the 1st or 2nd key event since lock." A press while the screen is still
freshly lit reads as an unlock attempt (B); a press after the screen has
had time to dim again reads as a wake (A) even though the device never
stopped being logically locked throughout.

**What this means for the combined guard/slam gate**: per this plan's own
"what this answers" section — a genuinely mixed result means don't trust
Space-once as the default wake mechanism without a deliberate delay, and
the mouse-move fallback (already built into
`cursor_anchor_corner_control_smoke.rs`) is the safer default until the
timing-confound hypothesis above is confirmed with a properly delay-varied
protocol (2s/4s/8s explicit waits before the press, matching this plan's
own contingency section) — which this run did NOT cleanly execute (the
long-delay trials were opportunistic, not a controlled sweep). Recommending
that controlled sweep as the actual next step if this mechanism needs to be
trusted again, rather than treating today's N=4 as final.

---

**Status: DRAFT, for review by pikvm-mcp-server@nixos-developer-system before
any implementation. NOT TO BE RUN LIVE TODAY** — the team's own call to
fully rest the iPad rig today stands (task_69cd3362e1da). This plan and its
review can happen today; actual execution waits for a genuinely fresh
session.

## The question this isolates

Does a single `Space` key press wake a genuinely-locked iPad (this rig's
specific NO-PASSCODE configuration) to a **visible, still-locked** screen,
or does it reliably escalate straight to the Touch ID/passcode prompt?

This question got tangled into today's combined category-2/category-5 live
gate three separate times, each time producing the SAME outcome (Touch ID
prompt, not the plain lock screen) regardless of the device's starting
state (confirmed-already-locked, and separately from an unverified/unknown
starting state) — but each attempt was also carrying the guard/slam/
recovery logic in the same run, so the two questions ("does the wake
mechanism behave as assumed" and "does the guard/slam logic work") never
got cleanly separated. The guard/slam/recovery logic's OWN safety behavior
held perfectly 3/3 times (fail-closed correctly, zero HID near a corner
every time) — this experiment is about the wake key alone, not a
re-litigation of that.

## Sourced assumption being tested

`ipad-unlock.ts`'s `unlockIpadWithCode` documents (lines 560-614, per
nixos-dev's citation during today's review): a single `Space` press wakes
the screen still-locked; a second press (or `Enter`, documented at
`ipad-unlock.ts:62` as "the actual unlock key on iPadOS 26 lock screens")
dismisses it. nixos-dev flagged real, honest uncertainty about whether this
holds identically on a device with **no passcode configured** (this rig's
documented default) versus the passcode-gated device that source was
presumably written against. That uncertainty has not actually been
resolved by today's three attempts — it's been re-encountered, not tested
in isolation.

## Exact minimal sequence

One single continuous process, matching this session's own established
"don't split a wake-then-observe sequence across a process boundary — the
window closes faster than a human can react" finding:

1. Screenshot #1 (baseline) — best-effort, informational, matches this
   session's own established pattern for this step.
2. Send `Ctrl+Cmd+Q` (same shortcut `pikvm_ipad_lock` sends:
   `send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])`).
3. Sleep ~2.5s (matches the tool's own documented "screen should turn off
   within 2s").
4. Screenshot #2 — confirm the lock actually took. **Ground truth here is
   the image itself** (per this codebase's own stated "no automated
   lock-screen classifier, human judgment on the real image" principle,
   already applied throughout today's session) — not the
   `streamer.source.online` flag, which today's session separately
   live-confirmed is an UNRELIABLE proxy for iPad lock state (it reflects
   ustreamer's own on-demand run state, not the device). If screenshot #2
   itself fails to capture (503/torn frame), retry the capture alone
   (no additional HID) up to 3x with a 1s pace before giving up — this is
   purely a capture-reliability retry, not a wake-mechanism action.
5. Send **exactly one** `Space` press. No second press, no `Enter`, no
   mouse move — this experiment tests ONE press in isolation, not a
   fallback chain.
6. Sleep 1.5s (this session's own live-confirmed settle time — an 800ms
   wait produced a genuinely torn capture frame earlier today; 1.5s did
   not repeat that).
7. Screenshot #3 — the actual result. Retry the capture alone (same 3x/1s
   policy as step 4) if it 503s/comes back torn, but send NO further HID.
8. **STOP.** No slam, no `anchor_cursor`, no `CallerAsserted`, no corner
   anywhere near this sequence, regardless of what screenshot #3 shows.

## Outcome classification — from screenshot #3, by eye, not inferred

Three possible outcomes, matching what this session actually observed
today across its three attempts, described precisely enough to classify
without ambiguity:

- **A. Plain lock screen** (the hoped-for, hypothesis-confirming outcome):
  clock + date, wallpaper visible full-frame, small lock icon top-center,
  "100% Charged"-style status line, thin home-indicator bar at the very
  bottom. NO "Touch ID" text, NO fingerprint icon, NO "Use Passcode"/
  "Cancel" buttons anywhere on screen.
- **B. Touch ID / passcode prompt** (the outcome observed 3/3 times
  today, tangled with the guard/slam logic): same wallpaper as A, but with
  a fingerprint icon + "Touch ID" label centered on screen, "Use
  Passcode" text below it, "Cancel" text further below. This is a
  DIFFERENT, more-escalated UI state than A, not a variant of it.
- **C. Fully unlocked**: real app content (Settings, home screen icons,
  whatever was active before locking) — no wallpaper-only lock UI at all.
  This is the documented "safe non-event, no HID near a corner" over-shoot
  case from today's session, not a failure of this experiment, just a
  data point that the single press dismissed further than expected.

If screenshot #3 is ambiguous, torn (post-retry), or shows something not
matching any of A/B/C — stop, do not classify, note it as inconclusive
rather than forcing a label.

## Recovery plan, per outcome

- **A (plain lock screen)**: no recovery needed — the sequence never
  risked anything (no HID beyond one lock command + one wake key, both
  already-established-safe primitives on their own). Optionally send the
  standard `unlock_ipad()` (Escape→Enter→Space) to return to normal for
  whatever comes next, same as any other gate's cleanup.
- **B (Touch ID prompt)**: this is the exact state today's session hit
  three times. Recovery ladder, cheapest first (same order used live
  today):
  1. `unlock_ipad()`'s standard key-press path (Escape→Enter→Space) —
     worked once out of the times it was tried today, did not work the
     other time (needed step 2).
  2. If (1) doesn't clear it: `unlock_ipad_with_code()` with the stored
     `PIKVM_IPAD_PASSCODE` (already pre-authorized by georg specifically
     for this rig/scenario, used successfully today). Never guess a
     passcode manually — this project's own standing rule.
  3. After recovery, take a confirming screenshot before considering the
     experiment's cleanup complete — don't assume recovery worked from
     the tool's own return message alone (today's session caught the
     tool's own recovery message being insuficient evidence at least
     once — always re-screenshot).
- **C (fully unlocked)**: no corrective action needed beyond normal
  cleanup (e.g. `ipad_go_home` if whatever surfaced isn't a sane resting
  state) — explicitly a safe, informative result per today's own
  established framing, not an error state.

## What this answers vs. doesn't

**Answers**: whether `Space`-once is a reliable "wake without dismiss"
primitive on THIS rig's no-passcode configuration, in isolation from any
other logic. A clean, repeated A outcome across a few isolated trials
would justify trusting the mechanism again in the combined gate; a
repeated B outcome would mean the combined gate's wake step needs a
different mechanism entirely (not just more retries), and the mouse-move
fallback (`--fallback-mouse-move`, already built into
`cursor_anchor_corner_control_smoke.rs`) should probably become the
DEFAULT wake mechanism rather than a fallback.

**Does NOT answer / doesn't re-litigate**: anything about `AnchorGuard`,
`CallerAsserted`'s contract, `slam_calls`, `corner_target_from_bounds`'s
verification math, or `unlock_ipad`'s own internal guard usage — all of
that has already been proven safe (fail-closed correctly) across today's
three real attempts and is out of scope here. This experiment is narrowly
about one key press's observable effect, nothing else.

## Suggested trial count

Given this is a binary classification question (does Space reliably do X
or not), not an accuracy/statistics question — recommend 3-5 isolated
trials as a first pass, not 20+. A/A/A across 3-5 trials is a real,
actionable signal at this sample size for "yes, trust it."

**If results come back MIXED (not uniformly A or uniformly B) — nixos-
dev's review point, real and not originally covered here**: don't
immediately conclude "the mechanism is just flaky, use the mouse-move
fallback." Every trial in this plan uses the SAME fixed ~2.5s lock→wake
delay — a mixed result could mean the mechanism is genuinely random, OR
it could mean there's a real TIMING confound (elapsed time since lock,
since last device activity, how long the screen had actually been off
before the Space press) correlating with A vs. B that a fixed-delay
protocol can't see. A timing-dependent effect and a purely-random one
look identical at N=3-5 but imply different fixes (tune the delay vs.
abandon Space entirely). Before concluding "unreliable, switch to mouse-
move": re-run with the lock→wake delay deliberately varied across trials
(e.g. 2s, 4s, 8s) and check whether the A/B split tracks the delay. Only
treat it as genuinely random if varying the delay doesn't change the
outcome pattern.

## What I'm asking nixos-dev to review

1. Is the outcome classification (A/B/C) complete, or is there a 4th real
   state this rig could land in that today's three attempts didn't
   happen to surface?
2. Is 3-5 trials the right count for this specific binary question, or
   does the analogy to a statistics-driven sample size (this project's
   usual N≥20/N≥80 rules) actually apply here in a way I'm underweighting?
3. Anything in the recovery ladder that should be reordered or supplemented,
   given today's real experience with it?
