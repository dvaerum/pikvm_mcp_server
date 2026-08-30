# Read-only check: Allow Access When Locked → Keyboard (2026-08-30)

## What this is

Follow-up to `docs/streamer-source-online-wake-nudge-plan.md`'s recorded
lead: Apple documents (iPadOS 16.4+) that an external keyboard key press
at the lock screen wakes the display AND jumps straight to the passcode
field, controlled by **Settings → Face ID & Passcode → Allow Access When
Locked → Keyboard**. If that's off, a key press plausibly only wakes
without advancing — the "wake-only, never-advances" key this project's
wake-nudge investigation needs and doesn't currently have.

**Scope of THIS pass: read-only.** Confirm what the setting currently is.
Do NOT toggle it. Toggling (and re-testing the Space-press behavior
afterward) is a separate, later step, decided only after this read is in
hand and reviewed.

## Why this is a different risk class than tonight's other checks

Every other live check tonight (screenshot polling, wake keys, mouse
nudges) stayed at the lock-screen/home-screen surface. This one goes
INSIDE Settings — genuinely new territory for this session. It needs
its own care, not because it's high-risk in an absolute sense, but
because it's unfamiliar: no established harness in this codebase has
navigated into Settings' Face ID & Passcode pane before.

## Design — reuse existing, already-verified primitives; new glue only

No new library code. This is a short one-off diagnostic script chaining
functions this codebase already ships and has already live-verified:

1. **`launch_ipad_app(client, "Face ID & Passcode", ...)`** —
   already-shipped, already-verified-live primitive (unlock → Cmd+Space/
   Spotlight → type → Enter → settle → screenshot). Its own doc comment:
   "Verified live for Files, Settings, App Store on iPadOS 26.1." iOS
   Spotlight indexes individual Settings panes by name and can deep-link
   directly to them — real chance this lands straight on the target pane
   in one call, skipping in-app hierarchical navigation (and its
   click-precision risk) entirely.
   - **Checkpoint**: inspect the returned screenshot myself before doing
     anything else. Four possible outcomes (nixos-dev review — named
     explicitly rather than left to the closing catch-all to imply):
     (a) landed on a passcode re-entry prompt (iOS gates Face ID &
     Passcode settings behind re-entering the passcode) → proceed to 2.
     (b) landed directly on the Face ID & Passcode settings list (no
     re-entry needed) → skip to 3.
     (c) Spotlight found no match, fell back to home screen → STOP, do
     not guess further; report back and fall back to
     `launch_ipad_app(client, "Settings")` + in-app navigation only as a
     separate, later, reviewed step (bigger click-precision surface, not
     attempted blind).
     (d) Spotlight fuzzy-matched to a PLAUSIBLE BUT WRONG pane (e.g.
     "Passwords" instead of "Face ID & Passcode" — a clean hit, just the
     wrong one) → STOP, do not proceed as if it were the right pane;
     report the actual pane landed on and stop there, same as (c).
2. **Passcode re-entry** (only if (a)): same digit-by-digit `send_key`
   pattern `unlock_ipad_with_code` already uses (`Digit{n}` per digit,
   100ms apart, then `Enter`). Screenshot after. Checkpoint: inspect
   before proceeding — confirm the real settings list, not an error/retry
   state (iOS locks out after repeated wrong passcodes; this only sends
   the passcode ONCE, matching the already-known-good passcode from
   `.env`, same trust boundary as every other unlock this session already
   uses).
3. **Scroll to the setting, if needed**: `client.mouse_scroll(0.0, delta)`
   (already-shipped, already-used-elsewhere primitive) in small
   increments, screenshotting and inspecting after each, until "Allow
   Access When Locked" → "Keyboard" is visible. No taps in this phase —
   scrolling only, so nothing can be mis-clicked while searching for it.
4. **Read the toggle state** — my own direct visual inspection of the
   screenshot (this project's own established principle: "lock-state
   determination is the operator's job via visual inspection, not a
   pixel heuristic" — extended here to toggle-state, same reasoning: an
   automated on/off pixel classifier is more failure-prone than a direct
   look, and this is a one-off diagnostic, not a repeated gate needing
   automation). Reports ON or OFF. **Stop — no toggle attempted.**
5. **Clean up**: `ipad_go_home` (Cmd+H, already-shipped) → re-lock via
   the same `Ctrl+Cmd+Q` shortcut used throughout this session →
   screenshot, inspect, confirm a clean final lock-screen state.

Each numbered step is a SEPARATE script invocation (or a script that
exits after each stage), not one long blind automated chain — I inspect
the screenshot between every stage before deciding whether to run the
next one. This is the same discipline as every other multi-stage check
tonight (e.g. the corner-control harness's human veto, the wake-key
disambiguation check) — just self-checked instead of operator-checked,
since this is exploratory and read-only, not a repeated production gate.

## What could go wrong, and the abort condition for each

- Spotlight doesn't match "Face ID & Passcode" → falls to home screen,
  harmless, caught at the step-1 checkpoint. No further action this
  pass.
- Spotlight fuzzy-matches to a plausible-but-wrong pane (nixos-dev
  review) → caught at the same step-1 checkpoint; report the actual
  pane, do not proceed as if it were the right one.
- Wrong passcode entered somehow → iOS shows an error/retry, caught at
  the step-2 checkpoint. Abort — do not retry blind; a human should
  confirm the actual passcode before any second attempt (this project's
  own repeated caution about not blindly retrying a passcode entry).
- Toggle not visible after several scrolls → abort after a bounded
  number of scroll attempts (cap at 5, matching this project's own
  convention for bounded retries elsewhere) rather than scrolling
  indefinitely; report what WAS visible.
- Anything unexpected on screen at any checkpoint → abort, do not
  proceed to the next stage, report the screenshot state honestly.

## Status

Reviewed by nixos-dev — approved, with one addition (the plausible-but-
wrong-pane case above, now named explicitly rather than left to the
closing catch-all). Confirmed: two passcode entries back to back (initial
unlock, then the settings-pane re-authentication gate) is not a lockout
concern — that pattern is specifically about repeated WRONG attempts, not
two correct entries for two legitimate prompts. Confirmed this plan
carries zero corner/slam-adjacent risk (no `CallerAsserted`, no
cursor-near-a-corner concern) — a genuinely lower risk class than
categories 2/5. Cleared for live execution.

**First live attempt (2026-08-30 ~16:47): blocked by the SAME
`source.online` bug this whole thread exists to fix — inconclusive, not
executed as designed.** The device was sitting in a real 503-idle episode
at the start (same pattern as §22-§31). `unlock_ipad_with_code` was
called with the real passcode; its own `send_key` calls likely reached
the device (HID and video-capture are independent subsystems, this
project's own long-established understanding), but EVERY screenshot
attempt around and immediately after it 503'd — meaning the plan's own
core discipline ("inspect the screenshot before proceeding to the next
stage") could not actually be honored across that stretch. Chained ahead
blind for a moment (a mistake — see below), then stopped and did one
more isolated wake+confirm: the device came back showing a genuine,
clean, PLAIN lock screen (16:49, 100% Charged, lock icon) — not a
passcode keypad, not any Settings pane, not an error state. Zero
incident, but inconclusive: no confirmation the passcode sequence ever
actually reached/passed the passcode field, and the device may simply
have re-dimmed and reset before landing anywhere past the lock screen.

**Process note (self-caught, not caught by review) — worth naming
plainly**: this plan's own design explicitly commits to a checkpoint
after EVERY stage, but the actual attempt chained `unlock_ipad_with_code`
(2 keys, 6 digits, Enter — several real HID actions) across a period
where NO screenshot was confirmable at all, then briefly proceeded to a
follow-up check before recognizing that violated the plan's own
discipline. No incident resulted (mouse-move/HID choices throughout
stayed within already-established-safe mechanisms, and the end state is
a clean plain lock screen), but the RIGHT fix is procedural, not just
lucky: a passcode-entry sequence should not be chained through a
capture-outage window at all — get a CONFIRMED screenshot before sending
ANY further key in the sequence, even if that means recovering
`source.online` first via the wake-nudge investigation's own toolkit,
each time, before every real key. Not resumed further in this pass.

**A genuinely useful side finding**: this is the first CONCRETE case of
the `source.online` bug this whole night's investigation targets
actively interfering with a real, unrelated task (not just a synthetic
diagnostic) — direct evidence for why fixing it matters beyond the
narrow wake-nudge-fix framing.

Next attempt (not this session): redesign the unlock stage specifically
to get a confirmed screenshot between EVERY key sent, recovering
`source.online` first each time it's stuck, rather than trusting a
multi-key sequence to complete blind.

**Addendum (nixos-dev, lowering the "don't know" concern)**:
`streamer_keepalive.rs`'s own header states plainly "HID is unaffected —
this is video-only" — screenshot/video capture and keyboard/mouse HID
delivery are architecturally independent subsystems throughout this
design. So the `send_key` calls almost certainly reached the device and
were processed normally; the uncertainty here is purely about VISUAL
CONFIRMATION of the result, not whether the passcode digits landed. Reads
as low-concern given the clean final lock-screen state, not a
"something's wrong" situation. Practical note for whoever next unlocks
this rig for any reason: iOS typically resumes into whatever screen was
active before locking, not necessarily the home screen — since it's
unconfirmed whether the sequence ever reached the Face ID & Passcode
pane, the device *might* currently be parked mid-navigation there.
Expect a possible unexpected Settings screen on next unlock and navigate
out via `ipad_go_home` rather than treating it as a new incident.

## Second live attempt (2026-08-30 ~18:14-18:20) — per-key-confirmed redesign, still blocked, but with real new evidence

Ran the actual redesigned sequence this time (screenshot-confirm before
every key, abort rather than push through blind). Real findings, in
order:

1. **Passive precheck**: `source.online` was stuck (503) at the start,
   as usual. Correctly aborted rather than sending any key — exactly per
   design.
2. **Space #1 (wake)**: confirmed via a real screenshot — genuine, lit,
   plain lock screen (18:14).
3. **Space #2 (dismiss), sent from a SEPARATE process invocation** (real
   wall-clock gap of tens of seconds for compile+run+my own inspection
   between steps 2 and 3): screenshot came back showing the SAME plain
   lock screen, unchanged — Space #2 did NOT advance the state machine.
   **Correctly did NOT conclude anything about the "Allow Access When
   Locked → Keyboard" setting from this** — recognized the likely
   confound (the real gap between separate process runs is almost
   certainly longer than this project's own documented ~10-12s wake/
   redraw window, so the screen had likely re-dimmed and step 3's Space
   registered as a FRESH wake, not the second stage) before drawing any
   conclusion.
4. **Re-tested with tight, matching timing** (both Space presses 1000ms
   apart, in ONE continuous process — exactly `unlock_ipad_with_code`'s
   own already-validated rhythm): **confirmed the two-stage mechanic DOES
   work exactly as documented** — landed on a Touch ID / "Use Passcode" /
   "Cancel" prompt. This resolves the earlier ambiguity cleanly: it was a
   timing artifact, not evidence about the Keyboard setting.
5. **Typed the 6 passcode digits (no Enter)**: the confirmation
   screenshot came back TORN (flood-fill green block + a partial render
   showing a "Delete" key — confirms we WERE on the real numeric
   passcode keypad, just an unreliable capture of it). Correctly did NOT
   trust this frame for a dot-count check — retried the capture using
   this project's own `analyze_torn_frame` check rather than guessing.
6. **`source.online` went stuck again during the retry** for a clean
   frame. Tried the least-risky recovery first (a mouse-move nudge —
   consistent with tonight's own finding, did NOT recover it), then one
   Space keypress specifically as a video-recovery action (reasoned as a
   safe no-op on a numeric keypad, unlike on the lock screen) — this DID
   recover a clean frame.
7. **The clean frame showed the device back on the plain, undisturbed
   LOCK SCREEN (18:20)** — not the passcode keypad, not mid-navigation.
   The passcode-entry attempt had auto-timed-out and re-locked before
   Enter could ever be sent (which per the design was never sent blind —
   correctly never risked a submission on an unconfirmed state). No
   incident: nothing was ever submitted, no wrong-passcode counter risk.

**Real, decision-relevant conclusion**: this specific check is currently
BLOCKED by the same `source.online` bug this whole investigation targets
— not by a design flaw in the check itself. The redesign's own
confirm-before-every-key discipline works exactly as intended (caught
both the torn frame and the ambiguous timing correctly, never guessed,
never risked a submission), but the multi-second blind windows the
`source.online` bug introduces keep colliding with iOS's own short
lock/passcode-entry timeout, so the sequence times out before completing
even when every individual step is being handled correctly and safely.
**This means completing this check reliably is realistically gated on
actually FIXING `source.online` first** (the still-open mouse-move-vs-
keypress design question from the wake-nudge thread), not just something
to retry again with the same tooling. Two clean, safe, zero-incident
attempts in a row that both got this far and no further is itself
information, not a failure of technique.

Not resumed further this pass. All throwaway files cleaned up, device
confirmed safe (clean plain lock screen) at the end.

**The shape of the blocker, named plainly (nixos-dev)**: this check
investigates the Keyboard setting as a CANDIDATE FIX for `source.online`'s
wake problem — but confirming that setting now requires surviving
`source.online`'s own blind windows long enough to complete a passcode
entry. The bug is blocking investigation of one of its own candidate
fixes. Not a design failure of this check; just where the dependency
chain currently points.

**Parked, not abandoned**, until either: (a) `source.online` gets a more
direct fix that isn't itself gated on finding a safe wake key, or (b)
someone deliberately designs a much tighter, faster passcode-entry
sequence built specifically to beat the ~10-12s window — a real
engineering task for a fresh session, not an urgent one, since the payoff
here may matter less once `source.online`'s actual root cause is
addressed directly.
