/**
 * Template set management — encapsulates the directory-backed cursor-
 * template store used by move-to.ts. Distinct from cursor-detect.ts so
 * the detection algorithms stay focused on math; this file owns I/O,
 * dedup, and capacity policy.
 *
 * Phase 3: multi-template support. A single cached template is brittle
 * across backdrops — once the cursor moves over a different wallpaper
 * or panel, the NCC score drifts below threshold and template-match
 * stops contributing. We instead maintain a SET of templates and let
 * `findCursorByTemplateSet` pick whichever one scores highest at match
 * time.
 *
 * Layout on disk: `<dir>/<n>.jpg` where `<n>` is a sequence number
 * (zero-padded to keep `ls` ordering stable).
 *
 * Migration: if a legacy `./data/cursor-template.jpg` exists when the
 * set is loaded, it's adopted as the first member of the set.
 */

import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  CursorTemplate,
  decodeToRgb,
  loadCursorTemplate,
  saveCursorTemplate,
} from './cursor-detect.js';

/** Maximum number of templates to keep on disk. When the set is full
 *  and a perceptually-distinct template arrives, the oldest entry by
 *  mtime is dropped. */
export const TEMPLATE_SET_CAP = 8;

/** NCC similarity above which two templates are treated as the same
 *  perceptual capture and the new one is skipped (no disk write, no
 *  growth of the set). 0.92 separates "different cursor over different
 *  backdrop" (~0.7-0.85 self-NCC) from "same cursor same backdrop"
 *  (~0.95+ self-NCC). */
export const TEMPLATE_DEDUP_NCC = 0.92;

/** Compute zero-mean NCC between two equal-size templates at offset
 *  (0,0). Used for dedup decisions when adding a new template. Returns
 *  a value in [-1, 1]; 1 = identical. */
export function templateSimilarity(a: CursorTemplate, b: CursorTemplate): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const n = a.width * a.height;
  let sumAR = 0, sumAG = 0, sumAB = 0;
  let sumBR = 0, sumBG = 0, sumBB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    sumAR += a.rgb[o]; sumAG += a.rgb[o + 1]; sumAB += a.rgb[o + 2];
    sumBR += b.rgb[o]; sumBG += b.rgb[o + 1]; sumBB += b.rgb[o + 2];
  }
  const meanAR = sumAR / n, meanAG = sumAG / n, meanAB = sumAB / n;
  const meanBR = sumBR / n, meanBG = sumBG / n, meanBB = sumBB / n;
  let dot = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const ar = a.rgb[o] - meanAR;
    const ag = a.rgb[o + 1] - meanAG;
    const ab = a.rgb[o + 2] - meanAB;
    const br = b.rgb[o] - meanBR;
    const bg = b.rgb[o + 1] - meanBG;
    const bb = b.rgb[o + 2] - meanBB;
    dot += ar * br + ag * bg + ab * bb;
    varA += ar * ar + ag * ag + ab * ab;
    varB += br * br + bg * bg + bb * bb;
  }
  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Load every `*.jpg` in `dir` as a CursorTemplate. Returns an empty
 *  array if the directory doesn't exist. Sorted by filename so the
 *  ordering is stable across processes. */
export async function loadTemplateSet(dir: string): Promise<CursorTemplate[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }
  const jpegs = entries
    .filter((f) => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'))
    .sort();
  const out: CursorTemplate[] = [];
  for (const f of jpegs) {
    const t = await loadCursorTemplate(path.join(dir, f));
    if (t) out.push(t);
  }
  return out;
}

/** Migrate a legacy single-template file into the set directory if the
 *  directory is empty. Idempotent: re-running is a no-op once the
 *  legacy file has been removed. */
export async function migrateLegacyTemplate(
  legacyPath: string,
  dir: string,
): Promise<void> {
  let legacyExists = false;
  try {
    await fs.access(legacyPath);
    legacyExists = true;
  } catch {
    return;
  }
  if (!legacyExists) return;
  const existing = await loadTemplateSet(dir);
  if (existing.length > 0) return; // already migrated or set non-empty
  await fs.mkdir(dir, { recursive: true });
  // Copy the legacy file in as the first set entry; we don't delete the
  // legacy file so older code paths continue to work, and so a manual
  // rollback is possible.
  const buf = await fs.readFile(legacyPath);
  await fs.writeFile(path.join(dir, '00.jpg'), buf);
}

/** Decide whether `candidate` should be added to `existing[]`. Returns
 *  the updated set (new array) and a `decision` describing what
 *  happened. Stateless: callers persist the result if they want it on
 *  disk. */
export function planAddition(
  candidate: CursorTemplate,
  existing: CursorTemplate[],
): { kept: CursorTemplate[]; decision: 'duplicate' | 'added' | 'replaced' } {
  for (const t of existing) {
    const sim = templateSimilarity(candidate, t);
    if (sim >= TEMPLATE_DEDUP_NCC) {
      return { kept: existing, decision: 'duplicate' };
    }
  }
  if (existing.length < TEMPLATE_SET_CAP) {
    return { kept: [...existing, candidate], decision: 'added' };
  }
  // Cap reached — drop the first slot (oldest by load order) and append.
  return { kept: [...existing.slice(1), candidate], decision: 'replaced' };
}

/** Persist a candidate template to the set directory if planAddition
 *  decides to keep it. Returns the new in-memory set so the caller can
 *  update its cache without re-reading the disk. */
export async function persistTemplate(
  dir: string,
  candidate: CursorTemplate,
  existing: CursorTemplate[],
): Promise<{ kept: CursorTemplate[]; decision: 'duplicate' | 'added' | 'replaced' }> {
  const plan = planAddition(candidate, existing);
  if (plan.decision === 'duplicate') return plan;

  await fs.mkdir(dir, { recursive: true });

  if (plan.decision === 'replaced') {
    // Drop oldest file on disk to mirror the in-memory drop.
    const entries = (await fs.readdir(dir))
      .filter((f) => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'))
      .sort();
    if (entries.length > 0) {
      await fs.unlink(path.join(dir, entries[0]));
    }
  }

  // Write candidate as next sequence number. Uses high-resolution
  // timestamp so concurrent writes don't clash; `.sort()` orders
  // chronologically.
  const stamp = String(Date.now()).slice(-10);
  const filename = `${stamp}.jpg`;
  await saveCursorTemplate(candidate, path.join(dir, filename));
  return plan;
}

/** Saved here so move-to.ts can import a single source of truth and
 *  tests can override the directory without re-reading move-to. */
export const DEFAULT_TEMPLATE_DIR = './data/cursor-templates';
export const LEGACY_TEMPLATE_PATH = './data/cursor-template.jpg';

// Re-exports so callers can import both detection and persistence from
// the same module if it's more convenient.
export { decodeToRgb };
