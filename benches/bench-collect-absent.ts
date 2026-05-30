/**
 * Collect 50 frames where Auto-Hide Pointer has had time to fade the
 * cursor away. Per-trial: emit one small wiggle, sleep STALE_SECONDS,
 * capture. The cursor should be invisible (or very faded) in most
 * frames.
 *
 * Live-streams to label-review by appending to verified-for-review.jsonl
 * after every frame. Pre-create the dataset directory + empty jsonl,
 * register with the server, then run.
 *
 * Usage: npx tsx bench-collect-absent.ts [n=50] [stale_seconds=15]
 * Output dir: BENCH_OUT_DIR env var (caller must pre-create).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad, launchIpadApp } from '../src/pikvm/ipad-unlock.js';

const N = Number(process.argv[2] ?? 50);
const STALE_SECONDS = Number(process.argv[3] ?? 15);
const SCENES = ['home', 'Settings', 'Books', 'Files', 'Notes', 'Maps', 'Calendar'];

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(a: number, b: number) { return Math.floor(Math.random() * (b - a + 1)) + a; }

async function main() {
  const ROOT = process.env.BENCH_OUT_DIR;
  if (!ROOT) { console.error('BENCH_OUT_DIR required'); process.exit(1); }
  await fs.mkdir(ROOT, { recursive: true });
  const reviewPath = path.join(ROOT, 'verified-for-review.jsonl');
  try { await fs.access(reviewPath); } catch { await fs.writeFile(reviewPath, ''); }
  const reviewFh = await fs.open(reviewPath, 'a');

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  console.error(`Output: ${ROOT}`);
  console.error(`N=${N} frames, stale wait=${STALE_SECONDS}s, scenes=${SCENES.length}`);
  console.error(`Estimated time: ${Math.ceil((N * (STALE_SECONDS + 5)) / 60)} min\n`);

  try { await unlockIpad(client); } catch (e) { console.error(`unlock: ${(e as Error).message}`); }
  await sleep(500);

  let idx = 0;
  const perScene = Math.ceil(N / SCENES.length);
  for (const scene of SCENES) {
    if (idx >= N) break;
    await ipadGoHome(client);
    await sleep(900);
    if (scene !== 'home') {
      try {
        await launchIpadApp(client, scene, { unlockFirst: false });
        await sleep(2500);
      } catch (e) {
        console.error(`scene ${scene}: launch failed (${(e as Error).message})`);
      }
    }
    const sceneSlug = scene.toLowerCase();
    const sceneDir = path.join(ROOT, sceneSlug);
    await fs.mkdir(sceneDir, { recursive: true });

    for (let i = 0; i < perScene && idx < N; i++) {
      // Small wiggle to ensure cursor was recently active, then wait long
      // enough for Auto-Hide Pointer to fade it.
      await client.mouseMoveRelative(randInt(-30, 30), randInt(-30, 30));
      console.error(`  [${idx + 1}/${N}] scene=${sceneSlug} waiting ${STALE_SECONDS}s for Auto-Hide…`);
      await sleep(STALE_SECONDS * 1000);

      const shot = await client.screenshot({ quality: 80 });
      const file = `frame-${String(idx).padStart(4, '0')}.jpg`;
      await fs.writeFile(path.join(sceneDir, file), shot.buffer);
      const entry = {
        abs_frame_path: path.resolve(sceneDir, file),
        cursor: null,
        algorithm_label: null,
        scene: `${sceneSlug}:absent-15s`,
        mode: 'absent-targeted',
        stale_seconds: STALE_SECONDS,
      };
      await reviewFh.write(JSON.stringify(entry) + '\n');
      await reviewFh.datasync();
      idx++;
    }
  }
  await reviewFh.close();
  console.error(`\nDone: ${idx} frames at ${ROOT}`);
  await ipadGoHome(client).catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
