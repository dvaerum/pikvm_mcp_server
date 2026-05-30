/**
 * Phase 251 diagnostic: does any single template return multiple
 * confident matches at distinct positions on the iPad home screen?
 *
 * Phase 250 score-margin gate operates cross-template: it compares
 * the winning template's top-1 score to other templates' top-1
 * scores. Phase 250 N=10 showed it fires 0/10 — strong hint that the
 * bimodal FP class is per-template, not cross-template.
 *
 * This script captures the live home screen and runs each cached
 * template with topK:5, verbose:true. It reports per-template:
 *   - top-K scores
 *   - whether ≥2 of those scores are above 0.83 minScore
 *   - the spread between top-1 and top-2 (intra-template margin)
 *
 * Output decides the next investigation:
 *   - If many templates show top-2 ≥ 0.83 at distinct positions:
 *     per-template topK selection (or ambiguity rejection) is a
 *     real lever.
 *   - If top-2 collapses to noise (<0.6) on every template: the FP
 *     is the dominant true cursor confidently being misread, and
 *     the per-template angle won't help. Need a different signal.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { decodeScreenshot, findCursorByTemplateDecoded } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase251-topk';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 251 top-K diagnostic at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 1200));

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Loaded ${templates.length} cached templates from ${DEFAULT_TEMPLATE_DIR}`);

if (templates.length === 0) {
  console.error('No templates cached — cannot diagnose. Run pikvm_seed_cursor_template first.');
  process.exit(1);
}

// Capture stderr to count distinct candidates per template per trial.
let capturedLogs: string[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = args.map((a) => String(a)).join(' ');
  capturedLogs.push(msg);
  originalConsoleError(...args);
};

const N = 5;
type TemplateStats = {
  trials: { top1: number; top2: number; sameSpot: boolean }[];
};
const perTemplate: TemplateStats[] = templates.map(() => ({ trials: [] }));

for (let trial = 1; trial <= N; trial++) {
  originalConsoleError(`\n--- Trial ${trial} ---`);
  const shot = await client.screenshot();
  const decoded = await decodeScreenshot(shot.buffer);
  await fs.writeFile(`${ROOT}/trial${trial}.jpg`, shot.buffer);

  for (let ti = 0; ti < templates.length; ti++) {
    capturedLogs = [];
    findCursorByTemplateDecoded(decoded, templates[ti], {
      topK: 5,
      verbose: true,
      minScore: 0,  // we want all top-K regardless of threshold
    });
    // Parse the [template-match] top-N: line we just emitted.
    const topLine = capturedLogs.find((l) => l.includes('[template-match] top-'));
    let top1 = 0, top2 = 0;
    let p1: { x: number; y: number } | null = null;
    let p2: { x: number; y: number } | null = null;
    if (topLine) {
      const matches = [...topLine.matchAll(/(\d+)=([\d.]+)@\((\d+),(\d+)\)/g)];
      if (matches.length >= 1) {
        top1 = parseFloat(matches[0][2]);
        p1 = { x: parseInt(matches[0][3]), y: parseInt(matches[0][4]) };
      }
      if (matches.length >= 2) {
        top2 = parseFloat(matches[1][2]);
        p2 = { x: parseInt(matches[1][3]), y: parseInt(matches[1][4]) };
      }
    }
    const dist = p1 && p2 ? Math.hypot(p1.x - p2.x, p1.y - p2.y) : 0;
    const sameSpot = dist < 30;
    perTemplate[ti].trials.push({ top1, top2, sameSpot });
  }
}

console.error = originalConsoleError;

console.error(`\n\n=== PER-TEMPLATE SUMMARY (N=${N} trials each) ===\n`);
console.error('idx | mean(top1) | mean(top2) | trials w/ top2≥0.83 | trials w/ top2 at distinct spot');
console.error('----+------------+------------+---------------------+--------------------------------');
let anyAmbiguous = 0;
for (let ti = 0; ti < templates.length; ti++) {
  const t = perTemplate[ti].trials;
  const m1 = t.reduce((s, x) => s + x.top1, 0) / t.length;
  const m2 = t.reduce((s, x) => s + x.top2, 0) / t.length;
  const top2HighCount = t.filter(x => x.top2 >= 0.83).length;
  const distinctCount = t.filter(x => x.top2 >= 0.83 && !x.sameSpot).length;
  if (distinctCount > 0) anyAmbiguous++;
  console.error(
    `${ti.toString().padStart(3)} |   ${m1.toFixed(3)}    |   ${m2.toFixed(3)}    |       ` +
    `${top2HighCount}/${N}            |       ${distinctCount}/${N}`
  );
}

console.error(`\n=== VERDICT ===`);
console.error(`Templates with intra-template ambiguity (top-2 ≥0.83 at distinct spot in ≥1 trial): ${anyAmbiguous}/${templates.length}`);

if (anyAmbiguous >= Math.max(1, templates.length / 3)) {
  console.error(`\n→ Per-template topK selection is a REAL LEVER.`);
  console.error(`  Worth shipping a per-template top-K-aware selector.`);
} else {
  console.error(`\n→ Per-template topK is NOT the lever.`);
  console.error(`  Each template returns one confident match (true OR false); no internal ambiguity.`);
  console.error(`  Means: when the cursor is wrong, the template scores it cleanly at the wrong place.`);
  console.error(`  Need a different signal (motion-diff cross-validation, contour-aware template, etc.).`);
}

process.exit(0);
