/**
 * α — Trajectory trace of Books-target click trials.
 *
 * During each trial's clickAtWithRetry, spawn a background polling
 * loop that captures a screenshot every ~500ms in parallel with the
 * click pipeline. Result: a video-rate sequence of the cursor's
 * journey from "post-Cmd+H" to "click fired".
 *
 *   PIKVM_ML_MODEL=ml/cursor-v1.onnx npx tsx bench-alpha-trace-books.ts
 *
 * Output:
 *   data/alpha-trace/trial-N/poll-NNNN.jpg   (high-rate trajectory)
 *   data/alpha-trace/trial-N/00-pre.jpg      (right after ipadGoHome)
 *   data/alpha-trace/trial-N/99-post.jpg     (after clickAtWithRetry)
 *   data/alpha-trace/trial-N/result.json     (success/residual/timings)
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const TRIALS = process.argv[2] ? Number(process.argv[2]) : 3;
const POLL_INTERVAL_MS = 500;
const TARGET = { x: 642, y: 808 };  // Books

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/alpha-trace';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

for (let t = 1; t <= TRIALS; t++) {
  const dir = path.join(ROOT, `trial-${t}`);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== Trial ${t}/${TRIALS} ===`);

  // Point the emit logger at this trial's folder. client.ts checks
  // PIKVM_EMIT_LOG on every emit, so swapping it per trial gives us
  // a clean per-trial log without filtering.
  process.env.PIKVM_EMIT_LOG = path.join(dir, 'emits.jsonl');

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 900));

  // Save the "post-Cmd+H, pre-click" baseline frame.
  const preShot = await client.screenshot();
  await fs.writeFile(path.join(dir, '00-pre.jpg'), preShot.buffer);

  // Background polling loop. Captures every POLL_INTERVAL_MS until
  // told to stop. Numbered sequentially for chronological inspection.
  let stopPolling = false;
  let pollIdx = 0;
  const pollTimes: number[] = [];
  const pollPromise = (async () => {
    const t0 = Date.now();
    while (!stopPolling) {
      try {
        const shot = await client.screenshot();
        const idx = pollIdx++;
        const elapsed = Date.now() - t0;
        pollTimes.push(elapsed);
        await fs.writeFile(
          path.join(dir, `poll-${String(idx).padStart(4, '0')}.jpg`),
          shot.buffer,
        );
      } catch (e) {
        console.error(`  poll error: ${(e as Error).message}`);
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();

  const t0 = Date.now();
  let success = false;
  let residual: number | null = null;
  let attempts = 0;
  let error: string | null = null;

  try {
    const r = await clickAtWithRetry(client, TARGET, {
      maxRetries: defaultMaxRetriesFor(false),
      moveToOptions: { profile: profile ?? undefined },
    });
    success = r.success;
    attempts = r.attempts ?? 0;
    const finalDetected = r.finalMoveResult?.finalDetectedPosition ?? null;
    if (finalDetected) {
      residual = Math.round(Math.hypot(
        finalDetected.x - TARGET.x,
        finalDetected.y - TARGET.y,
      ));
    }
  } catch (e: unknown) {
    error = (e as Error).message;
  }

  // Stop polling, wait for the loop to drain.
  stopPolling = true;
  await pollPromise;

  // Save final post-click frame.
  const postShot = await client.screenshot();
  await fs.writeFile(path.join(dir, '99-post.jpg'), postShot.buffer);

  const elapsedMs = Date.now() - t0;
  const result = {
    trial: t,
    target: TARGET,
    success,
    residual,
    attempts,
    elapsedMs,
    pollFrames: pollIdx,
    pollIntervalMs: POLL_INTERVAL_MS,
    error,
  };
  await fs.writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify(result, null, 2),
  );

  console.error(
    `  ${success ? 'HIT' : 'MISS'} attempts=${attempts} ` +
    `residual=${residual ?? '-'} elapsed=${elapsedMs}ms ` +
    `poll-frames=${pollIdx}` + (error ? ` err=${error}` : ''),
  );
}

console.error(`\nFrames + results saved under ${ROOT}/trial-N/`);
