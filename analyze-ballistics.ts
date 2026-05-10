/**
 * Phase 206 — analyze the existing ballistics.json for the
 * acceleration curve the user predicted exists.
 *
 * Loads data/ballistics.json, groups samples by (axis, pace),
 * tabulates px/mickey vs magnitude. Looks for the smooth curve.
 *
 * Usage: npx tsx analyze-ballistics.ts
 */

import { promises as fs } from 'fs';

interface Sample {
  axis: 'x' | 'y';
  magnitude: number;
  pace: 'fast' | 'slow';
  callCount: number;
  mickeysEmitted: number;
  pixelsMeasured: number;
  pxPerMickey: number;
  rep: number;
}

interface Profile {
  version: number;
  createdAt: string;
  resolution: { width: number; height: number };
  samples: Sample[];
}

const profile: Profile = JSON.parse(await fs.readFile('./data/ballistics.json', 'utf8'));
console.log(`Profile created: ${profile.createdAt}`);
console.log(`Resolution: ${profile.resolution.width}x${profile.resolution.height}`);
console.log(`Total samples: ${profile.samples.length}\n`);

// Group: (axis, pace, magnitude) → list of px/mickey
const grouped = new Map<string, number[]>();
for (const s of profile.samples) {
  const key = `${s.axis}:${s.pace}:${s.magnitude}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key)!.push(s.pxPerMickey);
}

// Aggregate medians
type Row = { axis: 'x' | 'y'; pace: string; magnitude: number; median: number; samples: number };
const rows: Row[] = [];
for (const [key, values] of grouped.entries()) {
  const [axis, pace, magStr] = key.split(':');
  values.sort((a, b) => a - b);
  const median = values.length % 2 === 1
    ? values[Math.floor(values.length / 2)]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  rows.push({
    axis: axis as 'x' | 'y',
    pace,
    magnitude: Number(magStr),
    median,
    samples: values.length,
  });
}

// Sort by axis, pace, magnitude
rows.sort((a, b) =>
  a.axis.localeCompare(b.axis) ||
  a.pace.localeCompare(b.pace) ||
  a.magnitude - b.magnitude
);

// Print as table
console.log('axis | pace | mag | px/mickey (median) | n');
console.log('-----+------+-----+-------------------+---');
for (const r of rows) {
  console.log(
    `${r.axis}    | ${r.pace.padEnd(4)} | ${String(r.magnitude).padStart(3)} | ${r.median.toFixed(3).padStart(17)} | ${r.samples}`,
  );
}

// Per-axis-pace, look at the relationship:
// px/mickey vs magnitude
console.log('\n=== Curve analysis (per axis × pace) ===');
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.axis}:${r.pace}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

for (const [key, gRows] of groups.entries()) {
  console.log(`\n${key}: ${gRows.length} magnitude points`);
  console.log('  mag | px/mickey | px/mickey × mag = effective px per call');
  for (const r of gRows) {
    const effective = r.median * r.magnitude;
    console.log(`  ${String(r.magnitude).padStart(3)} | ${r.median.toFixed(3).padStart(7)}   | ${effective.toFixed(1)}`);
  }

  // Check if log-magnitude vs log-pxpermickey is linear
  // (would suggest a power law)
  if (gRows.length >= 3) {
    const xs = gRows.map(r => Math.log(r.magnitude));
    const ys = gRows.map(r => Math.log(r.median));
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    const slope = num / den;
    const intercept = meanY - slope * meanX;
    console.log(`  Power-law fit: log(px/mickey) = ${slope.toFixed(3)} * log(magnitude) + ${intercept.toFixed(3)}`);
    console.log(`  → px/mickey ≈ ${Math.exp(intercept).toFixed(3)} * magnitude^${slope.toFixed(3)}`);
    console.log(`  → effective px = ${Math.exp(intercept).toFixed(3)} * magnitude^${(slope + 1).toFixed(3)}`);
  }
}
