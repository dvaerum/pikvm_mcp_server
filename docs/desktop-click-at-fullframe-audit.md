# `click_at` full-frame-desktop audit (offline)

Follow-up to [desktop-support-gap-analysis.md](./desktop-support-gap-analysis.md)
**gap #2** ("always-run helpers assume an iPad letterbox … *should* degrade but
this is assumed, not verified"). This audit verifies the `pikvm_mouse_click_at`
always-run path on a **full-frame desktop** (absolute mode, no letterbox), and
fixes the one place it did **not** degrade cleanly.

Author: pikvm-mcp-server@nixos-developer-system (offline). Live desktop
measurement remains @georgs-mac-mini's half.

---

## Method

Traced the `pikvm_mouse_click_at` handler (`src/index.ts:1365`) and its delegate
chain for `mouseAbsoluteMode === true` (i.e. `--target desktop`), default args.
Desktop defaults resolve to the **single-shot** branch (`maxRetries === 0`), not
the retry orchestrator, so the path is: handler → `moveToPixel`
(`src/pikvm/move-to.ts`) → `discoverOrigin` → `CursorLocator.locate('origin')`
→ `locateCursor` (`src/pikvm/cursor-detect.ts`), with `slamToCorner` as fallback.

## What already degrades correctly (verified)

`mouseAbsoluteMode === true` disarms every iPad-tuned gate at the handler:

| Helper | Desktop behaviour | Gate |
|---|---|---|
| Brightness gate | `minBrightness = 0` → both the inline (`index.ts:1434`) and retry (`click-verify.ts:537`) gates are **skipped**; cannot abort on a bright or dark desktop | `index.ts:1406` |
| Retry orchestrator / proximity (`maxResidualPx`) / chunk pacing | `maxRetries = 0` → **single-shot**, retry-only helpers never run | `index.ts:1397`, `click-verify.ts:1292` |
| `forbidSlamFallback` (auto-fallback throw) | `!mouseAbsoluteMode` → **false** → disarmed; a locate-miss falls through to slam instead of throwing | `index.ts:1416` |

`detectIpadBounds` on a normal full-frame desktop reads a **landscape** bounding
box, which the slam guard treats as "clearly not an iPad" — so a *content-bearing*
desktop frame was already fine.

## The bug: Phase-32 slam guard was not gated by mode  ✅ FIXED

`discoverOrigin`'s Phase-32 guard (`move-to.ts:1018-1035`) refuses to slam unless
the target is provably non-iPad:

```
const forbidSlamOnIpad = options.forbidSlamOnIpad ?? true;   // default TRUE
const knownNonIpad = detectedBounds !== null && detectedBounds.orientation === 'landscape';
if (forbidSlamOnIpad && !knownNonIpad && !callerProvidedOrigin) throw "refusing slam-then-move — target type undetermined …";
```

This guard was **not** keyed off `mouseAbsoluteMode`, and `click_at` never passed
`forbidSlamOnIpad`, so it defaulted `true` even in desktop mode. Failure case on a
**full-frame desktop**:

1. `locateCursor` misses (its relative-probe constants are iPad-tuned — see below), **and**
2. bounds detection returns `null` because the frame is uniform/blank (a black
   terminal, a solid-colour splash, a just-woken display),

→ `detectedBounds === null` → `knownNonIpad === false` → the guard **throws
"target type undetermined"**. It presumes an undetermined target is an iPad — but
`--target desktop` already declared it is not.

**Fix** (`src/index.ts`, in `click_at`'s `moveOpts`): pass
`forbidSlamOnIpad: !mouseAbsoluteMode`, mirroring the adjacent
`forbidSlamFallback: !mouseAbsoluteMode`. In desktop mode the guard is disarmed
(safe by construction — no iPad hot-corners exist on a desktop, which is the
*only* thing the guard protects against); iPad mode keeps the default `true`.
Pinned by a new case in `move-to.forbidSlamOnIpad.test.ts` ("allows slam-then-move
when bounds detection fails but caller opted out (desktop mode)").

## Remaining, for live desktop verification (not fixed offline)

These are correct-to-flag but need a real desktop behind the PiKVM to tune — no
offline fix, they route to the live half:

1. **`locateCursor` probe constants are iPad-tuned** (`cursor-detect.ts:502-601`):
   a fixed `-120` wake-nudge and `±60/180/360` relative probes, a sanity window
   `[probeDelta*0.3, probeDelta*25]` that assumes iPadOS pointer-acceleration
   (~20×), `brightnessFloor: 100`, and a `4–90 px / ≥2-cluster` band matched to
   the iPad cursor's bright-pixel signature. On a **linear absolute-mouse
   desktop** a relative-probe displacement is different (smaller, 1:1), so pairs
   can fall outside the window → **false miss** → drops to slam. Not fatal now
   (slam proceeds post-fix), but the high-accuracy `detect-then-move` path won't
   reach its accuracy on desktop until these are validated/tuned live. Note:
   basic desktop control does **not** need this path at all — absolute
   `pikvm_mouse_move(x,y)` after `auto_calibrate` needs no cursor detection.
2. **Handler inline brightness gate is mean-only** (`index.ts:1447`,
   `brightness.mean < minBrightness`, no `stddev`/severity guard), unlike the
   safer retry-path gate (requires `severity === 'very-dim'`, i.e. `stddev < 3`).
   Harmless under desktop defaults (`minBrightness === 0`), but a caller that
   manually sets `minBrightness > 0` on the single-shot path could false-abort a
   genuinely dark-but-high-contrast desktop (a dark terminal). Low priority;
   noted so a future change unifies on the severity-aware check.

## Bottom line

The full-frame desktop `click_at` path degrades cleanly after this one-line fix.
The residual items are accuracy-tuning of the optional high-accuracy mover, best
measured against real hardware — they do not block basic desktop control, which
runs through the cursor-agnostic absolute path.
