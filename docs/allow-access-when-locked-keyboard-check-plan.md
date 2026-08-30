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
     anything else. Three possible outcomes:
     (a) landed on a passcode re-entry prompt (iOS gates Face ID &
     Passcode settings behind re-entering the passcode) → proceed to 2.
     (b) landed directly on the Face ID & Passcode settings list (no
     re-entry needed) → skip to 3.
     (c) Spotlight found no match, fell back to home screen → STOP, do
     not guess further; report back and fall back to
     `launch_ipad_app(client, "Settings")` + in-app navigation only as a
     separate, later, reviewed step (bigger click-precision surface, not
     attempted blind).
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

Design only — not yet executed. Sent to nixos-dev for review before any
live contact, per the manager's own framing that this deserves the same
review discipline as the wake-nudge fix itself.
