// Compare human-verified labels against the orange-moved autolabel
// (which is what v9-bordered was trained on). If they agree closely,
// retraining on human labels won't help — the labels weren't the
// bottleneck. If they differ systematically, retraining could lift
// model quality.
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface AutoEntry { frame: string; cursor: { x: number; y: number } | null; }
interface HumanEntry { frame: string; cursor: { visible: boolean; x?: number; y?: number } | null; decision: string; }

const BATCHES = [
  { dir: 'data/cursor-collect-2026-05-27T19-00-08', humanFile: 'human-verified-real.jsonl' },
  { dir: 'data/cursor-collect-2026-05-27T19-29-10', humanFile: 'human-verified-real.jsonl' },
  { dir: 'data/cursor-collect-2026-05-27T19-32-25', humanFile: 'human-verified-real.jsonl' },
];

let grandTotalCompared = 0;
let grandAgree5 = 0, grandAgree15 = 0, grandAgree35 = 0;
let grandDistances: number[] = [];
let grandPresenceDiff = 0;

for (const { dir, humanFile } of BATCHES) {
  const auto = (await fs.readFile(path.join(dir, 'cursor-orange-moved-autolabel.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as AutoEntry);
  const autoByFrame = new Map(auto.map(e => [e.frame, e.cursor]));

  const humanLines = (await fs.readFile(path.join(dir, humanFile), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as HumanEntry);
  // Last write wins
  const humanByFrame = new Map<string, HumanEntry>();
  for (const h of humanLines) {
    const key = h.frame.includes('/') ? h.frame.split('/').slice(-2).join('/') : h.frame;
    humanByFrame.set(key, h);
  }

  let n = 0, agree5 = 0, agree15 = 0, agree35 = 0, presenceDiff = 0;
  const distances: number[] = [];
  for (const [frame, autoCursor] of autoByFrame) {
    const h = humanByFrame.get(frame);
    if (!h) continue;
    n++;
    const hVis = h.cursor?.visible === true;
    const aVis = autoCursor !== null;
    if (hVis !== aVis) {
      presenceDiff++;
      continue;
    }
    if (!hVis) continue;  // both absent → trivially agree
    const d = Math.hypot(autoCursor!.x - h.cursor!.x!, autoCursor!.y - h.cursor!.y!);
    distances.push(d);
    if (d <= 5)  agree5++;
    if (d <= 15) agree15++;
    if (d <= 35) agree35++;
  }
  distances.sort((a, b) => a - b);
  const pct = (n: number, t: number) => `${n}/${t} (${(100 * n / t).toFixed(0)}%)`;
  const p = (q: number) => distances.length
    ? distances[Math.floor(distances.length * q)].toFixed(1)
    : '—';
  console.log(`\n=== ${dir} ===`);
  console.log(`  compared:          ${n}`);
  console.log(`  presence diff:     ${presenceDiff}`);
  console.log(`  agree ≤  5 px:    ${pct(agree5, n)}`);
  console.log(`  agree ≤ 15 px:    ${pct(agree15, n)}`);
  console.log(`  agree ≤ 35 px:    ${pct(agree35, n)}`);
  console.log(`  distance p50:      ${p(0.50)} px`);
  console.log(`  distance p75:      ${p(0.75)} px`);
  console.log(`  distance p95:      ${p(0.95)} px`);
  console.log(`  distance max:      ${distances.length ? distances[distances.length - 1].toFixed(1) : '—'} px`);
  grandTotalCompared += n;
  grandAgree5 += agree5;
  grandAgree15 += agree15;
  grandAgree35 += agree35;
  grandPresenceDiff += presenceDiff;
  grandDistances.push(...distances);
}

grandDistances.sort((a, b) => a - b);
const gp = (q: number) => grandDistances.length
  ? grandDistances[Math.floor(grandDistances.length * q)].toFixed(1)
  : '—';
const gpct = (n: number, t: number) => `${n}/${t} (${(100 * n / t).toFixed(0)}%)`;
console.log(`\n=== TOTAL (3 batches) ===`);
console.log(`  compared:          ${grandTotalCompared}`);
console.log(`  presence diff:     ${grandPresenceDiff}`);
console.log(`  agree ≤  5 px:    ${gpct(grandAgree5, grandTotalCompared)}`);
console.log(`  agree ≤ 15 px:    ${gpct(grandAgree15, grandTotalCompared)}`);
console.log(`  agree ≤ 35 px:    ${gpct(grandAgree35, grandTotalCompared)}`);
console.log(`  distance p50:      ${gp(0.50)} px`);
console.log(`  distance p75:      ${gp(0.75)} px`);
console.log(`  distance p95:      ${gp(0.95)} px`);
console.log(`  distance max:      ${grandDistances.length ? grandDistances[grandDistances.length - 1].toFixed(1) : '—'} px`);
