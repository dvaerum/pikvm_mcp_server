/**
 * Phase 308: instrument cursor-shape-detect's failures on production
 * post-emit frames.
 *
 * Phase 307 live bench showed 16/40 trials had detection residual
 * > 50 px (some up to 365 px). The detector picked SOMETHING but
 * not the cursor. To improve the detector, we need to see what it
 * picked in those failure cases.
 *
 * This bench drives cursor toward each of 4 target icons, takes a
 * pre-click screenshot, runs findCursorShapeCandidates(k=5) on it,
 * and saves an annotated PNG showing:
 *   - cyan circle = target
 *   - magenta circle = detector's top-1 pick
 *   - yellow circles = detector's top-2..5
 *
 * No click is fired (we just need detection data). 5 trials per
 * target × 2 reps = 40 frames per run.
 *
 * Then I look at the annotations and see what the detector picks
 * when it picks wrong.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase308-instrumented/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 308 instrumented detector at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGETS = [
  { name: 'Settings', x: 905, y: 800 },
  { name: 'Books',    x: 640, y: 800 },
  { name: 'TV',       x: 773, y: 800 },
  { name: 'AppStore', x: 905, y: 680 },
];

const N_PER = 3;
const N_REPS = 2;

interface Annotation {
  trial: string;
  target: { x: number; y: number };
  predicted: { x: number; y: number };
  detected: { x: number; y: number } | null;
  detectedResidualPx: number | null;
  top5: { x: number; y: number; pixels: number; shapeScore: number; distFromTarget: number }[];
}

const annotations: Annotation[] = [];

for (let rep = 1; rep <= N_REPS; rep++) {
  for (const target of TARGETS) {
    console.error(`\n--- Rep ${rep} ${target.name} (${target.x},${target.y}) ---`);
    for (let i = 1; i <= N_PER; i++) {
      try {
        await ipadGoHome(client, { forceHomeViaSwipe: true });
      } catch {
        await unlockIpad(client, { dragPx: 1500 });
        await sleep(800);
        await ipadGoHome(client, { forceHomeViaSwipe: true });
      }
      await sleep(1500);

      let r;
      try {
        r = await moveToPixel(client, { x: target.x, y: target.y }, {
          profile: profile ?? undefined,
          forbidSlamFallback: true,
          strategy: 'detect-then-move',
        });
      } catch (e) {
        console.error(`  ${target.name}.${i}: moveToPixel threw: ${(e as Error).message.slice(0, 80)}`);
        continue;
      }

      const shot = await client.screenshot();
      const tag = `r${rep}_${target.name}_${i.toString().padStart(2, '0')}`;
      await fs.writeFile(path.join(ROOT, `${tag}.jpg`), shot.buffer);

      const decoded = await decodeScreenshot(shot.buffer);
      const cands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 5);

      // Annotate with sharp + SVG overlay
      const marks: Array<{ x: number; y: number; color: string; label: string }> = [];
      marks.push({ x: target.x, y: target.y, color: '0,255,255', label: 'TGT' });
      if (r.finalDetectedPosition) {
        marks.push({ x: Math.round(r.finalDetectedPosition.x), y: Math.round(r.finalDetectedPosition.y), color: '0,255,0', label: 'PROD' });
      }
      for (let k = 0; k < cands.length; k++) {
        const c = cands[k];
        const color = k === 0 ? '255,0,255' : '255,255,0';
        marks.push({ x: Math.round(c.centroidX), y: Math.round(c.centroidY), color, label: `${k + 1}` });
      }

      const svg = marks
        .map((m) =>
          `<circle cx="${m.x}" cy="${m.y}" r="16" stroke="rgb(${m.color})" stroke-width="3" fill="none"/>` +
          `<text x="${m.x + 20}" y="${m.y + 5}" fill="rgb(${m.color})" font-size="20" font-family="monospace" font-weight="bold">${m.label}</text>`
        )
        .join('');
      const svgBuf = Buffer.from(`<svg width="${decoded.width}" height="${decoded.height}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
      await sharp(shot.buffer).composite([{ input: svgBuf, top: 0, left: 0 }]).png().toFile(path.join(ROOT, `${tag}-annotated.png`));

      const detected = r.finalDetectedPosition ?? null;
      const detectedResidualPx = r.finalResidualPx ?? null;
      const top5 = cands.map((c) => ({
        x: Math.round(c.centroidX),
        y: Math.round(c.centroidY),
        pixels: c.pixels,
        shapeScore: c.shapeScore,
        distFromTarget: Math.hypot(c.centroidX - target.x, c.centroidY - target.y),
      }));

      annotations.push({
        trial: tag,
        target: { x: target.x, y: target.y },
        predicted: r.predicted,
        detected,
        detectedResidualPx,
        top5,
      });

      const flagShort =
        detectedResidualPx === null
          ? 'NULL'
          : detectedResidualPx <= 50
            ? `OK(${detectedResidualPx.toFixed(0)}px)`
            : `WRONG(${detectedResidualPx.toFixed(0)}px)`;
      console.error(`  ${tag}: ${flagShort} top1=${top5[0] ? `(${top5[0].x},${top5[0].y})d=${top5[0].distFromTarget.toFixed(0)}` : 'none'}`);
    }
  }
}

await fs.writeFile(path.join(ROOT, 'annotations.json'), JSON.stringify({ version: VERSION, annotations }, null, 2));

console.error(`\n=== Summary ===`);
const wrongs = annotations.filter((a) => a.detectedResidualPx !== null && a.detectedResidualPx > 50);
const nulls = annotations.filter((a) => a.detectedResidualPx === null);
const ok = annotations.filter((a) => a.detectedResidualPx !== null && a.detectedResidualPx <= 50);
console.error(`OK (≤50 px): ${ok.length}/${annotations.length}`);
console.error(`WRONG (>50 px): ${wrongs.length}/${annotations.length}`);
console.error(`NULL: ${nulls.length}/${annotations.length}`);
console.error(`Inspect ${ROOT}/r*_*-annotated.png for WRONG cases.`);
process.exit(0);
