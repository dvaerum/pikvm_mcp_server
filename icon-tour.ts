/**
 * Phase 130 — extensive testing: move cursor over every home-screen
 * icon in random order. Verifies Phase 127 (ratio clamp) +
 * Phase 121 (hotspot) algorithmic chain reaches every target.
 *
 * Read-only: only moveToPixel, no clicks. Reports per-icon residual.
 */
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { decodeScreenshot, findCursorByTemplateSet } from './src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);

interface Icon { name: string; x: number; y: number; }

const icons: Icon[] = [
  // Main grid
  { name: 'FaceTime', x: 1027, y: 432 },
  { name: 'Files', x: 1162, y: 432 },
  { name: 'Reminders', x: 1027, y: 564 },
  { name: 'Maps', x: 1162, y: 564 },
  { name: 'Home', x: 757, y: 700 },
  { name: 'Camera', x: 892, y: 700 },
  { name: 'AppStore', x: 1027, y: 700 },
  { name: 'Games', x: 1162, y: 700 },
  { name: 'Books', x: 757, y: 833 },
  { name: 'TV', x: 892, y: 833 },
  { name: 'Settings', x: 1027, y: 833 },
];

// Fisher-Yates shuffle.
const order = [...icons];
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

console.log(`Touring ${order.length} icons in random order...\n`);

interface Result { icon: Icon; cursor: { x: number; y: number } | null; residualPx: number | null; templateScore: number | null; }
const results: Result[] = [];

for (const icon of order) {
  let move: Awaited<ReturnType<typeof moveToPixel>> | null = null;
  try {
    move = await moveToPixel(client, icon, {
      strategy: 'detect-then-move',
      forbidSlamFallback: true,
      profile,
      linearTriggerResidualPx: 200,
      linearChunkMagnitude: 20,
      linearChunkPaceMs: 80,
      linearCorrectionCap: 40,
      linearMaxPasses: 12,
      maxCorrectionPasses: 12,
      linearResidualPx: 25,
      iconToleranceResidualPx: 25,
      disableLinearBailout: true,
    });
  } catch (e) {
    console.log(`  ${icon.name.padEnd(12)}: ERROR moveToPixel — ${(e as Error).message.split('\n')[0]}`);
    results.push({ icon, cursor: null, residualPx: null, templateScore: null });
    continue;
  }

  await new Promise(r => setTimeout(r, 400));
  const shot = await client.screenshot();
  const decoded = await decodeScreenshot(shot.buffer);
  // Hint at the TARGET — after a successful move the cursor should be near
  // there. Fixes the Phase 123 class of false-positive (calendar widget
  // at (758, 450) scoring 0.66 against cursor template) by biasing
  // template-match toward the post-move expected position.
  const found = findCursorByTemplateSet(decoded, templates, {
    minScore: 0.5,
    expectedNear: icon,
    expectedNearRadius: 100,
  });

  const cursor = found?.position ?? move.finalDetectedPosition;
  const residual = cursor ? Math.hypot(cursor.x - icon.x, cursor.y - icon.y) : null;
  const score = found?.score ?? null;

  console.log(
    `  ${icon.name.padEnd(12)}: target=(${icon.x},${icon.y})  cursor=${cursor ? `(${cursor.x},${cursor.y})` : 'NOT FOUND'}  ` +
    `residual=${residual !== null ? residual.toFixed(1) + 'px' : '—'}  templateScore=${score !== null ? score.toFixed(2) : '—'}`,
  );
  results.push({ icon, cursor, residualPx: residual, templateScore: score });
}

const verified = results.filter(r => r.residualPx !== null);
const verifiedResiduals = verified.map(r => r.residualPx!).sort((a, b) => a - b);
const median = verifiedResiduals[Math.floor(verifiedResiduals.length / 2)];
const p95 = verifiedResiduals[Math.floor(verifiedResiduals.length * 0.95)];
const within10 = verifiedResiduals.filter(r => r <= 10).length;
const within25 = verifiedResiduals.filter(r => r <= 25).length;

console.log(`\n=== Summary ===`);
console.log(`  ${verified.length}/${results.length} cursor positions verified by template-match`);
console.log(`  median residual: ${median?.toFixed(1) ?? 'N/A'}px`);
console.log(`  p95 residual: ${p95?.toFixed(1) ?? 'N/A'}px`);
console.log(`  within 10px of target: ${within10}/${verified.length}`);
console.log(`  within 25px of target: ${within25}/${verified.length}`);
