/**
 * Phase 192-B (v0.5.182) — frame-by-frame cursor trajectory capture
 * with CursorBelief instrumentation.
 *
 * Each chunk emit records both the visible frame AND the belief's
 * predicted position ± σ. Output:
 *   - PNG frames at  ./data/trajectory-frames/{T}/NN-cN.jpg
 *   - JSONL log at   ./data/trajectory-frames/predictions.jsonl
 *
 * The JSONL log lets later analysis cross-check predictions against
 * cursor positions read from the screenshots.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

// iPad letterbox bounds at 1680×1050 (read from prior trajectory data —
// iPad area is roughly x=510..1170, y=50..1010).
client.setBeliefBounds({ x: 510, y: 50, width: 660, height: 960 });

const ROOT = './data/trajectory-frames';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'predictions.jsonl');

interface LogRow {
  trajectory: string;
  frame: number;
  label: string;
  emit: { dx: number; dy: number } | null;
  beliefBefore: { x: number; y: number; sx: number; sy: number } | null;
  beliefAfter: { x: number; y: number; sx: number; sy: number };
  ratio: { x: number; y: number };
  edges: { north: boolean; south: boolean; east: boolean; west: boolean };
}

async function appendLog(row: LogRow): Promise<void> {
  await fs.appendFile(LOG, JSON.stringify(row) + '\n');
}

function snapshotBelief() {
  return {
    x: client.belief.position.x,
    y: client.belief.position.y,
    sx: Math.sqrt(client.belief.variance.x),
    sy: Math.sqrt(client.belief.variance.y),
  };
}

async function snap(dir: string, idx: number, label: string): Promise<void> {
  await new Promise(r => setTimeout(r, 80));
  const shot = await client.screenshot({ quality: 75 });
  const file = path.join(ROOT, dir, `${idx.toString().padStart(2, '0')}-${label}.jpg`);
  await fs.writeFile(file, shot.buffer);
}

async function wakeup(): Promise<void> {
  await client.mouseMoveRelative(30, 0);
  await new Promise(r => setTimeout(r, 80));
  await client.mouseMoveRelative(-30, 0);
  await new Promise(r => setTimeout(r, 250));
}

async function trajectory(
  name: string,
  dx: number,
  dy: number,
  chunks: number,
  paceMs: number,
): Promise<void> {
  const dir = name;
  await fs.mkdir(path.join(ROOT, dir), { recursive: true });
  console.error(`\n=== ${name}: ${chunks} chunks of (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}) @ ${paceMs}ms ===`);

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 1000));
  await wakeup();
  await snap(dir, 0, 'start');

  // Belief at start frame — the wakeup emits already updated it; we
  // log "after" only for the start frame since there's no "before".
  await appendLog({
    trajectory: name,
    frame: 0,
    label: 'start',
    emit: null,
    beliefBefore: null,
    beliefAfter: snapshotBelief(),
    ratio: { x: client.belief.ratio.x, y: client.belief.ratio.y },
    edges: client.belief.isAtEdge(),
  });
  console.error(`  ${name}/00-start.jpg | belief ${formatBelief()}`);

  for (let i = 1; i <= chunks; i++) {
    const before = snapshotBelief();
    await client.mouseMoveRelative(dx, dy);
    const after = snapshotBelief();
    await new Promise(r => setTimeout(r, paceMs - 80));
    await snap(dir, i, `c${i}`);
    await appendLog({
      trajectory: name,
      frame: i,
      label: `c${i}`,
      emit: { dx, dy },
      beliefBefore: before,
      beliefAfter: after,
      ratio: { x: client.belief.ratio.x, y: client.belief.ratio.y },
      edges: client.belief.isAtEdge(),
    });
    console.error(`  ${name}/${i.toString().padStart(2, '0')}-c${i}.jpg | belief ${formatBelief()}`);
  }

  await new Promise(r => setTimeout(r, 400));
  await snap(dir, chunks + 1, 'settle');
  await appendLog({
    trajectory: name,
    frame: chunks + 1,
    label: 'settle',
    emit: null,
    beliefBefore: null,
    beliefAfter: snapshotBelief(),
    ratio: { x: client.belief.ratio.x, y: client.belief.ratio.y },
    edges: client.belief.isAtEdge(),
  });
  console.error(`  ${name}/${(chunks + 1).toString().padStart(2, '0')}-settle.jpg | belief ${formatBelief()}`);
}

function formatBelief(): string {
  const b = client.belief;
  const e = b.isAtEdge();
  const eFlags = (['north', 'south', 'east', 'west'] as const)
    .filter(k => e[k]).join(',') || '-';
  return (
    `pos=(${b.position.x.toFixed(0)}±${Math.sqrt(b.variance.x).toFixed(0)}, ` +
    `${b.position.y.toFixed(0)}±${Math.sqrt(b.variance.y).toFixed(0)}) ` +
    `ratio=(${b.ratio.x.toFixed(2)},${b.ratio.y.toFixed(2)}) edges=${eFlags}`
  );
}

async function main(): Promise<void> {
  await trajectory('T1-eastward', 15, 0, 6, 120);
  await trajectory('T2-southward', 0, 15, 6, 120);
  await trajectory('T3-edge-nw', -50, -50, 8, 120);
  console.error(`\nFrames + belief log saved under ${ROOT}`);
  console.error(`Inspect: jq . ${LOG}`);
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
