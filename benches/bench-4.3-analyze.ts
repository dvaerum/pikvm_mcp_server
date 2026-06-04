/**
 * 4.3' Analyzer: consume two run dirs (v12 + v13) from
 * bench-4.3-groundtruth and produce the head-to-head verdict.
 *
 * Per cross-cutting rule, the comparison metric is detector_vs_ipad
 * (how far the production detector's reported position was from
 * iPadCollector's ground truth), NOT residual_detector (which would
 * let the detector judge itself). residual_ipad is reported as a
 * sanity check on whether the cursor was actually near the target.
 *
 * Usage: tsx benches/bench-4.3-analyze.ts <v12-dir> <v13-dir>
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface Row {
  trial: number;
  attempt: number;
  detector_x: string;
  detector_y: string;
  ipad_x_hdmi: string;
  ipad_y_hdmi: string;
  residual_detector: string;
  residual_ipad: string;
  detector_minus_ipad: string;
  frame: string;
}

async function loadRows(dir: string): Promise<Row[]> {
  const tsv = await fs.readFile(path.join(dir, 'summary.tsv'), 'utf8');
  const [header, ...lines] = tsv.split('\n').filter((l) => l.trim());
  const cols = header.split('\t');
  return lines.map((l) => {
    const fields = l.split('\t');
    const o: Record<string, string> = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = fields[i] ?? '';
    return {
      trial: Number(o.trial),
      attempt: Number(o.attempt),
      detector_x: o.detector_x,
      detector_y: o.detector_y,
      ipad_x_hdmi: o.ipad_x_hdmi,
      ipad_y_hdmi: o.ipad_y_hdmi,
      residual_detector: o.residual_detector,
      residual_ipad: o.residual_ipad,
      detector_minus_ipad: o.detector_minus_ipad,
      frame: o.frame,
    };
  });
}

function num(s: string): number | null {
  if (s === '' || s === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function stats(values: number[]): { n: number; p50: number; mean: number; p25: number; p75: number; p95: number; max: number } {
  if (values.length === 0) return { n: 0, p50: NaN, mean: NaN, p25: NaN, p75: NaN, p95: NaN, max: NaN };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
  return {
    n: s.length,
    p50: q(0.5),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p25: q(0.25),
    p75: q(0.75),
    p95: q(0.95),
    max: s[s.length - 1],
  };
}

function fmt(s: ReturnType<typeof stats>): string {
  return `n=${s.n} p50=${s.p50.toFixed(1)} mean=${s.mean.toFixed(1)} p25=${s.p25.toFixed(1)} p75=${s.p75.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`;
}

async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('Usage: tsx benches/bench-4.3-analyze.ts <v12-dir> <v13-dir>');
    process.exit(2);
  }
  const rowsA = await loadRows(a);
  const rowsB = await loadRows(b);
  console.log(`v12 dir: ${a} (${rowsA.length} rows)`);
  console.log(`v13 dir: ${b} (${rowsB.length} rows)`);

  const detVsIpadA = rowsA.map((r) => num(r.detector_minus_ipad)).filter((v): v is number => v !== null);
  const detVsIpadB = rowsB.map((r) => num(r.detector_minus_ipad)).filter((v): v is number => v !== null);
  const ipadResA = rowsA.map((r) => num(r.residual_ipad)).filter((v): v is number => v !== null);
  const ipadResB = rowsB.map((r) => num(r.residual_ipad)).filter((v): v is number => v !== null);

  console.log('\n=== detector_vs_ipad (the A/B metric — lower = detector closer to truth) ===');
  console.log(`v12: ${fmt(stats(detVsIpadA))}`);
  console.log(`v13: ${fmt(stats(detVsIpadB))}`);

  console.log('\n=== residual_ipad (sanity — was cursor actually near target?) ===');
  console.log(`v12: ${fmt(stats(ipadResA))}`);
  console.log(`v13: ${fmt(stats(ipadResB))}`);

  // Paired-attempt comparison: when both runs cover the same
  // (trial, attempt) and both have valid det_vs_ipad, count wins/losses.
  const keyA = new Map(rowsA.map((r) => [`${r.trial}.${r.attempt}`, r] as const));
  let v12Better = 0, tied = 0, v13Better = 0, missing = 0;
  for (const rB of rowsB) {
    const rA = keyA.get(`${rB.trial}.${rB.attempt}`);
    if (!rA) { missing++; continue; }
    const a12 = num(rA.detector_minus_ipad);
    const a13 = num(rB.detector_minus_ipad);
    if (a12 === null || a13 === null) { missing++; continue; }
    if (Math.abs(a12 - a13) < 0.5) tied++;
    else if (a13 < a12) v13Better++;
    else v12Better++;
  }
  console.log(`\n=== paired by (trial, attempt) ===`);
  console.log(`v13 better: ${v13Better}  tied: ${tied}  v12 better: ${v12Better}  missing/null: ${missing}`);

  // Divergence frames: paired rows where detector_minus_ipad differs by ≥15 px.
  // These deserve visual audit.
  const divergences: { trial: number; attempt: number; v12: number; v13: number; v12Frame: string; v13Frame: string }[] = [];
  for (const rB of rowsB) {
    const rA = keyA.get(`${rB.trial}.${rB.attempt}`);
    if (!rA) continue;
    const a12 = num(rA.detector_minus_ipad);
    const a13 = num(rB.detector_minus_ipad);
    if (a12 === null || a13 === null) continue;
    if (Math.abs(a12 - a13) >= 15) {
      divergences.push({ trial: rB.trial, attempt: rB.attempt, v12: a12, v13: a13, v12Frame: rA.frame, v13Frame: rB.frame });
    }
  }
  console.log(`\n=== divergences (|v12_det_vs_ipad − v13_det_vs_ipad| ≥ 15 px) ===`);
  for (const d of divergences) {
    console.log(`  trial ${d.trial} a${d.attempt}: v12=${d.v12.toFixed(1)} v13=${d.v13.toFixed(1)}  Δ=${(d.v13 - d.v12).toFixed(1)}`);
    console.log(`    v12 ${a}/${d.v12Frame}`);
    console.log(`    v13 ${b}/${d.v13Frame}`);
  }
  console.log(`(visually inspect each — that's the audit per 1.13b lesson)`);
}

main().catch((e) => { console.error(`FATAL: ${e}`); process.exit(2); });
