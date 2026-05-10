# Phase 246 (v0.5.212) — expose Phase 202 keepalive screenshot via MCP

**Date:** 2026-05-11
**Version:** v0.5.212
**Status:** Shipped + live-verified.

## Problem

`PiKVMClient.screenshotKeepingCursorAlive` (Phase 202, v0.5.197) is
the production-proven way to take a screenshot with the iPad cursor
visible — it emits a ±1 px wake nudge immediately before the
snapshot so iPadOS doesn't fade the cursor between captures.

The library function is used internally by detection probes and the
seed-template code path, but **was not exposed via the MCP
`pikvm_screenshot` tool**. MCP callers (LLM agents, automation
scripts) doing visual cursor verification or debugging click_at
residuals always got the plain `screenshot` variant — and on iPad
that means the cursor has usually faded by the time the frame is
captured (Phase 242 documented this clearly).

Same silent-exposure pattern Phase 238/239/241 closed for the
unlock/home/click_at tools.

## Fix

`src/index.ts`:

- Tool description updated to explain when to use `keepCursorAlive`
  (iPad cursor visibility for verification or debugging)
- `inputSchema` adds `keepCursorAlive: boolean` property with
  default-false semantics
- Handler routes via `validateBoolean(args.keepCursorAlive)` —
  when truthy, calls `pikvm.screenshotKeepingCursorAlive(opts)`;
  otherwise the plain `pikvm.screenshot(opts)` path

No library change. Default `false` preserves backward compatibility
for every existing caller.

## Live verification

`npx tsx -e` snippet calls both variants in sequence — plain
screenshot then keepalive screenshot — and confirms both return
valid JPEG buffers. nix build green at v0.5.212.

## Regression test

Extended `src/__tests__/mcp-tool-schema-exposure.test.ts` with 2
new tests under "pikvm_screenshot — Phase 202 keepalive variant
exposed (Phase 246)":

1. Schema declares `keepCursorAlive: boolean`
2. Handler text contains both `validateBoolean(args.keepCursorAlive)`
   AND `screenshotKeepingCursorAlive`

727/727 tests pass.

## Why this matters

Real MCP clients debugging an iPad click_at miss often want to
visually inspect "where did the cursor actually land?" Before
Phase 246 they would call `pikvm_screenshot`, get a faded-cursor
frame, and conclude "the cursor isn't even there" — which is a
false negative. After Phase 246, `pikvm_screenshot({ keepCursorAlive:
true })` gives a reliable cursor-visible frame.

## State

- v0.5.212 ships the exposure
- 727 tests, nix build green
- Pushed to origin/main
