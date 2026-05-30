// Score v10's live predictions against your human labels on the 20
// pre-click frames. Also compares v9-bordered's parallel prediction.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BENCH = 'data/cursor-collect-v10-livebench-2026-05-30T07-00-55';

const src = (await fs.readFile(path.join(BENCH, 'verified-for-review.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));
const human = (await fs.readFile(path.join(BENCH, 'human-verified.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const humanByPath = new Map<string, any>();
for (const h of human) {
  humanByPath.set(h.frame.split('/').slice(-2).join('/'), h);
}

const v10Dists: number[] = [];
const v9Dists: number[] = [];
const rows: Array<{ scene: string; classification: string; truth: {x:number;y:number}; v10: {x:number;y:number}; v9: {x:number;y:number}; d10: number; d9: number; better: 'v10'|'v9'|'tie' }> = [];

for (const s of src) {
  const key = s.abs_frame_path.split('/').slice(-2).join('/');
  const h = humanByPath.get(key);
  if (!h || !h.cursor?.visible) continue;
  const truth = { x: h.cursor.x, y: h.cursor.y };
  const v10 = s.algorithm_label;
  const v9 = s.v9_label;
  const d10 = Math.hypot(v10.x - truth.x, v10.y - truth.y);
  const d9 = Math.hypot(v9.x - truth.x, v9.y - truth.y);
  v10Dists.push(d10);
  v9Dists.push(d9);
  rows.push({
    scene: s.scene,
    classification: s.classification,
    truth, v10, v9,
    d10: Math.round(d10),
    d9: Math.round(d9),
    better: d10 < d9 ? 'v10' : d9 < d10 ? 'v9' : 'tie',
  });
}

const p = (arr: number[], q: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
};
const fmt = (arr: number[]) =>
  `p50=${p(arr, 0.5)}  p75=${p(arr, 0.75)}  p95=${p(arr, 0.95)}  max=${p(arr, 1.0)}`;
const ratePct = (arr: number[], t: number) =>
  `${arr.filter(d => d <= t).length}/${arr.length} (${(100 * arr.filter(d => d <= t).length / arr.length).toFixed(0)}%)`;

console.log(`Frames compared: ${rows.length}\n`);
console.log(`v10 (live) → ${fmt(v10Dists)}`);
console.log(`v9  (live) → ${fmt(v9Dists)}\n`);
console.log(`v10 ≤ 35 px: ${ratePct(v10Dists, 35)}`);
console.log(`v9  ≤ 35 px: ${ratePct(v9Dists, 35)}`);
console.log(`v10 ≤ 80 px: ${ratePct(v10Dists, 80)}`);
console.log(`v9  ≤ 80 px: ${ratePct(v9Dists, 80)}`);
console.log();
const v10Wins = rows.filter(r => r.better === 'v10').length;
const v9Wins = rows.filter(r => r.better === 'v9').length;
console.log(`per-frame: v10 closer ${v10Wins}, v9 closer ${v9Wins}, tied ${rows.length - v10Wins - v9Wins}\n`);

console.log('Per frame (truth | v10 dist | v9 dist | winner | classification):');
for (const r of rows.sort((a, b) => a.scene.localeCompare(b.scene))) {
  console.log(`  ${r.scene.padEnd(20)} truth=(${r.truth.x},${r.truth.y}) v10=${String(r.d10).padStart(4)}  v9=${String(r.d9).padStart(4)}  ${r.better}  ${r.classification}`);
}
