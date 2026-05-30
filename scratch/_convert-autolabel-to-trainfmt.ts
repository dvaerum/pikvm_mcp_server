/**
 * Convert cursor-orange-moved-autolabel.jsonl to the format expected by
 * train-cursor-v8.py (and similar). Output goes into the same dataset
 * directory as `human-verified.jsonl` so the trainer can pick it up.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T19-00-08';
const SRC = path.join(ROOT, 'cursor-orange-moved-autolabel.jsonl');
const OUT = path.join(ROOT, 'human-verified.jsonl');

interface Auto { frame: string; cursor: { x: number; y: number } | null; decision: string; }

async function main() {
  const lines = (await fs.readFile(SRC, 'utf8')).trim().split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const a = JSON.parse(line) as Auto;
    const entry: Record<string, unknown> = { frame: a.frame };
    if (a.cursor) {
      entry.cursor = { visible: true, x: a.cursor.x, y: a.cursor.y };
      entry.decision = 'correct';
    } else {
      entry.cursor = { visible: false };
      entry.decision = 'absent';
    }
    entry.decided_at = new Date().toISOString();
    out.push(JSON.stringify(entry));
  }
  await fs.writeFile(OUT, out.join('\n') + '\n');
  console.log(`Wrote ${out.length} entries → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
