# Phase 284 — bundle starter cursor templates in the repo

**Date:** 2026-05-12
**Version:** v0.5.225 (no binary change — assets only)
**Status:** Shipped. Fresh deploys now boot with working NCC.

## What changed

- `.gitignore`: changed `data/` → `data/*` with `!data/cursor-templates/` exception
- Added 5 starter cursor templates under `data/cursor-templates/`
- README updated with note about bundled templates and the B2 future direction

## Why

Phase 281 found that NCC (the primary cursor detector) silently returned null on every iPad home-screen frame because the cached templates didn't match the current iPadOS cursor appearance. The pipeline fell through to cursor-shape-detect's noisy fallback, and click rate dropped to ~0% on both targets.

Phase 283 fixed it on **this** machine by extracting fresh templates from saved frames. But the templates live in `data/`, which was gitignored, so they didn't travel with the repo. **Any other deployment would hit the same silent-failure mode.**

Phase 284 makes those templates ship with the codebase. New deploys now boot with NCC scoring 0.85-0.90 against current iPadOS cursor, and the near-target click rate is ~70% out of the box (matches Phase 283 measurement).

## Future direction — B2: auto-refresh check on startup

Bundling templates fixes new deploys today but doesn't survive **future iPadOS updates** that re-render the cursor. When that happens, the bundled templates will go stale and the silent-failure mode returns.

The long-term fix (deferred): add a startup self-test in the MCP server. On first `pikvm_mouse_click_at` call:

1. Drive cursor to a known visible mid-screen position
2. Run NCC against the bundled templates
3. If best score < 0.83, automatically invoke `seedCursorTemplate` to capture a fresh template
4. Cache the result and proceed with the click

Estimated effort: ~3-4 hours. Adds ~5s of latency to the first click after each deployment but every click after is at production speed.

Not done this phase — deferred until iPadOS template-staleness recurs in the wild and demonstrates that bundling alone isn't enough.

## Verification

- `git check-ignore` confirms `data/cursor-templates/*.jpg` is tracked while other `data/` paths stay ignored
- The 5 templates in the cache produced 70% click rate on near target during Phase 283 N=40 verification

## State

- v0.5.225 unchanged (no binary change)
- 5 templates committed under `data/cursor-templates/`
- New deploys should match Phase 283's ~70% near-target click rate immediately
- Far-target still 0% (separate problem; Phase 285 addresses)
