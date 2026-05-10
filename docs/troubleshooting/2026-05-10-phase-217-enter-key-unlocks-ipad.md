# Phase 217 — Enter key unlocks the iPad lock screen on iPadOS 26

**Date:** 2026-05-10
**Version:** v0.5.205
**Status:** Live-verified.

## TL;DR

Phase 210 (v0.5.199) made `unlockIpad` send a `Space` key press
before the swipe — that worked at the time. By 2026-05-10 the
iPad's auto-lock screen no longer responds to `Space`: dragPx
values 800/1200/1500/2000 + `Space` all left the iPad on the lock
screen with the time displayed.

Live test today: an `Enter` key press unlocks the same lock screen
reliably and reaches the home screen in one shot. Phase 217
extends `unlockIpad`'s key-press preamble to send Escape + Enter +
Space. The swipe still runs as a fallback.

## How this was found

After repeated `unlockIpad` calls left the iPad on the lock screen,
I tried four variants:

| Variant | Action | Result |
|:------:|:------|:------|
| A | mouseClick + swipe-up from current position | Opened **Control Center** (cursor was at top — wrong gesture region) |
| B | `Enter` after Variant A | (closed Control Center but didn't reach home from prior state) |
| C | `Cmd+Space` (Spotlight) | (no useful state change) |
| D | `Escape` + `Enter` | **Reached the home screen** |

Variant D was the success: Escape closed the Control Center that
Variant A's wrong-region swipe had opened, then Enter dismissed
the lock screen.

A follow-up test starting from a fresh lock state (cursor positioned
at the bottom-center swipe origin) confirmed `Enter` alone unlocks.
The `Escape` step is defensive — it's a no-op on a clean lock
screen, but neutralizes any Control Center / Notification Centre
state from prior failed gestures.

## What changed in code (v0.5.205)

`src/pikvm/ipad-unlock.ts:102-129` — the `tryKeyPressFirst`
preamble now sends three keys in sequence:

```ts
await client.sendKey('Escape');   // defensive — close any open overlay
await sleep(200);
await client.sendKey('Enter');    // the actual unlock on iPadOS 26
await sleep(600);
await client.sendKey('Space');    // legacy fallback (Phase 210 path)
await sleep(400);
```

The mouse-down + upward swipe still runs after this, so callers
that target an iPad on a lock screen iPadOS revision where Enter
doesn't unlock will still get the swipe-based unlock.

## What changed in tests

`src/pikvm/__tests__/unlockIpad.test.ts` (Phase 210 → Phase 217):

- "emits a Space key press BEFORE the swipe by default" became
  "emits Escape, Enter, and Space key presses BEFORE the swipe by
  default" — asserts all three keys are sent and Enter precedes
  the first mouse-down (which opens the swipe).
- New test pins the Enter-before-Space ordering.
- The `tryKeyPressFirst: false` skip-test still passes (no key
  presses).

`unlockIpad.test.ts` 14/14 passing. Full suite 692/692 green.
Nix build green at v0.5.205.

## Related

This phase only addresses the lock-screen entry path. The remaining
home-screen click-rate work (Phase 216 / 217+ candidates around
locateCursor + template-match) is unchanged — but downstream
benches now reach the home screen reliably, which means the
detection-layer measurements aren't being polluted by the iPad
state.

## Files in this commit

- `src/pikvm/ipad-unlock.ts` — Escape + Enter + Space preamble
- `src/pikvm/__tests__/unlockIpad.test.ts` — updated/added tests
- `package.json` + `src/version.ts` — v0.5.205
- `test-phase217-aggressive-unlock.ts`, `test-phase217-double-unlock.ts`,
  `test-phase217-state.ts`, `test-phase217-enter-unlock.ts` —
  diagnostic scripts kept for future reference
- `docs/troubleshooting/2026-05-10-phase-217-enter-key-unlocks-ipad.md`
  — this doc

## State at v0.5.205

- 692/692 tests green
- Nix build green
- Lock-screen unlock verified live with the new Enter+Space preamble
- All commits pushed
