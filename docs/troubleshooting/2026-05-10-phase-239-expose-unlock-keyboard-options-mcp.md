# Phase 239 — expose `tryKeyPressFirst` + `swipeOnKeyPressFailure` via MCP

**Date:** 2026-05-10
**Version:** v0.5.210
**Status:** Shipped + live-verified.

## Problem

Same gap as Phase 238 (which exposed `forceHomeViaSwipe`): the
`pikvm_ipad_unlock` MCP tool's description and inputSchema were
frozen at Phase 209 (swipe-only path). After Phase 217 added
keys-first unlocking and Phase 219 added the `swipeOnKeyPressFailure`
gate, neither option had any MCP surface — they could only be set
by library callers (test scripts).

This meant any LLM agent or external script using the deployed
MCP server got stuck with the legacy swipe-only behavior, even
though the library defaults had moved on. Concretely:
- No way to opt out of the keys-first path (e.g. for diagnostics)
- No way to suppress the swipe fallback (Phase 219's escape hatch
  for "iPad may already be unlocked, don't re-lock me")
- Tool description still claimed swipe is the primary path, which
  is wrong since Phase 217

## Fix

`src/index.ts`:

- Tool description rewritten to describe the keys-first sequence
  (Esc + Enter + Space) and explain the Phase 219 swipe fallback
- `inputSchema` adds `tryKeyPressFirst` (boolean) and
  `swipeOnKeyPressFailure` (boolean)
- Handler forwards both args via `validateBoolean`

No library change. Defaults preserved (`tryKeyPressFirst: true`,
`swipeOnKeyPressFailure: true`).

## Live verification

`test-phase239-mcp-args.ts` — opens Settings, then calls
`unlockIpad({ swipeOnKeyPressFailure: false })`. Library semantics:
when `false`, the legacy always-swipe path is forced (the variable
name is counter-intuitive but documented in the code comment).
A swipe from the foreground app re-locks the iPad (Phase 219's
documented hazard).

**Result:** post-call screenshot shows lock screen → swipe ran →
arg was forwarded correctly. The same call without arg forwarding
would have skipped the swipe and left Settings foregrounded.

The test also accidentally re-confirmed the Phase 219 hazard is
real on the live iPad: forcing the swipe on a home/foreground
screen does re-lock. This is exactly why
`swipeOnKeyPressFailure: true` is the correct default.

## Side effect

The verification re-locked the iPad. Followup `unlockIpad` call
restored it; subsequent `launchIpadApp('Settings')` confirmed
operational state.

## What's now exposed via MCP

```json
{
  "tryKeyPressFirst": true,         // Phase 217 keys-first (default)
  "swipeOnKeyPressFailure": true,   // Phase 219 conditional swipe
  "slamFirst": true,                // legacy swipe path
  "startX": 955, "startY": 1035,
  "dragPx": 1500,
  "chunkMickeys": 30
}
```

Real callers can now:
- Force the legacy swipe-only path:
  `pikvm_ipad_unlock({ tryKeyPressFirst: false })`
- Suppress the swipe entirely (safe on already-unlocked iPad):
  `pikvm_ipad_unlock({ swipeOnKeyPressFailure: true })` (default)
- Force always-swipe (legacy behavior):
  `pikvm_ipad_unlock({ swipeOnKeyPressFailure: false })`

## State

- v0.5.210 ships the MCP surface fix
- 707/707 tests pass
- nix build succeeds
- Pushed to origin/main
