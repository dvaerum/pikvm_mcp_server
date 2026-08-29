# DRAFT — combined E2E category 2 + category 5 live-hardware plan

**Status: reviewed by nixos-dev, sent to the manager for final sign-off.
NOT YET BUILT OR RUN.** Written per the manager's explicit instruction
after two real lock incidents this session on the same underlying
mistake.

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

## Review (pikvm-mcp-server@nixos-developer-system, 2026-08-29)

Confirmed correct: the `CallerAsserted` contract read (safe BECAUSE lock
screen), the recovery-via-real-`unlock_ipad()` step, and the `TopLeft`
corner choice (checked against iOS's bottom-corner lock-screen quick
actions — flashlight/camera — which a bottom-corner slam could trigger
instead of a system gesture; `slam.rs`'s default is `TopLeft`, and this
plan never overrides it).

Answered the step-5 open question, sourced from `ipad-unlock.ts`'s
`unlockIpadWithCode` (lines 560-614): send **Space once**, not Enter —
one press wakes the screen still-locked; a second press (or Enter, which
`ipad-unlock.ts:62` documents as "the actual unlock key on iPadOS 26 lock
screens") dismisses it. Real caveat flagged, not resolved: unclear whether
this holds identically on a NO-PASSCODE config (this rig's documented
default) — so screenshot #2 stays the actual arbiter regardless, with a
defined fallback: if Space over-shoots to a fully unlocked screen, that's
a safe, informative non-event (no HID went near a corner), not an
incident — re-lock and retry the wake via a small mouse move instead of a
second keypress.

Two real gaps caught, folded into the sequence below:
1. Phase A's streamer-offline check must be a **hard abort**, not an
   assumption, if the lock action didn't actually take.
2. Phase B must take and re-confirm its **own fresh screenshot** right
   before the guarded slam — never trust Phase A's now-stale screenshot
   across the process boundary + manual-review time gap. Same
   "confirm CURRENT state, not an earlier step's" discipline as §8 item 5
   and this session's own v2 incident.

## Proposed exact sequence (post-review)

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
3. Sleep ~2.5s.
4. Check `streamer.source.online` (the objective, non-visual ground-truth
   signal this project already uses elsewhere) — confirm `on:false`.
   **HARD ABORT** (nonzero exit, clear message, no further action) if it's
   still `true` — the lock never took; do not fall through to step 5
   against a screen that was never off.
5. Send **Space once** (not Enter, not the full Escape→Enter→Space unlock
   sequence — that's designed to fully dismiss). Sleep briefly (~1s).
6. Screenshot #2, save it, print a clear message, **exit the process**
   (no slam in this phase, regardless of what screenshot #2 shows).

### Manual checkpoint (me, before Phase B)

Read screenshot #2. Three possible outcomes:
- **Genuine lock screen** (clock/wallpaper/home-indicator, no app
  content) → proceed to Phase B.
- **Fully unlocked** (Space over-shot) → safe non-event, no HID near a
  corner. Re-run Phase A, replacing step 5 with a small relative mouse
  move instead of a keypress, then re-check screenshot #2.
- **Anything else** (blank/off frame, error, ambiguous) → stop and
  reassess rather than guessing.

### Phase B — guarded corner-slam pair + real recovery (reuses existing code)

7. **Own fresh screenshot #2b FIRST** — do not trust Phase A's screenshot
   #2 as proof of current state. Re-confirm by eye (me, again) that #2b is
   still a genuine lock screen before proceeding to step 8. If it isn't
   (state changed between Phase A's exit and this invocation), stop —
   don't fire the slam.
8. Positive control: `anchor_cursor(AnchorRequest{ guard:
   CallerAsserted{reason: "operator confirmed via screenshot #2b (Phase B,
   taken immediately before this call) that the iPad is on a genuine lock
   screen"}, slam_calls: None, ... })` — same code as
   `cursor_anchor_corner_control_smoke.rs` already has, reason string
   corrected to describe the TRUE precondition and reference the FRESH
   screenshot, not Phase A's. Expect `verified: Some(true)`.
9. Negative control: same guard, `slam_calls: Some(3)`. Expect
   `verified: Some(false)`.
10. Screenshot #3 — confirm still on lock screen (or wherever the slams
    left it), not something unexpected.
11. Real recovery: call `unlock_ipad(&client, IpadUnlockOptions{ verbose:
    true, ..Default::default() })` — the actual production function,
    which internally uses `CallerAsserted` on this exact lock-screen
    precondition (its own real call site's reason string: "Layer 5 — lock
    screen has no active hot corner"). This is category 5's own required
    coverage, exercised for real rather than synthetically.
12. Final screenshot — confirm recovered to a sane, recognizable state
    (ideally back to whatever screenshot #1 showed, though an app
    switch during recovery is acceptable as long as it's a real,
    non-broken state — same "check final device state" discipline as
    every other gate this session).

## Status

Reviewed by nixos-dev (both open items answered, 2 gaps caught and folded
in above). Sent to the manager for final sign-off before any code is
written or the rig is touched again.
