/**
 * Convert cursor-bordered-autolabel.jsonl into a verified.jsonl that
 * the label-review tool can consume. The auto-label goes into the
 * `algorithm_label` slot (yellow marker), and `cursor` is set to null
 * so each frame is shown as "unverified" and the human must label.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T18-18-56';
const SRC = path.join(ROOT, 'cursor-bordered-autolabel.jsonl');
const OUT = path.join(ROOT, 'verified.jsonl');

async function main() {
  const text = await fs.readFile(SRC, 'utf8');
  const lines = text.trim().split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const auto = JSON.parse(line);
    const abs = path.resolve(ROOT, auto.frame);
    const entry: Record<string, unknown> = {
      abs_frame_path: abs,
      cursor: null,
      scene: auto.frame.split('/')[0],
    };
    if (auto.cursor) {
      entry.algorithm_label = { x: auto.cursor.x, y: auto.cursor.y };
    }
    out.push(JSON.stringify(entry));
  }
  await fs.writeFile(OUT, out.join('\n') + '\n');
  console.log(`Wrote ${out.length} entries → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
