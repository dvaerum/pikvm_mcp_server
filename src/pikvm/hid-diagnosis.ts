/**
 * HID failure-mode discriminator (fix (d)). Splits the single "HID broken"
 * bucket into two operationally DISTINCT states so the operator/agent picks the
 * RIGHT fix instead of blindly re-running usb_reconnect:
 *
 *   - HID DOWN — the USB gadget input path is dead. Ground truth is the UDC
 *     state (not attached); when that endpoint isn't wired we fall back to the
 *     kvmd HID flags (mouse OR keyboard online ⇒ not down). NOT keyboard alone:
 *     a healthy box was live-observed reporting keyboard=offline while the mouse
 *     clicked 4/4 — the flags lie, so we only call DOWN when BOTH agree offline.
 *     Fix: pikvm_usb_reconnect / pikvm_hid_recover.
 *   - HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (input reaches
 *     the target) yet the pointer can't be found on screen (faded / off-screen /
 *     dim frame). usb_reconnect does NOTHING for this; the fix is to wake the
 *     cursor (a mouse nudge) or raise brightness.
 *
 * Kept out of hid-recovery.ts on purpose: this classifies a state, it does not
 * drive the recovery ladder — and the separation keeps it conflict-free with the
 * (c) behavioral-verify branch that is rewriting hid-recovery.ts in parallel.
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
  | { kind: 'hid-down' }
  | { kind: 'up-no-cursor' }
  | { kind: 'unknown' };

/**
 * Pure classifier.
 * @param hidUp  ground-truth HID up/down: UDC.online when the endpoint is wired,
 *               else the kvmd flags (mouse OR keyboard online), else null when
 *               neither can be read (→ 'unknown', never a false verdict).
 * @param cursor result of localizing the pointer in a fresh frame, or null.
 */
export function classifyHid(input: { hidUp: boolean | null; cursor: CursorPoint | null }): HidDiagnosis {
  if (input.hidUp === false) return { kind: 'hid-down' };
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
      return (
        `HID DOWN — the USB gadget input path is dead (UDC not attached, or both kvmd HID flags offline). ` +
        `Fix: pikvm_usb_reconnect (add the reboot rung via pikvm_hid_recover if that doesn't take).`
      );
    case 'up-no-cursor':
      return (
        `⚠ HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (keyboard/UDC online, input reaches ` +
        `the target) but the pointer can't be found on screen (faded / off-screen / dim frame). ` +
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
  // HID up/down: UDC ground truth first, else the kvmd flags (advisory), else null.
  // Fall back to mouse OR keyboard online, NOT keyboard alone — a healthy box was
  // live-observed (2026-07-30) reporting keyboard=offline while the mouse clicked
  // 4/4, so keyboard-only would emit a FALSE "HID DOWN". Genuinely-dead HID showed
  // BOTH flags offline, so "either online ⇒ not down" separates the states safely.
  let hidUp: boolean | null = null;
  const udc = await udcReader().catch(() => null);
  if (udc != null) {
    hidUp = udc.online;
  } else {
    try {
      const hid = await client.getHidProfile();
      hidUp = hid.mouseOnline || hid.keyboardOnline;
    } catch {
      hidUp = null;
    }
  }

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

  return classifyHid({ hidUp, cursor });
}
