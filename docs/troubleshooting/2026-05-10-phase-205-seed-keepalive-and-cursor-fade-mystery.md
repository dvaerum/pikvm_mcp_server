# Phase 205 (v0.5.197) — seedCursorTemplate uses keepalive screenshots; cursor-fade still mysterious

**Date:** 2026-05-10  
**Files changed:**
- `src/pikvm/seed-template.ts` — uses `screenshotKeepingCursorAlive` if
  available on the client (Phase 202 method)
- Bumped version to 0.5.197

## Code change

`seedCursorTemplate` now prefers `client.screenshotKeepingCursorAlive`
when present (the method added in Phase 202). This emits a ±1px wake
nudge immediately before screenshot capture so the iPad cursor is
visible in both the BEFORE and AFTER frames the seed function uses
for motion-diff.

The change is opt-in via the optional method on
`SeedTemplateClient` interface — test mocks that don't supply it
fall back to plain `screenshot()` (no behavior change).

## Why this should have helped

Live empirical finding from Phase 202: emitting a 1px wake nudge
right before screenshot keeps the cursor visible. Without it, ~95%
of detection screenshots find no cursor. With it, cursor stays
visible.

`seedCursorTemplate` was missing this fix. Previous `seedCursor*`
calls failed with "no cursor-sized motion-diff clusters detected"
when the AFTER frame was captured ~500ms after the move (cursor
fades in ~200ms).

## What actually happened

Multiple bench v3 runs after the fix STILL got
"no cursor-sized motion-diff clusters detected". Even when I
manually probed (Bash):

1. `pikvm_mouse_move (relative=true, 100, 100)`
2. `pikvm_mouse_move (relative=true, 1, 0)` — wake nudge
3. `pikvm_screenshot` — captured immediately

→ Cursor INVISIBLE in the captured screenshot.

This worked earlier in the session (move 50,50 + 1px nudge + 
screenshot → cursor visible). Now it doesn't. Possible reasons:
- The iPad's cursor-fade has gotten more aggressive (perhaps
  power-saving kicked in after extended use).
- PiKVM screenshot latency increased (server load, network).
- Background activity interfered.

## What's still working

- Phase 202 cursor-keepalive in `move-to.ts` is shipped and
  presumably still working in production click flows (each
  screenshot has its own wake nudge).
- 673/673 tests pass.
- nix build green at v0.5.197.

## What this means for the user's data-collection plan

The user's strategic plan (collect per-emit data → fit math model
of acceleration) requires reliable cursor detection. Even with
Phase 202 + Phase 205, single-frame cursor visibility is
intermittent on this iPad in this session.

To make data collection work, the bench needs to either:
1. Tolerate detection failures and aggregate enough samples that
   noise averages out (raise reps to 5+, expect 30%+ failure
   rate on cursor location)
2. OR investigate WHY the cursor visibility is unreliable (PiKVM
   server, iPad settings, USB HID timing) — possibly out of
   scope for this MCP project
3. OR pivot to using the production `pikvm_measure_ballistics`
   tool which already aggregates noise via median (Phase 203
   doc proposed this as Option A)

## State at end of this iteration

- v0.5.197 with Phase 205
- Working tree clean, all pushed
- 673/673 tests pass
- Bench v3 still doesn't run end-to-end (seed fails)
- No new px/mickey data collected this iteration

## Honest summary

Phase 205 was the right code change but didn't unblock the bench.
The cursor-fade issue is more complex than just "wake nudge before
screenshot" — there's something about the iPad's current state
that makes the cursor invisible even immediately after motion.
Worth investigating in a future session, but not productive to
keep iterating on it now.
