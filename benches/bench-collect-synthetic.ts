/**
 * Synthetic training-frame collector.
 *
 * Drives the iPad app (over WS on port 8767) to render procedural
 * scenes; emits PiKVM HID moves to vary the cursor position; queries
 * the app for the actual cursor position; captures a PiKVM screenshot
 * and saves it with an auto-label.
 *
 * The iPad app is the ground truth for cursor position — we don't
 * care where moveToPixel *tried* to land, only where the cursor
 * actually ended up. This is what makes the labels free of human
 * labelling effort.
 *
 * Usage:
 *   npx tsx bench-collect-synthetic.ts --target 100
 *
 * Requires PiKVM env vars set (same as other bench-* scripts) and
 * the iPad app already connected to ws://<this-mac>:8767.
 *
 * Output: data/cursor-collect-synthetic-{TS}/ with per-scene-kind
 * subdirs and a verified.jsonl with one row per frame.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { startIpadAppServer, type IpadSession } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, buildTransform, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767;
const TARGET = (() => {
  const i = process.argv.indexOf('--target');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 100;
})();
const SETTLE_MS = 150;
const STEP_MICKEYS_MIN = 30;
const STEP_MICKEYS_MAX = 90;
const BIG_STEP_EVERY = 5;
const BIG_STEP_MICKEYS = 200;
const EDGE_MARGIN = 100;
const RANDOM_EFFECTS = true;

/** Pick a random EffectSpec: 50% no-blur else [3,15] px; brightness [-0.3,0.3]; colorMul per-channel [0.75,1.25]. */
function randomEffect(): Parameters<IpadSession['setEffect']>[0] {
  const blur = Math.random() < 0.5 ? 0 : 3 + Math.random() * 12;
  const brightness = -0.3 + Math.random() * 0.6;
  const colorMul: [number, number, number] = [
    0.75 + Math.random() * 0.5,
    0.75 + Math.random() * 0.5,
    0.75 + Math.random() * 0.5,
  ];
  return { blur, brightness, colorMul };
}

interface SceneRecipe {
  kind: 'procedural';
  proc_kind: string;
  params: Record<string, number>;
  label: string;
}

const SCENES: SceneRecipe[] = [
  { kind: 'procedural', proc_kind: 'solid',    params: { r: 0.1, g: 0.1, b: 0.1 },           label: 'proc:solid-dark' },
  { kind: 'procedural', proc_kind: 'solid',    params: { r: 0.9, g: 0.9, b: 0.9 },           label: 'proc:solid-light' },
  { kind: 'procedural', proc_kind: 'gradient', params: { r1: 0.2, g1: 0.4, b1: 0.7, r2: 0.9, g2: 0.6, b2: 0.3, angle: 0 }, label: 'proc:gradient' },
  { kind: 'procedural', proc_kind: 'checker',  params: { cell: 80 },                          label: 'proc:checker-80' },
  { kind: 'procedural', proc_kind: 'noise',    params: { cell: 6, seed: 1 },                  label: 'proc:noise-6' },
  { kind: 'procedural', proc_kind: 'noise',    params: { cell: 3, seed: 42 },                 label: 'proc:noise-3' },
];

function rndInt(lo: number, hi: number): number {
  return Math.floor(lo + Math.random() * (hi - lo));
}

async function waitForSession(): Promise<{ sess: IpadSession; closeServer: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = startIpadAppServer({
      port: PORT,
      async onSession(sess) {
        resolve({ sess, closeServer: () => server.close() });
      },
    });
    setTimeout(() => reject(new Error('timed out waiting for iPad app to connect')), 120_000);
  });
}

async function main() {
  console.log(`[collect] starting WS server on ws://0.0.0.0:${PORT}, target=${TARGET}`);
  console.log('[collect] waiting for iPad app to connect…');

  const { sess, closeServer } = await waitForSession();
  console.log(`[collect] connected: ${JSON.stringify(sess.hello)}`);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  if (!sess.hello) throw new Error('no hello payload');
  console.log('[collect] lighting screen for calibration…');
  await sess.showScene({ kind: 'procedural', params: { proc_kind: 'solid', r: 0.95, g: 0.95, b: 0.95 } });
  await new Promise((r) => setTimeout(r, 400));  // let iPad render + PiKVM streamer settle
  console.log('[collect] taking calibration screenshot…');
  const shot0 = await client.screenshot();
  const region = await detectIpadRegion(shot0.buffer);
  // detectIpadRegion inflates by NATIVE_MARGIN on each side for downstream
  // template-extraction safety. For mapping logical pointer coords to
  // screenshot pixels we need the *tight* content rect, or labels drift
  // up to NATIVE_MARGIN px off near the edges.
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
    frameW: region.frameW,
    frameH: region.frameH,
  };
  const xform = buildTransform(tight, sess.hello.logicalW, sess.hello.logicalH);
  console.log(`[collect] iPad region in screenshot (tight): x=${tight.x} y=${tight.y} w=${tight.w} h=${tight.h} (frame ${region.frameW}×${region.frameH})`);
  const isFallback = region.x === 0 && region.y === 0 && region.w === region.frameW && region.h === region.frameH;
  if (isFallback) {
    console.error('[collect] WARNING: region detection fell back to full frame — labels will be in screenshot coords not iPad coords');
  }
  console.log(`[collect] logical → screenshot scale: x=${(region.w / sess.hello.logicalW).toFixed(3)} y=${(region.h / sess.hello.logicalH).toFixed(3)}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, -5);
  const outDir = path.join('data', `cursor-collect-synthetic-${ts}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, 'procedural'), { recursive: true });
  const jsonlPath = path.join(outDir, 'verified.jsonl');
  const manifestPath = path.join(outDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    ts,
    target: TARGET,
    ipad: sess.hello,
    region,
    scenes: SCENES.map((s) => s.label),
  }, null, 2));
  console.log(`[collect] output dir: ${outDir}`);

  let saved = 0;
  let skipped = 0;
  const t0 = Date.now();
  const logicalW = sess.hello.logicalW;
  const logicalH = sess.hello.logicalH;
  let lastCur: { x: number; y: number } | null = null;

  for (let i = 0; i < TARGET; i++) {
    const recipe = SCENES[i % SCENES.length];
    try {
      await sess.showScene({ kind: recipe.kind, params: { proc_kind: recipe.proc_kind, ...recipe.params } });
    } catch (e) {
      console.error(`[collect] frame ${i + 1}: showScene failed: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    // Pick + apply a randomized post-render effect per frame (blur / brightness / colorMul).
    const effect = RANDOM_EFFECTS ? randomEffect() : null;
    if (effect) {
      try {
        await sess.setEffect(effect);
      } catch (e) {
        console.error(`[collect] frame ${i + 1}: setEffect failed: ${(e as Error).message}`);
      }
    }

    const big = i > 0 && i % BIG_STEP_EVERY === 0;
    const mag = big ? BIG_STEP_MICKEYS : rndInt(STEP_MICKEYS_MIN, STEP_MICKEYS_MAX);
    // emit toward center when within EDGE_MARGIN px of any edge — keeps cursor distribution off the saturating edges
    const nearEdge = lastCur !== null && (
      lastCur.x < EDGE_MARGIN || lastCur.x > logicalW - EDGE_MARGIN ||
      lastCur.y < EDGE_MARGIN || lastCur.y > logicalH - EDGE_MARGIN
    );
    let angle: number;
    if (nearEdge && lastCur) {
      const cxv = logicalW / 2 - lastCur.x;
      const cyv = logicalH / 2 - lastCur.y;
      const base = Math.atan2(cyv, cxv);
      angle = base + (Math.random() - 0.5) * (2 * Math.PI / 3);  // ±60°
    } else {
      angle = Math.random() * 2 * Math.PI;
    }
    const dx = Math.round(Math.cos(angle) * mag);
    const dy = Math.round(Math.sin(angle) * mag);
    await client.mouseMoveRelative(dx, dy);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    let cur;
    try {
      cur = await sess.getCursor();
    } catch (e) {
      console.error(`[collect] frame ${i + 1}: getCursor failed: ${(e as Error).message}`);
      skipped++;
      continue;
    }
    lastCur = { x: cur.x, y: cur.y };

    const inside = cur.x >= 0 && cur.x < sess.hello.logicalW && cur.y >= 0 && cur.y < sess.hello.logicalH;
    if (!inside) {
      console.error(`[collect] frame ${i + 1}: cursor out of iPad bounds (${cur.x.toFixed(1)}, ${cur.y.toFixed(1)}) — skipping`);
      skipped++;
      continue;
    }

    const px = xform.toScreenshotPx(cur.x, cur.y);
    const shot = await client.screenshot();
    const seq = String(saved + 1).padStart(5, '0');
    const relPath = `procedural/frame-${seq}.jpg`;
    await fs.writeFile(path.join(outDir, relPath), shot.buffer);
    const row = {
      frame: relPath,
      cursor: { visible: true, x: Math.round(px.x), y: Math.round(px.y) },
      decision: 'synthetic',
      scene: recipe.label,
      logical: { x: Math.round(cur.x * 10) / 10, y: Math.round(cur.y * 10) / 10 },
      decided_at: new Date().toISOString(),
      ...(effect ? { effect: { blur: effect.blur, brightness: effect.brightness, colorMul: effect.colorMul } } : {}),
    };
    await fs.appendFile(jsonlPath, JSON.stringify(row) + '\n');
    saved++;

    if (saved % 10 === 0 || saved === TARGET) {
      const dt = (Date.now() - t0) / 1000;
      const rate = saved / dt;
      const eta = (TARGET - saved) / rate;
      console.log(`[collect] ${saved}/${TARGET}  (${rate.toFixed(2)}/s, ETA ${eta.toFixed(0)}s, skipped=${skipped})  last=(${row.cursor.x},${row.cursor.y}) scene=${recipe.label}`);
    }
  }

  console.log(`[collect] done. saved=${saved} skipped=${skipped} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[collect] verified.jsonl: ${jsonlPath}`);

  await closeServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
