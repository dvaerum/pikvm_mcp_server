/**
 * Phase 58/59 — bootstrap a cursor template via wake-and-capture.
 *
 * The cursor-template chain (Phase 51 verification, Phase 53 cohesion gate,
 * Phase 56 brightness floor) needs at least ONE good template in
 * `data/cursor-templates/` for `findCursorByTemplateSet` to do anything
 * useful. Until then, Phase 51 silently skips its check.
 *
 * After a fresh deployment (or after the templates dir is cleared), the
 * normal motion-diff path can populate the set during regular click_at
 * calls — but only if motion-diff actually identifies the cursor on
 * those calls. On animated UI (iPad home screen, dark-mode Settings,
 * etc.) it sometimes doesn't, and the deadlock persists.
 *
 * `seedCursorTemplate` breaks that deadlock with a deterministic
 * one-shot capture: emit a known relative motion, diff before/after,
 * pick the largest motion cluster, extract a 24×24 template at its
 * centroid, validate via `looksLikeCursor`, and persist.
 *
 * This module is the pure orchestration logic; the MCP tool wrapper
 * lives in `index.ts` and the test harness consumes the same function
 * via a mocked client.
 */

import {
  decodeScreenshot,
  diffPixels,
  diffScreenshotsDecoded,
  extractCursorTemplateDecoded,
} from './cursor-detect.js';
import type { CursorTemplate, DecodedScreenshot } from './cursor-detect.js';
import { looksLikeCursor } from './move-to.js';
import {
  persistTemplate,
  loadTemplateSet,
  DEFAULT_TEMPLATE_DIR,
} from './template-set.js';

/** The minimum surface area of `PiKVMClient` needed by `seedCursorTemplate`.
 *  Defined as a structural type so tests can supply a small fake. */
export interface SeedTemplateClient {
  screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }>;
  mouseMoveRelative(dx: number, dy: number): Promise<void>;
}

export interface SeedTemplateOptions {
  /** X-axis mickeys for the wake motion. Default 100. */
  emitDx?: number;
  /** Y-axis mickeys for the wake motion. Default 0. */
  emitDy?: number;
  /** Delay between motion and post-screenshot. Default 500 ms. */
  settleMs?: number;
  /** Override the template directory (tests). */
  dir?: string;
  /** Override `setTimeout` (tests pass a stub that resolves immediately). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the persisted-template loader (tests). */
  loadExisting?: (dir: string) => Promise<CursorTemplate[]>;
  /** Override the persist function (tests). */
  persist?: typeof persistTemplate;
}

export interface SeedTemplateResult {
  /** True iff a template was newly added to the set. False on duplicate
   *  or any failure path. */
  ok: boolean;
  /** The detected cursor centroid (HDMI pixels), or null if motion-diff
   *  produced no clusters. */
  cursorPosition: { x: number; y: number } | null;
  /** True iff a NEW template was written (decision === 'added' or
   *  'replaced'). False on duplicate or any failure. */
  templatePersisted: boolean;
  /** persistTemplate's decision when reached, otherwise undefined. */
  decision?: 'added' | 'replaced' | 'duplicate';
  /** Total templates in the set after the operation. */
  templateCount?: number;
  /** Human-readable explanation of the outcome. */
  reason: string;
}

export async function seedCursorTemplate(
  client: SeedTemplateClient,
  options: SeedTemplateOptions = {},
): Promise<SeedTemplateResult> {
  const emitDx = options.emitDx ?? 100;
  const emitDy = options.emitDy ?? 0;
  const settleMs = options.settleMs ?? 500;
  const dir = options.dir ?? DEFAULT_TEMPLATE_DIR;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const loadExisting = options.loadExisting ?? loadTemplateSet;
  const persist = options.persist ?? persistTemplate;

  const before = await client.screenshot();
  await client.mouseMoveRelative(emitDx, emitDy);
  await sleep(settleMs);
  const after = await client.screenshot();

  const decBefore = await decodeScreenshot(before.buffer);
  const decAfter = await decodeScreenshot(after.buffer);
  // Phase 103 + 104: cluster-size bounds tuned from live measurement.
  // Phase 103 was too tight — used 70 max based on a wrong assumption
  // that iPad cursors are 25-50 px. Phase 104 measured live (debug-diff
  // script): the actual iPadOS cursor in a plain area produces diff
  // clusters of 80-90 px (anti-aliased edges + soft shadow). Bumped
  // max to 120 to admit real cursors comfortably while still excluding
  // pointer-effect halos (200-400+ px).
  //
  // Lower bound 15 excludes JPEG noise (typical noise clusters are
  // 1-15 px in our measurements).
  const clusters = diffScreenshotsDecoded(decBefore, decAfter, {
    diffThreshold: 30,
    minClusterSize: 15,
    maxClusterSize: 120,
    mergeRadius: 20,
    brightnessFloor: 100,
    maxChannelDelta: 0,
  });
  if (clusters.length === 0) {
    return {
      ok: false,
      cursorPosition: null,
      templatePersisted: false,
      reason:
        'no cursor-sized motion-diff clusters detected (15-120 px). Cursor may be off-screen, dim, faded, or already at the wake-emit destination. Try a larger emitDx/emitDy or wait for iPadOS to render the cursor before seeding.',
    };
  }
  // Phase 106: compute the per-pixel diff mask once. Used to mask the
  // template extract — pixels that didn't change (static background
  // context like text or icons) get zeroed out, leaving only the
  // cursor's contribution. This solves the context-bleed problem from
  // Phase 104: extracting a 24×24 region around the cursor previously
  // captured "cursor + surrounding text/indicator bar/icons" which
  // looksLikeCursor correctly rejected as too-bright. With the mask,
  // the template has bright cursor pixels in the AFTER position and
  // dark/zero everywhere else regardless of background.
  const diffMask = diffPixels(
    decBefore.rgb,
    decAfter.rgb,
    decBefore.width,
    decBefore.height,
    30,    // diffThreshold (matches diffScreenshotsDecoded above)
    100,   // brightnessFloor
    0,     // maxChannelDelta
  );

  // Phase 104: try each candidate cluster, accept the first that
  // produces a template passing looksLikeCursor. Motion-diff produces
  // TWO clusters per cursor move — the BEFORE position (now empty in
  // decAfter, so extraction yields a dark template that fails
  // brightness gate) and the AFTER position (now bright, extraction
  // yields a real cursor template). Cluster sizes are often similar
  // (89 px vs 83 px in live data), so picking "largest" doesn't reliably
  // pick the AFTER cluster. Trying both is robust.
  const sorted = [...clusters].sort((a, b) => b.pixels - a.pixels);
  let chosenCluster: typeof sorted[number] | null = null;
  let chosenTemplate: CursorTemplate | null = null;
  const rejectReasons: string[] = [];
  for (const cluster of sorted) {
    const pos = {
      x: Math.round(cluster.centroidX),
      y: Math.round(cluster.centroidY),
    };
    const candidate = extractMaskedTemplate(decAfter, pos, 24, diffMask);
    if (looksLikeCursor(candidate)) {
      chosenCluster = cluster;
      chosenTemplate = candidate;
      break;
    }
    rejectReasons.push(`(${pos.x},${pos.y}) ${cluster.pixels}px → looksLikeCursor rejected`);
  }
  if (!chosenCluster || !chosenTemplate) {
    return {
      ok: false,
      cursorPosition: {
        x: Math.round(sorted[0].centroidX),
        y: Math.round(sorted[0].centroidY),
      },
      templatePersisted: false,
      reason:
        `looksLikeCursor rejected all ${sorted.length} candidate cluster(s). ` +
        `Tried: ${rejectReasons.slice(0, 5).join('; ')}. The motion-diff clusters may not be the cursor — try a different wake emit direction, or check that the iPad screen is bright enough.`,
    };
  }
  const cursorPos = {
    x: Math.round(chosenCluster.centroidX),
    y: Math.round(chosenCluster.centroidY),
  };
  const template = chosenTemplate;
  const existing = await loadExisting(dir);
  const result = await persist(dir, template, existing);
  return {
    ok: result.decision !== 'duplicate',
    cursorPosition: cursorPos,
    templatePersisted: result.decision !== 'duplicate',
    decision: result.decision,
    templateCount: result.kept.length,
    reason:
      result.decision === 'duplicate'
        ? 'Template was perceptually similar to an existing one — kept the existing copy.'
        : `Template ${result.decision} (${result.kept.length} total).`,
  };
}

/**
 * Phase 106: extract a 24×24 cursor template from `screenshot` centred on
 * `centre`, but ZERO OUT pixels that are NOT in the supplied diff mask.
 *
 * The motivation: the cursor's footprint is a small subset of the 24×24
 * template region. The rest is static background context (text, icons,
 * indicator bars) that contaminates the template — looksLikeCursor's
 * brightness gate then rejects the extract because the surrounding
 * context contributes too many bright pixels.
 *
 * The diff mask flags pixels that CHANGED between BEFORE and AFTER
 * frames — the cursor's contribution is exactly that set (because the
 * cursor moved). Masking the extract to the diff signature gives a
 * template that has bright cursor pixels in the right shape and zeros
 * everywhere else, regardless of what was originally underneath the
 * cursor.
 *
 * NCC matching against future screenshots still works: the cursor's
 * distinctive bright pattern dominates the correlation; the dark
 * background pixels in the template multiply against future-screenshot
 * pixels and contribute variance, but the cursor pattern carries the
 * match score.
 *
 * Pure: no I/O, deterministic.
 */
export function extractMaskedTemplate(
  screenshot: DecodedScreenshot,
  centre: { x: number; y: number },
  size: number,
  diffMask: ReadonlyArray<boolean>,
): CursorTemplate {
  // Extract first via the existing path (handles edge clamping correctly).
  const tpl = extractCursorTemplateDecoded(screenshot, centre, size);
  // Re-derive the same clamped top-left as extractCursorTemplateDecoded
  // so we can index back into the diff mask at the matching pixel.
  const half = Math.floor(size / 2);
  const left = Math.max(0, Math.min(screenshot.width - size, centre.x - half));
  const top = Math.max(0, Math.min(screenshot.height - size, centre.y - half));
  // Iterate the template's pixels; for any whose source-frame position is
  // NOT in the diff mask, zero out the RGB triple.
  for (let y = 0; y < size; y++) {
    const srcY = top + y;
    for (let x = 0; x < size; x++) {
      const srcX = left + x;
      const maskIdx = srcY * screenshot.width + srcX;
      if (!diffMask[maskIdx]) {
        const tplOff = (y * size + x) * 3;
        tpl.rgb[tplOff] = 0;
        tpl.rgb[tplOff + 1] = 0;
        tpl.rgb[tplOff + 2] = 0;
      }
    }
  }
  return tpl;
}
