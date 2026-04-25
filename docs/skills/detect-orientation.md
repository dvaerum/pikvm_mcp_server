# pikvm_detect_orientation — Detect iPad Bounds and Orientation

## Purpose
PiKVM captures the full HDMI frame (e.g. 1920×1080), but an iPad displayed in portrait fills only a vertical strip in the middle, with black letterbox bars on either side; in landscape, the iPad fills (or nearly fills) the frame. This tool finds the iPad's actual content rectangle inside the HDMI capture and reports its size, position, centre, and orientation.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| brightnessSum | number | 60 | Per-channel sum (R+G+B) above which a pixel counts as iPad content rather than letterbox black. Lower this if your iPad has very dark wallpaper that the default threshold misses. |

## Example Call
```json
{ "name": "pikvm_detect_orientation", "arguments": {} }
```

## Output
A JSON blob describing the detected bounds:
```json
{
  "x": 616,
  "y": 48,
  "width": 688,
  "height": 984,
  "centerX": 960,
  "centerY": 540,
  "orientation": "portrait",
  "resolution": { "width": 1920, "height": 1080 }
}
```

## When to Use
- **Almost never directly.** `pikvm_ipad_unlock` and `pikvm_mouse_move_to` both call this internally when their swipe/slam origin arguments are not set, so most agents can rely on automatic orientation handling.
- Call this manually when: (a) you want to inspect the iPad layout for debugging, (b) you want to precompute slam/unlock origins to skip the repeated detection cost on tight loops, or (c) the iPad's wallpaper is so dark that auto-detection misses content and you want to tune `brightnessSum`.

## How It Works
1. Take a screenshot of the HDMI frame.
2. Decode to raw RGB.
3. Coarse pass: sample every 4th row/column, find the bounding box of pixels whose channel sum exceeds `brightnessSum`.
4. Refine each edge to pixel accuracy by walking inward from the coarse bounds.
5. Compare width vs. height to label orientation.

## Caveats
- Detection assumes the iPad displays visible UI (status bar, dock, lock-screen clock). If the iPad is asleep with the screen completely off, the entire HDMI frame may be near-black and detection will throw.
- Animated wallpapers and transitions can change the detected bounds by a few pixels; this is fine for the swipe/slam targets that consume them but call again if you cached an outdated rect.
