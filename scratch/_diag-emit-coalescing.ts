/**
 * Diagnose why moveToPixel observes "residual 313.5 → 313.5 → 313.5"
 * patterns — i.e. the cursor not moving across 3-4 emit attempts.
 *
 * Three classes of experiment, each with v11 measuring cursor position
 * before and after every emit:
 *
 *  A) SINGLE EMIT MAGNITUDE: emit N mickeys ONCE at various N; observe
 *     px/mickey ratio. If small-N emits don't move at all, there's a
 *     minimum-magnitude threshold (e.g., motion-velocity gate).
 *
 *  B) RAPID SEQUENCE WITH NO DELAY: emit 10 small moves back-to-back
 *     with no inter-emit sleep. Compare total displacement to expected.
 *     If displacement << 10 × per-emit, iPad is coalescing.
 *
 *  C) RAPID SEQUENCE AT VARIOUS DELAYS: same as B but with 16ms / 50ms /
 *     100ms inter-emit sleeps. Find the threshold above which emits stop
 *     coalescing. That's the minimum safe rate for moveToPixel.
 *
 * Single-source-of-truth: use cursor-v11.onnx for the position readout.
 */
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const INPUT_W = 768, INPUT_H = 480;
const HEATMAP_W = 192, HEATMAP_H = 120;
const FRAME_W = 1920, FRAME_H = 1080;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const v11 = await ort.InferenceSession.create('ml/cursor-v11.onnx');

async function detectCursor(jpeg: Buffer): Promise<{ x: number; y: number; presence: number } | null> {
  const { data: rgb } = await sharp(jpeg)
    .resize(INPUT_W, INPUT_H, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * INPUT_W * INPUT_H);
  const plane = INPUT_W * INPUT_H;
  for (let y = 0; y < INPUT_H; y++) for (let x = 0; x < INPUT_W; x++) {
    const s = (y * INPUT_W + x) * 3;
    const d = y * INPUT_W + x;
    inp[0 * plane + d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
    inp[1 * plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
    inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
  }
  const t = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await v11.run({ frame: t });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0, bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  const presence = 1 / (1 + Math.exp(-presLogit));
  if (presence < 0.5) return null;
  return {
    x: ((bestIdx % HEATMAP_W) / HEATMAP_W) * FRAME_W,
    y: (Math.floor(bestIdx / HEATMAP_W) / HEATMAP_H) * FRAME_H,
    presence,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readPos(client: PiKVMClient): Promise<{ x: number; y: number } | null> {
  const shot = await client.screenshot();
  const r = await detectCursor(shot.buffer);
  return r ? { x: r.x, y: r.y } : null;
}

async function settle(client: PiKVMClient, ms = 350) {
  await sleep(ms);  // let any pointer-effect animation finish
}

async function main() {
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  console.error('unlocking + going home');
  try { await unlockIpad(client); } catch (e) { console.error(`unlock: ${(e as Error).message}`); }
  await ipadGoHome(client);
  await sleep(800);
  // Park cursor in the middle of the iPad screen so emits in any
  // direction have room.
  for (let i = 0; i < 8; i++) await client.mouseMoveRelative(-127, -127);  // top-left corner
  await sleep(200);
  for (let i = 0; i < 4; i++) await client.mouseMoveRelative(60, 60);  // back to center-ish
  await sleep(400);

  let initialPos = await readPos(client);
  console.error(`baseline pos: ${initialPos ? `(${initialPos.x.toFixed(0)},${initialPos.y.toFixed(0)})` : 'NOT DETECTED'}`);
  console.error();

  // --- Experiment A: single emit magnitude ---
  console.error('=== A: single-emit magnitude (px/mickey) ===');
  for (const mag of [5, 10, 20, 30, 50, 80, 100]) {
    await client.mouseMoveRelative(-mag, 0); await settle(client);  // step left first
    const before = await readPos(client);
    if (!before) { console.error(`  mag=${mag}: no baseline (cursor faded?)`); continue; }
    await client.mouseMoveRelative(mag, 0);
    await settle(client);
    const after = await readPos(client);
    if (!after) { console.error(`  mag=${mag}: post-emit cursor lost`); continue; }
    const dx = after.x - before.x;
    console.error(`  mag=${mag}: dx=${dx.toFixed(0)}px  ratio=${(dx / mag).toFixed(2)}px/mickey`);
  }
  console.error();

  // --- Experiment B: rapid sequence with NO delay ---
  console.error('=== B: rapid sequence — N emits, NO delay ===');
  for (const N of [1, 2, 3, 5, 10]) {
    // Park left so we have room to move right.
    for (let i = 0; i < 4; i++) await client.mouseMoveRelative(-50, 0);
    await settle(client);
    const before = await readPos(client);
    if (!before) { console.error(`  N=${N}: no baseline`); continue; }
    for (let i = 0; i < N; i++) await client.mouseMoveRelative(30, 0);
    await settle(client);
    const after = await readPos(client);
    if (!after) { console.error(`  N=${N}: post-burst cursor lost`); continue; }
    const dx = after.x - before.x;
    const expected = N * 30 * 1.4;  // mickeys * nominal ratio
    console.error(`  N=${N} × 30 mickey: dx=${dx.toFixed(0)}px  (expected ~${expected.toFixed(0)})  coalesce_loss=${(100 * (1 - dx / expected)).toFixed(0)}%`);
  }
  console.error();

  // --- Experiment C: rapid sequence at various delays ---
  console.error('=== C: 10 × 30-mickey emits, varying inter-emit delay ===');
  for (const delay of [0, 8, 16, 32, 64, 100, 150]) {
    for (let i = 0; i < 4; i++) await client.mouseMoveRelative(-50, 0);
    await settle(client);
    const before = await readPos(client);
    if (!before) { console.error(`  delay=${delay}ms: no baseline`); continue; }
    for (let i = 0; i < 10; i++) {
      await client.mouseMoveRelative(30, 0);
      if (delay > 0) await sleep(delay);
    }
    await settle(client);
    const after = await readPos(client);
    if (!after) { console.error(`  delay=${delay}ms: cursor lost`); continue; }
    const dx = after.x - before.x;
    const expected = 10 * 30 * 1.4;
    console.error(`  delay=${delay}ms: dx=${dx.toFixed(0)}px  (expected ~${expected.toFixed(0)})  coalesce_loss=${(100 * (1 - dx / expected)).toFixed(0)}%`);
  }
  console.error();

  await ipadGoHome(client).catch(() => undefined);
  console.error('done');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
