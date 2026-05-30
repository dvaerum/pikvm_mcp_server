/**
 * Pinned-cursor click-timing bench v2 — hardened with environmental guards.
 *
 * Prior runs failed because:
 *   (a) iPad screen was dim → detection unreliable
 *   (b) cursor was faded → no real cursor on screen
 *   (c) v8 hallucinated a fixed status-bar feature as the cursor → looked like
 *       cursor wasn't moving when in fact there was no cursor at all
 *
 * This version adds three guards before each trial:
 *
 *   1. **Brightness gate** — analyzeBrightness; abort if dim.
 *   2. **Live cursor wake** — emit large wiggles and verify via v8 that the
 *      detected position ACTUALLY MOVES between consecutive screenshots.
 *      If v8's report is identical (false positive), keep wiggling.
 *   3. **Motion-verified positioning** — when iterating cursor toward target,
 *      each emit must produce a non-zero change in v8 position; if not, the
 *      v8 reading is rejected as a false-positive and we wake again.
 *
 * Output: data/click-timing-pinned-<timestamp>/
 *
 * Usage: npx tsx bench-click-timing-pinned.ts [trials_per_duration]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { unlockIpad, ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { analyzeBrightness, DIM_THRESHOLD, MIN_STDDEV_FOR_CONTRAST } from '../src/pikvm/brightness.js';

const TARGET = { name: 'Settings', x: 1027, y: 825 };
const DURATIONS_MS = [30, 80, 150, 300, 600, 1000];
const POSITION_TOLERANCE_PX = 12;
const MAX_POSITION_ATTEMPTS = 15;
const RATIO_PX_PER_MICKEY = 1.3;
const SETTLE_AFTER_EMIT_MS = 250;
const SETTLE_AFTER_CLICK_MS = 800;
const FRAME_W = 1680;
const FRAME_H = 1050;
const MOTION_VERIFY_PX = 5;  // post-emit, v8 must report a change ≥ this to be trusted
const MAX_WAKE_TRIES = 6;

interface TrialResult {
  trial_idx: number;
  click_duration_ms: number;
  brightness_ok: boolean;
  brightness_mean: number | null;
  brightness_stddev: number | null;
  cursor_woken: boolean;
  positioned: boolean;
  position_attempts: number;
  cursor_at_click: { x: number; y: number } | null;
  cursor_at_click_residual_px: number | null;
  screen_changed: boolean;
  changed_fraction: number | null;
  pre_frame: string;
  post_frame: string;
  error?: string;
  elapsed_ms: number;
}

const TRIALS_PER_DURATION = process.argv[2] ? Number(process.argv[2]) : 5;
if (!Number.isInteger(TRIALS_PER_DURATION) || TRIALS_PER_DURATION < 1) {
  console.error('usage: npx tsx bench-click-timing-pinned.ts [trials_per_duration]');
  process.exit(2);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/click-timing-pinned-${ts}`);
const TRIALS_DIR = path.join(OUT, 'trials');

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

async function diffJpegs(a: Buffer, b: Buffer): Promise<number> {
  const W = 480, H = 300, T = 20;
  const [{ data: ad }, { data: bd }] = await Promise.all([
    sharp(a).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let changed = 0;
  for (let i = 0; i < ad.length; i += 3) {
    if (Math.abs(ad[i] - bd[i]) > T || Math.abs(ad[i+1] - bd[i+1]) > T || Math.abs(ad[i+2] - bd[i+2]) > T) changed++;
  }
  return changed / (W * H);
}

async function detectCursor(): Promise<{ x: number; y: number; presence: number } | null> {
  const jpg = await takeRawScreenshot(client);
  const v8 = await findCursorByV8FullFrame(jpg, FRAME_W, FRAME_H, { minPresence: 0.5 });
  return v8 ? { x: v8.x, y: v8.y, presence: v8.presence } : null;
}

/** Wake the cursor by big-amplitude wiggles, and verify via v8 that the
 *  detected position actually changes between consecutive screenshots. If
 *  v8 keeps reporting the same pixel (false positive on a UI feature), keep
 *  trying. Returns true iff we verified live cursor motion. */
async function wakeAndVerifyCursor(): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_WAKE_TRIES; attempt++) {
    // Wiggle: large right-then-left.
    await client.mouseMoveRelative(80, 30);
    await new Promise((r) => setTimeout(r, 150));
    const pos1 = await detectCursor();
    await client.mouseMoveRelative(-80, -30);
    await new Promise((r) => setTimeout(r, 150));
    const pos2 = await detectCursor();
    if (pos1 && pos2) {
      const moved = Math.hypot(pos1.x - pos2.x, pos1.y - pos2.y);
      if (moved >= MOTION_VERIFY_PX) {
        return true;  // cursor responded to emits — real cursor
      }
    }
  }
  return false;
}

/** Drive cursor toward target. Each emit-detect cycle requires the cursor
 *  to actually move (>= MOTION_VERIFY_PX) or the detection is rejected and
 *  we wake again. */
async function pinCursorToTarget(): Promise<{ position: { x: number; y: number } | null; attempts: number }> {
  let lastPos: { x: number; y: number } | null = null;
  for (let i = 0; i < MAX_POSITION_ATTEMPTS; i++) {
    const cursor = await detectCursor();
    if (!cursor) {
      // No cursor — try to wake
      const woke = await wakeAndVerifyCursor();
      if (!woke) return { position: null, attempts: i };
      continue;
    }
    // Verify motion if we have a prior position and emitted since
    if (lastPos && Math.hypot(cursor.x - lastPos.x, cursor.y - lastPos.y) < MOTION_VERIFY_PX) {
      // v8 reading didn't move — likely false positive. Try to re-wake.
      const woke = await wakeAndVerifyCursor();
      if (!woke) return { position: null, attempts: i };
      lastPos = null;
      continue;
    }

    const dx = TARGET.x - cursor.x;
    const dy = TARGET.y - cursor.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= POSITION_TOLERANCE_PX) {
      return { position: cursor, attempts: i };
    }
    const mx = Math.max(-127, Math.min(127, Math.round(dx / RATIO_PX_PER_MICKEY)));
    const my = Math.max(-127, Math.min(127, Math.round(dy / RATIO_PX_PER_MICKEY)));
    await client.mouseMoveRelative(mx, my);
    await new Promise((r) => setTimeout(r, SETTLE_AFTER_EMIT_MS));
    lastPos = cursor;
  }
  return { position: null, attempts: MAX_POSITION_ATTEMPTS };
}

async function runTrial(idx: number, durationMs: number): Promise<TrialResult> {
  const preFile = `T-${String(idx).padStart(3, '0')}-pre.jpg`;
  const postFile = `T-${String(idx).padStart(3, '0')}-post.jpg`;
  const t0 = Date.now();
  const result: TrialResult = {
    trial_idx: idx,
    click_duration_ms: durationMs,
    brightness_ok: false,
    brightness_mean: null,
    brightness_stddev: null,
    cursor_woken: false,
    positioned: false,
    position_attempts: 0,
    cursor_at_click: null,
    cursor_at_click_residual_px: null,
    screen_changed: false,
    changed_fraction: null,
    pre_frame: preFile,
    post_frame: postFile,
    elapsed_ms: 0,
  };

  try { await unlockIpad(client, {}); } catch { /* ignored */ }

  try {
    // GUARD 1: brightness
    const probeJpg = await takeRawScreenshot(client);
    const bright = await analyzeBrightness(probeJpg, {});
    result.brightness_mean = bright.mean;
    result.brightness_stddev = bright.stddev;
    if (bright.mean < DIM_THRESHOLD || bright.stddev < MIN_STDDEV_FOR_CONTRAST) {
      result.error = `screen too dim (mean=${bright.mean.toFixed(1)} stddev=${bright.stddev.toFixed(1)})`;
      result.elapsed_ms = Date.now() - t0;
      return result;
    }
    result.brightness_ok = true;

    // GUARD 2: wake + verify cursor is real (moves on command)
    const woke = await wakeAndVerifyCursor();
    if (!woke) {
      result.error = 'cursor failed to wake (no v8 motion after wiggles)';
      result.elapsed_ms = Date.now() - t0;
      return result;
    }
    result.cursor_woken = true;

    // GUARD 3: motion-verified positioning
    const pin = await pinCursorToTarget();
    result.position_attempts = pin.attempts;
    if (!pin.position) {
      result.error = 'failed to position cursor (motion-verified) within tolerance';
      result.elapsed_ms = Date.now() - t0;
      return result;
    }
    result.positioned = true;
    result.cursor_at_click = pin.position;
    result.cursor_at_click_residual_px = Math.hypot(pin.position.x - TARGET.x, pin.position.y - TARGET.y);

    // Capture pre-click, click, capture post-click.
    const preBuf = await takeRawScreenshot(client);
    await fs.writeFile(path.join(TRIALS_DIR, preFile), preBuf);
    await client.mouseClick('left', { downMs: durationMs });
    await new Promise((r) => setTimeout(r, SETTLE_AFTER_CLICK_MS));
    const postBuf = await takeRawScreenshot(client);
    await fs.writeFile(path.join(TRIALS_DIR, postFile), postBuf);
    const frac = await diffJpegs(preBuf, postBuf);
    result.changed_fraction = frac;
    result.screen_changed = frac > 0.02;
  } catch (e) {
    result.error = `${e}`;
  }
  result.elapsed_ms = Date.now() - t0;

  try { await ipadGoHome(client, { settleMs: 600 }); } catch { /* ignored */ }
  await new Promise((r) => setTimeout(r, 300));
  return result;
}

async function main() {
  await fs.mkdir(TRIALS_DIR, { recursive: true });
  console.log(`Output: ${OUT}`);
  console.log(`Target: ${TARGET.name} @ (${TARGET.x}, ${TARGET.y})`);
  console.log(`Durations: ${DURATIONS_MS.join(', ')} ms`);
  console.log(`Trials per duration: ${TRIALS_PER_DURATION}`);
  console.log(`Position tolerance: ${POSITION_TOLERANCE_PX} px, motion verify: ${MOTION_VERIFY_PX} px`);
  console.log(`Brightness gate: mean ≥ ${DIM_THRESHOLD}, stddev ≥ ${MIN_STDDEV_FOR_CONTRAST}\n`);

  console.log('Setup: unlock + home...');
  await unlockIpad(client, {});
  await ipadGoHome(client, { settleMs: 800 });
  await new Promise((r) => setTimeout(r, 400));

  // Pre-flight brightness check.
  const probeJpg = await takeRawScreenshot(client);
  const bright = await analyzeBrightness(probeJpg, {});
  console.log(`Pre-flight brightness: mean=${bright.mean.toFixed(1)} stddev=${bright.stddev.toFixed(1)}`);
  if (bright.mean < DIM_THRESHOLD) {
    console.error(`\n❌ Screen too dim (${bright.mean.toFixed(1)} < ${DIM_THRESHOLD}). Set brightness higher and retry.`);
    console.error(`(Bench would fail every trial; aborting now to save time.)`);
    process.exit(3);
  }

  const sequence: Array<{ duration: number }> = [];
  for (let t = 0; t < TRIALS_PER_DURATION; t++) {
    for (const duration of DURATIONS_MS) {
      sequence.push({ duration });
    }
  }

  const results: TrialResult[] = [];
  for (let i = 0; i < sequence.length; i++) {
    const { duration } = sequence[i];
    console.log(`[${i + 1}/${sequence.length}] duration=${duration}ms...`);
    try {
      const r = await runTrial(i, duration);
      results.push(r);
      if (r.positioned) {
        console.log(
          `  → wake✓ pinned in ${r.position_attempts} attempts (residual=${r.cursor_at_click_residual_px!.toFixed(0)}px) ` +
          `clicked → changed=${r.screen_changed} (frac=${(r.changed_fraction! * 100).toFixed(1)}%) (${r.elapsed_ms}ms)`,
        );
      } else {
        const stage = !r.brightness_ok ? 'brightness'
          : !r.cursor_woken ? 'wake' : 'position';
        console.log(`  → FAILED at ${stage}: ${r.error} (${r.elapsed_ms}ms)`);
      }
    } catch (e) {
      console.error(`  → trial ${i} EXCEPTION: ${e}`);
    }

    await fs.writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({
        created_at: ts,
        target: TARGET,
        durations_ms: DURATIONS_MS,
        trials_per_duration: TRIALS_PER_DURATION,
        position_tolerance_px: POSITION_TOLERANCE_PX,
        motion_verify_px: MOTION_VERIFY_PX,
        results,
      }, null, 2),
    );
  }

  console.log('\n=== Summary per click duration (positioned trials only) ===');
  for (const d of DURATIONS_MS) {
    const all = results.filter((r) => r.click_duration_ms === d);
    const positioned = all.filter((r) => r.positioned);
    const changed = positioned.filter((r) => r.screen_changed);
    const pinPct = all.length ? (100 * positioned.length / all.length).toFixed(0) : '—';
    const chgPct = positioned.length ? (100 * changed.length / positioned.length).toFixed(0) : '—';
    console.log(
      `  ${d}ms: pinned ${positioned.length}/${all.length} (${pinPct}%), ` +
      `screen-changed ${changed.length}/${positioned.length} (${chgPct}% of pinned)`,
    );
  }
  // Failure breakdown
  const brightFail = results.filter(r => !r.brightness_ok).length;
  const wakeFail = results.filter(r => r.brightness_ok && !r.cursor_woken).length;
  const posFail = results.filter(r => r.cursor_woken && !r.positioned).length;
  console.log(`\nFailure modes: brightness=${brightFail}, wake=${wakeFail}, position=${posFail}`);
  console.log(`Manifest: ${OUT}/manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
