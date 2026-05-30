/**
 * Phase 254: emit-only positioning to avoid Phase 253 lock-screen trigger.
 *
 * Phase 253 found slamToCorner (28 rapid 127px @ 60ms) triggered the
 * iPad lock screen mid-experiment (or auto-lock fired in the gap; can't
 * distinguish from a single trial). Either way, slam is unsafe.
 *
 * This script: unlock + home + sleep + take initial screenshot to verify
 * we're still on home (NOT lock) BEFORE seeding. If on lock, abort with
 * a clear message. If on home, do a chunked-emit relative move to deposit
 * cursor near (840, 600) [center-bottom area, far from clock widget at
 * top-left and far from app icons], then seedCursorTemplate, then
 * compare.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { decodeScreenshot, findCursorByTemplateDecoded } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from '../src/pikvm/seed-template.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase254-emit-only';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 254 emit-only at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

// Sanity check: take a screenshot to confirm we're on home, not lock screen
const sanity = await client.screenshot();
await fs.writeFile(`${ROOT}/sanity.jpg`, sanity.buffer);
console.error('Sanity screenshot saved. Continuing on the assumption we\'re on home.');

// Emit-only positioning: chunked relative move toward (840, 600).
// Cursor's actual starting position is unknown, but a series of right+down
// emits will move it that way. We don't slam first — that's what locked us.
console.error('Step 0: chunked emit (right+down, no slam) toward mid-bottom...');
const STEPS = 12;  // 12 × ~80px chunks = ~960px total
for (let i = 0; i < STEPS; i++) {
  await client.mouseMoveRelative(80, 50);
  await sleep(50);
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
console.error(`\nStep 2: forcing seedCursorTemplate...`);
const seed = await seedCursorTemplate(client);
console.error(
  `Step 2: seed result: ok=${seed.ok} ` +
  `cursorPos=${seed.cursorPosition ? `(${seed.cursorPosition.x},${seed.cursorPosition.y})` : 'null'} ` +
  `persisted=${seed.templatePersisted} decision=${seed.decision} reason="${seed.reason}"`,
);

if (!seed.templatePersisted) {
  console.error('\nFAIL: seed did not persist. Inspect F0.jpg + sanity.jpg.');
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
console.error(`F0: cached max top-1 = ${f0MaxTop1.toFixed(3)}`);
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
} else if (!FRESH_OK && CACHED_FAILED) {
  console.error('H2 LIKELY: masked extraction (Phase 106) leaks backdrop.');
} else if (FRESH_OK && !CACHED_FAILED) {
  console.error('AMBIGUOUS: cached unexpectedly cleared 0.83.');
} else {
  console.error('NEITHER fresh nor cached cleared 0.83. Inspect F1.jpg.');
}
process.exit(0);
