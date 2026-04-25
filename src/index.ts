#!/usr/bin/env node
/**
 * PiKVM MCP Server
 *
 * Provides MCP tools for controlling remote machines via PiKVM.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { PiKVMClient } from './pikvm/client.js';
import { loadConfig } from './config.js';
import { allPrompts, getPromptByName } from './prompts/index.js';
import { skillTools, isSkillTool, handleSkillToolCall } from './prompts/skill-tools.js';
import { BusyLock } from './pikvm/lock.js';
import { autoCalibrateWithRetries } from './pikvm/auto-calibrate.js';
import {
  measureBallistics,
  loadProfile,
  Axis,
  Pace,
  BallisticsProfile,
} from './pikvm/ballistics.js';
import { moveToPixel } from './pikvm/move-to.js';
import {
  unlockIpad,
  launchIpadApp,
  ipadGoHome,
  ipadOpenAppSwitcher,
} from './pikvm/ipad-unlock.js';
import { detectIpadBounds } from './pikvm/orientation.js';

// Defer initialization to main() for proper error handling
let pikvm: PiKVMClient;
let calibrationConfig: { rounds: number; verifyRounds: number; moveDelayMs: number };
let cachedProfile: BallisticsProfile | null = null;
let mouseAbsoluteMode: boolean = true; // refreshed at startup; true = absolute tools usable
const lock = new BusyLock();

async function refreshProfile(path?: string): Promise<void> {
  cachedProfile = await loadProfile(path ?? './data/ballistics.json').catch(() => null);
}

/** List of tool names that only work on a target with `mouse.absolute=true`.
 *  When the device reports relative mode, these are gated with a clear
 *  error pointing the caller to the relative-mode tools. */
const ABSOLUTE_MOUSE_TOOLS = new Set<string>([
  'pikvm_calibrate',
  'pikvm_set_calibration',
  'pikvm_get_calibration',
  'pikvm_clear_calibration',
  'pikvm_auto_calibrate',
]);
const ABSOLUTE_MOUSE_NOTE =
  'This target reports mouse.absolute=false (typical for iPad / boot-mouse HID). ' +
  'Use the relative-mode tools instead: pikvm_ipad_unlock, pikvm_mouse_move with relative:true, ' +
  'pikvm_mouse_click_at, pikvm_mouse_move_to, pikvm_mouse_click. See docs/skills/ipad-keyboard-workflow.md ' +
  'for the recommended pattern.';

/** For pikvm_mouse_move and pikvm_mouse_click, x/y arguments mean *absolute*
 *  positioning which doesn't work on a relative-only target. Detect that
 *  call shape and gate it. */
function callsAbsoluteMode(name: string, args: Record<string, unknown>): boolean {
  if (name === 'pikvm_mouse_move') {
    // Absolute is the default unless relative:true is set.
    return args.relative !== true;
  }
  if (name === 'pikvm_mouse_click') {
    // Absolute only when both x and y are supplied.
    return typeof args.x === 'number' && typeof args.y === 'number';
  }
  return false;
}

// ============================================================================
// Input Validation Helpers
// ============================================================================

/**
 * Validate that a value is a string, returning undefined if not
 */
function validateString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate that a value is a string and non-empty, throwing if required but missing
 */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Validate and clamp a number to bounds, returning undefined if not a number
 */
function validateNumber(value: unknown, min?: number, max?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/**
 * Validate that a value is a number, throwing if required but missing
 */
function requireNumber(value: unknown, fieldName: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} is required and must be a number`);
  }
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/**
 * Validate that a value is a boolean
 */
function validateBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Validate that a value is an array of strings with at least one element
 */
function requireStringArray(value: unknown, fieldName: string, minLength = 1): string[] {
  if (!Array.isArray(value) || value.length < minLength) {
    throw new Error(`${fieldName} must be an array with at least ${minLength} element(s)`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName} must contain only strings`);
    }
    result.push(item);
  }
  return result;
}

/**
 * Validate optional string array
 */
function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Validate enum value
 */
function validateEnum<T extends string>(value: unknown, allowed: readonly T[], defaultValue: T): T {
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  return defaultValue;
}

const VALID_BUTTONS = ['left', 'right', 'middle', 'up', 'down'] as const;
const VALID_KEY_STATES = ['press', 'release', 'click'] as const;

// Define available tools
const tools: Tool[] = [
  {
    name: 'pikvm_screenshot',
    description: 'Capture a screenshot from the PiKVM video stream. Returns the current screen as a JPEG image.',
    inputSchema: {
      type: 'object',
      properties: {
        maxWidth: {
          type: 'number',
          description: 'Maximum width of the screenshot in pixels (optional, for preview)',
        },
        maxHeight: {
          type: 'number',
          description: 'Maximum height of the screenshot in pixels (optional, for preview)',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (optional, default 80)',
        },
      },
    },
  },
  {
    name: 'pikvm_get_resolution',
    description: 'Get the current screen resolution of the remote machine. Useful for knowing valid coordinate ranges for mouse operations.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_type',
    description: 'Type text on the remote machine using PiKVM. Handles special characters correctly via keymap conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to type',
        },
        keymap: {
          type: 'string',
          description: 'Keyboard layout (default: en-us)',
        },
        slow: {
          type: 'boolean',
          description: 'Use slow typing mode for compatibility',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in ms (0-200)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'pikvm_key',
    description: 'Send a key or key combination to the remote machine. Use JavaScript key codes (e.g., KeyA, Enter, ControlLeft).',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key code (e.g., KeyA, Enter, Escape, F1)',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys to hold (e.g., ["ControlLeft", "AltLeft"])',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Key state: press (hold), release, or click (press+release, default)',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'pikvm_shortcut',
    description: 'Send a keyboard shortcut (multiple keys pressed simultaneously). Example: Ctrl+Alt+Delete',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of key codes to press together (e.g., ["ControlLeft", "AltLeft", "Delete"])',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'pikvm_mouse_move',
    description: 'Move the mouse cursor to a position on the remote machine. For absolute moves, coordinates are in screen pixels (0,0 = top-left). For relative moves, deltas are clamped to -127 to 127.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'X coordinate in pixels (absolute) or delta pixels (relative)',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in pixels (absolute) or delta pixels (relative)',
        },
        relative: {
          type: 'boolean',
          description: 'If true, move relative to current position (delta -127 to 127). Default: false (absolute pixel position)',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_mouse_click',
    description: 'Click a mouse button on the remote machine. Optionally move to a pixel position first.',
    inputSchema: {
      type: 'object',
      properties: {
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle', 'up', 'down'],
          description: 'Mouse button to click (default: left). "up" and "down" are scroll wheel buttons.',
        },
        x: {
          type: 'number',
          description: 'X pixel coordinate to move to before clicking (optional)',
        },
        y: {
          type: 'number',
          description: 'Y pixel coordinate to move to before clicking (optional)',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Button state: press (hold), release, or click (default)',
        },
      },
    },
  },
  {
    name: 'pikvm_mouse_scroll',
    description: 'Scroll the mouse wheel on the remote machine.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaX: {
          type: 'number',
          description: 'Horizontal scroll amount (negative = left, positive = right)',
        },
        deltaY: {
          type: 'number',
          description: 'Vertical scroll amount (negative = up, positive = down)',
        },
      },
      required: ['deltaY'],
    },
  },
  {
    name: 'pikvm_calibrate',
    description: 'Start mouse coordinate calibration. Moves cursor to screen center and returns expected position. Take a screenshot after calling this to visually verify actual cursor position, then call pikvm_set_calibration with calculated factors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_set_calibration',
    description: 'Set mouse coordinate calibration factors. Calculate factors as: factorX = expected_x / actual_x, factorY = expected_y / actual_y. For example, if calibration moved cursor to expected (960, 540) but it landed at (720, 405), factors would be 960/720=1.33 and 540/405=1.33.',
    inputSchema: {
      type: 'object',
      properties: {
        factorX: {
          type: 'number',
          description: 'X-axis calibration factor (typically 1.0-1.5)',
        },
        factorY: {
          type: 'number',
          description: 'Y-axis calibration factor (typically 1.0-1.5)',
        },
      },
      required: ['factorX', 'factorY'],
    },
  },
  {
    name: 'pikvm_get_calibration',
    description: 'Get current mouse calibration state. Returns null if not calibrated.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_clear_calibration',
    description: 'Clear mouse calibration, reverting to uncalibrated mode.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_ipad_unlock',
    description: 'Unlock an iPad from its lock screen by emitting a USB HID swipe-up gesture at the home indicator bar. Moves the cursor to the bottom-center of the iPad display, presses the left button, rapid-fires upward relative deltas covering 800 px (default), then releases. Verified on an iPad displayed portrait in a 1920x1080 HDMI frame — a 400 px drag does NOT unlock; 800 px does. Returns a post-unlock screenshot so the caller can confirm the iPad is now on the home screen. SIDE EFFECTS: on an already-unlocked home screen this is a no-op (the swipe is interpreted as "go home" which is idempotent). On an already-unlocked iPad that is INSIDE AN APP, the same swipe will close the app and return to home — check with pikvm_screenshot before calling if app state matters.',
    inputSchema: {
      type: 'object',
      properties: {
        slamFirst: { type: 'boolean', description: 'Slam to top-left corner first to establish a known cursor position. Default true.' },
        startX: { type: 'number', description: 'HDMI X of the unlock-swipe start. Default 955 (iPad portrait center).' },
        startY: { type: 'number', description: 'HDMI Y of the unlock-swipe start. Default 1035 (just above the home indicator bar).' },
        dragPx: { type: 'number', description: 'Total pixel distance dragged upward. Default 800. If the swipe does not unlock, try 1000 or 1200.' },
        chunkMickeys: { type: 'number', description: 'Per-call mickey size for the drag. Smaller = faster apparent motion. Default 30.' },
      },
    },
  },
  {
    name: 'pikvm_detect_orientation',
    description: 'Detect the iPad content bounds and orientation within the HDMI capture frame. Useful for landscape-aware automation — returns the iPad bounding rect (x/y/width/height), centre point, orientation (portrait or landscape), and full HDMI resolution. Both pikvm_ipad_unlock and pikvm_mouse_move_to call this automatically when their offset arguments are not specified, so most callers do not need to invoke it directly. Use this tool when you want to inspect the iPad layout, or precompute slam/swipe origins for repeated calls.',
    inputSchema: {
      type: 'object',
      properties: {
        brightnessSum: { type: 'number', description: 'Per-channel sum (R+G+B) above which a pixel counts as iPad content rather than letterbox black. Default 60.' },
      },
    },
  },
  {
    name: 'pikvm_ipad_home',
    description: 'Return the iPad to the home screen from any foreground app, by emitting the same swipe-up-from-home-indicator gesture used by pikvm_ipad_unlock. Idempotent on the home screen; dismisses any foreground app; unlocks if currently on the lock screen. Returns a post-gesture screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        settleMs: { type: 'number', description: 'Settle delay after the gesture (ms). Default 800.' },
      },
    },
  },
  {
    name: 'pikvm_ipad_app_switcher',
    description: 'Open the iPad App Switcher (Cmd+Tab) and capture a screenshot of available apps. Cmd is held while screenshotting (so the switcher stays visible) then released, which selects the currently-focused app in the switcher. For multi-step switching, drive Cmd manually via pikvm_key.',
    inputSchema: {
      type: 'object',
      properties: {
        holdMs: { type: 'number', description: 'How long to hold Cmd before screenshotting (ms). Default 800.' },
      },
    },
  },
  {
    name: 'pikvm_ipad_launch_app',
    description: 'Launch an iPad app via the verified keyboard-first pipeline: unlock (if locked) → Spotlight (Cmd+Space) → type the app name → Enter. Returns a post-launch screenshot. Far more reliable than clicking an app icon — bypasses cursor positioning entirely. Verified on iPadOS 26.1 for Files, Settings, App Store. If the named app does not appear in Spotlight (typo, app not installed, locale-specific name), iPad returns to the home screen and the screenshot will reflect that.',
    inputSchema: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'App name as it appears in Spotlight (case-insensitive). Examples: "Files", "Settings", "App Store", "Safari".' },
        unlockFirst: { type: 'boolean', description: 'Run pikvm_ipad_unlock first. Default true. Set false if you know the iPad is already unlocked and want to skip the swipe.' },
        spotlightSettleMs: { type: 'number', description: 'Settle after opening Spotlight (ms). Default 700.' },
        postTypeSettleMs: { type: 'number', description: 'Settle after typing the app name (ms). Default 600.' },
        launchSettleMs: { type: 'number', description: 'Settle after pressing Enter, before returning screenshot (ms). Default 1500.' },
      },
      required: ['appName'],
    },
  },
  {
    name: 'pikvm_mouse_move_to',
    description: 'Move the mouse pointer to an approximate target pixel on a PiKVM target in RELATIVE mouse mode (e.g. iPad). Default strategy ("detect-then-move") probes+diffs to locate the cursor without moving it much, then emits a chunked delta sequence to the target. Runs up to 2 correction passes (probe-driven) and a ground-truth detection pass so the returned message reports the actual cursor landing position. Returns a post-move screenshot. Use pikvm_mouse_click_at for "move then click".',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate in HDMI-screenshot pixels' },
        y: { type: 'number', description: 'Target Y coordinate in HDMI-screenshot pixels' },
        strategy: {
          type: 'string',
          enum: ['detect-then-move', 'slam-then-move', 'assume-at'],
          description: 'Origin discovery. "detect-then-move" (default) probes+diffs to find the cursor (safe — no slam). "slam-then-move" pins cursor to top-left (risky on iPad: hot-corner re-lock). "assume-at" requires assumeCursorAtX/Y.',
        },
        assumeCursorAtX: { type: 'number', description: 'With strategy="assume-at", HDMI X where cursor currently is.' },
        assumeCursorAtY: { type: 'number', description: 'With strategy="assume-at", HDMI Y where cursor currently is.' },
        slamOriginX: { type: 'number', description: 'HDMI X of post-slam origin. Default 625.' },
        slamOriginY: { type: 'number', description: 'HDMI Y of post-slam origin. Default 65.' },
        fallbackPxPerMickey: { type: 'number', description: 'px/mickey used when no profile. Default 1.3 (empirical iPad with mag=60 chunks).' },
        chunkMagnitude: { type: 'number', description: 'Per-call delta magnitude for chunking. Default 60.' },
        chunkPaceMs: { type: 'number', description: 'Milliseconds between chunked calls. Default 20.' },
        correct: { type: 'boolean', description: 'Enable motion-diff detection + correction. Default true.' },
        maxCorrectionPasses: { type: 'number', description: 'Max correction passes. Default 2.' },
        minResidualPx: { type: 'number', description: 'Early-exit threshold (px) for correction loop. Default 25.' },
        warmupMickeys: { type: 'number', description: 'Tiny move emitted before screenshot A so cursor renders. Default 8 mickeys.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_mouse_click_at',
    description: 'Move the mouse to an approximate target pixel (via pikvm_mouse_move_to) and then click. Returns a post-click screenshot. Inherits pikvm_mouse_move_to\'s detection/correction pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate in HDMI-screenshot pixels' },
        y: { type: 'number', description: 'Target Y coordinate in HDMI-screenshot pixels' },
        button: { type: 'string', enum: ['left', 'right', 'middle', 'up', 'down'], description: 'Mouse button. Default left.' },
        strategy: {
          type: 'string',
          enum: ['detect-then-move', 'slam-then-move', 'assume-at'],
          description: 'Origin discovery. Default "detect-then-move".',
        },
        assumeCursorAtX: { type: 'number', description: 'With strategy="assume-at", HDMI X where cursor currently is.' },
        assumeCursorAtY: { type: 'number', description: 'With strategy="assume-at", HDMI Y where cursor currently is.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_measure_ballistics',
    description: 'Characterise the relative-mouse acceleration curve of a PiKVM target in RELATIVE mouse mode (mouse.absolute=false, e.g. iPad). Slams the pointer to the top-left corner, then sweeps (axis × delta magnitude × pace) and measures the resulting pixel displacement per emitted mickey. Writes a ballistics profile JSON used by pikvm_mouse_move_to and pikvm_mouse_click_at. One-off per device; re-run if resolution or orientation changes. Takes a few minutes. Other tools are blocked during measurement.',
    inputSchema: {
      type: 'object',
      properties: {
        magnitudes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Per-call delta magnitudes to sample (mickeys). Default: [5,10,20,40,80,127].',
        },
        paces: {
          type: 'array',
          items: { type: 'string', enum: ['fast', 'slow'] },
          description: 'Paces to sample. "fast" = back-to-back calls (exercises acceleration), "slow" = 30ms between calls (steady-state). Default: both.',
        },
        axes: {
          type: 'array',
          items: { type: 'string', enum: ['x', 'y'] },
          description: 'Axes to measure. Default: ["x","y"]. Negative directions assumed symmetric.',
        },
        reps: {
          type: 'number',
          description: 'Repetitions per (axis, magnitude, pace) cell, median-aggregated. Default: 2.',
        },
        callsPerCell: {
          type: 'number',
          description: 'Number of delta calls emitted per measurement cell. Default: 5.',
        },
        slowPaceMs: {
          type: 'number',
          description: 'Milliseconds between calls in "slow" pace. Default: 30.',
        },
        settleMs: {
          type: 'number',
          description: 'Milliseconds to wait after moving, before capturing. Default: 400.',
        },
        profilePath: {
          type: 'string',
          description: 'Where to write the JSON profile. Default: ./data/ballistics.json.',
        },
        verbose: {
          type: 'boolean',
          description: 'Log per-cell diagnostics to stderr. Default: false.',
        },
      },
    },
  },
  {
    name: 'pikvm_auto_calibrate',
    description: 'Automatically calibrate mouse coordinates by detecting the cursor position via screenshot diffing. This is more accurate than manual calibration. Moves the mouse multiple times, compares screenshots to find the cursor, and computes calibration factors. Other tools are blocked during calibration.',
    inputSchema: {
      type: 'object',
      properties: {
        rounds: {
          type: 'number',
          description: 'Number of sampling rounds (default: 5)',
        },
        verifyRounds: {
          type: 'number',
          description: 'Number of verification rounds (default: 5)',
        },
        moveDelayMs: {
          type: 'number',
          description: 'Delay in ms after each mouse move for capture to settle (default: 300). Increase if calibration fails on slow connections.',
        },
        mergeRadius: {
          type: 'number',
          description: 'Radius in pixels for merging nearby clusters (e.g., cursor + drop shadow). Default: 30.',
        },
        minSamples: {
          type: 'number',
          description: 'Minimum valid samples required for calibration to succeed. Default: 3.',
        },
        maxRatioDivergence: {
          type: 'number',
          description: 'Maximum allowed divergence between X and Y ratios within a single round. Rejects noisy rounds where ratios are incoherent. Default: 0.5.',
        },
        verbose: {
          type: 'boolean',
          description: 'Log per-round debug data (centroid positions, accept/reject reasons). Default: false.',
        },
      },
    },
  },
  ...skillTools,
];

// Create MCP server
const server = new Server(
  {
    name: 'pikvm-mcp-server',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Handle list prompts request
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: allPrompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    })),
  };
});

// Handle get prompt request
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = getPromptByName(name, args);
  if (!result) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  return {
    description: result.definition.description,
    messages: result.messages,
  };
});

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Block other tools while a long-running op (auto-calibration or
  // ballistics measurement) is in progress. The excluded tools are allowed
  // through so their own handlers can return a more specific error.
  if (lock.isBusy && name !== 'pikvm_auto_calibrate' && name !== 'pikvm_measure_ballistics') {
    return {
      content: [{ type: 'text', text: `Error: ${lock.holder} in progress, please wait.` }],
      isError: true,
    };
  }

  // Gate absolute-mouse-only tools when the target reports mouse.absolute=false.
  // The relative-mode tools (pikvm_mouse_move with relative:true,
  // pikvm_mouse_click_at, etc.) remain available.
  if (!mouseAbsoluteMode) {
    if (ABSOLUTE_MOUSE_TOOLS.has(name) || callsAbsoluteMode(name, args as Record<string, unknown>)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: tool '${name}' requires absolute-mode mouse. ${ABSOLUTE_MOUSE_NOTE}`,
          },
        ],
        isError: true,
      };
    }
  }

  try {
    if (isSkillTool(name)) {
      return handleSkillToolCall(name, args);
    }

    switch (name) {
      case 'pikvm_screenshot': {
        const result = await pikvm.screenshot({
          maxWidth: validateNumber(args.maxWidth, 1, 10000),
          maxHeight: validateNumber(args.maxHeight, 1, 10000),
          quality: validateNumber(args.quality, 1, 100),
        });

        // Build informative message about the screenshot
        let infoText = `Screenshot captured (${result.screenshotWidth}x${result.screenshotHeight}`;
        if (result.scaleX !== 1 || result.scaleY !== 1) {
          infoText += `, scaled from ${result.actualWidth}x${result.actualHeight}`;
          infoText += `, scale factor: ${result.scaleX.toFixed(2)}x${result.scaleY.toFixed(2)}`;
        }
        infoText += '). Mouse coordinates from this image will be auto-scaled.';

        return {
          content: [
            {
              type: 'text',
              text: infoText,
            },
            {
              type: 'image',
              data: result.buffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          ],
        };
      }

      case 'pikvm_get_resolution': {
        const resolution = await pikvm.getResolution(true); // force refresh
        return {
          content: [
            {
              type: 'text',
              text: `Screen resolution: ${resolution.width}x${resolution.height} pixels. Valid mouse coordinates: x=0-${resolution.width - 1}, y=0-${resolution.height - 1}`,
            },
          ],
        };
      }

      case 'pikvm_type': {
        const text = requireString(args.text, 'text');
        await pikvm.type(text, {
          keymap: validateString(args.keymap),
          slow: validateBoolean(args.slow),
          delay: validateNumber(args.delay, 0, 200),
        });
        // Don't echo full text in response to avoid leaking sensitive input
        const displayText = text.length > 50 ? `${text.substring(0, 50)}...` : text;
        return {
          content: [{ type: 'text', text: `Typed ${text.length} character(s): "${displayText}"` }],
        };
      }

      case 'pikvm_key': {
        const key = requireString(args.key, 'key');
        const modifiers = validateStringArray(args.modifiers);
        const state = validateEnum(args.state, VALID_KEY_STATES, 'click');

        // Press modifiers
        for (const mod of modifiers) {
          await pikvm.sendKey(mod, { state: true });
        }

        // Send main key
        if (state === 'press') {
          await pikvm.sendKey(key, { state: true });
        } else if (state === 'release') {
          await pikvm.sendKey(key, { state: false });
        } else {
          await pikvm.sendKey(key); // click
        }

        // Release modifiers (in reverse order)
        for (const mod of [...modifiers].reverse()) {
          await pikvm.sendKey(mod, { state: false });
        }

        return {
          content: [
            {
              type: 'text',
              text: modifiers.length > 0
                ? `Sent key: ${modifiers.join('+')}+${key}`
                : `Sent key: ${key}`,
            },
          ],
        };
      }

      case 'pikvm_shortcut': {
        const keys = requireStringArray(args.keys, 'keys', 1);
        if (keys.length > 10) {
          throw new Error('keys array must have at most 10 elements');
        }
        await pikvm.sendShortcut(keys);
        return {
          content: [{ type: 'text', text: `Sent shortcut: ${keys.join('+')}` }],
        };
      }

      case 'pikvm_mouse_move': {
        const x = requireNumber(args.x, 'x');
        const y = requireNumber(args.y, 'y');
        const relative = validateBoolean(args.relative) ?? false;
        let calibrationWarning = '';
        if (relative) {
          // Relative moves are clamped to -127 to 127 in the client
          await pikvm.mouseMoveRelative(x, y);
        } else {
          // Absolute moves should be positive pixel coordinates
          const clampedX = Math.max(0, Math.round(x));
          const clampedY = Math.max(0, Math.round(y));
          const result = await pikvm.mouseMove(clampedX, clampedY);
          if (result.calibrationInvalidated) {
            calibrationWarning = '\n⚠️ Resolution changed - calibration has been cleared. Recalibrate with pikvm_auto_calibrate (preferred) or pikvm_calibrate.';
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: (relative
                ? `Moved mouse by (${x}, ${y})`
                : `Moved mouse to pixel (${Math.max(0, Math.round(x))}, ${Math.max(0, Math.round(y))})`) + calibrationWarning,
            },
          ],
        };
      }

      case 'pikvm_mouse_click': {
        const button = validateEnum(args.button, VALID_BUTTONS, 'left');
        const clickX = validateNumber(args.x, 0);
        const clickY = validateNumber(args.y, 0);

        // Move to position first if specified
        if (clickX !== undefined && clickY !== undefined) {
          await pikvm.mouseMove(Math.round(clickX), Math.round(clickY));
        }

        const state = validateEnum(args.state, VALID_KEY_STATES, 'click');
        if (state === 'press') {
          await pikvm.mouseClick(button, { state: true });
        } else if (state === 'release') {
          await pikvm.mouseClick(button, { state: false });
        } else {
          await pikvm.mouseClick(button);
        }

        return {
          content: [{ type: 'text', text: `${button} click` }],
        };
      }

      case 'pikvm_mouse_scroll': {
        const deltaY = requireNumber(args.deltaY, 'deltaY');
        const deltaX = validateNumber(args.deltaX) ?? 0;
        await pikvm.mouseScroll(deltaX, deltaY);
        return {
          content: [
            {
              type: 'text',
              text: `Scrolled (${deltaX}, ${deltaY})`,
            },
          ],
        };
      }

      case 'pikvm_calibrate': {
        const result = await pikvm.calibrate();
        return {
          content: [
            {
              type: 'text',
              text: `Calibration started.\n` +
                `Resolution: ${result.resolution.width}x${result.resolution.height}\n` +
                `Expected cursor position: (${result.expectedPosition.x}, ${result.expectedPosition.y})\n` +
                `Normalized coordinates sent: (${result.requestedNormalized.x}, ${result.requestedNormalized.y})\n\n` +
                `${result.message}`,
            },
          ],
        };
      }

      case 'pikvm_set_calibration': {
        const factorX = requireNumber(args.factorX, 'factorX');
        const factorY = requireNumber(args.factorY, 'factorY');
        pikvm.setCalibrationFactors(factorX, factorY);
        const calibration = pikvm.getCalibration();
        return {
          content: [
            {
              type: 'text',
              text: `Calibration set: factorX=${factorX.toFixed(4)}, factorY=${factorY.toFixed(4)}\n` +
                `Resolution at calibration: ${calibration?.resolution.width}x${calibration?.resolution.height}\n` +
                `Note: Calibration will be automatically cleared if resolution changes.`,
            },
          ],
        };
      }

      case 'pikvm_get_calibration': {
        const calibration = pikvm.getCalibration();
        if (calibration) {
          return {
            content: [
              {
                type: 'text',
                text: `Current calibration:\n` +
                  `  factorX: ${calibration.factorX.toFixed(4)}\n` +
                  `  factorY: ${calibration.factorY.toFixed(4)}\n` +
                  `  Resolution at calibration: ${calibration.resolution.width}x${calibration.resolution.height}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: 'Not calibrated. Mouse coordinates use default 1.0 factor (no correction).',
              },
            ],
          };
        }
      }

      case 'pikvm_clear_calibration': {
        pikvm.clearCalibration();
        return {
          content: [
            {
              type: 'text',
              text: 'Calibration cleared. Mouse coordinates now use default 1.0 factor (no correction).',
            },
          ],
        };
      }

      case 'pikvm_ipad_unlock': {
        const result = await unlockIpad(pikvm, {
          slamFirst: validateBoolean(args.slamFirst) ?? true,
          startX: validateNumber(args.startX, 0, 4000),
          startY: validateNumber(args.startY, 0, 4000),
          dragPx: validateNumber(args.dragPx, 100, 3000),
          chunkMickeys: validateNumber(args.chunkMickeys, 1, 127),
        });
        return {
          content: [
            { type: 'text', text: result.message },
            { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_ipad_launch_app': {
        const appName = requireString(args.appName, 'appName');
        const result = await launchIpadApp(pikvm, appName, {
          unlockFirst: validateBoolean(args.unlockFirst) ?? true,
          spotlightSettleMs: validateNumber(args.spotlightSettleMs, 0, 5000),
          postTypeSettleMs: validateNumber(args.postTypeSettleMs, 0, 5000),
          launchSettleMs: validateNumber(args.launchSettleMs, 0, 10000),
        });
        return {
          content: [
            { type: 'text', text: result.message },
            { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_detect_orientation': {
        const bounds = await detectIpadBounds(pikvm, {
          brightnessSum: validateNumber(args.brightnessSum, 0, 765),
        });
        const message =
          `iPad ${bounds.orientation} content: ${bounds.width}×${bounds.height} ` +
          `at HDMI (${bounds.x},${bounds.y})→(${bounds.x + bounds.width - 1},${bounds.y + bounds.height - 1}); ` +
          `centre (${bounds.centerX},${bounds.centerY}); ` +
          `HDMI frame ${bounds.resolution.width}×${bounds.resolution.height}.`;
        return {
          content: [
            { type: 'text', text: message },
            { type: 'text', text: JSON.stringify(bounds) },
          ],
        };
      }

      case 'pikvm_ipad_home': {
        const result = await ipadGoHome(pikvm, {
          settleMs: validateNumber(args.settleMs, 0, 5000),
        });
        return {
          content: [
            { type: 'text', text: result.message },
            { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_ipad_app_switcher': {
        const result = await ipadOpenAppSwitcher(pikvm, {
          holdMs: validateNumber(args.holdMs, 100, 5000),
        });
        return {
          content: [
            { type: 'text', text: result.message },
            { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_mouse_move_to': {
        const tx = requireNumber(args.x, 'x');
        const ty = requireNumber(args.y, 'y');
        const strategyStr = validateEnum(
          args.strategy,
          ['detect-then-move', 'slam-then-move', 'assume-at'] as const,
          'detect-then-move',
        );
        const assumeX = validateNumber(args.assumeCursorAtX);
        const assumeY = validateNumber(args.assumeCursorAtY);
        const assumeCursorAt =
          assumeX !== undefined && assumeY !== undefined
            ? { x: assumeX, y: assumeY }
            : undefined;
        const result = await moveToPixel(
          pikvm,
          { x: tx, y: ty },
          {
            strategy: strategyStr,
            assumeCursorAt,
            slamOriginPx: {
              x: validateNumber(args.slamOriginX) ?? 625,
              y: validateNumber(args.slamOriginY) ?? 65,
            },
            fallbackPxPerMickey: validateNumber(args.fallbackPxPerMickey, 0.01, 10),
            chunkMagnitude: validateNumber(args.chunkMagnitude, 1, 127),
            chunkPaceMs: validateNumber(args.chunkPaceMs, 0, 500),
            correct: validateBoolean(args.correct),
            maxCorrectionPasses: validateNumber(args.maxCorrectionPasses, 0, 5),
            minResidualPx: validateNumber(args.minResidualPx, 1, 200),
            warmupMickeys: validateNumber(args.warmupMickeys, 0, 50),
            profile: cachedProfile,
          },
        );
        return {
          content: [
            { type: 'text', text: result.message },
            { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_mouse_click_at': {
        const tx = requireNumber(args.x, 'x');
        const ty = requireNumber(args.y, 'y');
        const button = validateEnum(args.button, VALID_BUTTONS, 'left');
        const strategyStr = validateEnum(
          args.strategy,
          ['detect-then-move', 'slam-then-move', 'assume-at'] as const,
          'detect-then-move',
        );
        const assumeX = validateNumber(args.assumeCursorAtX);
        const assumeY = validateNumber(args.assumeCursorAtY);
        const assumeCursorAt =
          assumeX !== undefined && assumeY !== undefined
            ? { x: assumeX, y: assumeY }
            : undefined;
        const result = await moveToPixel(
          pikvm,
          { x: tx, y: ty },
          {
            strategy: strategyStr,
            assumeCursorAt,
            profile: cachedProfile,
          },
        );
        // Brief pause so iPadOS registers the cursor as stationary before click
        await new Promise((r) => setTimeout(r, 80));
        await pikvm.mouseClick(button);
        // Post-click screenshot
        const shot = await pikvm.screenshot();
        return {
          content: [
            {
              type: 'text',
              text:
                result.message +
                `\nClicked ${button} at approximate position. Post-click screenshot attached.`,
            },
            { type: 'image', data: shot.buffer.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      }

      case 'pikvm_measure_ballistics': {
        if (lock.isBusy) {
          return {
            content: [{ type: 'text', text: 'Ballistics measurement is already in progress.' }],
            isError: true,
          };
        }

        lock.acquire('Ballistics measurement');
        try {
          const magnitudes = Array.isArray(args.magnitudes)
            ? args.magnitudes.filter((m): m is number => typeof m === 'number' && m > 0 && m <= 127)
            : undefined;
          const paces = Array.isArray(args.paces)
            ? args.paces.filter((p): p is Pace => p === 'fast' || p === 'slow')
            : undefined;
          const axes = Array.isArray(args.axes)
            ? args.axes.filter((a): a is Axis => a === 'x' || a === 'y')
            : undefined;

          const result = await measureBallistics(pikvm, {
            magnitudes: magnitudes && magnitudes.length > 0 ? magnitudes : undefined,
            paces: paces && paces.length > 0 ? paces : undefined,
            axes: axes && axes.length > 0 ? axes : undefined,
            reps: validateNumber(args.reps, 1, 10),
            callsPerCell: validateNumber(args.callsPerCell, 1, 50),
            slowPaceMs: validateNumber(args.slowPaceMs, 0, 1000),
            settleMs: validateNumber(args.settleMs, 50, 3000),
            profilePath: validateString(args.profilePath),
            verbose: validateBoolean(args.verbose),
          });

          let summary = result.message + '\n';
          if (result.profile) {
            const mKeys = Object.keys(result.profile.medians).sort();
            summary += '\nMedian px/mickey by cell:\n';
            for (const k of mKeys) {
              summary += `  ${k} → ${result.profile.medians[k].toFixed(4)}\n`;
            }
            // Refresh the in-memory profile so subsequent move-to calls use it
            cachedProfile = result.profile;
          }

          return {
            content: [{ type: 'text', text: summary }],
            isError: !result.success,
          };
        } finally {
          lock.release();
        }
      }

      case 'pikvm_auto_calibrate': {
        if (lock.isBusy) {
          return {
            content: [{ type: 'text', text: 'Auto-calibration is already in progress.' }],
            isError: true,
          };
        }

        lock.acquire('Auto-calibration');
        try {
          const result = await autoCalibrateWithRetries(pikvm, {
            rounds: validateNumber(args.rounds, 2, 20) ?? calibrationConfig.rounds,
            verifyRounds: validateNumber(args.verifyRounds, 1, 20) ?? calibrationConfig.verifyRounds,
            moveDelayMs: validateNumber(args.moveDelayMs, 50, 2000) ?? calibrationConfig.moveDelayMs,
            mergeRadius: validateNumber(args.mergeRadius, 0, 200),
            minSamples: validateNumber(args.minSamples, 1, 20),
            maxRatioDivergence: validateNumber(args.maxRatioDivergence, 0, 1),
            verbose: validateBoolean(args.verbose),
          });

          return {
            content: [
              {
                type: 'text',
                text: `Auto-calibration ${result.success ? 'succeeded' : 'failed'}.\n` +
                  `Resolution: ${result.resolution.width}x${result.resolution.height}\n` +
                  `Factors: X=${result.factorX.toFixed(4)}, Y=${result.factorY.toFixed(4)}\n` +
                  `Confidence: ${(result.confidence * 100).toFixed(0)}%\n` +
                  `Verification score: ${result.verificationScore}\n` +
                  `Valid samples: ${result.validSamples}/${result.totalRounds}\n\n` +
                  result.message,
              },
            ],
          };
        } finally {
          lock.release();
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Sanitize error messages to avoid exposing sensitive information
    let message: string;
    if (error instanceof Error) {
      // Strip any potential credential information from error messages
      message = error.message
        .replace(/X-KVMD-Passwd[^,\s]*/gi, 'X-KVMD-Passwd=[REDACTED]')
        .replace(/password[=:][^\s,]*/gi, 'password=[REDACTED]');
    } else {
      message = 'An unexpected error occurred';
    }
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  // Load configuration (deferred to here for proper error handling)
  const config = loadConfig();
  pikvm = new PiKVMClient(config.pikvm);
  calibrationConfig = config.calibration;

  // Verify connection on startup
  const authOk = await pikvm.checkAuth();
  if (!authOk) {
    console.error('Warning: Could not authenticate with PiKVM. Check credentials.');
  }

  // Load ballistics profile if present (used by pikvm_mouse_move_to)
  await refreshProfile();
  if (cachedProfile) {
    console.error(`Loaded ballistics profile (${cachedProfile.samples.length} samples).`);
  }

  // Detect whether the target is in absolute or relative mouse mode so we
  // can gate absolute-only tools (calibration, etc.) when running on iPad.
  try {
    const hid = await pikvm.getHidProfile();
    mouseAbsoluteMode = hid.mouseAbsolute;
    console.error(
      `HID: mouse=${hid.mouseOnline ? 'online' : 'offline'}/${hid.mouseAbsolute ? 'absolute' : 'relative'}, ` +
        `keyboard=${hid.keyboardOnline ? 'online' : 'offline'}.`,
    );
    if (!hid.mouseAbsolute) {
      console.error(
        'Target is in RELATIVE mouse mode (mouse.absolute=false). ' +
          'Absolute-mode tools (pikvm_calibrate*, pikvm_auto_calibrate, pikvm_mouse_move default, ' +
          'pikvm_mouse_click with x/y) will be refused with a guidance message. ' +
          'Use pikvm_mouse_click_at, pikvm_mouse_move_to, and the keyboard-first workflow ' +
          '(see docs/skills/ipad-keyboard-workflow.md).',
      );
    }
  } catch (err) {
    console.error(
      `Warning: could not read HID profile (${(err as Error).message}). ` +
        'Defaulting to absolute mode; relative-mode-only tools may surface confusing errors on this device.',
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PiKVM MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
