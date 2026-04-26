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
  diffScreenshotsDecoded,
  extractCursorTemplateDecoded,
} from './cursor-detect.js';
import type { CursorTemplate } from './cursor-detect.js';
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
  const clusters = diffScreenshotsDecoded(decBefore, decAfter, {
    diffThreshold: 30,
    minClusterSize: 4,
    maxClusterSize: 200,
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
        'no motion-diff clusters detected — cursor may be off-screen, dim, or already at the wake-emit destination. Try a larger emitDx/emitDy.',
    };
  }
  const cursorCluster = clusters.sort((a, b) => b.pixels - a.pixels)[0];
  const cursorPos = {
    x: Math.round(cursorCluster.centroidX),
    y: Math.round(cursorCluster.centroidY),
  };
  // Reuse the already-decoded `decAfter` rather than re-decoding the
  // JPEG via the convenience wrapper. Avoids one full sharp() pipeline
  // per seed call.
  const template = extractCursorTemplateDecoded(decAfter, cursorPos, 24);
  if (!looksLikeCursor(template)) {
    return {
      ok: false,
      cursorPosition: cursorPos,
      templatePersisted: false,
      reason:
        'looksLikeCursor rejected the extracted template (cohesion / brightness / saturation gate failed). The motion-diff cluster may not actually be the cursor — try a different wake emit, or check that the iPad screen is bright enough.',
    };
  }
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
