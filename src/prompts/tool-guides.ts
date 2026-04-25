/**
 * Tool guide prompts — one per PiKVM tool that agents commonly use.
 */

import type { PromptDefinition } from './types.js';

export const toolGuidePrompts: PromptDefinition[] = [
  // ---------- take-screenshot ----------
  {
    name: 'take-screenshot',
    description: 'Guide for capturing screenshots with pikvm_screenshot',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_screenshot — Capture a Screenshot

## Purpose
Capture the current screen of the remote machine as a JPEG image. This is your primary way to **see** what is on screen.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| maxWidth | number | *(native)* | Maximum width in pixels — image is scaled down if the screen is wider |
| maxHeight | number | *(native)* | Maximum height in pixels — image is scaled down if the screen is taller |
| quality | number | 80 | JPEG quality (1-100) |

Scaling preserves aspect ratio. When you scale a screenshot, the server tracks the scale factor so that mouse coordinates you derive from the image are automatically mapped back to native resolution.

## Example Call
\`\`\`json
{
  "name": "pikvm_screenshot",
  "arguments": { "maxWidth": 1280, "quality": 70 }
}
\`\`\`

## Tips
- Omit maxWidth/maxHeight to get the full native resolution — best for reading small text.
- Use lower quality (50-60) when you only need layout/position information to save bandwidth.
- Always take a screenshot **after** performing an action to verify the result.
- The response includes a text line describing dimensions and any scaling that was applied.`,
          },
        },
      ];
    },
  },

  // ---------- check-resolution ----------
  {
    name: 'check-resolution',
    description: 'Guide for checking screen resolution with pikvm_get_resolution',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_get_resolution — Check Screen Resolution

## Purpose
Return the current width and height of the remote screen in pixels. The result defines the valid coordinate space for all mouse operations.

## Parameters
None.

## Example Call
\`\`\`json
{ "name": "pikvm_get_resolution" }
\`\`\`

## When to Call
- At the **start of a session** so you know the coordinate space before any mouse interaction.
- After the remote machine might have **changed resolution** (e.g., opening a game, switching display settings).
- Before **calibration** — the calibrate workflow uses this value.

## Tips
- Valid mouse coordinates range from (0, 0) to (width-1, height-1).
- If the resolution changes after you have calibrated, calibration is **automatically invalidated** — you will need to recalibrate.`,
          },
        },
      ];
    },
  },

  // ---------- type-text ----------
  {
    name: 'type-text',
    description: 'Guide for typing text with pikvm_type',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_type — Type Text

## Purpose
Type a string of text on the remote machine. The server converts characters into the correct HID key events using the specified keyboard layout, so special characters (e.g., @, #, {) are handled correctly.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| text | string | *(required)* | The text to type |
| keymap | string | en-us | Keyboard layout for character-to-key conversion |
| slow | boolean | false | Use slow typing mode (adds extra delays for compatibility) |
| delay | number | *(default)* | Delay between keystrokes in ms (0-200) |

## Example Call
\`\`\`json
{
  "name": "pikvm_type",
  "arguments": { "text": "Hello, world!", "slow": true }
}
\`\`\`

## Tips
- Use \`pikvm_type\` for printable text. For control keys (Enter, Tab, Escape, etc.) use \`pikvm_key\` instead.
- Enable **slow** mode or increase **delay** if the target machine drops characters.
- Very long strings may hit PiKVM endpoint limits — keep individual calls under ~1000 characters and split longer text into multiple calls.
- The response shows a truncated preview of what was typed (first 50 chars) for privacy.`,
          },
        },
      ];
    },
  },

  // ---------- send-key ----------
  {
    name: 'send-key',
    description: 'Guide for sending keys with pikvm_key',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_key — Send a Key or Key Combination

## Purpose
Send a single key event, optionally with modifier keys held down. Use this for control keys, function keys, and modifier combos that aren't representable as plain text.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| key | string | *(required)* | JavaScript key code (e.g., Enter, KeyA, F5) |
| modifiers | string[] | [] | Modifier keys to hold while pressing key |
| state | "click" \\| "press" \\| "release" | click | Key state — click sends press+release |

## Common Key Codes
- Letters: KeyA … KeyZ
- Digits: Digit0 … Digit9
- Function: F1 … F12
- Modifiers: ShiftLeft, ControlLeft, AltLeft, MetaLeft (and Right variants)
- Special: Enter, Escape, Backspace, Tab, Space, Delete, Insert, Home, End, PageUp, PageDown
- Arrows: ArrowUp, ArrowDown, ArrowLeft, ArrowRight

## Example Calls
\`\`\`json
{ "name": "pikvm_key", "arguments": { "key": "Enter" } }

{ "name": "pikvm_key", "arguments": { "key": "KeyS", "modifiers": ["ControlLeft"] } }

{ "name": "pikvm_key", "arguments": { "key": "ShiftLeft", "state": "press" } }
\`\`\`

## Tips
- For simultaneous multi-key shortcuts (e.g., Ctrl+Alt+Del), prefer \`pikvm_shortcut\` — it presses all keys in one operation.
- Use **press** / **release** states for drag operations or when you need a modifier held across multiple actions.
- Modifiers are automatically pressed before and released after the main key.`,
          },
        },
      ];
    },
  },

  // ---------- send-shortcut ----------
  {
    name: 'send-shortcut',
    description: 'Guide for sending keyboard shortcuts with pikvm_shortcut',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_shortcut — Send a Keyboard Shortcut

## Purpose
Press multiple keys simultaneously. All keys are pressed in order, then released in reverse order, mimicking a human pressing a shortcut.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| keys | string[] | *(required)* | Array of key codes to press together (max 10) |

## Example Calls
\`\`\`json
{ "name": "pikvm_shortcut", "arguments": { "keys": ["ControlLeft", "AltLeft", "Delete"] } }

{ "name": "pikvm_shortcut", "arguments": { "keys": ["ControlLeft", "KeyC"] } }

{ "name": "pikvm_shortcut", "arguments": { "keys": ["AltLeft", "F4"] } }
\`\`\`

## Tips
- List **modifier keys first**, then the action key — this mirrors how humans press shortcuts.
- Maximum of **10 keys** per call.
- Common shortcuts: Ctrl+C (copy), Ctrl+V (paste), Ctrl+Z (undo), Alt+Tab (switch window), Ctrl+Alt+Delete (security attention).
- If you only need one key with modifiers, \`pikvm_key\` with the \`modifiers\` parameter works too. \`pikvm_shortcut\` is better when there are many keys or no single "main" key.`,
          },
        },
      ];
    },
  },

  // ---------- move-mouse ----------
  {
    name: 'move-mouse',
    description: 'Guide for moving the mouse with pikvm_mouse_move',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_mouse_move — Move the Mouse Cursor

## Purpose
Move the mouse cursor to an absolute pixel position or by a relative delta.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | X coordinate (absolute) or delta (relative) |
| y | number | *(required)* | Y coordinate (absolute) or delta (relative) |
| relative | boolean | false | If true, move relative to current position |

## Coordinate Space
- **Absolute mode** (default): (0, 0) is the top-left corner. Maximum values are (width-1, height-1) from \`pikvm_get_resolution\`.
- **Relative mode**: Deltas are clamped to -127 to 127 per call. Use multiple calls for larger relative moves.

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_move", "arguments": { "x": 500, "y": 300 } }

{ "name": "pikvm_mouse_move", "arguments": { "x": -50, "y": 0, "relative": true } }
\`\`\`

## Tips
- If calibration is active, absolute coordinates are automatically adjusted.
- A **resolution change** will invalidate calibration — you'll see a warning in the response.
- To move and click in one step, use \`pikvm_mouse_click\` with x/y parameters instead.`,
          },
        },
      ];
    },
  },

  // ---------- click-element ----------
  {
    name: 'click-element',
    description: 'Guide for clicking with pikvm_mouse_click',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_mouse_click — Click a Mouse Button

## Purpose
Click a mouse button, optionally moving to a position first. Supports left, right, middle click and scroll wheel buttons.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| button | "left" \\| "right" \\| "middle" \\| "up" \\| "down" | left | Button to click. "up"/"down" are scroll wheel buttons |
| x | number | *(current)* | X pixel coordinate to move to before clicking |
| y | number | *(current)* | Y pixel coordinate to move to before clicking |
| state | "click" \\| "press" \\| "release" | click | Button state |

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_click", "arguments": { "x": 500, "y": 300 } }

{ "name": "pikvm_mouse_click", "arguments": { "button": "right", "x": 100, "y": 200 } }

{ "name": "pikvm_mouse_click", "arguments": { "button": "left", "x": 100, "y": 100, "state": "press" } }
\`\`\`

## Tips
- Providing x and y moves the cursor **then** clicks — it's a single tool call instead of move + click.
- Use **press** and **release** states for drag-and-drop: press at the source, move, release at the destination.
- Double-click: call twice in quick succession with the same coordinates.
- Always take a screenshot first to determine accurate click coordinates.`,
          },
        },
      ];
    },
  },

  // ---------- auto-calibrate ----------
  {
    name: 'auto-calibrate',
    description: 'Guide for automatic mouse calibration with pikvm_auto_calibrate',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_auto_calibrate — Automatic Mouse Calibration

## Purpose
Automatically calibrate mouse coordinates by detecting the cursor position via screenshot diffing. More accurate than manual calibration because it detects the actual cursor position programmatically instead of relying on visual estimation.

## How It Works
1. Moves the mouse a known distance across multiple rounds
2. Diffs pairs of screenshots to find cursor-sized changes (connected pixel clusters)
3. Compares detected movement to commanded movement to compute calibration factors
4. Verifies accuracy by moving to random positions and checking detected vs expected positions
5. Retries with increased delays if verification fails

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| rounds | number | 5 | Number of sampling rounds to compute calibration factors |
| verifyRounds | number | 5 | Number of verification rounds after calibration is computed |
| moveDelayMs | number | 300 | Delay in ms after each mouse move (increase for slow PiKVM connections) |

## Example Call
\`\`\`json
{ "name": "pikvm_auto_calibrate" }

{ "name": "pikvm_auto_calibrate", "arguments": { "moveDelayMs": 500 } }
\`\`\`

## Tips
- This is the **preferred calibration method** — try it before manual calibration.
- Other tools are blocked while auto-calibration is running.
- If it fails, try increasing \`moveDelayMs\` (slow video capture is the most common cause).
- If it repeatedly fails, fall back to manual calibration with \`pikvm_calibrate\`.
- Works best when the desktop is static (no animations, videos, or blinking elements near the cursor).`,
          },
        },
      ];
    },
  },

  // ---------- scroll-page ----------
  {
    name: 'scroll-page',
    description: 'Guide for scrolling with pikvm_mouse_scroll',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_mouse_scroll — Scroll the Mouse Wheel

## Purpose
Scroll the mouse wheel vertically or horizontally.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| deltaY | number | *(required)* | Vertical scroll: negative = scroll up, positive = scroll down |
| deltaX | number | 0 | Horizontal scroll: negative = scroll left, positive = scroll right |

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_scroll", "arguments": { "deltaY": -3 } }

{ "name": "pikvm_mouse_scroll", "arguments": { "deltaY": 5, "deltaX": 2 } }
\`\`\`

## Tips
- A deltaY of **-3 to -5** is a reasonable "scroll up one section" amount; **3 to 5** for scrolling down.
- Move the cursor over the target area first if the scroll should apply to a specific pane or element.
- For long pages, use multiple scroll calls with screenshots in between to verify you've reached the desired content.
- Horizontal scrolling is less commonly supported — verify it works on the target application.`,
          },
        },
      ];
    },
  },

  // ---------- detect-orientation ----------
  {
    name: 'detect-orientation',
    description: 'Guide for pikvm_detect_orientation — find the iPad letterbox bounds within the HDMI capture',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_detect_orientation — Detect iPad Bounds and Orientation

## Purpose
PiKVM captures the full HDMI frame (e.g. 1920×1080), but an iPad displayed in portrait fills only a vertical strip in the middle, with black letterbox bars on either side; in landscape, the iPad fills (or nearly fills) the frame. This tool finds the iPad's actual content rectangle inside the HDMI capture and reports its size, position, centre, and orientation.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| brightnessSum | number | 60 | Per-channel sum (R+G+B) above which a pixel counts as iPad content rather than letterbox black. Lower this if your iPad has very dark wallpaper that the default threshold misses. |

## Example Call
\`\`\`json
{ "name": "pikvm_detect_orientation", "arguments": {} }
\`\`\`

## When to Use
- **Almost never directly.** \`pikvm_ipad_unlock\` and \`pikvm_mouse_move_to\` both call this internally when their swipe/slam origin arguments are not set, so most agents can rely on automatic orientation handling.
- Call manually for debugging or when you want to precompute slam/unlock origins to skip repeated detection cost.

## Tips
- If detection throws "entire screenshot is black" the HDMI input is disconnected or the iPad is asleep — wake it via \`pikvm_ipad_unlock\` or a key press first.
- Animated wallpaper transitions can shift the detected rect by a few pixels; that is fine for slam/swipe origins which only need the rough centre and inset corner.`,
          },
        },
      ];
    },
  },

  // ---------- ipad-unlock ----------
  {
    name: 'ipad-unlock',
    description: 'Guide for unlocking an iPad via pikvm_ipad_unlock',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_ipad_unlock — Unlock the iPad from Lock Screen

## Purpose
iPadOS requires a swipe-up-from-bottom gesture to dismiss the lock screen. With a USB HID mouse, this is emitted as: position cursor → press → rapid upward drag → release. This tool packages the verified gesture parameters so agents don't have to reinvent them.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| slamFirst | boolean | true | Slam to top-left first for a known origin |
| startX | number | auto | HDMI X of swipe start. Auto-detected from iPad letterbox bounds (centre X). Override only if detection misfires. |
| startY | number | auto | HDMI Y of swipe start. Auto-detected from iPad letterbox bounds (~45 px above the iPad bottom edge). Override only if detection misfires. |
| dragPx | number | 800 | Total upward drag distance |
| chunkMickeys | number | 30 | Per-call mickey size (smaller = faster motion) |

The unlock swipe origin is computed from \`pikvm_detect_orientation\` so it works for portrait or landscape iPads in any letterbox position without manual tuning. Pass explicit \`startX\`/\`startY\` only if auto-detection picks the wrong area (e.g. when the iPad's HDMI signal is partly black for non-letterbox reasons).

## Example Call
\`\`\`json
{ "name": "pikvm_ipad_unlock", "arguments": {} }
\`\`\`

## When to Use
- Before any click/move operation if a fresh screenshot shows the lock screen.
- After a long period of inactivity (iPadOS auto-locks after 30 s – 2 min by default).

## Side Effects on Already-Unlocked iPads
This tool emits the iPadOS swipe-up-from-home-indicator gesture. iPadOS interprets it differently depending on state:

| State | Result |
|---|---|
| Lock screen | Unlocks → home screen (intended use) |
| Home screen | No-op ("go home" is idempotent when already home) |
| **Inside an app** | **Closes the app** and returns to home screen |

**Check with \`pikvm_screenshot\` first** if there's a risk the iPad is inside an app you don't want to dismiss.

## Tips
- **Check the returned screenshot.** If the iPad is still on the lock screen, call again with \`dragPx: 1000\` or \`1200\`.
- If the swipe consistently fails, the iPad's letterbox offset may differ on your device. Measure where the home indicator actually is in your screenshots and override \`startX\`/\`startY\`.
- Empirically verified: 400 px drag does NOT unlock; 800 px does. Speed matters less than total distance.`,
          },
        },
      ];
    },
  },

  // ---------- measure-ballistics ----------
  {
    name: 'measure-ballistics',
    description: 'Guide for characterizing relative-mouse ballistics with pikvm_measure_ballistics',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_measure_ballistics — Characterize iPad/Relative-Mouse Ballistics

## Purpose
When the PiKVM target uses \`mouse.absolute=false\` (e.g. iPad), deltas have a non-trivial, non-linear pixel/mickey ratio because of OS-side pointer acceleration. This tool slams the cursor to a known corner, sweeps (axis × magnitude × pace × rep), and writes a JSON profile to \`./data/ballistics.json\`. The profile is consulted by \`pikvm_mouse_move_to\` and \`pikvm_mouse_click_at\`.

## When to Run
- Once per device + orientation + resolution.
- When your observed move-to accuracy degrades (e.g. after iPadOS updates that change pointer acceleration).

## Caveats (read before running)
- **Needs a quiet screen.** On the iPad home screen, animated widgets (clock second hand, weather ticker) produce so many pixel diffs that cursor detection mis-locks on them. Navigate to a static screen first — iPad Settings, a blank Safari page, or the lock screen.
- **Results have variance.** Even on quiet screens, per-cell medians can vary 2-3x between runs because iPad auto-hides the cursor and pointer-effect rendering perturbs the diff. Treat the profile as a *hint*, not ground truth.
- **Takes ~1-5 minutes** depending on rep count.

## Example Calls
\`\`\`json
{ "name": "pikvm_measure_ballistics", "arguments": {} }

{ "name": "pikvm_measure_ballistics", "arguments": { "magnitudes": [127], "paces": ["slow"], "reps": 5, "verbose": true } }
\`\`\`

## Tips
- If \`samplesAccepted\` is much less than the total sweep size, the screen was too noisy — navigate to a quieter view and retry.
- A reasonable default empirical value on iPad is **~1.0 px/mickey at mag=127, pace=slow** — if your profile's medians are far from that, re-check the target screen.
- You can skip this tool entirely. \`pikvm_mouse_move_to\` falls back to 1.0 px/mickey when no profile exists, and its output screenshot lets the caller close the loop visually.`,
          },
        },
      ];
    },
  },

  // ---------- move-to ----------
  {
    name: 'move-to',
    description: 'Guide for approximate move-to-pixel with pikvm_mouse_move_to',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_mouse_move_to — Approximate Move to a Screen Pixel (Relative Mode)

## Purpose
Move the pointer to an approximate target pixel on a PiKVM target in relative mouse mode (iPad, etc.). The tool slams the pointer to the top-left corner to establish a known origin, emits a calculated delta sequence using a ballistics profile (if any) or a default \`1.0\` px/mickey, then returns a post-move screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| slamFirst | boolean | true | Slam to top-left before moving (establishes origin) |
| slamOriginX | number | auto | HDMI X of post-slam origin. Auto-detected from iPad letterbox bounds via \`pikvm_detect_orientation\`; works for portrait or landscape. Override only if detection misfires. |
| slamOriginY | number | auto | HDMI Y of post-slam origin. Auto-detected. |
| fallbackPxPerMickey | number | 1.0 | px/mickey used when no profile |
| chunkMagnitude | number | 127 | Per-call delta size |
| chunkPaceMs | number | 20 | Pace between chunked calls (ms) |
| deadZoneMickeys | number | 0 | Extra mickeys to compensate for edge absorption |

## Expected Accuracy
Open-loop: within **~20-100 pixels** of target on this iPad. That's close enough for icon targeting if the icon is ~100px+ across. **For sub-50px precision, close the loop visually:**

1. Call \`pikvm_mouse_move_to\` to get near the target.
2. In the returned screenshot, locate the cursor (small arrow, usually on wallpaper).
3. Compute pixel error (actual - target).
4. Issue a correction with \`pikvm_mouse_move\` in relative mode: delta ≈ -(error_x, error_y) mickeys (1 mickey ≈ 1 pixel at mag=127 pace=20ms).
5. Screenshot again; repeat if needed.

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_move_to", "arguments": { "x": 960, "y": 540 } }

{ "name": "pikvm_mouse_move_to", "arguments": { "x": 1200, "y": 800, "slamOriginX": 500, "slamOriginY": 60 } }
\`\`\`

## Tips
- Slam origin auto-detection runs \`pikvm_detect_orientation\` on the current frame and reads the iPad letterbox bounds, so portrait, landscape, or non-default-position iPads work without manual tuning. If detection misfires (e.g. fully-black wallpaper), pass \`slamOriginX\`/\`slamOriginY\` explicitly.
- Prefer \`pikvm_mouse_click_at\` when you want "move + click in one step".`,
          },
        },
      ];
    },
  },

  // ---------- click-at ----------
  {
    name: 'click-at',
    description: 'Guide for click-at-coordinate with pikvm_mouse_click_at',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: `# pikvm_mouse_click_at — Click at an Approximate Screen Pixel (Relative Mode)

## Purpose
On a PiKVM target in relative mouse mode (iPad), move the pointer to an approximate target pixel and click. Internally: \`pikvm_mouse_move_to\` → brief settle → \`mouseClick\`. Returns a post-click screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| button | string | left | left / right / middle / up / down |
| slamFirst | boolean | true | Slam to top-left before moving |
| slamOriginX | number | auto | HDMI X of post-slam origin. Auto-detected via \`pikvm_detect_orientation\`. |
| slamOriginY | number | auto | HDMI Y of post-slam origin. Auto-detected. |

## When to Use
- Tapping an iPad app icon whose bounding box is ≥100×100 px — the ~50 px accuracy is inside the hit target.
- Any coarse click where an error of tens of pixels is acceptable.

## When NOT to Use
- Sub-50 px precision (e.g. tapping a single character in a text field). Use the closed-loop pattern from the \`move-to\` guide instead.

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700 } }

{ "name": "pikvm_mouse_click_at", "arguments": { "x": 400, "y": 400, "button": "right" } }
\`\`\`

## Tips
- Take a \`pikvm_screenshot\` first to confirm the target pixel is where the UI element actually is — icon positions change between app rearrangements and iOS versions.
- After the click, examine the returned screenshot: did the expected app open / dialog appear? If not, the click missed — retry with the closed-loop correction from \`move-to\`.`,
          },
        },
      ];
    },
  },
];
