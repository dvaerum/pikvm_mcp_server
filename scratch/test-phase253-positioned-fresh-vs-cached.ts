/**
 * Phase 253: Phase 252 retry with cursor pre-positioned far from clock widget.
 *
 * Phase 252 confirmed: seedCursorTemplate(client) on the home screen
 * fails because the clock widget's second-hand animation produces a
 * larger merged motion-diff cluster than the cursor's tiny wake-emit.
 *
 * Fix: explicitly slam to a corner FAR from clock widget, then chunked-
 * deposit cursor at mid-bottom (~840, 600). The wake-emit's diff there
 * is well-separated from the clock widget's motion at (~605-695, 95-185).
 *
 * Then run the same comparison: cached templates max top-1 vs the
 * freshly-seeded template's top-1 on a frame captured AFTER the seed.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { decodeScreenshot, findCursorByTemplateDecoded } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from '../src/pikvm/seed-template.js';
import { slamToCorner } from '../src/pikvm/ballistics.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase253-positioned';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 253 positioned-seed at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);

// --- Pre-position: slam top-left, then chunked emit to land near (840, 600) ---
console.error('Step 0: slam top-left + chunked deposit to (~840, 600)');
await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
// After slam to top-left, cursor is near (0, 0) in HDMI space.
// Emit ~840 right, ~600 down in 100-mickey chunks.
const targetX = 840;
const targetY = 600;
const remX = targetX, remY = targetY;
let emittedX = 0, emittedY = 0;
while (emittedX < remX || emittedY < remY) {
  const dx = Math.min(100, remX - emittedX);
  const dy = Math.min(100, remY - emittedY);
  if (dx === 0 && dy === 0) break;
  await client.mouseMoveRelative(dx, dy);
  emittedX += dx;
  emittedY += dy;
  await sleep(40);
}
await sleep(800);

// --- Step 1: capture F0 and score cached templates ---
const cachedBefore = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`\nStep 1: cached set size = ${cachedBefore.length}`);

const f0 = await client.screenshot();
const decF0 = await decodeScreenshot(f0.buffer);
await fs.writeFile(`${ROOT}/F0.jpg`, f0.buffer);

let f0MaxTop1 = 0;
for (const t of cachedBefore) {
  const r = findCursorByTemplateDecoded(decF0, t, { minScore: 0 });
  if (r && r.score > f0MaxTop1) f0MaxTop1 = r.score;
}
console.error(`Step 1: F0 cached max top-1 = ${f0MaxTop1.toFixed(3)} (threshold 0.83)`);

// --- Step 2: force fresh seedCursorTemplate ---
console.error(`\nStep 2: forcing seedCursorTemplate (cursor pre-positioned at ~(${targetX},${targetY}))...`);
const seed = await seedCursorTemplate(client);
console.error(
  `Step 2: seed result: ok=${seed.ok} ` +
  `cursorPos=${seed.cursorPosition ? `(${seed.cursorPosition.x},${seed.cursorPosition.y})` : 'null'} ` +
  `persisted=${seed.templatePersisted} decision=${seed.decision} reason="${seed.reason}"`,
);

if (!seed.templatePersisted) {
  console.error('\nFAIL: seed did not persist. Cannot compare. Inspect F0.jpg + try larger emit.');
  process.exit(1);
}

// --- Step 3: capture F1 and score the (now larger) set ---
await sleep(600);
const cachedAfter = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`\nStep 3: post-seed set size = ${cachedAfter.length}`);

const f1 = await client.screenshot();
const decF1 = await decodeScreenshot(f1.buffer);
await fs.writeFile(`${ROOT}/F1.jpg`, f1.buffer);

const fsP = await import('fs/promises');
const path = await import('path');
const files = (await fsP.readdir(DEFAULT_TEMPLATE_DIR))
  .filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg'))
  .sort();
const stats = await Promise.all(
  files.map(async f => ({ f, mtime: (await fsP.stat(path.join(DEFAULT_TEMPLATE_DIR, f))).mtimeMs })),
);
stats.sort((a, b) => b.mtime - a.mtime);
const newestFile = stats[0]?.f;
console.error(`Step 3: newest template file = ${newestFile} (mtime ${new Date(stats[0]?.mtime ?? 0).toISOString()})`);

let cachedMaxTop1OnF1 = 0;
let freshTop1OnF1 = 0;
let freshTopK: { score: number; x: number; y: number }[] = [];

const orig = console.error.bind(console);
let captured: string[] = [];
console.error = (...args: unknown[]) => {
  captured.push(args.map(a => String(a)).join(' '));
  orig(...args);
};

for (let ti = 0; ti < cachedAfter.length; ti++) {
  captured = [];
  const r = findCursorByTemplateDecoded(decF1, cachedAfter[ti], {
    topK: 5,
    verbose: true,
    minScore: 0,
  });
  const fileForIdx = files[ti] ?? `idx${ti}`;
  const isFresh = fileForIdx === newestFile;
  const top = r?.score ?? 0;
  if (isFresh) {
    freshTop1OnF1 = top;
    const topLine = captured.find(l => l.includes('[template-match] top-'));
    if (topLine) {
      const matches = [...topLine.matchAll(/(\d+)=([\d.]+)@\((\d+),(\d+)\)/g)];
      freshTopK = matches.map(m => ({
        score: parseFloat(m[2]),
        x: parseInt(m[3]),
        y: parseInt(m[4]),
      }));
    }
  } else {
    if (top > cachedMaxTop1OnF1) cachedMaxTop1OnF1 = top;
  }
}

console.error = orig;

console.error(`\n=== RESULT ===`);
console.error(`F0: cached max top-1 = ${f0MaxTop1.toFixed(3)} (Phase 251 baseline; expected 0.45-0.82)`);
console.error(`F1: cached max top-1 = ${cachedMaxTop1OnF1.toFixed(3)} (excluding fresh)`);
console.error(`F1: FRESH template top-1 = ${freshTop1OnF1.toFixed(3)}`);
if (freshTopK.length > 0) {
  console.error(`F1: FRESH top-${freshTopK.length}: ` +
    freshTopK.map((c, i) => `${i + 1}=${c.score.toFixed(3)}@(${c.x},${c.y})`).join(' '));
}
console.error(`Seeded cursor position: (${seed.cursorPosition?.x},${seed.cursorPosition?.y})`);

console.error(`\n=== VERDICT ===`);
const FRESH_OK = freshTop1OnF1 >= 0.83;
const CACHED_FAILED = cachedMaxTop1OnF1 < 0.83;
if (FRESH_OK && CACHED_FAILED) {
  console.error('H1 CONFIRMED: stale cache is the lever.');
  console.error('  Fresh template clears 0.83 minScore on a frame where cached fail.');
  console.error('  → Phase 254: aggressive context-conditioned reseeding.');
} else if (!FRESH_OK && CACHED_FAILED) {
  console.error('H2 LIKELY: masked extraction (Phase 106) leaks backdrop.');
  console.error('  Fresh template ALSO fails 0.83 even seeded at this exact frame.');
  console.error('  → Phase 254: revisit Phase 106 mask construction or a non-NCC');
  console.error('    cursor representation.');
} else if (FRESH_OK && !CACHED_FAILED) {
  console.error('AMBIGUOUS: cached unexpectedly cleared 0.83 too.');
  console.error('  Worth re-running with a different position to verify.');
} else {
  console.error('NEITHER fresh nor cached cleared 0.83.');
  console.error('  Inspect F1.jpg manually to confirm cursor is visible.');
}
process.exit(0);
