/**
 * Phase 252: does a freshly-seeded template score ≥0.83 on a frame
 * where cached templates fail?
 *
 * Phase 251 (v0.5.216) found that on the iPad home screen, all 5
 * cached templates score 0.45-0.81 — none clear the 0.83 minScore
 * even though the cursor is plainly visible. Re-framed the bimodal
 * pattern as "confident-correct vs SILENT-and-fallback-noisy" not
 * "confident-correct vs confident-wrong."
 *
 * Two competing hypotheses:
 *   H1: cached templates are STALE — extracted against a different
 *       wallpaper region, NCC degraded against current backdrop.
 *       Fresh template at current cursor position would clear 0.83.
 *   H2: masked extraction itself (Phase 106) leaks too much backdrop
 *       — even a freshly-extracted template won't clear 0.83 against
 *       a slightly-different surrounding context.
 *
 * Procedure:
 *   1. Unlock + home + settle.
 *   2. Capture F0; run all cached templates with topK; record
 *      max top-1 across cached set.
 *   3. Force a fresh seedCursorTemplate (which captures a new pre/post
 *      frame pair and persists the masked extract).
 *   4. Re-load the template set (now N+1 with the fresh one at the
 *      end of the directory).
 *   5. Capture F1 (same UI state as F0, cursor at roughly same place).
 *   6. Run all templates against F1 with topK; report:
 *        - max top-1 across cached templates
 *        - top-1 of the freshly-persisted template
 *        - whether fresh ≥ 0.83
 *
 * Decision tree:
 *   - Fresh ≥ 0.83: H1 (stale cache) confirmed. Next phase: more
 *     aggressive context-conditioned reseeding.
 *   - Fresh < 0.83: H2 (extraction leaks) likely. Next phase:
 *     revisit Phase 106 mask tightening / extraction strategy.
 *   - Fresh ≥ 0.83 but cached close to threshold (0.78+): partial —
 *     stale matters but minScore-floor + locality may also be a lever.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { decodeScreenshot, findCursorByTemplateDecoded } from './src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from './src/pikvm/seed-template.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase252-fresh-vs-cached';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 252 fresh-vs-cached at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 1200));

// --- Step 1: capture F0 and score cached templates ---
const cachedBefore = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Step 1: cached set size = ${cachedBefore.length}`);

const f0 = await client.screenshot();
const decF0 = await decodeScreenshot(f0.buffer);
await fs.writeFile(`${ROOT}/F0.jpg`, f0.buffer);

let f0MaxTop1 = 0;
for (let ti = 0; ti < cachedBefore.length; ti++) {
  const r = findCursorByTemplateDecoded(decF0, cachedBefore[ti], {
    minScore: 0,
    verbose: false,  // quiet: collect aggregate only
  });
  if (r && r.score > f0MaxTop1) f0MaxTop1 = r.score;
}
console.error(`Step 1: F0 cached max top-1 = ${f0MaxTop1.toFixed(3)} (threshold 0.83)`);

// --- Step 2: force fresh seedCursorTemplate ---
console.error(`\nStep 2: forcing seedCursorTemplate...`);
const seed = await seedCursorTemplate(client);
console.error(
  `Step 2: seed result: ok=${seed.ok} cursorPos=${
    seed.cursorPosition ? `(${seed.cursorPosition.x},${seed.cursorPosition.y})` : 'null'
  } persisted=${seed.templatePersisted} decision=${seed.decision} reason="${seed.reason}"`,
);

// --- Step 3: capture F1 and score the (now larger) set ---
await new Promise(r => setTimeout(r, 600));
const cachedAfter = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`\nStep 3: post-seed set size = ${cachedAfter.length}`);

const f1 = await client.screenshot();
const decF1 = await decodeScreenshot(f1.buffer);
await fs.writeFile(`${ROOT}/F1.jpg`, f1.buffer);

// Score every template; identify which one is the fresh seed by mtime.
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

// loadTemplateSet sorts entries alphabetically; map index → filename.
let freshTopK: { score: number; x: number; y: number }[] = [];
let cachedMaxTop1OnF1 = 0;
let freshTop1OnF1 = 0;

const originalConsoleError = console.error.bind(console);
let captured: string[] = [];
console.error = (...args: unknown[]) => {
  captured.push(args.map(a => String(a)).join(' '));
  originalConsoleError(...args);
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

console.error = originalConsoleError;

console.error(`\n=== RESULT ===`);
console.error(`F0: cached max top-1 = ${f0MaxTop1.toFixed(3)} (Phase 251 baseline; expected 0.45-0.82)`);
console.error(`F1: cached max top-1 = ${cachedMaxTop1OnF1.toFixed(3)} (sanity check, should match F0)`);
console.error(`F1: FRESH template top-1 = ${freshTop1OnF1.toFixed(3)}`);
if (freshTopK.length > 0) {
  console.error(`F1: FRESH template top-${freshTopK.length}: ` +
    freshTopK.map((c, i) => `${i + 1}=${c.score.toFixed(3)}@(${c.x},${c.y})`).join(' '));
}

console.error(`\n=== VERDICT ===`);
const FRESH_OK = freshTop1OnF1 >= 0.83;
const CACHED_FAILED = cachedMaxTop1OnF1 < 0.83;
if (FRESH_OK && CACHED_FAILED) {
  console.error('H1 CONFIRMED: stale cache is the lever.');
  console.error('  Fresh template clears 0.83 minScore on a frame where cached fail.');
  console.error('  Next phase: aggressive context-conditioned reseeding (re-seed when');
  console.error('    cached top-1 < 0.83 mid-session, not just at TTL expiry).');
} else if (!FRESH_OK && CACHED_FAILED) {
  console.error('H2 LIKELY: masked extraction (Phase 106) leaks backdrop.');
  console.error('  Fresh template ALSO fails 0.83 on the same frame. Not a freshness');
  console.error('  problem — the extraction itself produces templates that lose NCC');
  console.error('  against even slightly-different backdrop pixels in the surrounding');
  console.error('  region. Next phase: revisit Phase 106 mask tightness or move to a');
  console.error('  pure cursor-shape representation (alpha-mask, edge-only, etc.).');
} else if (FRESH_OK && !CACHED_FAILED) {
  console.error('AMBIGUOUS: cached unexpectedly cleared 0.83 too.');
  console.error('  Phase 251 ran on a frame where cached failed, but this run');
  console.error('  caught them succeeding. Run Phase 252 again later to gather more');
  console.error('  data on the failure conditions.');
} else {
  console.error('NEITHER fresh nor cached cleared 0.83.');
  console.error('  Could mean: the cursor isn\'t in either frame at the position');
  console.error('  motion-diff identified, OR Phase 106 extraction is broken.');
  console.error('  Inspect data/phase252-fresh-vs-cached/F1.jpg manually.');
}
process.exit(0);
