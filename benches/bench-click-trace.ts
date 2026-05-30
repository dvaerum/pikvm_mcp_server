/**
 * Phase 194-B (v0.5.188) — per-step click-pipeline tracing.
 *
 * The Phase 193-C bench showed 1/12 visually-inspected "hits"
 * actually opened the right app. Cursor reportedly at residual
 * 35 px from Files yet click opened Maps. Hypothesis: cursor
 * position reported by `moveToPixel.finalDetectedPosition` is
 * NOT where the cursor is when `mouseClick` fires — there's
 * drift between moveToPixel return and the actual click.
 *
 * This bench traces each pipeline stage manually (bypassing
 * clickAtWithRetry) so we can see EXACTLY where cursor lands at:
 *   1. before moveToPixel (origin discovery state)
 *   2. after moveToPixel (algorithm-reported cursor pos)
 *   3. after Phase-125-style in-motion approach
 *   4. immediately after mouseClick (no settle)
 *   5. 2 seconds after mouseClick (settled, cursor auto-hidden,
 *      app fully launched if click landed correctly)
 *
 * Each stage saves a screenshot. A log records:
 *   - target px
 *   - algorithm-reported cursor pos (from moveToPixel)
 *   - visible cursor pos in each saved frame (manual eyeball,
 *     or NCC template-match against post-stage frame)
 *   - residual computed at each stage
 *
 * Usage:
 *   npx tsx bench-click-trace.ts            # 3 trials × 1 target
 *   npx tsx bench-click-trace.ts settings   # only Settings target
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { decodeScreenshot, findCursorByTemplateSet } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { looksLikeCursor } from '../src/pikvm/move-to.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/click-trace';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const TARGETS_ALL = {
  settings:  { x: 905,  y: 800, name: 'Settings' },
  books:     { x: 640,  y: 800, name: 'Books' },
  appstore:  { x: 905,  y: 680, name: 'App Store' },
  files:     { x: 1035, y: 420, name: 'Files' },
};

const arg = process.argv[2];
const targets = arg && arg in TARGETS_ALL
  ? { [arg]: TARGETS_ALL[arg as keyof typeof TARGETS_ALL] }
  : TARGETS_ALL;
const TRIALS = 3;

async function snap(file: string, q = 80): Promise<Buffer> {
  const shot = await client.screenshot({ quality: q });
  await fs.writeFile(file, shot.buffer);
  return shot.buffer;
}

async function locateCursorViaTemplate(buf: Buffer, hint?: { x: number; y: number }): Promise<{ x: number; y: number; score: number } | null> {
  const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, looksLikeCursor).catch(() => []);
  if (templates.length === 0) return null;
  const dec = await decodeScreenshot(buf);
  const r = findCursorByTemplateSet(dec, templates, { expectedNear: hint, expectedNearRadius: 200 });
  if (!r) return null;
  return { x: r.position.x, y: r.position.y, score: r.score };
}

interface TraceLog {
  target: string;
  trial: number;
  reportedFinalCursor: { x: number; y: number } | null;
  ratio: { x: number; y: number } | null;
  visibleCursor: {
    s2_postMoveToPixel: { x: number; y: number; score: number } | null;
    s3_postApproach: { x: number; y: number; score: number } | null;
    s4_postClickImmediate: { x: number; y: number; score: number } | null;
    s5_postClickSettled: { x: number; y: number; score: number } | null;
  };
  residuals: {
    s2_reported: number | null;
    s2_visible: number | null;
    s3_visible: number | null;
    s4_visible: number | null;
  };
}

const logs: TraceLog[] = [];

console.error(`Phase 194-B click-trace — ${Object.keys(targets).length} target(s) × ${TRIALS} trials\n`);

for (const [slug, target] of Object.entries(targets)) {
  const dir = path.join(ROOT, slug);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== ${target.name} (${target.x}, ${target.y}) ===`);

  for (let trial = 1; trial <= TRIALS; trial++) {
    const stub = `${trial.toString().padStart(2, '0')}`;
    console.error(`\n  Trial ${trial}/${TRIALS}`);

    // Reset to home
    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 800));

    // Stage 1: pre-move state
    await snap(path.join(dir, `${stub}-s1-pre.jpg`));

    // Stage 2: moveToPixel
    let mvResult;
    try {
      mvResult = await moveToPixel(client, target, {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      });
    } catch (e) {
      console.error(`    moveToPixel threw: ${(e as Error).message}`);
      logs.push({
        target: slug, trial,
        reportedFinalCursor: null,
        ratio: null,
        visibleCursor: { s2_postMoveToPixel: null, s3_postApproach: null, s4_postClickImmediate: null, s5_postClickSettled: null },
        residuals: { s2_reported: null, s2_visible: null, s3_visible: null, s4_visible: null },
      });
      continue;
    }

    const reportedCursor = mvResult.finalDetectedPosition;
    const reportedResidual = reportedCursor
      ? Math.hypot(reportedCursor.x - target.x, reportedCursor.y - target.y)
      : null;

    const s2Buf = await snap(path.join(dir, `${stub}-s2-postMove.jpg`));
    const s2Visible = await locateCursorViaTemplate(s2Buf, reportedCursor ?? undefined);

    console.error(
      `    s2 moveToPixel: reported (${reportedCursor?.x.toFixed(0) ?? '?'}, ${reportedCursor?.y.toFixed(0) ?? '?'}) ` +
      `residual=${reportedResidual?.toFixed(0) ?? '?'}px; visible-template ${s2Visible ? `(${s2Visible.x}, ${s2Visible.y}) score=${s2Visible.score.toFixed(2)}` : 'null'}`
    );

    // Stage 3: Phase-125-style in-motion approach
    const ratioX = mvResult.usedPxPerMickey?.x ?? 1.3;
    const ratioY = mvResult.usedPxPerMickey?.y ?? 1.3;
    if (reportedCursor) {
      const apDx = target.x - reportedCursor.x;
      const apDy = target.y - reportedCursor.y;
      const apx = Math.max(-10, Math.min(10, Math.round(apDx / ratioX)));
      const apy = Math.max(-10, Math.min(10, Math.round(apDy / ratioY)));
      if (apx !== 0 || apy !== 0) {
        await client.mouseMoveRelative(apx, apy);
      }
    }

    const s3Buf = await snap(path.join(dir, `${stub}-s3-postApproach.jpg`));
    const s3Visible = await locateCursorViaTemplate(s3Buf, reportedCursor ?? undefined);
    console.error(
      `    s3 postApproach:                                                visible-template ${s3Visible ? `(${s3Visible.x}, ${s3Visible.y}) score=${s3Visible.score.toFixed(2)}` : 'null'}`
    );

    // Stage 4: click + immediate snap (no settle)
    await client.mouseClick('left');
    const s4Buf = await snap(path.join(dir, `${stub}-s4-postClick0ms.jpg`));
    const s4Visible = await locateCursorViaTemplate(s4Buf);
    console.error(
      `    s4 postClick0ms:                                                visible-template ${s4Visible ? `(${s4Visible.x}, ${s4Visible.y}) score=${s4Visible.score.toFixed(2)}` : 'null'}`
    );

    // Stage 5: settled (2s)
    await new Promise(r => setTimeout(r, 2000));
    await snap(path.join(dir, `${stub}-s5-postClick2s.jpg`));
    // Don't bother looking for cursor at s5 — auto-hidden. Just save the
    // frame so we can visually verify whether the right app launched.

    const r2v = (a: { x: number; y: number } | null): number | null =>
      a ? Math.hypot(a.x - target.x, a.y - target.y) : null;

    logs.push({
      target: slug, trial,
      reportedFinalCursor: reportedCursor,
      ratio: mvResult.usedPxPerMickey ? { x: ratioX, y: ratioY } : null,
      visibleCursor: {
        s2_postMoveToPixel: s2Visible,
        s3_postApproach: s3Visible,
        s4_postClickImmediate: s4Visible,
        s5_postClickSettled: null,
      },
      residuals: {
        s2_reported: reportedResidual,
        s2_visible: r2v(s2Visible),
        s3_visible: r2v(s3Visible),
        s4_visible: r2v(s4Visible),
      },
    });
  }
}

await fs.writeFile(path.join(ROOT, 'log.json'), JSON.stringify(logs, null, 2));
console.error(`\n\nDone. Inspect ${ROOT}/<target>/NN-s{1..5}-*.jpg + log.json.`);
console.error(`Compare s2-reported (algorithm) vs s2-visible (template) — if they disagree, detection is lying again.`);
console.error(`Compare s2 vs s4 — drift between moveToPixel return and click landing.`);
process.exit(0);
