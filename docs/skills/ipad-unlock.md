# pikvm_ipad_unlock — Unlock the iPad from Lock Screen

## Purpose
Dismiss the iPadOS lock screen and return to home. The current
mechanism (Phase 217, v0.5.205) sends three keyboard keys —
`Escape` → `Enter` → `Space` — followed by a swipe-up gesture
ONLY if the keys can't be sent or the caller opts in. `Enter` is
the actual unlock key on iPadOS 26 lock screens; `Space` was the
working key on earlier revisions and is kept as a fallback. The
swipe is the legacy mechanism and is now opt-in (Phase 219,
v0.5.206) because running it after a successful key-press takes
an already-unlocked home screen back to the lock screen.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| tryKeyPressFirst | boolean | true | Send Esc + Enter + Space before any swipe. Set false to skip keys and go straight to swipe (legacy callers / older iPadOS). |
| swipeOnKeyPressFailure | boolean | true | When keys ran successfully, SKIP the swipe. Set false to force the legacy keys-then-swipe sequence. |
| slamFirst | boolean | true | Slam to top-left first for a known cursor origin (only relevant when the swipe runs). |
| startX | number | auto | HDMI X of swipe start. Auto-detected from iPad letterbox bounds (centre X). Override only if detection misfires. |
| startY | number | auto | HDMI Y of swipe start. Auto-detected (~45 px above the iPad bottom edge). |
| dragPx | number | 1500 | Total upward drag distance (Phase 209, v0.5.198 raised default 800 → 1500 for stricter iPadOS thresholds). |
| chunkMickeys | number | 30 | Per-call mickey size (smaller = faster motion). |

The unlock swipe origin is computed from `pikvm_detect_orientation` so it works for portrait or landscape iPads in any letterbox position without manual tuning.

## Example Call
```json
{ "name": "pikvm_ipad_unlock", "arguments": {} }
```

## When to Use
- Before any click/move operation if a fresh screenshot shows the lock screen.
- After a long period of inactivity (iPadOS auto-locks after 30 s – 2 min by default).

## Side Effects on Already-Unlocked iPads
- **Default behavior (keys + skip swipe)**: SAFE on home screen. Esc + Enter + Space are no-ops on home; the swipe is skipped because keys ran successfully.
- **`swipeOnKeyPressFailure: false`** or **`tryKeyPressFirst: false`**: the swipe runs. **HAZARD**: a swipe-up from the bottom on an already-unlocked home screen is interpreted by iPadOS as a system gesture that takes the iPad TO THE LOCK SCREEN (live-verified Phase 219, 2026-05-10). Only enable when keys cannot reach the iPad.

## Tips
- **Check the returned screenshot.** If the iPad is still on the lock screen, call again with `tryKeyPressFirst: false` (forces the swipe-based unlock).
- The Phase 210 doc claimed `Space` alone unlocks. That stopped working between Phase 210 and Phase 217; `Enter` is the current working key. The Esc + Enter + Space sequence is defensive — Esc closes any Control Centre / Notification Centre overlay that a prior failed gesture may have opened.
- The 1500-px swipe was empirically validated (Phase 209). 400 px does NOT unlock; 800 px did at one point but stopped clearing the threshold on this iPad later.

## See Also
- `docs/troubleshooting/2026-05-10-phase-217-enter-key-unlocks-ipad.md` — current authoritative mechanism
- `docs/troubleshooting/2026-05-10-phase-219-unlock-from-home-locks-ipad.md` — why the swipe is now opt-in
- `docs/troubleshooting/2026-05-10-phase-210-space-key-unlocks-ipad.md` — historical SUPERSEDED finding
