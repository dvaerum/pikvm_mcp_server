/**
 * M8 — per-call before/during/after frame capture for the mouse tools
 * (pikvm_mouse_click_at, pikvm_mouse_move, pikvm_mouse_move_to).
 *
 * This is the first-class, typed generalization of the env-gated
 * PIKVM_PREDOWN_DIR proof-shot: a caller can ask a single move/click to write
 * a baseline ("before"), a cursor-guaranteed-rendered frame at the operation's
 * business end ("during"), and a post-op frame ("after"), then get the saved
 * paths back in the tool result. Capture is ADVISORY — it never alters the
 * click/move outcome, only adds latency for the phases requested.
 *
 * The "during" grab MUST go through screenshotKeepingCursorAlive() (net-zero
 * ±1 nudge): a plain screenshot races the ~1-2 s iPad cursor fade and comes
 * back cursorless — the exact bug fixed in e3d9295. `cursorAliveGrab` is the
 * ONE shared helper the predown proof-shot and capture:["during"] both use.
 */
import { saveSnapshot, type SnapshotRegion } from './snapshot.js';

export type CapturePhase = 'before' | 'during' | 'after';

/** A validated capture request. `undefined` config = capture OFF. */
export interface CaptureConfig {
  /** Which phases to write. De-duplicated, order-preserving. Non-empty. */
  phases: CapturePhase[];
  /** Path prefix; each phase writes `${prefix}-${phase}.jpg` (parent dirs
   *  created by saveSnapshot). */
  prefix: string;
  /** Optional crop applied to every phase frame. Default = full frame. */
  region?: SnapshotRegion;
}

/** One written frame, returned to the caller so the triple comes back in the
 *  tool result, not just to disk. */
export interface CaptureSaved {
  phase: CapturePhase;
  path: string;
  bytes: number;
}

/** The minimal client surface capture drives — structural so tests can inject
 *  a lightweight stub. `screenshotKeepingCursorAlive` is optional: when a
 *  client doesn't expose it we degrade to a plain screenshot (matches the
 *  predown fallback). */
export interface CaptureClient {
  screenshot(): Promise<{ buffer: Buffer }>;
  screenshotKeepingCursorAlive?(): Promise<{ buffer: Buffer }>;
}

/**
 * The shared cursor-alive grab. Prefers screenshotKeepingCursorAlive (the
 * net-zero wake-nudge that keeps the iPad cursor rendered) and falls back to a
 * plain screenshot when the client can't. Used by BOTH the PIKVM_PREDOWN_DIR
 * proof-shot and capture:["during"] — do not duplicate this branch.
 */
export async function cursorAliveGrab(client: CaptureClient): Promise<Buffer> {
  const shot = client.screenshotKeepingCursorAlive
    ? await client.screenshotKeepingCursorAlive()
    : await client.screenshot();
  return shot.buffer;
}

/**
 * Capture one phase if it was requested. Grabs the frame ("during" via the
 * cursor-alive path, "before"/"after" via a plain screenshot), crops it to
 * `config.region`, and writes `${prefix}-${phase}.jpg`. Returns the saved
 * record, or null when the phase isn't in `config.phases` (so the caller pays
 * zero screenshots for phases it didn't ask for).
 *
 * `providedBuffer` lets a caller reuse a frame it already has in hand (e.g. the
 * post-click screenshot for the "after" phase) instead of paying a second grab.
 *
 * This throws on a screenshot/write failure — callers that must stay advisory
 * use `capturePhaseAdvisory`.
 */
export async function capturePhase(
  client: CaptureClient,
  config: CaptureConfig,
  phase: CapturePhase,
  providedBuffer?: Buffer,
): Promise<CaptureSaved | null> {
  if (!config.phases.includes(phase)) return null;
  const buffer =
    providedBuffer ??
    (phase === 'during'
      ? await cursorAliveGrab(client)
      : (await client.screenshot()).buffer);
  const saved = await saveSnapshot(buffer, `${config.prefix}-${phase}.jpg`, config.region);
  return { phase, path: saved.path, bytes: saved.bytes };
}

/**
 * Advisory wrapper around capturePhase: a capture failure returns null and is
 * swallowed so it can NEVER break the click/move it is documenting.
 */
export async function capturePhaseAdvisory(
  client: CaptureClient,
  config: CaptureConfig,
  phase: CapturePhase,
  providedBuffer?: Buffer,
): Promise<CaptureSaved | null> {
  try {
    return await capturePhase(client, config, phase, providedBuffer);
  } catch {
    // Advisory: capture must not alter the operation's outcome.
    return null;
  }
}

/** Format the saved phase records for the tool-result text. */
export function formatCaptureLines(saved: (CaptureSaved | null)[]): string {
  const done = saved.filter((s): s is CaptureSaved => s !== null);
  if (done.length === 0) return '';
  return (
    '\nCapture:' +
    done.map((s) => `\n  ${s.phase}: ${s.path} (${s.bytes} bytes)`).join('')
  );
}

function requireFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${field} must be a finite number`);
  }
  return n;
}

/**
 * Parse + validate the capture args shared by all three mouse tools. Returns a
 * CaptureConfig, or undefined when capture is off (arg absent or an empty
 * array = zero behavior change). Throws a clear MCP-surfaceable error when the
 * request is malformed — notably capturePrefix is REQUIRED once any phase is
 * requested.
 */
export function parseCaptureConfig(args: Record<string, unknown>): CaptureConfig | undefined {
  const raw = args.capture;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('capture must be an array of "before" | "during" | "after".');
  }
  const phases: CapturePhase[] = [];
  for (const p of raw) {
    if (p !== 'before' && p !== 'during' && p !== 'after') {
      throw new Error(
        `capture entries must each be "before" | "during" | "after" (got ${JSON.stringify(p)}).`,
      );
    }
    if (!phases.includes(p)) phases.push(p);
  }
  if (phases.length === 0) return undefined; // empty array = OFF

  const prefix = args.capturePrefix;
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error('capturePrefix is required when capture requests one or more phases.');
  }

  let region: SnapshotRegion | undefined;
  if (args.captureRegion !== undefined && args.captureRegion !== null) {
    const r = args.captureRegion as Record<string, unknown>;
    region = {
      x: requireFiniteNumber(r.x, 'captureRegion.x'),
      y: requireFiniteNumber(r.y, 'captureRegion.y'),
      width: requireFiniteNumber(r.width, 'captureRegion.width'),
      height: requireFiniteNumber(r.height, 'captureRegion.height'),
    };
  }

  return { phases, prefix, region };
}
