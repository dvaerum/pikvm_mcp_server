// Compare human labels vs algorithm-reported positions per scene+class.
import { promises as fs } from 'node:fs';

const src = (await fs.readFile('data/verify-pa26/verified.jsonl', 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));
const hum = (await fs.readFile('data/verify-pa26/human-verified.jsonl', 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

// Index humans by frame basename (target/file.jpg)
const humByPath = new Map<string, any>();
for (const h of hum) humByPath.set(h.frame.split('/').slice(-2).join('/'), h);
// Index src by same key
function key(absPath: string): string {
  return absPath.split('/').slice(-2).join('/');
}

let total = 0, agree35 = 0, agree80 = 0, absent = 0, cursorPresent = 0;
const targetTrue = { hit: 0, skip: 0, miss: 0, nolaunch: 0 };
const targetNo = { hit: 0, skip: 0, miss: 0, nolaunch: 0 };
const perScene: Record<string, { n: number; algoCorrect: number; absent: number; cursorPresent: number }> = {};

for (const s of src) {
  const h = humByPath.get(key(s.abs_frame_path));
  if (!h) continue;
  total++;
  const scene = s.scene; // e.g. "books:SKIP"
  perScene[scene] ??= { n: 0, algoCorrect: 0, absent: 0, cursorPresent: 0 };
  perScene[scene].n++;

  if (h.decision === 'absent' || h.cursor?.visible === false) {
    absent++;
    perScene[scene].absent++;
    continue;
  }
  cursorPresent++;
  perScene[scene].cursorPresent++;
  const algo = s.algorithm_label;
  const c = h.cursor;
  if (!c || c.x == null) continue;
  const d = Math.hypot(algo.x - c.x, algo.y - c.y);
  if (d <= 35) agree35++;
  if (d <= 80) agree80++;
  if (d <= 35) perScene[scene].algoCorrect++;
}

console.log(`Total: ${total}`);
console.log(`Cursor absent (no visible cursor): ${absent}/${total}`);
console.log(`Cursor present:                    ${cursorPresent}/${total}`);
console.log(`Algorithm correct (≤35 px):        ${agree35}/${cursorPresent} = ${(100*agree35/cursorPresent).toFixed(0)}% (of present-cursor frames)`);
console.log(`Algorithm close (≤80 px):          ${agree80}/${cursorPresent} = ${(100*agree80/cursorPresent).toFixed(0)}%`);
console.log();
console.log('Per scene:');
for (const [k, v] of Object.entries(perScene).sort()) {
  console.log(
    `  ${k.padEnd(20)} n=${v.n.toString().padStart(2)} absent=${v.absent.toString().padStart(2)} ` +
    `present=${v.cursorPresent.toString().padStart(2)} algo-correct(≤35)=${v.algoCorrect}/${v.cursorPresent}`,
  );
}
