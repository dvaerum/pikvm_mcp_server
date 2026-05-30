// Parse latest PA26 bench output and emit verified.jsonl for label review.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const txt = await fs.readFile('/tmp/bench-pa26.txt', 'utf-8');
const lines = txt.split('\n');

const out: string[] = [];
let scene = '';

for (const line of lines) {
  const sceneMatch = line.match(/=== (\w+) \(\d+, \d+\)/);
  if (sceneMatch) {
    scene = sceneMatch[1].toLowerCase();
    continue;
  }
  // Match e.g. "  1/15 SKIP attempts=4 pos=(764,564) sim=1.000 → data/click-bench-prod/books/01-skip.jpg"
  const m = line.match(/^\s*(\d+)\/\d+ (\w+) attempts=\d+ pos=\((-?\d+),(-?\d+)\) sim=([\d.]+) → (\S+\.jpg)/);
  if (!m) continue;
  const [, , cls, xStr, yStr, sim, relPath] = m;
  const absPath = path.resolve(relPath);
  // Skip if file doesn't exist (latest run only keeps current frames)
  try {
    await fs.access(absPath);
  } catch { continue; }
  out.push(JSON.stringify({
    abs_frame_path: absPath,
    cursor: null,
    scene: `${scene}:${cls}`,
    algorithm_label: { x: Number(xStr), y: Number(yStr) },
    sim: Number(sim),
  }));
}

const outDir = 'data/verify-pa26';
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, 'verified.jsonl');
await fs.writeFile(outPath, out.join('\n') + '\n');
console.log(`Wrote ${out.length} entries to ${outPath}`);
