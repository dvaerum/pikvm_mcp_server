/**
 * openLoopShape REAL-pixel stage pinpoint (offline; consumes @georgs-mac-mini's capture).
 *
 * The offline SYNTHETIC sweep (bench-openloopshape-offline-sweep.ts) ruled out three
 * code-level causes of the live "~48% locate on grey, 0% upper-right" — detector
 * coordinate/edge, hint-radius, region-crop — so the blind-spot is realism-specific
 * to REAL captures. This script runs the openLoopShape detection STAGES INDIVIDUALLY
 * on real captured grey frames to pinpoint WHICH stage drops the upper-right cursor:
 *   - cascade       findCursorByV8FullFrame (full-frame, hint-independent) — the tracker
 *   - ml-multihint  findCursorByMLMultiHint (hint = GT, best case)
 *   - shape-dark    findCursorByShape(expectedNear=GT, r=100)
 *   - shape-bright  findCursorByShape(expectedNear=GT, r=100, brightThreshold=120)
 * (The device-only wiggle-verify gate can't run offline — flagged, not tested.)
 *
 * DATA CONTRACT (produced by the capture on the iPad node):
 *   data/openloopshape-real/manifest.jsonl — one JSON object per line:
 *     { "file": "frame-upper-right-01.jpg", "target": "upper-right",
 *       "gt_x": 1112, "gt_y": 308, "hdmi_w": 1920, "hdmi_h": 1080 }
 *   with the referenced JPEGs alongside it in the same dir. gt_x/gt_y = iPadCollector
 *   getCursor mapped to HDMI px (the real cursor tip). One+ frame per standardTarget,
 *   ESPECIALLY upper-right.
 *
 * Usage: npx tsx benches/analyze-openloopshape-real.ts [--dir data/openloopshape-real] [--hit 35]
 */
import { promises as fs } from 'fs';
import path from 'path';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { findCursorByV8FullFrame, findCursorByMLMultiHint, buildMLHints } from '../src/pikvm/cursor-ml-detect.js';

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const DIR = path.resolve(argStr('dir', 'data/openloopshape-real'));
const HIT = argNum('hit', 35);

interface ManifestRow {
  file: string; target: string; gt_x: number; gt_y: number; hdmi_w?: number; hdmi_h?: number;
}

async function main() {
  const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(DIR, 'manifest.jsonl'), 'utf8');
  } catch {
    console.error(`No manifest at ${path.join(DIR, 'manifest.jsonl')}.`);
    console.error('Waiting on the @georgs-mac-mini capture (blocked on rig HID recovery).');
    console.error('Expected contract: one JSON/line { file, target, gt_x, gt_y, hdmi_w, hdmi_h }.');
    process.exit(2);
  }
  const rows: ManifestRow[] = manifestRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const jpeg = await fs.readFile(path.join(DIR, row.file));
    const shot = await decodeScreenshot(jpeg);
    const gt = { x: row.gt_x, y: row.gt_y };

    // Stage 1: cascade (full-frame, hint-independent) — THE tracker.
    let cascade: { hit: boolean; residual: number | null } = { hit: false, residual: null };
    try {
      const v8 = await findCursorByV8FullFrame(shot.buffer, shot.width, shot.height);
      if (v8) { const r = dist(v8.x, v8.y, gt.x, gt.y); cascade = { hit: r <= HIT, residual: r }; }
    } catch { /* model/inference issue → miss */ }

    // Stage 2: ML multi-hint (hint = GT = best case).
    let ml: { hit: boolean; residual: number | null } = { hit: false, residual: null };
    try {
      const hints = buildMLHints(gt, shot.width, shot.height, gt);
      const m = await findCursorByMLMultiHint(shot.buffer, shot.width, shot.height, hints, { minConfidence: 0.5 });
      if (m) { const r = dist(m.x, m.y, gt.x, gt.y); ml = { hit: r <= HIT, residual: r }; }
    } catch { /* miss */ }

    // Stage 3: shape dark + bright (expectedNear = GT).
    const shape = (bright: boolean): { hit: boolean; residual: number | null } => {
      const c = findCursorByShape(shot.rgb, shot.width, shot.height,
        bright ? { expectedNear: gt, expectedNearRadius: 100, brightThreshold: 120 }
               : { expectedNear: gt, expectedNearRadius: 100 });
      if (!c) return { hit: false, residual: null };
      const r = dist(c.centroidX, c.centroidY, gt.x, gt.y);
      return { hit: r <= HIT, residual: r };
    };
    const dark = shape(false), brt = shape(true);

    const anyLocated = cascade.hit || ml.hit || dark.hit || brt.hit;
    results.push({ file: row.file, target: row.target, gt, cascade, ml, dark, bright: brt, anyLocated });
  }

  // Report per-target which stages locate — pinpoints the failing stage.
  const byTarget = new Map<string, Record<string, unknown>[]>();
  for (const r of results) {
    const t = r.target as string;
    byTarget.set(t, [...(byTarget.get(t) ?? []), r]);
  }
  console.log(`\nopenLoopShape REAL-pixel stage pinpoint — ${results.length} frames, HIT<=${HIT}px\n`);
  const rate = (rs: Record<string, unknown>[], k: string) =>
    `${Math.round(100 * rs.filter((r) => (r[k] as { hit: boolean }).hit).length / rs.length)}%`;
  for (const [t, rs] of [...byTarget.entries()].sort()) {
    console.log(`${t.padEnd(13)} n=${rs.length}  cascade ${rate(rs, 'cascade')}  ml ${rate(rs, 'ml')}  shape-dark ${rate(rs, 'dark')}  shape-bright ${rate(rs, 'bright')}  ANY ${Math.round(100 * rs.filter((r) => r.anyLocated).length / rs.length)}%`);
  }
  console.log('\nInterpretation: if cascade% is high everywhere, the tracker is fine — the live');
  console.log('miss is downstream (wiggle-verify or the mover feeding a bad hint). If cascade%');
  console.log('collapses at upper-right, the verifier drops the real upper-right cursor → that');
  console.log('is the fix site. shape-* is the fallback that only fires when cascade declines.');

  await fs.writeFile(path.join(DIR, 'analysis.json'), JSON.stringify({ HIT, results }, null, 2));
  console.log(`\nWrote ${path.join(DIR, 'analysis.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
