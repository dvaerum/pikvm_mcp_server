/**
 * Diverse cursor data collection.
 *
 * For each scene (home + several apps), walk the cursor through ~20
 * positions and save each frame with metadata. The captured frames
 * become candidate training data once human-labeled in the label-
 * review tool (or once we train a presence-only model that doesn't
 * need positions).
 *
 * Each batch run lives in its own timestamped directory so multiple
 * /loop iterations don't clobber each other.
 *
 *   npx tsx bench-collect-diverse.ts [frames_per_scene]
 *
 * Default: 20 frames per scene × 6 scenes = 120 per batch.
 */
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  ipadGoHome,
  unlockIpad,
  launchIpadApp,
} from '../src/pikvm/ipad-unlock.js';

const FRAMES_PER_SCENE = process.argv[2] ? Number(process.argv[2]) : 20;
const FRAME_W = 1680;
const FRAME_H = 1050;

// Apps reachable via Spotlight on this iPad.
const APPS = ['Settings', 'Books', 'Notes', 'Files', 'Maps', 'Calendar'];

const INPUT_W = 768;
const INPUT_H = 480;
const HEATMAP_W = 192;
const HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ROOT = `./data/cursor-collect-${ts}`;
await fs.mkdir(ROOT, { recursive: true });

// Load v6 (best available) for algo-prediction overlay.
let v6Session: ort.InferenceSession | null = null;
try {
  v6Session = await ort.InferenceSession.create('ml/cursor-v6.onnx');
  console.error('loaded v6 for algo-prediction overlay');
} catch (e) {
  console.error(`(v6 load failed: ${(e as Error).message}) — frames will save without algo predictions`);
}

async function v6Predict(jpeg: Buffer): Promise<{ x: number; y: number; presence: number } | null> {
  if (!v6Session) return null;
  const { data: rgb } = await sharp(jpeg)
    .resize(INPUT_W, INPUT_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * INPUT_W * INPUT_H);
  const plane = INPUT_W * INPUT_H;
  for (let y = 0; y < INPUT_H; y++) {
    for (let x = 0; x < INPUT_W; x++) {
      const s = (y * INPUT_W + x) * 3;
      const d = y * INPUT_W + x;
      inp[0 * plane + d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
      inp[1 * plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
      inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  const tensor = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await v6Session.run({ frame: tensor });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  }
  return {
    x: ((bestIdx % HEATMAP_W) / HEATMAP_W) * FRAME_W,
    y: (Math.floor(bestIdx / HEATMAP_W) / HEATMAP_H) * FRAME_H,
    presence: 1 / (1 + Math.exp(-presLogit)),
  };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Pick a relative displacement that actively explores the screen
// instead of doing a zero-mean random walk (which just clusters the
// cursor around its starting position).
//
// Strategy: every other frame, slam toward a random corner / edge
// (large directional move). In between, do small jitter so the cursor
// settles in varied spots rather than always at a corner. Every ~7
// frames, do a "long jump" — a single ±127 emit in a random direction
// — to traverse the screen.
function explorationStep(idx: number) {
  if (idx % 7 === 0) {
    // Long jump — single emit at the API max in a random direction.
    const angle = Math.random() * Math.PI * 2;
    return {
      dx: Math.round(Math.cos(angle) * 127),
      dy: Math.round(Math.sin(angle) * 127),
    };
  }
  if (idx % 2 === 0) {
    // Aim toward a random target on the screen by emitting a large
    // displacement in that direction. With the cursor's current
    // position unknown, just pick a big random vector — over enough
    // frames this covers the full screen.
    const m = 80 + Math.floor(Math.random() * 47);  // 80-127
    const angle = Math.random() * Math.PI * 2;
    return {
      dx: Math.round(Math.cos(angle) * m),
      dy: Math.round(Math.sin(angle) * m),
    };
  }
  // Small jitter to vary final landing spot from the previous big move.
  const m = 25;
  return {
    dx: Math.round((Math.random() - 0.5) * 2 * m),
    dy: Math.round((Math.random() - 0.5) * 2 * m),
  };
}

interface Manifest {
  scene: string;
  scene_dir: string;
  frames: Array<{
    file: string;
    decided_at: string;
    emit_history: Array<{ dx: number; dy: number }>;
    algorithm_label?: { x: number; y: number; presence: number };
  }>;
}

async function collectScene(scene: string, isApp: boolean): Promise<Manifest> {
  console.error(`\n=== scene: ${scene} ===`);
  await ipadGoHome(client);
  await sleep(900);

  if (isApp) {
    try {
      await launchIpadApp(client, scene, { unlockFirst: false });
      console.error(`  launched ${scene} via Spotlight`);
      await sleep(2500);  // let app load
    } catch (e) {
      console.error(`  ${scene}: launchIpadApp failed: ${(e as Error).message}`);
      // Try again from home next iteration; for now, just take frames of home.
    }
  }

  const sceneDir = path.join(ROOT, scene.toLowerCase());
  await fs.mkdir(sceneDir, { recursive: true });
  const emit_history: Array<{ dx: number; dy: number }> = [];
  const frames: Manifest['frames'] = [];

  for (let i = 0; i < FRAMES_PER_SCENE; i++) {
    // Brief wake (small in-out) so the cursor renders.
    await client.mouseMoveRelative(15, 0);
    await sleep(30);
    await client.mouseMoveRelative(-15, 0);
    emit_history.push({ dx: 15, dy: 0 });
    emit_history.push({ dx: -15, dy: 0 });
    await sleep(120);
    // Take a frame with the cursor freshly woken.
    const shot = await client.screenshot();
    const file = `frame-${String(i).padStart(3, '0')}.jpg`;
    await fs.writeFile(path.join(sceneDir, file), shot.buffer);
    const algo = (await v6Predict(shot.buffer)) ?? undefined;
    frames.push({
      file,
      decided_at: new Date().toISOString(),
      emit_history: [...emit_history],
      algorithm_label: algo,
    });
    console.error(
      `  ${file}: algo=(${algo ? algo.x.toFixed(0) : '?'},${algo ? algo.y.toFixed(0) : '?'}) ` +
      `pres=${algo ? algo.presence.toFixed(2) : '?'}`,
    );
    // Move the cursor for next iteration so frames are diverse.
    const step = explorationStep(i);
    await client.mouseMoveRelative(step.dx, step.dy);
    emit_history.push(step);
    await sleep(100);
  }
  return { scene, scene_dir: sceneDir, frames };
}

async function main() {
  console.error('unlocking iPad…');
  try {
    await unlockIpad(client);
    await sleep(1000);
  } catch (e) {
    console.error(`unlock warning: ${(e as Error).message}`);
  }

  const manifests: Manifest[] = [];

  // Home scene first.
  manifests.push(await collectScene('home', false));
  // Then each app.
  for (const app of APPS) {
    try {
      manifests.push(await collectScene(app, true));
    } catch (e) {
      console.error(`scene ${app} aborted: ${(e as Error).message}`);
    }
  }

  // Aggregate manifest.
  const summary = {
    batch_dir: ROOT,
    started_at: ts,
    finished_at: new Date().toISOString(),
    total_frames: manifests.reduce((s, m) => s + m.frames.length, 0),
    scenes: manifests.map((m) => ({
      scene: m.scene,
      n: m.frames.length,
      dir: path.relative(ROOT, m.scene_dir),
    })),
  };
  await fs.writeFile(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));

  // Per-scene jsonl manifest.
  for (const m of manifests) {
    const lines = m.frames.map((f) => JSON.stringify({ scene: m.scene, ...f }));
    await fs.writeFile(path.join(m.scene_dir, 'manifest.jsonl'), lines.join('\n') + '\n');
  }

  console.error(`\nbatch complete: ${summary.total_frames} frames across ${manifests.length} scenes`);
  console.error(`  ${ROOT}`);

  // Return cursor to home so next session/batch starts in a known state.
  await ipadGoHome(client).catch(() => undefined);
}

main();
