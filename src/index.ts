#!/usr/bin/env node
/**
 * PiKVM MCP Server
 *
 * Provides MCP tools for controlling remote machines via PiKVM.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { PiKVMClient, createDefaultBelief } from './pikvm/client.js';
import { loadConfig, resolveHttpAuth } from './config.js';
import { parseCliOptions, helpText } from './cli.js';
import { startHttpServer } from './http-server.js';
import { makeStaticAuthorizer, type HttpAuth, type HeaderAuthorizer } from './auth.js';
import { makeKvmdAuthorizer } from './kvmd-auth.js';
import { type LoginGate } from './session-auth.js';
import { recoverHid, makeBehavioralVerifier, makeHttpRecoveryTrigger, type RecoveryTrigger } from './pikvm/hid-recovery.js';
import { appendOperatorHint } from './operator-hints.js';
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
  verifyClickByDiff,
  clickAtWithRetry,
  defaultMaxRetriesFor,
  defaultMaxResidualPxFor,
  defaultChunkPaceMsFor,
  runDismissRecipe,
  formatDismissResult,
} from './pikvm/click-verify.js';
import { seedCursorTemplate } from './pikvm/seed-template.js';
import { VERSION } from './version.js';
import {
  unlockIpad,
  unlockIpadWithCode,
  launchIpadApp,
  ipadGoHome,
  ipadOpenAppSwitcher,
} from './pikvm/ipad-unlock.js';
import { detectIpadBounds, detectIpadBoundsFromBuffer } from './pikvm/orientation.js';
import { analyzeBrightness, VERY_DIM_THRESHOLD } from './pikvm/brightness.js';
import { runHealthCheck } from './pikvm/health-check.js';

// Defer initialization to main() for proper error handling
let pikvm: PiKVMClient;
let calibrationConfig: { rounds: number; verifyRounds: number; moveDelayMs: number };
let cachedProfile: BallisticsProfile | null = null;
// Default to FALSE (relative mode = treat as iPad until proven otherwise) so
// that forbidSlamFallback is automatically TRUE on startup-detection failure.
// Phase 33: live-verified 2026-04-26 that defaulting to true caused
// pikvm_mouse_click_at to slam on iPad and re-lock the screen when
// getHidProfile() failed at startup (network blip, slow PiKVM, etc.).
// Default-unsafe is unacceptable when the failure mode is "destroys the
// test environment". Refresh on first successful startup detection; if
// detection fails, the safe-for-iPad default stands.
let mouseAbsoluteMode: boolean = false;
const lock = new BusyLock();

// Host recovery trigger for the HID-recovery ladder's rungs 2-3 (UDC rebind /
// reboot). These are privileged HOST operations this unprivileged service can't
// do itself, so it POSTs to a pikvm-nixos-provided helper. Configured via
// PIKVM_HID_RECOVERY_URL (+ optional bearer token); unset ⇒ rungs 2-3 report
// unavailable. See docs/runbooks/hid-recovery.md ("Trigger interface").
let recoveryTrigger: RecoveryTrigger | undefined;
function getRecoveryTrigger(): RecoveryTrigger {
  if (!recoveryTrigger) {
    recoveryTrigger = makeHttpRecoveryTrigger({
      url: process.env.PIKVM_HID_RECOVERY_URL,
      token: process.env.PIKVM_HID_RECOVERY_TOKEN,
      verifySsl: process.env.PIKVM_HID_RECOVERY_VERIFY_SSL === 'true',
    });
  }
  return recoveryTrigger;
}

async function refreshProfile(path?: string): Promise<void> {
  cachedProfile = await loadProfile(path ?? './data/ballistics.json').catch(() => null);
}

const ABSOLUTE_MOUSE_NOTE =
  'This target reports mouse.absolute=false (typical for iPad / boot-mouse HID). ' +
  'Use the relative-mode tools instead: pikvm_ipad_unlock, pikvm_mouse_move with relative:true, ' +
  'pikvm_mouse_click_at, pikvm_mouse_move_to, pikvm_mouse_click. See docs/skills/ipad-keyboard-workflow.md ' +
  'for the recommended pattern.';

/**
 * The single source of truth for "which calls need mouse.absolute=true".
 * Each entry is a predicate over the call's args (a bare `() => true` for tools
 * that are always absolute-only). Previously this knowledge was split across a
 * name Set and a separate `callsAbsoluteMode` special-case function. When the
 * device reports relative mode, a matching call is gated with ABSOLUTE_MOUSE_NOTE.
 */
const ABSOLUTE_MOUSE_GATE: Record<string, (args: Record<string, unknown>) => boolean> = {
  // Calibration tools drive absolute positioning end-to-end.
  pikvm_calibrate: () => true,
  pikvm_set_calibration: () => true,
  pikvm_get_calibration: () => true,
  pikvm_clear_calibration: () => true,
  pikvm_auto_calibrate: () => true,
  // For move/click the SHAPE of the call decides: x/y mean absolute pixels.
  pikvm_mouse_move: (args) => args.relative !== true, // absolute unless relative:true
  pikvm_mouse_click: (args) => typeof args.x === 'number' && typeof args.y === 'number',
};

/** True when this call requires an absolute-mode mouse on the target. */
function requiresAbsoluteMouse(name: string, args: Record<string, unknown>): boolean {
  const gate = ABSOLUTE_MOUSE_GATE[name];
  return gate ? gate(args) : false;
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
    name: 'pikvm_version',
    description: `Return the running pikvm-mcp-server version. Useful for detecting whether a deployed server is current with main — if the version doesn't match the latest commit's version, the server needs a redeploy. Currently embedded version: ${VERSION}.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_health_check',
    description: 'One-call diagnostic: server version, HID mouse/keyboard online + absolute/relative mode, streamer HDMI-source online, and detected iPad bounds/orientation. Run first after deploy or when click_at misbehaves.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_screenshot',
    description: 'Capture a JPEG from the PiKVM video stream. On iPad pass keepCursorAlive:true to emit a net-zero ±1px nudge just before the snapshot so the auto-fading cursor stays visible for verification.',
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
        keepCursorAlive: {
          type: 'boolean',
          description: 'Phase 202 v0.5.197: emit a ±1 px mouse nudge immediately before the snapshot so the iPad cursor stays visible (iPadOS auto-fades stationary cursors after a few seconds). Net displacement is zero. Default false. Set true when you need a screenshot for cursor verification or to visually confirm where the cursor landed after a click_at.',
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
    name: 'pikvm_screen_state',
    description: 'Fast "is the screen on?" check via the streamer API; returns { on, resolution }. on:false means no HDMI signal (iPad locked/asleep/off) and pikvm_screenshot 503s. Cheaper than pikvm_health_check — one API call.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_hid_reset',
    description: 'Recovery when HID mouse/keyboard shows online:false: soft-reinits the emulated HID and returns online state after settleMs. A soft reset cannot force host re-enumeration — the target may need a physical cable replug.',
    inputSchema: {
      type: 'object',
      properties: {
        reconnectUsb: {
          type: 'boolean',
          description: 'Also cycle the OTG USB connection (set_connected 0→1) after the soft reset. No-op on PiKVM builds where the `connected` control is not wired. Default false.',
        },
        settleMs: {
          type: 'number',
          description: 'Milliseconds to wait after the reset before re-reading HID online state. Default 2000.',
        },
      },
    },
  },
  {
    name: 'pikvm_hid_recover',
    description:
      'Escalating recovery for a broken HID (mouse/keyboard not driving the target while video is fine). ' +
      'R0 first checks the target is present (a screenshot returns an image) — NOTHING recovers an asleep/' +
      'absent target, so wake it first. Then it climbs the ladder, verifying BEHAVIORALLY after each rung ' +
      '(emits a mouse move + checks the screen changed — the online flags have lied). HONESTLY: R1 (soft ' +
      'reset, = pikvm_hid_reset) is a cheap first try that often does NOT fix a controller-level drop. R2 ' +
      '(soft_connect USB pull-up toggle) and R3a (UDC rebind) are host-provided and UNTESTED as recoveries. ' +
      'R3b (reboot the PiKVM, host-provided) is the most reliable remote option (worked once) but is ' +
      'DESTRUCTIVE (~30-90s), so it needs allowReboot:true. If every remote rung fails, the tool escalates ' +
      'to R4: a HUMAN must physically re-plug the target USB or power it on — remote recovery cannot always ' +
      'fix this. Host rungs (R2/R3a/R3b) need the pikvm-nixos recovery trigger configured; otherwise they ' +
      'report unavailable and R1 still runs.',
    inputSchema: {
      type: 'object',
      properties: {
        maxRung: {
          type: 'number',
          description: 'Highest rung to attempt: 1 = soft reset only, 2 = + soft_connect toggle, 3 = + UDC rebind, 4 = + reboot. Default 3 (all non-destructive remote rungs).',
        },
        allowReboot: {
          type: 'boolean',
          description: 'Permit rung 4 (reboot the PiKVM device) — destructive: the whole appliance (including this server) goes down ~30-90s. Only used when maxRung is 4. Default false.',
        },
      },
    },
  },
  {
    name: 'pikvm_ipad_unlock_with_code',
    description: 'Keyboard-only unlock for a passcode-protected iPad: wakes the screen, types the digits, presses Enter. Code is sent to HID but never logged, stored, or echoed. Use instead of pikvm_ipad_unlock when a passcode is set.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'iPad passcode (digits only). Stored only in the in-memory request payload for the duration of this call; not persisted or logged.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'pikvm_ipad_lock',
    description: 'Lock the iPad via Ctrl+Cmd+Q. DESTRUCTIVE: turns the screen off, so HDMI goes offline and pikvm_screenshot 503s until wake. Verify with pikvm_screen_state (on:false). Unlock a passcode-free iPad with sendKey Enter.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_dismiss_popup',
    description: 'Runs the hidden-popup dismiss recipe (Escape then Enter) when a click lands right but nothing happens (an iOS security popup ate it). Best-effort. force:true also sends Cmd+H — DESTRUCTIVE: exits the foreground app.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'If true, append Cmd+H (system Home shortcut) AFTER the Escape+Enter recipe. Destructive: exits the current foreground app. Use only when (a) the iPad is on or near the home screen, AND (b) the plain Escape+Enter recipe did not produce a visible state change.',
        },
      },
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
    description: 'Unlock an iPad from the lock screen: tries Escape/Enter/Space keys first (Enter unlocks iPadOS), then falls back to a USB-HID swipe-up. Idempotent on an already-unlocked iPad. Returns a post-unlock screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tryKeyPressFirst: { type: 'boolean', description: 'Phase 217 v0.5.205: try Esc + Enter + Space keys FIRST. Default true. Set false to force the legacy swipe-only path.' },
        swipeOnKeyPressFailure: { type: 'boolean', description: 'Phase 219 v0.5.206: emit the swipe fallback when keys don\'t unlock. Default true. Set false to suppress the swipe entirely (useful when iPad may already be unlocked — the swipe-from-home-screen sometimes re-locks the iPad).' },
        slamFirst: { type: 'boolean', description: 'Slam to top-left corner first to establish a known cursor position before the swipe. Default true. Only used by the swipe path.' },
        startX: { type: 'number', description: 'HDMI X of the unlock-swipe start. Default 955 (iPad portrait center). Only used by the swipe path.' },
        startY: { type: 'number', description: 'HDMI Y of the unlock-swipe start. Default 1035 (just above the home indicator bar). Only used by the swipe path.' },
        dragPx: { type: 'number', description: 'Total pixel distance dragged upward. Default 1500 (Phase 209: bumped from 800 after live test 2026-05-10 found 1200 still insufficient on some iPads). If the swipe still does not unlock, try 2000.' },
        chunkMickeys: { type: 'number', description: 'Per-call mickey size for the drag. Smaller = faster apparent motion. Default 30.' },
      },
    },
  },
  {
    name: 'pikvm_detect_orientation',
    description: 'Detect the iPad content bounds in the HDMI frame: returns rect (x/y/w/h), centre, orientation (portrait/landscape), and HDMI resolution. Rarely needed directly — unlock and move_to invoke it automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        brightnessSum: { type: 'number', description: 'Per-channel sum (R+G+B) above which a pixel counts as iPad content rather than letterbox black. Default 60.' },
      },
    },
  },
  {
    name: 'pikvm_ipad_home',
    description: 'Return the iPad to the home screen via Cmd+H; idempotent there. Cmd+H does NOT dismiss the App Switcher — pass forceHomeViaSwipe:true for that. Does NOT unlock the lock screen — use pikvm_ipad_unlock.',
    inputSchema: {
      type: 'object',
      properties: {
        settleMs: { type: 'number', description: 'Settle delay after the gesture (ms). Default 800.' },
        forceHomeViaSwipe: { type: 'boolean', description: 'Phase 214 v0.5.202: also send slam-corner + upward swipe + Phase 231 defensive Esc+Enter + Phase 235 mid-screen cursor deposit after Cmd+H. Use when iPad may be in App Switcher mode. Default false.' },
        swipeDragPx: { type: 'number', description: 'Pixels to drag upward on the swipe path. Only used with forceHomeViaSwipe=true. Default 1500.' },
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
    description: 'Launch an iPad app keyboard-first: unlock (optional) then Spotlight (Cmd+Space), type appName, Enter. More reliable than clicking an icon. If the app is not found the iPad returns home. Returns a post-launch screenshot.',
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
    description: 'Move the pointer to a target HDMI pixel on a relative-mouse target (iPad). Default strategy on iPad is curve-one-shot: one detect + one deterministic curve emit (~11px). Use pikvm_mouse_click_at to move+click.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate in HDMI-screenshot pixels' },
        y: { type: 'number', description: 'Target Y coordinate in HDMI-screenshot pixels' },
        strategy: {
          type: 'string',
          enum: ['detect-then-move', 'slam-then-move', 'assume-at', 'curve-one-shot'],
          description: 'Movement strategy. "curve-one-shot" (DEFAULT on iPad/relative-mode): detect cursor once with V8 + one deterministic curve-based emit — no iterative correction; validated N=80 ≈11px + 8/8 correct-app-open vs the iterative path\'s ~73px on a real home screen. "detect-then-move" (default on desktop/absolute): probes+diffs to find the cursor then iteratively corrects. "slam-then-move" pins cursor to top-left (risky on iPad: hot-corner re-lock). "assume-at" requires assumeCursorAtX/Y.',
        },
        assumeCursorAtX: { type: 'number', description: 'With strategy="assume-at", HDMI X where cursor currently is.' },
        assumeCursorAtY: { type: 'number', description: 'With strategy="assume-at", HDMI Y where cursor currently is.' },
        slamOriginX: { type: 'number', description: 'HDMI X of post-slam origin. Default 625.' },
        slamOriginY: { type: 'number', description: 'HDMI Y of post-slam origin. Default 65.' },
        fallbackPxPerMickey: { type: 'number', description: 'px/mickey used when no profile. Default 1.3 (empirical iPad with mag=60 chunks).' },
        chunkMagnitude: { type: 'number', description: 'Per-call delta magnitude for chunking. Default 60.' },
        chunkPaceMs: { type: 'number', description: 'Milliseconds between chunked calls. Default 20.' },
        correct: { type: 'boolean', description: 'Enable motion-diff detection + correction. Default true.' },
        maxCorrectionPasses: { type: 'number', description: 'Max correction passes. Default 5.' },
        minResidualPx: { type: 'number', description: 'Early-exit threshold (px) for correction loop. Default 25.' },
        warmupMickeys: { type: 'number', description: 'Tiny move emitted before screenshot A so cursor renders. Default 8 mickeys.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_mouse_click_at',
    description: 'Move to a target HDMI pixel via pikvm_mouse_move_to then click. verifyClick (default) reports whether the click changed the screen; maxRetries re-probes on no-change; a brightness gate aborts on a dim iPad.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate in HDMI-screenshot pixels' },
        y: { type: 'number', description: 'Target Y coordinate in HDMI-screenshot pixels' },
        button: { type: 'string', enum: ['left', 'right', 'middle', 'up', 'down'], description: 'Mouse button. Default left.' },
        strategy: {
          type: 'string',
          enum: ['detect-then-move', 'slam-then-move', 'assume-at'],
          description: 'Origin discovery. Default "detect-then-move". DO NOT use "slam-then-move" on iPad targets — slam-to-corner triggers iPadOS hot-corner gesture and re-locks the screen mid-session (live-verified 2026-04-26). The Phase 32 guard refuses slam on detected iPad-portrait letterbox by default; pass forbidSlamOnIpad=false to override (only safe if iPad hot-corners are disabled).',
        },
        assumeCursorAtX: { type: 'number', description: 'With strategy="assume-at", HDMI X where cursor currently is.' },
        assumeCursorAtY: { type: 'number', description: 'With strategy="assume-at", HDMI Y where cursor currently is.' },
        verifyClick: { type: 'boolean', description: 'When true (default), capture pre and post screenshots and report whether the click visibly changed the screen. Set false to skip the extra screenshot round-trip.' },
        verifySettleMs: { type: 'number', description: 'Milliseconds to wait between click and post-click screenshot for the UI to render. Default 300.' },
        verifyRegionHalfPx: { type: 'number', description: 'When set, the verification diff is restricted to a square window of ±N HDMI px around the click target. Useful when the expected effect is a small/local UI change (button highlight, focus indicator) and a full-frame diff would be diluted by background animations. Default: full-frame.' },
        verifyMinChangeFraction: { type: 'number', description: 'Custom minimum changed-pixel fraction for screenChanged=true. Default 0.005 (0.5% of the diffed area). Raise to 0.01-0.02 on noisy backdrops (iPad home screen with animated widgets) to be more conservative; lower for tiny UI changes.' },
        maxRetries: { type: 'number', description: 'When >0, retry the click up to N times if click verification reports no screen change. Each retry runs a fresh detect-then-move probe (NOT compound corrections — independent trials). Default: 3 on iPad (relative-mouse) targets where per-attempt hit rate is ~50% — four attempts give ~88% cumulative hit rate plus headroom for the hidden-popup auto-dismiss recipe to fire on each retry; 0 on desktop (absolute-mouse) targets where single-shot is reliable. Pass 0 explicitly to opt out (single-shot). Requires verifyClick=true.' },
        minBrightness: { type: 'number', description: 'Brightness gate threshold (0-255). Before clicking, the server screenshots and computes mean RGB brightness AND stddev (Phase 48). The gate aborts with a "wake the iPad" error ONLY when the frame is uniformly dim (mean < threshold AND stddev < 3) — dark-mode UI passes the gate because the high stddev from text/icon contrast indicates cursor will still be detectable. Default 35 on iPad targets (Phase 39 calibrated against live data: 29 = popup overlay, 41 = bright iPad with dark wallpaper); 0 on non-iPad targets and to disable the gate entirely. Pass 0 explicitly to skip the gate (useful for intentionally-dark targets like video playback).' },
        autoUnlockOnDetectFail: { type: 'boolean', description: 'Phase 72: when an attempt fails because the iPad is on the lock screen (Phase 70 found this is the dominant detect-then-move failure mode), automatically call ipadGoHome to unlock and retry once before giving up on this attempt. SIDE EFFECT: if the iPad is INSIDE AN APP and detect-then-move fails for some other reason, this will exit the app to home — not what you want for in-app clicks. Default false (preserve manual control). Set true for fire-and-forget click_at on a fresh iPad target where you don\'t care about app state.' },
        maxResidualPx: { type: 'number', description: 'Phase 88: skip the click if the verified cursor is more than this many pixels from the target. Useful when callers care about CORRECT element hit, not just "screen changed". Live-verified failure mode (2026-04-27): residual 78 px caused a click targeting Settings → Software Update to instead activate the Apple Account sidebar row. Pass a positive integer to set the tolerance (e.g. 25 for strict icon-tolerance clicks, 50 for "near-enough is fine"). Default 25 on iPad (relative-mouse) targets — the gate is ON so an off-target move skips instead of launching the wrong app; 0/undefined on desktop. Override the default without redeploy via PIKVM_CLICK_MAX_RESIDUAL_PX (a number, or "off"/0 to disable).' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_measure_ballistics',
    description: 'Characterise a relative-mouse target acceleration curve: slams to top-left, sweeps axis x magnitude x pace, and writes a ballistics profile used by move_to/click_at. One-off per device; takes minutes; blocks other tools.',
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
    description: 'Auto-calibrate mouse coordinates by moving the cursor and diffing screenshots to locate it, then computing calibration factors. More accurate than manual pikvm_calibrate. Blocks other tools while running.',
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
  {
    name: 'pikvm_seed_cursor_template',
    description: 'Bootstrap cursor detection: emit a small relative move, diff before/after to find the cursor, save a 24×24 template to data/cursor-templates/. Run once after a fresh deploy or when that dir is cleared. Safe on iPad.',
    inputSchema: {
      type: 'object',
      properties: {
        emitDx: {
          type: 'number',
          description: 'X-axis mickeys for the wake motion. Default 100. Larger = cursor more visible but more screen movement.',
        },
        emitDy: {
          type: 'number',
          description: 'Y-axis mickeys for the wake motion. Default 0.',
        },
        settleMs: {
          type: 'number',
          description: 'Delay between motion and post-screenshot to let iPad render the cursor. Default 500.',
        },
      },
    },
  },
  ...skillTools,
];

// The in-band auth tool (opt-in, --allow-tool-login). Exposed ONLY when a login
// gate is present AND the session is not yet authenticated; on success the full
// tool set above unlocks for the session. Not a `pikvm_` device op — it's a
// session/transport concern — so it is deliberately unprefixed.
const LOGIN_TOOL: Tool = {
  name: 'login',
  description:
    'Authenticate THIS MCP session with your username and password (your PiKVM/kvmd ' +
    'credentials when the server runs in kvmd mode). Required before any other tool when ' +
    'the server enforces authentication and you did not present an Authorization header at ' +
    'connect. On success the full tool set unlocks for this session. The password is not ' +
    'logged or echoed.',
  inputSchema: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'Username (your PiKVM/kvmd user in kvmd mode).' },
      password: { type: 'string', description: 'Password. Not logged or echoed.' },
    },
    required: ['username', 'password'],
  },
};

// Create MCP server.
//
// This is a factory (not a module-global singleton) so the Streamable HTTP
// transport can mint a fresh Server per session — concurrent clients must not
// share one Server or they collide on JSON-RPC request IDs. The stdio path
// calls it exactly once. All heavy shared state (the PiKVMClient, the busy
// lock, mouseAbsoluteMode) stays in module globals, so per-session Servers are
// cheap wrappers over the same device connection.
//
// `gate` (Streamable HTTP + --allow-tool-login only): when present, this session
// exposes the `login` tool and gates every other tool until authenticated. The
// stdio path and header-only auth pass no gate → identical, ungated behavior.
export function createMcpServer(gate?: LoginGate): Server {
  const server = new Server(
    {
      name: 'pikvm-mcp-server',
      version: VERSION,
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
  // Pre-auth (login gate present, session not yet authenticated): expose ONLY
  // the login tool — don't leak the full tool surface before authentication.
  if (gate && !gate.session.authenticated) {
    return { tools: [LOGIN_TOOL] };
  }
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Login gate (--allow-tool-login). The `login` tool is the ONLY tool callable
  // on a pre-auth session; everything else is refused until it authenticates.
  if (gate) {
    if (name === 'login') {
      const { username, password } = args as { username?: unknown; password?: unknown };
      if (typeof username !== 'string' || typeof password !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: login requires string "username" and "password".' }],
          isError: true,
        };
      }
      if (gate.session.authenticated) {
        return { content: [{ type: 'text', text: 'Already authenticated for this session.' }] };
      }
      // makeLoginGate validates via the same authorizer as the header path and
      // flips session.authenticated on success. The password is never logged.
      const ok = await gate.login(username, password);
      return ok
        ? {
            content: [
              {
                type: 'text',
                text: 'Authentication successful — session authorized. All tools are now available.',
              },
            ],
          }
        : {
            content: [{ type: 'text', text: 'Error: authentication failed — invalid username or password.' }],
            isError: true,
          };
    }
    if (!gate.session.authenticated) {
      return {
        content: [
          {
            type: 'text',
            text: "Error: authentication required — call the 'login' tool with your username and password first.",
          },
        ],
        isError: true,
      };
    }
  }

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
    if (requiresAbsoluteMouse(name, args as Record<string, unknown>)) {
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
      case 'pikvm_version': {
        return {
          content: [
            {
              type: 'text',
              text: `pikvm-mcp-server v${VERSION}`,
            },
          ],
        };
      }

      case 'pikvm_health_check': {
        // Orchestration lives in pikvm/health-check.ts so it is unit-testable
        // with a stub client. It reconciles the in-process mouseAbsoluteMode
        // flag against the live HID profile and returns the refreshed value.
        const health = await runHealthCheck(pikvm, { mouseAbsoluteMode });
        mouseAbsoluteMode = health.mouseAbsoluteMode;
        return {
          content: [{ type: 'text', text: health.lines.join('\n') }],
        };
      }

      case 'pikvm_screenshot': {
        const opts = {
          maxWidth: validateNumber(args.maxWidth, 1, 10000),
          maxHeight: validateNumber(args.maxHeight, 1, 10000),
          quality: validateNumber(args.quality, 1, 100),
        };
        const result = validateBoolean(args.keepCursorAlive)
          ? await pikvm.screenshotKeepingCursorAlive(opts)
          : await pikvm.screenshot(opts);

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

      case 'pikvm_screen_state': {
        // Phase 189 introduced getStreamerStatus(); this case exposes
        // it as its own MCP tool. Cheaper than pikvm_health_check (a
        // single GET /streamer) and returns a clear { on: boolean }
        // that other tools can sanity-check before assuming HDMI is
        // available.
        try {
          const s = await pikvm.getStreamerStatus();
          const msg = s.sourceOnline
            ? `Screen ON. Resolution ${s.resolution.width}×${s.resolution.height}.`
            : `Screen OFF (no HDMI signal). Most common cause: iPad is locked / asleep / showing Touch ID gate. Wake with sendKey Enter (Phase 217: also dismisses lock screen on iPadOS 26 with no passcode), or pikvm_ipad_unlock for the swipe-based path. pikvm_screenshot will 503 until the screen wakes.`;
          return {
            content: [{ type: 'text', text: msg }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Screen state: FAILED to read (${(err as Error).message}). PiKVM itself may be unreachable.` }],
          };
        }
      }

      case 'pikvm_hid_reset': {
        const reconnectUsb = validateBoolean(args.reconnectUsb) ?? false;
        const settleMs = validateNumber(args.settleMs, 0, 30000);
        const after = await pikvm.resetHid({ reconnectUsb, settleMs });
        const recovered = after.mouseOnline && after.keyboardOnline;
        const lines = [
          `HID reset sent${reconnectUsb ? ' (+ OTG set_connected 0→1)' : ''}.`,
          `Post-reset HID: mouse=${after.mouseOnline ? 'online' : 'offline'}/` +
            `${after.mouseAbsolute ? 'absolute' : 'relative'}, ` +
            `keyboard=${after.keyboardOnline ? 'online' : 'offline'}.`,
        ];
        if (!recovered) {
          lines.push(
            'Still offline — a soft reset cannot force the host to re-enumerate. ' +
            'The target device (e.g. iPad) is not bringing the USB HID link up. ' +
            'Physically re-plug the USB-C data cable (not charge-only) or restart the target.',
          );
        }
        // Keep the in-process absolute-mode flag consistent with what we just read.
        mouseAbsoluteMode = after.mouseAbsolute;
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'pikvm_hid_recover': {
        const maxRung = (validateNumber(args.maxRung, 1, 4) ?? 3) as 1 | 2 | 3 | 4;
        const allowReboot = validateBoolean(args.allowReboot) ?? false;
        const verifier = makeBehavioralVerifier(pikvm);
        const result = await recoverHid(pikvm, getRecoveryTrigger(), verifier, { maxRung, allowReboot });
        const lines = [
          !result.targetPresent
            ? 'R0 target NOT present (no screenshot / HDMI) — no HID rung can run.'
            : result.initiallyBroken
              ? `HID flags reported broken. Escalated up to rung ${maxRung}${allowReboot ? ' (reboot permitted)' : ''}, verifying behaviorally after each:`
              : 'HID flags reported OK; behavioral check confirmed it — nothing to recover.',
          ...result.attempts.map((a) => `  ${a.rung} (${a.action}): ${a.recovered ? 'RECOVERED' : a.performed ? 'no change' : 'skipped/unavailable'} — ${a.detail}`),
          `→ ${result.recovered ? 'RECOVERED (behavioral verify healthy)' : 'STILL BROKEN'}.`,
        ];
        if (result.humanActionRequired) {
          lines.push(`R4 — HUMAN ACTION REQUIRED: ${result.humanActionRequired}`);
        }
        if (!result.recovered && result.targetPresent && maxRung < 4) {
          lines.push('Not recovered by the allowed rungs. Reboot (R3b) worked once and is the most reliable remote option: re-run with maxRung:4, allowReboot:true (needs the host recovery trigger configured).');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: !result.recovered };
      }

      case 'pikvm_ipad_unlock_with_code': {
        // 2026-06-03 user-provided keyboard-only unlock recipe.
        // unlockIpadWithCode validates code shape BEFORE any HID
        // activity so a malformed code doesn't half-type and trip
        // iPadOS's wrong-passcode counter.
        const code = requireString(args.code, 'code');
        const result = await unlockIpadWithCode(pikvm, code);
        return {
          content: [{
            type: 'text',
            text: `Unlock recipe fired (Space → wait → Space → wait → ${result.digitsSent} digits → Enter). Verify with pikvm_screen_state (expect on:true) and pikvm_screenshot. If wrong-passcode, iPadOS will show the shake animation and remain on the passcode prompt.`,
          }],
        };
      }

      case 'pikvm_ipad_lock': {
        // 2026-06-03: Ctrl+Cmd+Q is the standard macOS "Lock Screen"
        // shortcut and iPadOS honors it from an attached keyboard
        // (verified live on iPadOS 26). The iPad's HDMI output turns
        // off ~immediately; pikvm_screen_state will report on:false
        // within a couple of seconds.
        await pikvm.sendShortcut(['ControlLeft', 'MetaLeft', 'KeyQ']);
        return {
          content: [{
            type: 'text',
            text: 'Sent Ctrl+Cmd+Q (iPadOS Lock Screen). Screen should turn off within 2 s. Verify with pikvm_screen_state (expect on:false). To unlock again: sendKey Enter (wakes the screen; on iPadOS 26 with no passcode also dismisses the lock screen).',
          }],
        };
      }

      case 'pikvm_dismiss_popup': {
        // Phase 165: run the documented Phase 141 hidden-popup dismiss recipe.
        // Phase 172 extracted formatDismissResult so both formatting branches
        // are regression-pinned by unit tests.
        const force = validateBoolean(args.force) ?? false;
        const result = await runDismissRecipe(pikvm, { tryCmdH: force });
        return {
          content: [{ type: 'text', text: formatDismissResult(result) }],
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
          tryKeyPressFirst: validateBoolean(args.tryKeyPressFirst),
          swipeOnKeyPressFailure: validateBoolean(args.swipeOnKeyPressFailure),
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
          forceHomeViaSwipe: validateBoolean(args.forceHomeViaSwipe),
          swipeDragPx: validateNumber(args.swipeDragPx, 100, 3000),
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
          ['detect-then-move', 'slam-then-move', 'assume-at', 'curve-one-shot'] as const,
          // iPad (relative-mode) DEFAULTS to the validated curve-one-shot mover:
          // N=80 move ≈11px + 8/8 correct-app-open, vs the iterative path's ~73px
          // median on a real home screen (its per-pass motion-diff correction
          // oscillates/goes blind on textured backgrounds). Desktop (absolute)
          // keeps detect-then-move. Failure mode is safe: the proximity gate
          // skips rather than wrong-clicks. Curve is calibrated for the current
          // iPad-in-HDMI geometry (see curve-mover.ts / calibrateFullReport).
          !mouseAbsoluteMode ? 'curve-one-shot' : 'detect-then-move',
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
            // On iPad (mouse.absolute=false), slam-to-corner triggers
            // the hot-corner gesture and re-locks the screen. Refuse
            // the silent slam fallback; force the caller to handle
            // detection failure explicitly.
            forbidSlamFallback: !mouseAbsoluteMode,
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
          ['detect-then-move', 'slam-then-move', 'assume-at', 'curve-one-shot'] as const,
          // iPad (relative-mode) DEFAULTS to the validated curve-one-shot mover:
          // N=80 move ≈11px + 8/8 correct-app-open, vs the iterative path's ~73px
          // median on a real home screen (its per-pass motion-diff correction
          // oscillates/goes blind on textured backgrounds). Desktop (absolute)
          // keeps detect-then-move. Failure mode is safe: the proximity gate
          // skips rather than wrong-clicks. Curve is calibrated for the current
          // iPad-in-HDMI geometry (see curve-mover.ts / calibrateFullReport).
          !mouseAbsoluteMode ? 'curve-one-shot' : 'detect-then-move',
        );
        const assumeX = validateNumber(args.assumeCursorAtX);
        const assumeY = validateNumber(args.assumeCursorAtY);
        const assumeCursorAt =
          assumeX !== undefined && assumeY !== undefined
            ? { x: assumeX, y: assumeY }
            : undefined;
        const verifyClick = validateBoolean(args.verifyClick) ?? true;
        const verifySettleMs = validateNumber(args.verifySettleMs, 0, 5000) ?? 300;
        const verifyRegionHalfPx = validateNumber(args.verifyRegionHalfPx, 1, 1920);
        const verifyMinChangeFraction = validateNumber(args.verifyMinChangeFraction, 0.0001, 1);
        // Phase 94: default to 2 retries on iPad (relative-mouse), 0 on
        // desktop (absolute-mouse). Single-shot click_at is ~50% reliable
        // on tiny iPad targets (verified Phase 70 bench), ~88% with
        // retries=2. Phase 95 extracted defaultMaxRetriesFor so the
        // mapping is unit-tested.
        const maxRetriesArg = validateNumber(args.maxRetries, 0, 10);
        const maxRetries = maxRetriesArg !== undefined
          ? maxRetriesArg
          : defaultMaxRetriesFor(mouseAbsoluteMode);
        // Phase 38 / v0.5.26: explicit MCP parameter for the brightness gate.
        // Default mirrors the auto-policy: VERY_DIM_THRESHOLD on iPad
        // targets (relative-mouse), 0 elsewhere. Pass 0 explicitly to disable.
        const minBrightnessArg = validateNumber(args.minBrightness, 0, 255);
        const minBrightness = minBrightnessArg !== undefined
          ? minBrightnessArg
          : (mouseAbsoluteMode ? 0 : VERY_DIM_THRESHOLD);

        // Phase 136 / Phase 156: iPad targets get chunkPaceMs=100ms
        // open-loop default; desktop uses caller's default. Helper is
        // regression-pinned by defaultChunkPaceMsFor.test.ts.
        const chunkPace = defaultChunkPaceMsFor(mouseAbsoluteMode);
        const moveOpts = {
          strategy: strategyStr,
          assumeCursorAt,
          profile: cachedProfile,
          forbidSlamFallback: !mouseAbsoluteMode,
          // Desktop full-frame degrade: the Phase-32 slam guard exists ONLY to
          // avoid the iPadOS hot-corner re-lock, so it must be disarmed in
          // absolute/desktop mode. Otherwise a blank/uniform desktop frame
          // (cursor-locate miss + bounds-detect null) FALSE-ABORTS with "target
          // type undetermined" — the guard presumes an undetermined target is an
          // iPad. `--target desktop` declares it is not, so opt out (safe: no
          // iPad hot-corners exist on a desktop). Mirrors forbidSlamFallback above.
          forbidSlamOnIpad: !mouseAbsoluteMode,
          ...(chunkPace !== undefined ? { chunkPaceMs: chunkPace } : {}),
        };
        const verifyOpts = {
          ...(verifyRegionHalfPx !== undefined
            ? { region: { x: tx, y: ty, halfWidth: verifyRegionHalfPx, halfHeight: verifyRegionHalfPx } }
            : {}),
          ...(verifyMinChangeFraction !== undefined
            ? { minChangedFraction: verifyMinChangeFraction }
            : {}),
        };

        // Phase 38: brightness precheck. The retry path (maxRetries>0) does
        // this inside clickAtWithRetry (we pass minBrightness through). On
        // the single-shot path (maxRetries=0) we run the gate here.
        // Phase 38b (v0.5.27): scope the brightness measurement to detected
        // iPad bounds so letterbox bars don't trigger false-positive dim
        // verdicts on a bright iPad-portrait screen.
        if (minBrightness > 0 && maxRetries === 0) {
          try {
            const shot0 = await pikvm.screenshot();
            let region: { x: number; y: number; width: number; height: number } | undefined;
            try {
              const bounds = await detectIpadBoundsFromBuffer(shot0.buffer, { verbose: false });
              region = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
            } catch {
              // No bounds detected — analyse full frame. On a non-iPad target
              // there's no letterbox to confuse, so the full-frame mean is
              // accurate.
            }
            const brightness = await analyzeBrightness(shot0.buffer, { region });
            if (brightness.mean < minBrightness) {
              return {
                content: [{
                  type: 'text',
                  text:
                    `Click aborted: iPad display blocked ` +
                    `(mean brightness=${brightness.mean.toFixed(0)}/255, threshold=${minBrightness}). ` +
                    `iPad auto-brightness does NOT affect HDMI — dim HDMI means an ` +
                    `iOS modal/security prompt is dimming the screen. Try ` +
                    `pikvm_key Escape, Enter, or Cmd+Period to dismiss blindly; ` +
                    `if none work, a human must dismiss the prompt physically on the iPad.`,
                }],
                isError: true,
              };
            }
          } catch (_err) {
            // Precheck failure is non-fatal — fall through to the click.
          }
        }

        // Phase 25: when maxRetries > 0, use the retry orchestrator
        // (clickAtWithRetry) which loops moveToPixel + click + verify
        // until success or exhausted retries. When maxRetries === 0,
        // preserve the single-shot path for backward compat.
        if (verifyClick && maxRetries > 0) {
          const r = await clickAtWithRetry(
            pikvm,
            { x: tx, y: ty },
            {
              maxRetries,
              button,
              preClickSettleMs: 80,
              postClickSettleMs: verifySettleMs,
              verifyOptions: verifyOpts,
              moveToOptions: moveOpts,
              minBrightness,
              autoUnlockOnDetectFail: args.autoUnlockOnDetectFail === true,
              // Phase 135: iPad targets get a 35 px default gate so the click
              // doesn't silently land on an adjacent icon. Caller can override
              // (or pass 0 to disable).
              maxResidualPx: args.maxResidualPx !== undefined
                ? Number(args.maxResidualPx)
                : defaultMaxResidualPxFor(mouseAbsoluteMode),
            },
          );
          const attemptsText =
            r.attempts === 1
              ? '1 attempt'
              : `${r.attempts} attempts (${r.success ? 'succeeded' : 'all failed'})`;
          const summaryText = r.failureSummary ? `\n${r.failureSummary}` : '';
          return {
            content: [
              {
                type: 'text',
                text:
                  r.finalMoveResult.message +
                  `\nClicked ${button} at approximate position. ` +
                  `Phase 25 retry-on-miss ran ${attemptsText}. ` +
                  r.finalVerification.message +
                  summaryText,
              },
              { type: 'image', data: r.postClickScreenshot.toString('base64'), mimeType: 'image/jpeg' },
            ],
          };
        }

        const result = await moveToPixel(pikvm, { x: tx, y: ty }, moveOpts);
        // Brief pause so iPadOS registers the cursor as stationary before click
        await new Promise((r) => setTimeout(r, 80));
        // Pre-click screenshot AFTER cursor has settled at target, so the
        // pre→post diff isolates the click's UI effect from cursor motion.
        const preShot = verifyClick ? await pikvm.screenshot() : null;
        await pikvm.mouseClick(button);
        // Wait for the UI to render before capturing the post-click frame.
        await new Promise((r) => setTimeout(r, verifySettleMs));
        const shot = await pikvm.screenshot();

        let verificationText = '';
        if (verifyClick && preShot) {
          try {
            const verification = await verifyClickByDiff(preShot.buffer, shot.buffer, verifyOpts);
            verificationText = `\n${verification.message}`;
          } catch (err) {
            verificationText = `\nClick verification skipped: ${err instanceof Error ? err.message : String(err)}.`;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text:
                result.message +
                `\nClicked ${button} at approximate position. Post-click screenshot attached.` +
                verificationText,
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

      case 'pikvm_seed_cursor_template': {
        const result = await seedCursorTemplate(pikvm, {
          emitDx: args?.emitDx !== undefined ? Number(args.emitDx) : undefined,
          emitDy: args?.emitDy !== undefined ? Number(args.emitDy) : undefined,
          settleMs: args?.settleMs !== undefined ? Number(args.settleMs) : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: !result.ok,
        };
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
    // Phase 190: append actionable hint when the error pattern matches a
    // known operator-recoverable case. The raw "PiKVM API error 503 ...
    // UnavailableError ... Service Unavailable" doesn't tell the LLM
    // agent that the problem is source-side (iPad off / mid-reboot /
    // unplugged) rather than PiKVM-side. Hint points at
    // pikvm_health_check (Phase 189) which surfaces source.online state
    // and lets the agent decide whether to wait or escalate.
    message = appendOperatorHint(message);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
  });

  return server;
}

// Start server
async function main() {
  // Parse CLI first so --help works without any PiKVM config/credentials.
  // A usage error should print a clean message, not a stack trace.
  let cli;
  try {
    cli = parseCliOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\nRun 'pikvm-mcp-server --help' for usage.`);
    process.exit(2);
  }
  if (cli.help) {
    console.log(helpText());
    return;
  }
  if (!cli.target) {
    console.error(
      "--target is required — pass --target ipad or --target desktop (or set PIKVM_TARGET).\n" +
        "Run 'pikvm-mcp-server --help' for usage.",
    );
    process.exit(2);
  }

  // In http mode the security posture is an EXPLICIT, required choice (the
  // endpoint drives real input on a physical machine). Resolve it before doing
  // any work so a misconfiguration fails fast.
  let httpAuth: HttpAuth | undefined;
  if (cli.transport === 'http') {
    if (cli.security === undefined) {
      console.error(
        '--security is required in http mode — pass --security yes (static credential), ' +
          '--security kvmd (validate clients against PiKVM/kvmd users), or --security no ' +
          '(serve it with NO authentication). See --help.',
      );
      process.exit(2);
    }
    if (cli.security === 'yes') {
      httpAuth = resolveHttpAuth(process.env, cli);
      if (!httpAuth) {
        console.error(
          '--security yes requires an auth password — set --auth-password, --auth-password-file, ' +
            'PIKVM_MCP_AUTH_PASSWORD[_FILE], or the "pikvm-mcp-auth-password" systemd credential.',
        );
        process.exit(2);
      }
      console.error(`HTTP auth: ENABLED (static Basic, user "${httpAuth.username}").`);
    } else if (cli.security === 'kvmd') {
      console.error(
        'HTTP auth: ENABLED (kvmd-backed — clients log in with their PiKVM username/password).',
      );
    } else {
      console.error(
        `⚠ HTTP auth: DISABLED (--security no). Anyone who can reach ${cli.host}:${cli.port} can control the machine.`,
      );
    }
    if (cli.allowToolLogin && cli.security !== 'no') {
      console.error(
        "HTTP auth: in-band `login` tool ENABLED (--allow-tool-login). A pre-auth session may " +
          'connect without a header but can call ONLY `login` until it authenticates.',
      );
    } else if (cli.allowToolLogin) {
      console.error('Note: --allow-tool-login has no effect with --security no (nothing to authenticate).');
    }
  }

  // Load configuration (deferred to here for proper error handling)
  const config = loadConfig();

  // Build the /mcp header authorizer now that config (the PiKVM host/TLS/proxy the
  // kvmd backend validates against) is available. undefined = open (--security no).
  let httpAuthorize: HeaderAuthorizer | undefined;
  if (cli.transport === 'http') {
    if (cli.security === 'yes') {
      httpAuthorize = makeStaticAuthorizer(httpAuth!);
    } else if (cli.security === 'kvmd') {
      // Validate the CLIENT's Basic creds against kvmd (GET /api/auth/check) —
      // a SEPARATE check from the service creds the PiKVMClient uses. Reuses the
      // same host + TLS-verify + optional loopback proxy.
      httpAuthorize = makeKvmdAuthorizer({
        host: config.pikvm.host,
        verifySsl: config.pikvm.verifySsl,
        proxyUrl: config.pikvm.proxyUrl || undefined,
      });
    }
  }
  // C1 P2 (candidate 5): the CursorBelief is created at startup and injected into
  // the client, so it is no longer owned by PiKVMClient. Phase 3 wraps this same
  // instance in the CursorLocator (which becomes its front door); client.belief +
  // wrappers + the emit predict delegate to it. Behaviour is identical.
  const cursorBelief = createDefaultBelief();
  pikvm = new PiKVMClient(config.pikvm, cursorBelief);
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

  // --target (required) sets the mouse mode: 'ipad' = relative (curve-one-shot +
  // cascade), 'desktop' = absolute (legacy detect-then-move). The HID read above is
  // kept only to warn on a mismatch.
  const forcedAbsolute = cli.target === 'desktop';
  if (forcedAbsolute !== mouseAbsoluteMode) {
    console.error(
      `⚠ --target ${cli.target} overrides the HID-detected mode ` +
        `(HID reported ${mouseAbsoluteMode ? 'absolute/desktop' : 'relative/iPad'}).`,
    );
  }
  mouseAbsoluteMode = forcedAbsolute;
  console.error(
    `Control path: ${cli.target} → ` +
      `${mouseAbsoluteMode ? 'desktop (absolute, detect-then-move)' : 'iPad (relative, curve-one-shot + cascade)'}.`,
  );

  if (cli.transport === 'http') {
    // Streamable HTTP: one Server per session, minted by createMcpServer.
    const handle = await startHttpServer(createMcpServer, {
      host: cli.host,
      port: cli.port,
      authorize: httpAuthorize,
      allowToolLogin: cli.allowToolLogin,
    });
    console.error(`PiKVM MCP Server running (Streamable HTTP) at ${handle.url}`);
  } else {
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
    console.error('PiKVM MCP Server running (stdio)');
  }
}

// Auto-start only when executed directly, so tests (and other importers) can
// pull in createMcpServer without booting the server. realpathSync resolves the
// bin symlink (node_modules/.bin/pikvm-mcp-server -> dist/index.js) to the real
// module path so the deployed CLI still starts.
function isDirectRun(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
