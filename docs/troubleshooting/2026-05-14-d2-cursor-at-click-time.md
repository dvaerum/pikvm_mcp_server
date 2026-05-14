# D2 — cursor position at button-down moment

## Verdict

**Move-to is broken.** At the instant the click HID event fires,
the cursor is NOT on the target icon. Visual inspection of
PRE-button-down screenshots across 9 trials × up to 4 attempts
(maxRetries=3 + initial) on a clean iPad home screen:

- Some attempts: cursor 200-500 px from target (totally wrong
  position).
- Some attempts: cursor close to target but in the wallpaper gap
  between icons (no icon at click point → page-swipe trigger).
- Files target (1037, 425, row 2 column 4): cursor consistently
  stuck near y=850-880 (bottom-row dock area). Algorithm never
  reaches the upper rows for Files.

Hypothesis: **iPadOS pointer-effect snap is gluing the cursor to
dock icons**, and the algorithm's emit-based "move up" doesn't
overcome the snap. The cursor lands in or near the dock and stays
there regardless of target.

## Method

`PIKVM_PREDOWN_DIR=./data/d2-predown npx tsx
bench-ml-v0-vs-v1.ts v1 3` with D2a instrumentation in
`src/pikvm/click-verify.ts` that saves a screenshot immediately
before `client.mouseClick()`.

27 predown frames captured for 9 trials × ~3 attempts each
(some hits exited early, some failed to capture).

## Net click rate (D2 bench, clean state)

| Target   | hits | rate |
| -------- | ---- | ---- |
| Settings | 0/3  | 0%   |
| Books    | 0/3  | 0%   |
| Files    | 0/3  | 0%   |
| **All**  | **0/9** | **0%** |

screenChanged=false on every trial (no app opened, no page
swipe, no modal shown). This matches the visual finding: clicks
are landing in the wallpaper gap between icons, which neither
opens an app nor triggers a page-swipe (those happen only when
the click+drag is wider than this implementation generates).

## D2c decision

→ **D2.5 (debug detect-emit-land loop)** rather than D3 (click
HID timing). The cursor isn't on the icon at click time, so any
HID timing tweak is downstream of the actual bug.

D3a/D3b conditional are skipped: there is no point checking
HID click registration when the cursor isn't on the target.

## Confounders to acknowledge

- iPad battery at 10% with low-battery modal at start of first
  D2 run. Modal cleared via Escape key in scripts/dismiss-modal.ts,
  then bench re-run on confirmed home-page-1 state. Both
  pre/post-clear runs showed the same 0% rate and similar
  cursor-stuck-in-dock pattern, so battery is not the load-
  bearing cause.
- The bench uses `forbidSlamFallback: true` (no slam-to-anchor
  recovery). That's the production-mode default but means
  recoveries depend solely on detect-then-move.

## Files

- `bench-d1-pre-click-state.ts` (D1)
- `bench-ml-v0-vs-v1.ts` (D1e re-run, D2b)
- `src/pikvm/click-verify.ts` — added PIKVM_PREDOWN_DIR capture
  (D2a)
- `scripts/dismiss-modal.ts` — Escape × 2 keypresses to clear
  any system modal
- `docs/troubleshooting/2026-05-14-d1-bench-state.md` — D1
  verdict
- This file — D2 verdict

