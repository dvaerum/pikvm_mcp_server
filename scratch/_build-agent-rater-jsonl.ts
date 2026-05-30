// Build agent-for-review.jsonl: each frame has the agent's coords in the
// `cursor` field (so they render as the LABEL / green arrow) and the
// orange-moved autolabel in `algorithm_label` (so it renders as the yellow
// arrow). User sees both predictions overlaid and can confirm or correct
// the agent's pick directly.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BATCHES = [
  'data/cursor-collect-2026-05-27T19-29-10',
  'data/cursor-collect-2026-05-27T19-32-25',
];

interface Entry { frame: string; cursor: { x: number; y: number } | null; decision?: string; }

for (const batch of BATCHES) {
  // Load orange-moved autolabel for cross-reference
  const auto = (await fs.readFile(path.join(batch, 'cursor-orange-moved-autolabel.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
  const autoByFrame = new Map(auto.map(e => [e.frame, e.cursor]));

  // Combine the per-slice agent labels
  const dir = path.join(batch, 'agent-labels');
  const files = (await fs.readdir(dir)).filter(f =>
    f.endsWith('.jsonl') && !f.includes('SHARP-ALGO'),
  );
  const out: string[] = [];
  for (const f of files) {
    const slice = (await fs.readFile(path.join(dir, f), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
    for (const e of slice) {
      const agentCursor = e.cursor;
      const autolabelCursor = autoByFrame.get(e.frame) ?? null;
      // The agent's prediction becomes the LABEL (green arrow):
      //   present + position → visible: true
      //   absent             → visible: false
      const labelCursor = agentCursor
        ? { visible: true, x: agentCursor.x, y: agentCursor.y }
        : { visible: false, x: null, y: null };
      out.push(JSON.stringify({
        abs_frame_path: path.resolve(batch, e.frame),
        cursor: labelCursor,
        scene: e.frame.split('/')[0],
        algorithm_label: autolabelCursor,
        agent_decision: e.decision,
      }));
    }
  }
  const outPath = path.join(batch, 'agent-for-review.jsonl');
  await fs.writeFile(outPath, out.join('\n') + '\n');
  console.log(`${batch}: ${out.length} entries → ${outPath}`);
}
