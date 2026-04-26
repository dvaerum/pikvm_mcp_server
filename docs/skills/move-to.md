# pikvm_mouse_move_to — Approximate Move to a Screen Pixel (Relative Mode)

> **iPad users — keyboard-first is usually better.**
> Cursor positioning on iPad is fundamentally fragile due to non-disableable
> pointer acceleration. Most agent tasks can be done end-to-end via the
> keyboard pattern in
> [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md). Reach for this
> tool only when keyboard navigation can't reach the UI element you need.
>
> See [ipad-setup.md](ipad-setup.md) for recommended iPadOS settings
> when you do need cursor positioning.

## Purpose
Move the pointer to an approximate target pixel on a PiKVM target in relative mouse mode (iPad, etc.). Default strategy `"detect-then-move"` probes the cursor with a small motion-diff to discover the origin (no slam required), then emits a chunked delta sequence to the target with up to 2 correction passes plus a ground-truth detection pass. Returns a post-move screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| strategy | string | detect-then-move | Origin discovery. **DO NOT use `"slam-then-move"` on iPad** — slam to top-left triggers the iPadOS hot-corner gesture and re-locks the screen (Phase 32a). |
| assumeCursorAtX/Y | number | — | With `strategy="assume-at"`, where the cursor currently is. |
| fallbackPxPerMickey | number | 1.3 | px/mickey when no ballistics profile is loaded. |
| chunkMagnitude | number | 60 | Per-call delta size in mickeys. |
| chunkPaceMs | number | 20 | Pace between chunked calls (ms). |
| correct | boolean | true | Enable motion-diff detection + correction loop. |
| maxCorrectionPasses | number | 2 | Max correction passes (independent attempts to re-aim). |
| minResidualPx | number | 25 | Early-exit threshold (px) for the correction loop. |
| warmupMickeys | number | 8 | Tiny move emitted before screenshot A so the cursor renders. |

(The `slamOriginX/Y` parameters still exist for `strategy="slam-then-move"` but should NOT be used on iPad. The default `detect-then-move` strategy ignores them.)

## Expected Accuracy

After Phases 65-77 (v0.5.68+):

| Target width | Per-attempt residual ≤ 25 px | 3-attempt rate (with retry layer above) |
|--------------|------------------------------|------------------------------------------|
| ≥ 200 px     | ~80% (residual ≤ 100 px) | ~99% |
| 100-200 px   | ~70% (residual ≤ 100 px) | ~97% |
| 50-100 px    | ~60% (residual ≤ 50 px)  | ~94% |
| < 50 px      | ~50% (residual ≤ 25 px)  | ~88% |

Single-digit residuals are achievable when motion-diff succeeds (Phase 69 measured 6-9 px hits). 

## When to Use vs Closed-Loop Correction
- For most click tasks: prefer `pikvm_mouse_click_at` with `maxRetries: 2` — same algorithm, but with retry-on-miss orchestration baked in.
- For agent-driven closed-loop where you want screenshot inspection between move and click: this tool returns the screenshot and reported residual, suitable for an agent to compute a correction delta and issue follow-up `pikvm_mouse_move` calls.

## Example Calls
```json
{ "name": "pikvm_mouse_move_to", "arguments": { "x": 960, "y": 540 } }

{ "name": "pikvm_mouse_move_to", "arguments": { "x": 1200, "y": 800, "strategy": "assume-at", "assumeCursorAtX": 800, "assumeCursorAtY": 700 } }
```

## Tips
- Prefer `pikvm_mouse_click_at` for "move + click in one step" — it adds verification and retries.
- On an iPad that is locked, call `pikvm_ipad_unlock` first — move-to can move the cursor on a locked iPad but clicks will not trigger app behavior.
- iPadOS dims the cursor after ~1 s of inactivity; the algorithm's warmup nudge handles the common case but extra-long pauses between calls may need a manual wake.
