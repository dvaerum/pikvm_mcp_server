# Phase 238 — expose `forceHomeViaSwipe` (and Phase 231 + Phase 235 chain) via MCP

**Date:** 2026-05-10
**Version:** v0.5.209
**Status:** Shipped.

## Problem

The `pikvm_ipad_home` MCP tool was added before Phase 214 introduced
the `forceHomeViaSwipe` option, and its schema + handler were never
updated. As a result:

1. **Stale description.** The tool description claimed it "emits the
   same swipe-up-from-home-indicator gesture used by pikvm_ipad_unlock"
   and "unlocks if currently on the lock screen". Both are wrong — the
   default path is Cmd+H (no swipe, no unlock).
2. **Missing options.** `inputSchema.properties` exposed only
   `settleMs`. The `forceHomeViaSwipe` and `swipeDragPx` options
   defined in `IpadHomeOptions` had no MCP surface.
3. **Handler discarded args.** The case at `src/index.ts:1181` only
   forwarded `settleMs` even if a hypothetical caller had passed
   `forceHomeViaSwipe: true` somehow.

Combined effect: Phase 214 (App Switcher dismissal), Phase 231
(defensive Esc+Enter), and Phase 235 (mid-screen cursor deposit)
were all visible to library callers (`unlockIpad`, test scripts) but
**invisible to MCP-tool callers** — including the deployed server.

## Fix

`src/index.ts`:

- Replace stale tool description with one that accurately reflects
  Cmd+H semantics and links the Phase 214/231/235 chain.
- Add `forceHomeViaSwipe` (boolean) and `swipeDragPx` (number)
  properties to `inputSchema`.
- Forward both to `ipadGoHome` from the handler with `validateBoolean`
  / `validateNumber` (range 100-3000 px).

No library change. No behavior change for callers that don't pass the
new options. Default `forceHomeViaSwipe=false` preserves backward
compat exactly.

## Doc-truth chain updates

- `AGENTS.md:98` — describes Phase 214 + 231 + 235 chain on `pikvm_ipad_home`
- `README.md:152` — same on the README tool description
- `docs/skills/ipad-keyboard-first-workflow.md:31` — primitives table
  mentions Phase 231/235 alongside Phase 214

## Verification

- 707/707 tests pass at v0.5.209 (no test changes needed; existing
  `ipadGoHome.test.ts` covers the library function and the new MCP
  surface is a thin pass-through that gets covered by integration).
- nix build succeeds at v0.5.209.

## Why this matters

Real MCP clients (LLM agents, scripts) couldn't access the App-Switcher
dismissal path even though it was the canonical fix shipped in
Phase 214. They had to either:
- Use the lower-level `pikvm_mouse_*` + `pikvm_shortcut` tools and
  reimplement the gesture, or
- Live with `pikvm_ipad_home` being unable to escape the App Switcher.

After Phase 238, `pikvm_ipad_home({ forceHomeViaSwipe: true })` does
the right thing automatically — and the description tells callers what
it does.
