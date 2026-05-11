# Phase 258 — shape detector + locality gate picks cursor as top-1 (5/5)

**Date:** 2026-05-11
**Version:** v0.5.218
**Status:** Phase 257 shape detector packaged as production module
`src/pikvm/cursor-shape-detect.ts`. Locality gate confirms top-1
selection: cursor picked correctly in 5/5 Phase 251 frames where
NCC template matching fails completely. 16 unit tests pin the
contract. NOT YET integrated into the live click pipeline — that's
Phase 259.

## Ships in this phase

- `src/pikvm/cursor-shape-detect.ts` — production module
  - `findCursorByShape(rgb, width, height, options)` — main entry
  - `shapeScoreFor(pixels, asymmetry, centroidOffset, aspect)` — pure
    helper for unit tests
  - `ShapeCandidate`, `ShapeOptions` types
- `src/pikvm/__tests__/cursor-shape-detect.test.ts` — 16 tests
  covering:
  - Pure score behaviour (size peak, asymmetry cap, aspect penalty)
  - Synthetic frame detection (single blob, multiple blobs +
    locality disambiguation, null on uniform background)
  - Real Phase 251 frames (5 tests, one per saved trial; cursor
    picked within 30 px in all 5)
- Version bump 0.5.217 → 0.5.218

## What the module does

Drop-in alternative to `findCursorByTemplateSet`. Same shape of
input (decoded RGB + width/height) and similar shape of output
(centroid + score), but the algorithm is fundamentally different:

```typescript
import { findCursorByShape } from './pikvm/cursor-shape-detect.js';

const r = findCursorByShape(rgb, width, height, {
  expectedNear: client.belief.position,   // hint from cursor-belief
  expectedNearRadius: 200,                 // accept candidates within radius
});
// r is { centroidX, centroidY, pixels, shapeScore } or null
```

No template required. No cache. No "minScore" magic threshold (cursors
score 0.8+; non-cursor candidates score <0.5).

## Validation

### Phase 251 frames (acceptance: ≤30 px from visual cursor)

All 5 trial frames from `data/phase251-topk/`. Cursor visually
verified at (1063, 778) in trial1.jpg (Phase 251 doc).

| Trial | Detected pos | Dist | Result |
|------:|--------------|-----:|--------|
| 1     | (1063, 779)  |   1  | PASS   |
| 2     | (1063, 779)  |   1  | PASS   |
| 3     | (1063, 779)  |   1  | PASS   |
| 4     | (1063, 779)  |   1  | PASS   |
| 5     | (1063, 779)  |   1  | PASS   |

Compare to NCC on the same frames: max top-1 = 0.819, below 0.83
minScore = **detector returns null on every trial**.

### Stress tests (unit-test pinned)

- Bad hint (cursor far from `expectedNear`, tight radius) → returns
  null. Correct rejection — no false positive at the wrong place.
- Two cursor-shaped blobs in one frame + hint near one → returns
  the one near the hint. Locality gate disambiguates correctly.
- No dark pixels (uniform light frame) → returns null.

## Architectural significance

NCC failure mode (Phase 251):
> templates fail to clear 0.83 minScore at any position on the
> home screen even though the cursor is plainly visible

Shape detector on the SAME frames returns the cursor with high
confidence. The difference: NCC ties detection to **captured
pixels** (and their backdrop); shape ties detection to **what a
cursor looks like** (small dark asymmetric blob). Wallpaper
changes break NCC; they don't break shape.

This validates the user's observation:
> "humans recognise cursor shape abstractly — a small dark arrow on
> any backdrop"

The shape detector is the human-like approach the project needed
from day one but didn't pursue because pixel-NCC was the easier
starting point.

## Why ship NOW without live integration

Per the Phase 248/250 cleanup lesson: ship code only when there's
demonstrated effect.

- Phase 257 prototype showed cursor ranked top-5 with shape alone
- Phase 258 with locality gate shows cursor ranked TOP-1, 5/5
- 16 unit tests pin the contract against regressions
- The module is **fully back-compat** — nothing in the production
  click pipeline calls it yet

Phase 259 is the integration step: wire `findCursorByShape` into
`moveToPixel`'s correction-pass alongside (or replacing) the
template-match fallback. That's a larger surgery with its own A/B
gate.

## What stays open

- **Frame corpus**: Phase 251 trial frames are 5 captures of nearly
  the same UI state. Need diverse iPadOS contexts (apps with
  different brightness, lock screen, app switcher, cursor over
  icons vs wallpaper, cursor at different screen positions).
  Phase 259 should add a corpus + parameterised acceptance test.
- **Generalisation to dark-mode apps**: the `darkThreshold = 100`
  default assumes the cursor is darker than the surroundings.
  Dark-mode apps may have a light cursor on a dark background —
  inversion required. Documented in the module but not yet
  implemented (the `darkThreshold` option lets callers tune; no
  inversion path yet).
- **Live integration**: this module isn't called from production
  click code. Phase 259 wires it in.

## State

- v0.5.218
- 713/713 tests (was 697; +16 shape-detector tests)
- Nix build green
- Committed and pushed
