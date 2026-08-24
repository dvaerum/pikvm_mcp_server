/**
 * HID failure-mode discriminator (fix (d)). Splits the single "HID broken"
 * bucket into operationally DISTINCT states so the operator/agent picks the
 * RIGHT fix instead of blindly re-running usb_reconnect:
 *
 *   - HID DOWN — the USB gadget input path is dead. A CONFIDENT, directive DOWN
 *     ("run pikvm_usb_reconnect") is emitted ONLY from UDC KERNEL STATE (the
 *     loopback endpoint or the SSH reader). The kvmd HID flags are NOT trusted
 *     for a confident down verdict: live-observed 2026-07-30 that BOTH flags read
 *     offline on a demonstrably-working HID (UDC configured, clicks landing) — so
 *     the flags lie in BOTH directions and no flags-derived DOWN is trustworthy.
 *   - HID-down SUSPECTED (flags only) — when no UDC kernel reader is available and
 *     the flags fall to their DOWN signature (BOTH offline), the verdict is a
 *     NON-DIRECTIVE hedge: "confirm behaviorally before reconnecting", never a
 *     bare "run pikvm_usb_reconnect". This is the field reality — production has
 *     no UDC reader wired, so this is the path the real kiosk takes.
 *   - HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (input reaches
 *     the target) yet the pointer can't be found on screen (faded / off-screen /
 *     dim frame). usb_reconnect does NOTHING for this; the fix is to wake the
 *     cursor (a mouse nudge) or raise brightness.
 *
 * On the flags fallback, HID is treated UP if EITHER mouse or keyboard is online
 * (NOT keyboard alone, NOT mouse alone — either-alone moves the false verdict to
 * the other idle-input session); DOWN requires BOTH offline, the genuinely-dead
 * signature. UDC kernel state, when available, is AUTHORITATIVE and overrides the
 * flags entirely.
 *
 * Kept out of hid-recovery.ts on purpose: this classifies a state, it does not
 * drive the recovery ladder.
 */
import { decodeScreenshot } from './cursor-detect.js';
import { findCursorByV8FullFrame } from './cursor-ml-detect.js';
import { type UdcState } from './hid-recovery.js';

export type CursorPoint = { x: number; y: number };
export type CursorLocator = (buffer: Buffer) => Promise<CursorPoint | null>;

/** Default pointer localization — the SAME V8 detector the mover/click use, so
 *  "localizable" here means exactly what it means at click time. Injectable so
 *  unit tests never touch onnxruntime. */
export const defaultCursorLocator: CursorLocator = async (buffer) => {
  const dec = await decodeScreenshot(buffer);
  const hit = await findCursorByV8FullFrame(buffer, dec.width, dec.height);
  return hit ? { x: hit.x, y: hit.y } : null;
};

export type HidDiagnosis =
  | { kind: 'healthy'; cursor: CursorPoint }
  | { kind: 'hid-down' } // CONFIDENT, directive — only from UDC kernel state
  | { kind: 'hid-down-suspected' } // flags-only, NON-DIRECTIVE hedge
  | { kind: 'up-no-cursor' }
  | { kind: 'unknown' };

/**
 * Pure classifier.
 * @param hidUp  HID up/down: UDC.online when a kernel reader is wired, else the
 *               kvmd flags (mouse OR keyboard online), else null when neither can
 *               be read (→ 'unknown', never a false verdict).
 * @param cursor result of localizing the pointer in a fresh frame, or null.
 * @param udcConfirmed whether `hidUp` derives from UDC KERNEL STATE (authoritative)
 *               rather than the kvmd flags. A down verdict is CONFIDENT/directive
 *               only when confirmed; a flags-derived down is a NON-DIRECTIVE hedge,
 *               because the flags are known to misreport DOWN on a working HID.
 */
export function classifyHid(input: {
  hidUp: boolean | null;
  cursor: CursorPoint | null;
  udcConfirmed?: boolean;
}): HidDiagnosis {
  if (input.hidUp === false) {
    return input.udcConfirmed ? { kind: 'hid-down' } : { kind: 'hid-down-suspected' };
  }
  if (input.hidUp === true) {
    return input.cursor ? { kind: 'healthy', cursor: input.cursor } : { kind: 'up-no-cursor' };
  }
  return { kind: 'unknown' };
}

/** One-line verdict + the corrective action, for the health/recover reports. */
export function describeHidDiagnosis(d: HidDiagnosis): string {
  switch (d.kind) {
    case 'healthy':
      return `HID UP and cursor localizable at (${d.cursor.x},${d.cursor.y}) — input path AND pointer both good.`;
    case 'hid-down':
      // CONFIDENT — backed by UDC kernel state. Safe to issue the reconnect directive.
      return (
        `HID DOWN (UDC kernel state) — the USB gadget input path is dead. ` +
        `Fix: run pikvm_usb_reconnect (add the reboot rung via pikvm_hid_recover if that doesn't take).`
      );
    case 'hid-down-suspected':
      // NON-DIRECTIVE — flags only, no kernel truth. The flags misreport DOWN on a
      // working HID (both read offline on a box landing clicks), so we must NOT emit
      // a bare "run pikvm_usb_reconnect" here — hedge and demand behavioral confirmation.
      return (
        `⚠ Possible HID-down (UNCONFIRMED) — both kvmd HID flags read offline, but there is NO UDC kernel ` +
        `ground truth available here and these flags are known to misreport (seen offline on a working HID). ` +
        `Do NOT reconnect yet: confirm behaviorally first — does a click land? does the cursor localize? — ` +
        `and only then run pikvm_usb_reconnect if input is truly dead. Wire PIKVM_HID_RECOVERY_URL (or the ` +
        `SSH UDC reader) for an authoritative verdict.`
      );
    case 'up-no-cursor':
      return (
        `⚠ HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (a HID flag online / UDC configured, ` +
        `input reaches the target) but the pointer can't be found on screen (faded / off-screen / dim frame). ` +
        `pikvm_usb_reconnect will NOT help — this is not a HID-down state. Wake the cursor with a nudge ` +
        `(pikvm_mouse_move) or raise brightness, then re-check.`
      );
    case 'unknown':
      return (
        `HID state UNKNOWN — no UDC endpoint and the kvmd HID flags could not be read to tell HID up from down. ` +
        `Set PIKVM_HID_RECOVERY_URL (or the SSH transport) for the ground-truth UDC signal.`
      );
  }
}

/** The subset of PiKVMClient the diagnosis drives — structural so tests inject a stub. */
export type HidDiagnosisClient = {
  screenshot: () => Promise<{ buffer: Buffer }>;
  getHidProfile: () => Promise<{ mouseOnline: boolean; keyboardOnline: boolean; mouseAbsolute: boolean }>;
};

/**
 * The OR-semantics HID up/down resolution, as a PURE function over
 * already-obtained readings (no I/O — callers own fetching, since they fetch
 * on different schedules: diagnoseHidFromClient below skips the kvmd-flags
 * read entirely when a UDC reading is available, while health-check.ts always
 * fetches both for its own flag-lie reporting). UDC KERNEL STATE is
 * authoritative when present; only then is a down verdict confident/directive.
 * Else fall back to the kvmd flags — mouse OR keyboard online (NOT keyboard
 * alone: a healthy box was live-observed 2026-07-30 reporting keyboard=offline
 * while the mouse clicked 4/4; genuinely-dead HID showed BOTH offline). A
 * flags-derived down is only SUSPECTED, never a reconnect directive (see
 * udcConfirmed in classifyHid above).
 *
 * This was previously duplicated inline in both diagnoseHidFromClient and
 * health-check.ts's runHealthCheck — extracted so the OR-semantics decision
 * has one home. Do NOT confuse with hid-recovery.ts's flagsSuggestPartialHidLoss,
 * which is deliberately AND-semantics for a different purpose (see its doc).
 */
export function resolveHidUp(input: {
  udc: UdcState | null;
  hidFlags: { mouseOnline: boolean; keyboardOnline: boolean } | null;
}): { hidUp: boolean | null; udcConfirmed: boolean } {
  if (input.udc != null) return { hidUp: input.udc.online, udcConfirmed: true };
  if (input.hidFlags != null) {
    return { hidUp: input.hidFlags.mouseOnline || input.hidFlags.keyboardOnline, udcConfirmed: false };
  }
  return { hidUp: null, udcConfirmed: false };
}

/**
 * Orchestrated diagnosis for the recover handlers: reads the UDC ground truth
 * (falling back to the kvmd HID flags when the endpoint isn't wired), localizes
 * the cursor in a fresh frame, and classifies. Never throws — a failed keyboard
 * probe or screenshot degrades to 'unknown'/no-cursor rather than crashing the
 * caller's failure path.
 */
export async function diagnoseHidFromClient(
  client: HidDiagnosisClient,
  udcReader: () => Promise<UdcState | null>,
  locate: CursorLocator = defaultCursorLocator,
): Promise<HidDiagnosis> {
  const udc = await udcReader().catch(() => null);
  // Only fetch the kvmd flags when there's no UDC reading to fall back on —
  // resolveHidUp ignores hidFlags entirely once udc is non-null, so fetching
  // them unconditionally here would be a wasted call on every diagnosis.
  let hidFlags: { mouseOnline: boolean; keyboardOnline: boolean } | null = null;
  if (udc == null) {
    try {
      const hid = await client.getHidProfile();
      hidFlags = { mouseOnline: hid.mouseOnline, keyboardOnline: hid.keyboardOnline };
    } catch {
      hidFlags = null;
    }
  }
  const { hidUp, udcConfirmed } = resolveHidUp({ udc, hidFlags });

  // Only bother localizing the cursor when HID might be up — a down input path is
  // DOWN no matter what the pointer looks like, and we skip an ORT inference.
  let cursor: CursorPoint | null = null;
  if (hidUp !== false) {
    try {
      const shot = await client.screenshot();
      cursor = await locate(shot.buffer);
    } catch {
      cursor = null;
    }
  }

  return classifyHid({ hidUp, cursor, udcConfirmed });
}
