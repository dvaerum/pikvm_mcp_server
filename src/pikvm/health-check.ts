/**
 * Deployment health report — the orchestration behind the `pikvm_health_check`
 * MCP tool, extracted from the index.ts dispatch switch so it can be unit-tested
 * with a stub client (the switch case could only be exercised by standing up the
 * whole MCP server).
 *
 * Pure orchestration: takes the current in-process `mouseAbsoluteMode` flag and
 * returns the report lines PLUS the (possibly refreshed) flag — the handler
 * assigns it back. Each probe is independently guarded so one failure still
 * yields a useful partial report.
 */
import { PiKVMClient } from './client.js';
import { detectIpadBoundsFromBuffer, boundsToRegion } from './orientation.js';
import { analyzeBrightness, formatBrightnessReport } from './brightness.js';
import { type UdcState } from './hid-recovery.js';
import { classifyHid, describeHidDiagnosis, defaultCursorLocator, type CursorLocator } from './hid-diagnosis.js';
import { VERSION } from '../version.js';

/** The subset of PiKVMClient the health check drives — a structural type so
 *  tests can inject a lightweight stub. */
export type HealthCheckClient = Pick<
  PiKVMClient,
  'getStreamerStatus' | 'getHidProfile' | 'screenshot'
>;

export interface HealthCheckResult {
  lines: string[];
  /** The in-process flag after reconciliation with the live HID profile. */
  mouseAbsoluteMode: boolean;
}

export async function runHealthCheck(
  pikvm: HealthCheckClient,
  opts: {
    mouseAbsoluteMode: boolean;
    /**
     * M4: ground-truth UDC state (from GET {PIKVM_HID_RECOVERY_URL}/udc-state),
     * already resolved by the caller. `null` = endpoint unconfigured/unreachable
     * → the report falls back to the (lying) kvmd flags with a note.
     */
    udcState?: UdcState | null;
    /**
     * (d): pointer localizer for the HID-down vs HID-up-but-cursor-not-localizable
     * split. Injectable so unit tests never touch onnxruntime; defaults to the same
     * V8 detector the mover/click use.
     */
    locateCursor?: CursorLocator;
  },
): Promise<HealthCheckResult> {
  let mouseAbsoluteMode = opts.mouseAbsoluteMode;
  const lines: string[] = [];
  lines.push(`Server version: v${VERSION}`);
  lines.push(`mouseAbsoluteMode (in-process flag): ${mouseAbsoluteMode}`);
  lines.push(
    `  → forbidSlamFallback in click_at/move_to defaults to ${!mouseAbsoluteMode} ` +
    `(true = slam-fallback BLOCKED, safe for iPad).`,
  );

  // Phase 189: report streamer source state up-front. When iPad is
  // off (battery dead, mid-reboot, HDMI cable unplugged), screenshot
  // calls return 503 UnavailableError which is opaque. Surfacing
  // `streamer.source.online` here lets the operator distinguish
  // "PiKVM is down" from "the device behind the HDMI cable is off".
  try {
    const streamer = await pikvm.getStreamerStatus();
    if (streamer.sourceOnline) {
      lines.push(
        `Streamer source: online — HDMI capture has signal at ` +
        `${streamer.resolution.width}×${streamer.resolution.height}.`,
      );
    } else {
      lines.push(
        `⚠ Streamer source: OFFLINE — no HDMI signal. The device behind ` +
        `the cable (iPad in our setup) has its screen off. Most common ` +
        `cause: the iPad is LOCKED / asleep / showing a Touch ID gate. ` +
        `Less commonly: powered off (dead battery), mid-reboot, or ` +
        `unplugged. pikvm_screenshot will return 503 UnavailableError ` +
        `until the screen comes back. Wake the iPad with sendKey Enter ` +
        `(Phase 217 — also dismisses the lock screen on iPadOS 26 when ` +
        `no passcode is set) or pikvm_ipad_unlock for passcode-protected ` +
        `devices. Cursor/click tools are unusable in this state.`,
      );
    }
  } catch (err) {
    lines.push(`Streamer source state: FAILED to read (${(err as Error).message}).`);
  }

  // Live HID profile — re-read so a transient startup-detection failure
  // doesn't permanently mislead the operator.
  let hidFlags: { mouseOnline: boolean; keyboardOnline: boolean } | null = null;
  // (d): HID up/down for the pointer-diagnosis below. Seeded from the kvmd flags
  // (advisory — they LIE; overridden by the UDC ground truth when the endpoint is
  // wired). Fall back to mouse OR keyboard online, NOT keyboard alone: live-observed
  // 2026-07-30 that a healthy box (mouse clicking 4/4) reported keyboard=offline
  // persistently, so a keyboard-only fallback emits a FALSE "HID DOWN → reconnect".
  // Genuinely-dead HID showed BOTH flags offline, so "either online ⇒ not down" is
  // the safe bar and matches this mouse-first product's pointer focus.
  let hidUp: boolean | null = null;
  try {
    const hid = await pikvm.getHidProfile();
    hidFlags = { mouseOnline: hid.mouseOnline, keyboardOnline: hid.keyboardOnline };
    hidUp = hid.mouseOnline || hid.keyboardOnline;
    lines.push(
      `Live HID profile: mouse=${hid.mouseOnline ? 'online' : 'offline'}/` +
      `${hid.mouseAbsolute ? 'absolute' : 'relative'}, ` +
      `keyboard=${hid.keyboardOnline ? 'online' : 'offline'}.`,
    );
    if (hid.mouseAbsolute !== mouseAbsoluteMode) {
      lines.push(
        `  ⚠ MISMATCH: in-process flag (${mouseAbsoluteMode}) differs from live profile ` +
        `(${hid.mouseAbsolute}). Restart the MCP server to pick up the live value, ` +
        `or use this call to refresh: the in-process flag is now updated.`,
      );
      mouseAbsoluteMode = hid.mouseAbsolute;
    }
  } catch (err) {
    lines.push(`Live HID profile: FAILED to read (${(err as Error).message}).`);
    lines.push(
      `  → Cannot verify mouse mode from PiKVM. The in-process flag stands ` +
      `(currently ${mouseAbsoluteMode}). If your target is iPad, the safe default ` +
      `(false) protects against slam-on-startup-failure.`,
    );
  }

  // M4: GROUND-TRUTH USB HID gadget state. The kvmd HID online flags above LIE
  // (they've reported online:false with a working gadget and vice versa); the
  // kernel /sys/class/udc/<udc>/state is authoritative. Surface it, reframe the
  // flags as advisory, flag mismatches both directions, and drive the verdict off
  // the UDC state — not the flags. Falls back gracefully when the endpoint is
  // unconfigured/unreachable (never hard-fails the report).
  const udc = opts.udcState;
  if (udc == null) {
    lines.push(
      `USB HID gadget: unavailable (UDC-state endpoint not configured or unreachable; ` +
      `falling back to the kvmd HID flags above, which may lie). Set PIKVM_HID_RECOVERY_URL to enable.`,
    );
  } else {
    hidUp = udc.online; // UDC ground truth overrides the advisory kvmd flags
    lines.push(
      `USB HID gadget (ground truth): ${udc.state}${udc.udc ? ` [${udc.udc}]` : ''} — ` +
      `this is THE HID up/down signal.`,
    );
    if (hidFlags) {
      lines.push(
        `  kvmd HID flags: mouse=${hidFlags.mouseOnline ? 'on' : 'off'} ` +
        `keyboard=${hidFlags.keyboardOnline ? 'on' : 'off'} (advisory — these have lied; UDC state above is ground truth).`,
      );
      const flagsSayOffline = !hidFlags.mouseOnline || !hidFlags.keyboardOnline;
      const flagsSayOnline = hidFlags.mouseOnline || hidFlags.keyboardOnline;
      if (udc.online && flagsSayOffline) {
        lines.push(
          `  ⚠ FLAG-LIE: kvmd says HID offline but UDC is configured → HID likely UP; ` +
          `confirm behaviorally (move the mouse / send ⌘-H).`,
        );
      } else if (!udc.online && flagsSayOnline) {
        lines.push(
          `  ⚠ FLAG-LIE: kvmd says online but UDC not attached → HID likely DOWN; run pikvm_usb_reconnect.`,
        );
      }
    }
    // Overall HID verdict is driven by the UDC state, NOT the flags.
    lines.push(
      udc.online
        ? `  → HID verdict: UP (UDC configured).`
        : `  → HID verdict: DOWN (UDC ${udc.state}) → run pikvm_usb_reconnect.`,
    );
  }

  // Capture one screenshot and reuse it for bounds + brightness so we
  // don't pay two screenshots' worth of streamer latency.
  let healthShot: { buffer: Buffer } | null = null;
  try {
    healthShot = await pikvm.screenshot();
  } catch (err) {
    lines.push(`Screenshot: FAILED (${(err as Error).message}). Cannot run bounds or brightness checks.`);
  }

  // (d): split the "HID broken" bucket. HID DOWN (input path dead) needs
  // usb_reconnect; HID UP but cursor NOT LOCALIZABLE (gadget attached, pointer
  // faded/off-screen) does NOT — usb_reconnect can't fix a pointer that isn't
  // rendering. The verdict must ALWAYS print when we have a frame — including the
  // confirmed-DOWN case (hidUp===false), which is the whole reason (d) exists and
  // is the state that produced no guidance before. Skipping the ORT inference on a
  // down gadget is a separate concern: only LOCALIZE when HID might be up, but
  // classify + print either way.
  if (healthShot) {
    let cursor: { x: number; y: number } | null = null;
    if (hidUp !== false) {
      try {
        cursor = await (opts.locateCursor ?? defaultCursorLocator)(healthShot.buffer);
      } catch (err) {
        lines.push(`Pointer localization: FAILED (${(err as Error).message}).`);
      }
    }
    // udcConfirmed: a CONFIDENT/directive DOWN is allowed only when the verdict
    // rests on UDC kernel state — with no reader wired (opts.udcState null) a
    // flags-derived down is a NON-DIRECTIVE hedge, because the flags misreport DOWN
    // on a working HID (live-observed both-offline while clicks landed).
    lines.push(`  → ${describeHidDiagnosis(classifyHid({ hidUp, cursor, udcConfirmed: udc != null }))}`);
  }

  // Attempt iPad bounds detection — informative on portrait/landscape,
  // AND used to scope the Phase 37 brightness measurement to actual
  // display content (avoids the letterbox-false-positive bug where
  // black bars dragged the full-frame mean below the dim threshold
  // even on a fully-bright iPad).
  let detectedBounds: Awaited<ReturnType<typeof detectIpadBoundsFromBuffer>> | null = null;
  if (healthShot) {
    try {
      detectedBounds = await detectIpadBoundsFromBuffer(healthShot.buffer, { verbose: false });
      lines.push(
        `iPad bounds detection: ${detectedBounds.orientation} ${detectedBounds.width}×${detectedBounds.height} ` +
        `at HDMI (${detectedBounds.x},${detectedBounds.y}). The Phase 32 slam guard treats portrait ` +
        `bounds as iPad-letterbox.`,
      );
    } catch (err) {
      lines.push(
        `iPad bounds detection: FAILED (${(err as Error).message}). ` +
        `Either the target isn't an iPad in letterbox, OR the screen is currently ` +
        `dark/uniform (e.g. lock screen, all-black canvas). Phase 32a's fail-safe ` +
        `still refuses slam in this state.`,
      );
    }

    // Phase 37: report mean brightness. iPadOS auto-dims the display
    // after inactivity; on a dim frame, cursor pixels can fall below
    // the cursor-detection brightness floor (100). Live-verified
    // 2026-04-26: a dim home screen made every locateCursor probe
    // fail. Reporting the mean brightness here lets the operator
    // notice this BEFORE wasting time debugging click failures.
    // Computation lives in pikvm/brightness.ts so the threshold logic
    // is unit-tested without needing the MCP handler.
    //
    // Phase 38b (v0.5.27): pass detected iPad bounds as the analysis
    // region so letterbox bars don't drag the mean down (false positive
    // verified live 2026-04-26: bright home screen reported mean=41/255
    // because ~67% of the HDMI frame was black letterbox).
    try {
      const region = detectedBounds ? boundsToRegion(detectedBounds) : undefined;
      const report = await analyzeBrightness(healthShot.buffer, { region });
      lines.push(formatBrightnessReport(report));
      if (region) {
        lines.push(
          `  (brightness measured over iPad-content region only, ` +
          `not the full HDMI frame — letterbox bars excluded.)`,
        );
      }
    } catch (err) {
      lines.push(`Screen brightness: FAILED to compute (${(err as Error).message}).`);
    }
  }

  return { lines, mouseAbsoluteMode };
}
