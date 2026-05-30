// Build label-review source jsonls for the three orange-cursor training
// batches that v9-bordered was actually trained on. Each output entry
// has abs_frame_path (server requires this) plus algorithm_label from
// the orange-moved autolabel so the rater sees where the algo thinks
// the cursor is.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BATCHES = [
  'data/cursor-collect-2026-05-27T19-00-08',
  'data/cursor-collect-2026-05-27T19-29-10',
  'data/cursor-collect-2026-05-27T19-32-25',
];

for (const batch of BATCHES) {
  const autolabel = (await fs.readFile(path.join(batch, 'cursor-orange-moved-autolabel.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const out = autolabel.map(e => JSON.stringify({
    abs_frame_path: path.resolve(batch, e.frame),
    cursor: null,
    scene: e.frame.split('/')[0],
    algorithm_label: e.cursor,
    autolabel_decision: e.decision,
    autolabel_pixels: e.pixels,
  }));
  await fs.writeFile(path.join(batch, 'verified-for-review.jsonl'), out.join('\n') + '\n');
  console.log(`wrote ${out.length} entries to ${batch}/verified-for-review.jsonl`);
}
