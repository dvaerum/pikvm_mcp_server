# Cursor ground-truth labeling schema

Visual ground truth for `data/cursor-training-v0/` (239 pairs ×
A/B = 478 frames). Created 2026-05-13 after discovering the
existing labels are 100% algorithmic and inherit the wiggle-diff
heuristic's failure modes (Phase 310 tautology, label-text FPs,
widget-digit FPs).

## Output

One JSON line per frame in `data/cursor-training-v0/verified.jsonl`.
Resumable: line count = frames labeled.

## Schema

```json
{
  "frame": "2026-05-13_05-33-56_0000_A.jpg",
  "cursor": {
    "visible": true,
    "x": 1151,
    "y": 777,
    "tip_or_center": "tip",
    "state": "normal",
    "confidence": "high"
  },
  "frame_state": "lock",
  "bg_complexity": "moderate",
  "algorithm_label": { "x": 1151, "y": 777 },
  "agrees_with_algorithm": true,
  "agree_dist_px": 0,
  "notes": ""
}
```

### `cursor.visible`

- `true`: cursor is detectable to a human looking at the 200×200
  native-res crop centered on the algorithm label OR the
  downsampled full preview. Note coordinates.
- `false`: NO cursor anywhere in the frame, OR cursor faded
  beyond human visibility. Critical for negative examples —
  currently absent from training data, root cause of Phase 310
  tautology.

### `cursor.x` / `cursor.y`

Integer pixel coordinates in the 1680×1050 full-frame space. The
cursor's *tip* (point) is preferred. If the cursor is a pointer-
effect blob with no tip, use the center of the bounding box.
`null` when `visible: false`.

### `cursor.tip_or_center`

- `"tip"`: coordinates point to the cursor's arrowhead point.
- `"center"`: coordinates point to the center of a blob (when
  no arrowhead visible — pointer-effect mode).

### `cursor.state`

- `"normal"`: standard iPadOS pointer arrow, sharp edges.
- `"faded"`: cursor visible but lower-contrast than normal (mid-
  fade-out animation).
- `"pointer-effect-blob"`: iPadOS has snapped the cursor to a
  button/icon — appears as a tinted rounded shape, no arrow.
- `"edge-clipped"`: cursor partially off-screen or clipped by
  letterbox / status bar / dock.
- `"absent"`: no cursor in frame.

### `cursor.confidence`

How sure I am of the position (not how sure the cursor exists):
- `"high"`: cursor clearly visible, can pinpoint tip to ≤5 px.
- `"medium"`: cursor visible but position fuzzy (±10 px).
- `"low"`: barely visible; algorithm-position guess.

### `frame_state`

What the iPad was showing:
- `"lock"`: lock screen (clock visible, no app icons, "Wed 13
  May" date, swipe-up indicator).
- `"home"`: home screen (app icons visible, dock).
- `"app"`: an app is open.
- `"spotlight"`: Spotlight search open.
- `"appswitcher"`: app switcher open.
- `"other"`: anything else (Notification Center, Control Center,
  Settings deep view, modal, etc).

### `bg_complexity`

Local background around the cursor:
- `"simple"`: single color, smooth gradient, low texture.
- `"moderate"`: wallpaper with some variation but no fine detail.
- `"complex"`: text, icons, sharp edges, fine detail nearby.

### `algorithm_label`

The existing `cursor.{x,y}` from the wiggle-diff heuristic.
Always populate from the sidecar JSON.

### `agrees_with_algorithm`

- `true` if `visible: true` AND `hypot(x-algX, y-algY) ≤ 15px`.
- `false` otherwise (including all `visible: false` cases).

### `agree_dist_px`

- If `visible: true`: integer Euclidean distance from manual to
  algorithm label.
- If `visible: false`: `null` (no manual position to compare).

### `notes`

Free text. Use for anything not captured by the schema. Examples:
- `"two cursor-like blobs, picked the brighter one"`
- `"algorithm landed on clock digit"`
- `"cursor at extreme right edge, partially clipped"`
- `"can't tell if the dark spot is the cursor or wallpaper texture"`

## Process

1. Generate crops: `python3 ml/make-crops-for-labeling.py`
2. For each `<stem>.jpg`:
   - Read `data/cursor-training-v0/_crops/<stem>_crop.jpg` (200×200
     native pixels — clear view at full resolution).
   - If unsure cursor is real / want to check for cursor
     elsewhere: also Read `_crops/<stem>_full.jpg` (840×525
     downsampled preview).
   - Append the JSON line to `verified.jsonl`.

## Stop criteria

- All 478 frames labeled OR
- User explicitly says stop.

## Quality bar

- Trust your eyes. If you can't see a cursor, label
  `visible: false`. Even if the algorithm "saw" it, your job is
  to record what is *visually verifiable*, not to reproduce the
  heuristic.
- Mark confidence `"low"` and add notes when in doubt. Don't
  skip.
