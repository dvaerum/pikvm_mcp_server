/**
 * Collect 200 frames with the cursor in diverse presence states — visible
 * just after wake, idle (potentially faded if Auto-Hide Pointer is ON),
 * mid-move, at screen edges. The current 700-frame training set lacks
 * absent / edge / faded examples; that's what made v10 brittle.
 *
 * Per-trial append to a pre-registered label-review dataset so the rater
 * sees frames pop into the UI as the bench runs.
 *
 * Usage:
 *   npx tsx bench-collect-presence-diverse.ts [n=200] [scenes_csv]
 *
 * Output: data/cursor-collect-presence-{TS}/
 *   {scene}/frame-NNN.jpg
 *   verified-for-review.jsonl  (one append per frame)
 *   summary.json
 *
 * The script intentionally varies WHEN the screenshot is taken relative
 * to the last emit / wake:
 *   - mode "fresh": emit a small wiggle, capture immediately
 *   - mode "settled": emit, sleep 200 ms, capture
 *   - mode "stale": NO emit, capture (cursor may have faded by now)
 *   - mode "moving": emit a big move, capture mid-flight (~30 ms after)
 *   - mode "edge": slam cursor to a corner, capture (may be clipped)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad, launchIpadApp } from './src/pikvm/ipad-unlock.js';

const N_FRAMES = Number(process.argv[2] ?? 200);
const SCENES = (process.argv[3] ?? 'home,Settings,Books,Files,Notes,Maps,Calendar').split(',');

const MODES = ['fresh', 'settled', 'stale', 'moving', 'edge'] as const;
type Mode = typeof MODES[number];

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function run() {
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Accept BENCH_OUT_DIR override so the caller can pre-create the
  // directory + empty jsonl, register the dataset with label-review,
  // THEN start this bench. Otherwise generate a fresh timestamp.
  const ROOT = process.env.BENCH_OUT_DIR ?? (() => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `./data/cursor-collect-presence-${ts}`;
  })();
  await fs.mkdir(ROOT, { recursive: true });
  const reviewPath = path.join(ROOT, 'verified-for-review.jsonl');
  // Don't truncate if the caller pre-created the file.
  try { await fs.access(reviewPath); } catch { await fs.writeFile(reviewPath, ''); }
  const reviewFh = await fs.open(reviewPath, 'a');

  console.error(`Output: ${ROOT}`);
  console.error(`Target: ${N_FRAMES} frames across ${SCENES.length} scenes × ${MODES.length} capture modes`);
  console.error(`Append-per-frame: ${reviewPath}\n`);

  try { await unlockIpad(client); } catch (e) { console.error(`(unlock warning: ${(e as Error).message})`); }
  await sleep(500);

  let frameIdx = 0;
  const counts: Record<Mode, number> = { fresh: 0, settled: 0, stale: 0, moving: 0, edge: 0 };

  for (let s = 0; s < SCENES.length && frameIdx < N_FRAMES; s++) {
    const scene = SCENES[s];
    await ipadGoHome(client);
    await sleep(900);

    if (scene !== 'home') {
      try {
        await launchIpadApp(client, scene, { unlockFirst: false });
        await sleep(2500);
      } catch (e) {
        console.error(`  scene ${scene}: launch failed (${(e as Error).message}) — using home`);
      }
    }
    const sceneSlug = scene.toLowerCase();
    const sceneDir = path.join(ROOT, sceneSlug);
    await fs.mkdir(sceneDir, { recursive: true });

    // ~28 frames per scene if N_FRAMES=200 / 7 scenes; distribute across modes.
    const perScene = Math.ceil(N_FRAMES / SCENES.length);
    for (let i = 0; i < perScene && frameIdx < N_FRAMES; i++) {
      const mode: Mode = MODES[i % MODES.length];

      if (mode === 'fresh') {
        // Wake then immediate capture.
        await client.mouseMoveRelative(randInt(-30, 30), randInt(-30, 30));
      } else if (mode === 'settled') {
        await client.mouseMoveRelative(randInt(-30, 30), randInt(-30, 30));
        await sleep(200);
      } else if (mode === 'stale') {
        // No emit before capture. Cursor may have faded if Auto-Hide is ON.
        await sleep(randInt(500, 2500));
      } else if (mode === 'moving') {
        // Big move then capture quickly (mid-flight render).
        const angle = Math.random() * Math.PI * 2;
        await client.mouseMoveRelative(Math.round(Math.cos(angle) * 100), Math.round(Math.sin(angle) * 100));
        await sleep(30);
      } else if (mode === 'edge') {
        // Slam to a random corner / edge.
        const corner = randInt(0, 3);
        const big = 127;  // API max per emit
        if (corner === 0) for (let k = 0; k < 10; k++) await client.mouseMoveRelative(-big, -big);
        if (corner === 1) for (let k = 0; k < 10; k++) await client.mouseMoveRelative(big, -big);
        if (corner === 2) for (let k = 0; k < 10; k++) await client.mouseMoveRelative(-big, big);
        if (corner === 3) for (let k = 0; k < 10; k++) await client.mouseMoveRelative(big, big);
      }

      const shot = await client.screenshot({ quality: 80 });
      const file = `frame-${String(frameIdx).padStart(4, '0')}.jpg`;
      await fs.writeFile(path.join(sceneDir, file), shot.buffer);

      const entry = {
        abs_frame_path: path.resolve(sceneDir, file),
        cursor: null,            // user will label
        algorithm_label: null,   // no algo here — pure collection
        scene: `${sceneSlug}:${mode}`,
        mode,
      };
      await reviewFh.write(JSON.stringify(entry) + '\n');
      await reviewFh.datasync();

      counts[mode]++;
      frameIdx++;
      if (frameIdx % 5 === 0) {
        console.error(`  [${frameIdx}/${N_FRAMES}] scene=${sceneSlug} mode=${mode}`);
      }
    }
  }

  await reviewFh.close();
  await fs.writeFile(path.join(ROOT, 'summary.json'), JSON.stringify({
    total: frameIdx,
    scenes: SCENES,
    modes: counts,
    out_dir: ROOT,
    finished_at: new Date().toISOString(),
  }, null, 2));

  console.error(`\nDone: ${frameIdx} frames`);
  console.error(`Mode distribution: ${JSON.stringify(counts)}`);
  console.error(`Label review path: ${reviewPath}`);

  await ipadGoHome(client).catch(() => undefined);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
