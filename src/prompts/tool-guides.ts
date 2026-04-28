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
Move the pointer to an approximate target pixel on a PiKVM target in relative mouse mode (iPad, etc.). Default strategy \`"detect-then-move"\` probes the cursor with a small motion-diff to discover the origin (no slam required), then emits a chunked delta sequence to the target with up to 2 correction passes plus a ground-truth detection pass. Returns a post-move screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| strategy | string | detect-then-move | Origin discovery. **DO NOT use \`"slam-then-move"\` on iPad** — slam to top-left triggers the iPadOS hot-corner gesture and re-locks the screen (Phase 32a). |
| assumeCursorAtX/Y | number | — | With \`strategy="assume-at"\`, where the cursor currently is. |
| fallbackPxPerMickey | number | 1.3 | px/mickey when no ballistics profile is loaded. |
| chunkMagnitude | number | 60 | Per-call delta size in mickeys. |
| chunkPaceMs | number | 20 | Pace between chunked calls (ms). |
| correct | boolean | true | Enable motion-diff detection + correction loop. |
| maxCorrectionPasses | number | 2 | Max correction passes (independent attempts to re-aim). |
| minResidualPx | number | 25 | Early-exit threshold (px) for the correction loop. |
| warmupMickeys | number | 8 | Tiny move emitted before screenshot A so the cursor renders. |

## Expected Accuracy

After Phases 65-77 (v0.5.68+):

| Target width | Per-attempt residual ≤ 25 px | 3-attempt rate (with retry layer) |
|--------------|------------------------------|------------------------------------|
| ≥ 200 px     | ~80% (residual ≤ 100 px) | ~99% |
| 100-200 px   | ~70% (residual ≤ 100 px) | ~97% |
| 50-100 px    | ~60% (residual ≤ 50 px)  | **~50-60%** (Phase 111 N=15) |
| < 50 px      | ~50% (residual ≤ 25 px)  | ~88% |

Single-digit residuals are achievable when motion-diff succeeds (Phase 69 measured 6-9 px hits).

## When to Use vs Closed-Loop Correction
- For most click tasks: prefer \`pikvm_mouse_click_at\` (iPad default \`maxRetries: 3\` is auto-applied per Phase 142) — same algorithm, with retry-on-miss orchestration baked in.
- For agent-driven closed-loop where you want screenshot inspection between move and click: this tool returns the screenshot and reported residual, suitable for an agent to compute a correction delta and issue follow-up \`pikvm_mouse_move\` calls.

## Example Calls
\`\`\`json
{ "name": "pikvm_mouse_move_to", "arguments": { "x": 960, "y": 540 } }

{ "name": "pikvm_mouse_move_to", "arguments": { "x": 1200, "y": 800, "strategy": "assume-at", "assumeCursorAtX": 800, "assumeCursorAtY": 700 } }
\`\`\`

## Tips
- Prefer \`pikvm_mouse_click_at\` for "move + click in one step" — it adds verification and retries.
- On a locked iPad: call \`pikvm_ipad_unlock\` first. detect-then-move can move the cursor on a locked iPad but clicks won't trigger app behavior.
- iPadOS dims the cursor after ~1 s of inactivity; the algorithm's warmup nudge handles the common case.`,
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

## Reliability (Phase 70-72 measurements)

| Target width | Per-attempt hit | 3-attempt hit | Examples |
|--------------|-----------------|---------------|----------|
| ≥ 200 px | ~80% | ~99% | Sidebar rows, large buttons |
| 100-200 px | ~70% | ~97% | App icons, search fields |
| 50-100 px | ~60% | **~50-60%** | Standard buttons, page tabs, ~70 px iPad icons (Phase 111 measured) |
| < 50 px | ~50% | ~88% | Back arrows, X buttons, toggles |

**Phase 94 / Phase 142 default**: \`maxRetries\` defaults to 3 on iPad (relative-mouse) targets (originally 2; Phase 142 bumped to 3 for the Phase 141 hidden-popup auto-dismiss recipe to have an extra round). Turns ~50% per-attempt into ~88% reliable end-to-end on tiny targets. Pass \`maxRetries: 0\` explicitly to opt out (single-shot for one-off toggles).

**Silent failure remedy**: when click_at returns success but the post-click screenshot shows no UI change, the dominant cause is an iOS HDMI-blocked security popup (Apple Pay / Face ID / Low Battery / app permission) eating input. Call \`pikvm_dismiss_popup\` to fire the documented Escape → Enter recipe, then retry. Live-verified twice on Low Battery modals (10% and 5% — both dismissed cleanly with one Escape).

## Critical pre-flight

**The iPad MUST be unlocked.** Detect-then-move can't find the cursor against the lock-screen wallpaper. If you don't know the iPad's state, either:
1. Take a \`pikvm_screenshot\` first to confirm it's not on lock screen.
2. Pass \`autoUnlockOnDetectFail: true\` (Phase 72) for opt-in self-recovery — note this calls \`ipadGoHome\` which exits any open app.
3. Just call \`pikvm_ipad_unlock\` first if you know it might be locked.

## Parameters (key ones)
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| button | string | left | left / right / middle / up / down |
| maxRetries | number | 2 (iPad) / 0 (desktop) | Phase 94: auto-defaults to 2 on iPad (relative-mouse) / 0 on desktop. Pass 0 explicitly to opt out of retries on iPad. |
| autoUnlockOnDetectFail | boolean | false | Phase 72 opt-in lock-screen recovery |
| maxResidualPx | number | *(unset)* | Phase 88: skip the click if cursor lands more than N px from target. Set to 25 for strict icon-tolerance (refuses imprecise clicks that risk hitting adjacent UI elements); leave unset for permissive behaviour. |
| verifyClick | boolean | true | Pre/post screenshot diff confirms click landed |

## Recommended call shapes

**Reliable iPad click on a known-unlocked iPad:**
\`\`\`json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxRetries": 2 } }
\`\`\`

**Self-recovering click (assumes iPad might be locked / faded):**
\`\`\`json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxRetries": 2, "autoUnlockOnDetectFail": true } }
\`\`\`

**Strict-target click (refuse to click on the wrong adjacent element):**
\`\`\`json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxRetries": 2, "maxResidualPx": 25 } }
\`\`\`
With \`maxResidualPx: 25\`, attempts that land more than 25 px from the target are skipped (counts as a retry). Trades absolute hit rate for "I clicked the right thing" confidence — useful when the target is near other clickable elements that could be accidentally hit.

## When NOT to Use
- Tiny targets (< 30 px): even with retries, hit rate drops below 80%. Use keyboard navigation if available — see \`ipad-keyboard-workflow\`.
- Anywhere a keyboard shortcut exists: keyboard input has 100% reliability vs cursor's ~80-99%.

## Tips
- Take a \`pikvm_screenshot\` first to confirm the target pixel is where the UI element actually is — icon positions change between app rearrangements and iOS versions.
- After the click, examine the returned screenshot: did the expected app open / dialog appear? If not, the click missed — retry or fall back to keyboard.`,
          },
        },
      ];
    },
  },
];
