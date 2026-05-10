# Phase 208 — DEPLOYED MCP server has real bug: click_at fall back to slam locks the iPad

**Date:** 2026-05-10  
**Severity:** User-affecting

## What happened

Ran `pikvm_mouse_click_at(x=905, y=800)` via the deployed MCP
server (the version users actually call). Tool response:

> Target (905,800). Origin via slam-then-move at (11,56). Open-loop
> emitted 1016X+845Y mickeys in 17 chunk(s); default
> px/mickey=(0.88,0.88). Motion-diff failed — cursor pair not found;
> using predicted landing. Final position not detected — click
> accuracy uncertain. WARNING: detect-origin fell back to slam;
> iPad may have re-locked via hot corner.

Post-click screenshot: **iPad LOCK SCREEN.** Time stamp 07:22.

The user wanted to click Settings. Algorithm fell back to
slam-then-move. The slam emitted huge negative deltas to put cursor
at top-left corner, which the iPad interpreted as the hot-corner
gesture and **locked the screen.**

The tool's response message even WARNED about this possibility but
fell back to slam anyway.

## Why this matters

This is a production-tool bug that affects every iPad user every
time `pikvm_mouse_click_at` triggers the slam-fallback path. The
user has to:
1. Detect that the iPad got locked
2. Call `pikvm_ipad_unlock` (which itself doesn't reliably unlock
   on this iPad — see below)
3. Retry the original click

## Root cause

The deployed MCP binary lags the source tree. Per Phase 170 +
recent troubleshooting, deployed version is v0.5.176 (or similar
older). The source has Phase 32's `forbidSlamFallback: !mouseAbsoluteMode`
guard at `src/index.ts:1296` which would prevent this — but the
deployed binary was built before that guard's full effect, OR
`mouseAbsoluteMode` was detected as TRUE at startup (which would
disable the iPad guard).

## Secondary bug: unlock tool also unreliable

After the iPad got locked, called `pikvm_ipad_unlock` with default
`dragPx: 800`. iPad stayed on lock screen.

Retried with `dragPx: 1200`. **Still on lock screen.** Cursor
visible at top-right of the lock screen.

This iPad's unlock threshold is stricter than the documented
defaults. The tool documentation says "If the swipe does not
unlock, try 1000 or 1200" — both insufficient here.

## Recommended user action

1. **Restart the MCP client** to pick up v0.5.197 (latest source).
   The newer build has the Phase 32/33 guards that should prevent
   slam-fallback on iPad targets.
2. If the iPad gets locked anyway, manually unlock it on the
   device (the swipe-up gesture on the actual iPad).
3. After restart, the click_at tool will report explicit
   `forbidSlamFallback=true` errors instead of silently slamming
   and re-locking.

## Recommended code changes (next iteration)

1. **Increase the default `dragPx` in `pikvm_ipad_unlock`** from
   800 to 1500. The current default doesn't work on iPads with
   stricter unlock thresholds.
2. **Verify the deployed binary's `forbidSlamFallback` default**
   actually fires. Add a startup log that surfaces the active
   default.
3. **Add a `pikvm_health_check` tool** that confirms which guards
   are active without requiring a click attempt.

## State at end

- v0.5.197 source has the guards
- Deployed MCP server (whichever older version) does NOT
- iPad is currently on lock screen (as a consequence of this test)
- Next user action will need to unlock manually OR run
  `pikvm_ipad_unlock dragPx=1500` (untried, may also fail)
- Working tree clean, all pushed
