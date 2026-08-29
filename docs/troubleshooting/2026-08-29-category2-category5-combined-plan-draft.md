# DRAFT — combined E2E category 2 + category 5 live-hardware plan

**Status: NOT YET RUN. For review by pikvm-mcp-server@nixos-developer-system
before any hardware contact**, per the manager's explicit instruction after
two real lock incidents this session on the same underlying mistake.

## Why this plan exists (context for the reviewer)

Two incidents today, same root cause discovered only on the second one:

1. `cursor_anchor_corner_control_smoke.rs` v1 called `slam_to_corner`
   directly (bypassing `cursor_anchor.rs`'s `AnchorGuard` entirely). Full
   slam locked the iPad. Fixed by adding `AnchorRequest.slam_calls:
   Option<u32>` so a short/incomplete slam can go through the guarded
   `anchor_cursor` path instead of the raw primitive (commit fb80142,
   rust-port/module-4-mover).
2. v2 (retried through the fix, `guard: CallerAsserted{...}`) **locked the
   iPad again** — same outcome. Root cause: `CallerAsserted` **never
   refuses on the safety question by design** — it's not a check, it's the
   caller's own promise. Going through it changes nothing about what HID
   events reach the iPad. The actual mistake was asserting `CallerAsserted`
   on the WRONG precondition: its real contract (documented in
   `cursor_anchor.rs`'s own doc comment, and in `unlockIpad`/`ipadGoHome`'s
   real call sites) is *"a lock screen has no active hot corner"* — safety
   is true BECAUSE the target is a genuine lock screen, not despite it. My
   health-check confirmed the OPPOSITE (an active, unlocked Settings
   screen) and I asserted safety anyway — inverting the exact contract
   `docs/rust-port-plan.md` §8 item 5 already documented as a prior
   mistake (`cursor_anchor_smoke.rs` v2), which I had read and correctly
   quoted in my own harness's comments before repeating it in practice.

**Conclusion**: there is no safe way to do a full corner-slam-with-
verification against an arbitrary ACTIVE (non-lock) iPad screen — that's
exactly what `BoundsGuard` exists to refuse. The only guard that is both
(a) non-refusing and (b) actually safe is `CallerAsserted` used on a
**genuine, freshly-confirmed lock screen** — which is category 5's own
scenario. Manager-approved: fold category 2's live verification into
category 5's lock-screen session instead of treating them separately.

## Goal

One combined, carefully-paced session that:
- Deliberately locks the iPad via the project's own established mechanism.
- **Confirms the lock is real before any further action** — the exact
  step both incidents skipped.
- Runs the corner-slam positive/negative control pair (category 2) safely,
  because the precondition is now genuinely true.
- Recovers via the real production `unlock_ipad()` path — which itself
  uses `AnchorGuard::CallerAsserted` internally (`ipad_unlock/unlock.rs`'s
  own call site: `reason: "Layer 5 — lock screen has no active hot
  corner"`) — satisfying category 5's own flagged requirement (a genuine
  `CallerAsserted`-on-lock-screen positive path through `ipad_unlock.rs`'s
  real production code, not a synthetic smoke test) in the same pass.

## Proposed exact sequence

Two SEPARATE process invocations, not one continuous script — deliberately
inserting a real inspection point between locking and slamming, since a
saved screenshot is static once captured (not time-constrained to inspect
after the fact) even though the LOCK ACTION itself may be time-sensitive.

### Phase A — lock and confirm (new, small example)

1. Screenshot #1 (baseline) — confirm current state honestly (not a
   safety-relevant check, just documents what the rig looked like before).
2. Send `Ctrl+Cmd+Q` (the same shortcut `pikvm_ipad_lock` sends:
   `send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])`). Per that tool's
   own description: "Screen should turn off within 2s."
3. Sleep ~2.5s (a small margin over the documented 2s).
4. Check `pikvm_screen_state`-equivalent (`streamer.source.online` — the
   objective, non-visual ground-truth signal this project already uses
   elsewhere) — confirm `on:false`. This is a real, code-checkable
   assertion, not a pixel heuristic.
5. **OPEN QUESTION for review**: what should happen next to reach a
   genuinely lock-screen-visible (not fully-off) state? `ipad_lock`'s own
   tool description says "To unlock again: sendKey Enter (wakes the
   screen; **on iPadOS 26 with no passcode also dismisses the lock
   screen**)." If that's accurate for this rig's current config, sending
   Enter might skip straight past the visible lock screen to a fully
   dismissed/unlocked state — which would defeat the whole point of this
   phase. I don't have a confident, verified answer for what wakes the
   screen to a STILL-LOCKED, visually-confirmable lock-screen UI without
   also dismissing it. Options to consider (please check against
   `ipad-unlock.ts`/`ipad_unlock.rs`/any docs/troubleshooting notes on
   this, since I may be missing the right primitive):
   - A single relative mouse move (no click) — plausible on iOS/iPadOS as
     a "wake the display" gesture that does NOT also dismiss, unlike a key
     press. Untested by me this session.
   - Some other key already used elsewhere in this codebase for exactly
     "wake without dismissing."
   - If neither exists cleanly, an alternative: skip trying to WAKE a
     dimmed/off screen at all, and instead trigger the lock-screen-visible
     state via the SAME path that produced it twice already today (a
     `BoundsGuard`-refused... no — that path never showed a slam, it
     refused). Actually the two REAL lock-screen screenshots I have from
     today came from the CORNER-SLAM's hot-corner gesture locking the
     device, not from `Ctrl+Cmd+Q`. If `Ctrl+Cmd+Q` behaves differently
     (goes to a fully-off HDMI state instead of a visible lock screen),
     that's a materially different mechanism than what I've actually
     observed — flagging this distinction explicitly since I don't want
     to assume the two are equivalent.
6. Once (if) a lock-screen-visible state is reached: take screenshot #2,
   save it, print a clear message, and **exit the process** (no slam in
   this phase, regardless of what screenshot #2 shows).

### Manual checkpoint (me, before Phase B)

Read screenshot #2. Confirm by eye: clock/wallpaper/home-indicator-bar
visible, no app content, matches the lock-screen UI already seen twice
today in the incident screenshots. **Only proceed to Phase B if this is
unambiguously true.** If screenshot #2 shows anything else (blank/off
frame, an active app, an error), stop and re-assess rather than guessing.

### Phase B — guarded corner-slam pair + real recovery (reuses existing code)

7. Positive control: `anchor_cursor(AnchorRequest{ guard:
   CallerAsserted{reason: "operator confirmed via screenshot #2 (Phase A)
   that the iPad is on a genuine lock screen"}, slam_calls: None, ... })`
   — same code as `cursor_anchor_corner_control_smoke.rs` already has,
   just with the reason string corrected to describe the TRUE
   precondition this time (lock screen, not "non-lock-screen content").
   Expect `verified: Some(true)`.
8. Negative control: same guard, `slam_calls: Some(3)`. Expect
   `verified: Some(false)`.
9. Screenshot #3 — confirm still on lock screen (or wherever the slams
   left it), not something unexpected.
10. Real recovery: call `unlock_ipad(&client, IpadUnlockOptions{ verbose:
    true, ..Default::default() })` — the actual production function,
    which internally uses `CallerAsserted` on this exact lock-screen
    precondition (its own real call site's reason string: "Layer 5 — lock
    screen has no active hot corner"). This is category 5's own required
    coverage, exercised for real rather than synthetically.
11. Final screenshot — confirm recovered to a sane, recognizable state
    (ideally back to whatever screenshot #1 showed, though an app
    switch during recovery is acceptable as long as it's a real,
    non-broken state — same "check final device state" discipline as
    every other gate this session).

## What I'm asking nixos-dev to check

1. Is my understanding of `CallerAsserted`'s real contract correct (safe
   BECAUSE lock screen, not despite an active screen)? I believe so per
   `cursor_anchor.rs`'s own doc comment and the real `unlockIpad`/
   `ipadGoHome` call sites, but a fresh read is exactly the point here.
2. The open question in step 5 above — what's the right, already-
   established primitive (if one exists) to wake a locked-off screen to a
   VISIBLE lock screen without also dismissing it, on this rig's current
   iPadOS/passcode configuration? Or is `Ctrl+Cmd+Q` simply the wrong
   trigger to reach for here, and should Phase A instead rely on the
   corner-slam's own hot-corner-gesture lock (the mechanism that actually
   produced the lock screens I've directly observed) — accepting that as
   the intentional lock trigger instead of `pikvm_ipad_lock`?
3. Any other precondition-verification gap this plan hasn't caught, given
   this exact class of mistake has now happened twice.

Please reply with corrections/answers before I build Phase A/B's actual
code, not after — this is a review of the PLAN, not of finished code.
