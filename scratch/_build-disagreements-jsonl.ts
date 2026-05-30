// Build a per-batch "disagreements" jsonl: only the frames where the
// orange-moved autolabel and the agent label disagree by >50 px (or one
// says present + the other says absent). These are the high-value
// frames for human attention.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BATCHES = [
  'data/cursor-collect-2026-05-27T19-29-10',
  'data/cursor-collect-2026-05-27T19-32-25',
];

interface Cursor { x: number; y: number; }
interface Entry { frame: string; cursor: Cursor | null; decision?: string; }

const DISTANCE_THRESHOLD = 50;

for (const batch of BATCHES) {
  const autolabel = (await fs.readFile(path.join(batch, 'cursor-orange-moved-autolabel.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
  const autoByFrame = new Map(autolabel.map(e => [e.frame, e]));

  const dir = path.join(batch, 'agent-labels');
  const files = (await fs.readdir(dir)).filter(f =>
    f.endsWith('.jsonl') && !f.includes('SHARP-ALGO'),
  );
  const agentEntries: Entry[] = [];
  for (const f of files) {
    const slice = (await fs.readFile(path.join(dir, f), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
    agentEntries.push(...slice);
  }

  const disagreements: any[] = [];
  let nAgreePresent = 0, nAgreeAbsent = 0, nDistance = 0, nPresenceDiff = 0;
  for (const a of agentEntries) {
    const auto = autoByFrame.get(a.frame);
    if (!auto) continue;
    const autoCursor = auto.cursor;
    const agentCursor = a.cursor;
    if (autoCursor && agentCursor) {
      const d = Math.hypot(autoCursor.x - agentCursor.x, autoCursor.y - agentCursor.y);
      if (d > DISTANCE_THRESHOLD) {
        nDistance++;
        disagreements.push({
          abs_frame_path: path.resolve(batch, a.frame),
          cursor: null,
          scene: a.frame.split('/')[0],
          algorithm_label: autoCursor,
          agent_label: agentCursor,
          agent_decision: a.decision,
          disagreement_distance: Math.round(d),
          disagreement_type: 'position',
        });
      } else {
        nAgreePresent++;
      }
    } else if (autoCursor || agentCursor) {
      nPresenceDiff++;
      disagreements.push({
        abs_frame_path: path.resolve(batch, a.frame),
        cursor: null,
        scene: a.frame.split('/')[0],
        algorithm_label: autoCursor ?? agentCursor,
        agent_label: agentCursor,
        agent_decision: a.decision,
        autolabel_says_present: !!autoCursor,
        disagreement_type: 'presence',
      });
    } else {
      nAgreeAbsent++;
    }
  }

  const out = path.join(batch, 'disagreements-for-review.jsonl');
  await fs.writeFile(out, disagreements.map(d => JSON.stringify(d)).join('\n') + '\n');
  console.log(`${batch}:`);
  console.log(`  total compared:           ${agentEntries.length}`);
  console.log(`  agree present (≤${DISTANCE_THRESHOLD}px): ${nAgreePresent}`);
  console.log(`  agree absent:             ${nAgreeAbsent}`);
  console.log(`  disagree on position:     ${nDistance}`);
  console.log(`  disagree on presence:     ${nPresenceDiff}`);
  console.log(`  wrote ${disagreements.length} disagreements → ${out}`);
}
