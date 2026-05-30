/**
 * D1: verify the bench's starting state.
 *
 * For each (target, trial), save the screenshot AFTER ipadGoHome()
 * + 900ms settle but BEFORE clickAtWithRetry. This is what the
 * algorithm sees at the moment it starts the click attempt — the
 * "premise" frame.
 *
 * If these frames don't show the iPad home screen with target
 * icons at the bench's hard-coded coordinates, the bench premise
 * is broken and the 0% correct-hit rate in
 * bench-ml-v0-vs-v1.ts is the bench's fault, not the algorithm's.
 *
 * Run: npx tsx bench-d1-pre-click-state.ts [trials]
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const TRIALS = process.argv[2] !== undefined ? Number(process.argv[2]) : 3;

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/d1';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 800 },
  { name: 'Books',    slug: 'books',    x: 640, y: 800 },
  { name: 'Files',    slug: 'files',    x: 1180, y: 800 },
];

console.error(`D1: ${TRIALS} trials per target, save pre-click frame only`);

for (const target of TARGETS) {
  const dir = path.join(ROOT, target.slug);
  await fs.mkdir(dir, { recursive: true });
  for (let i = 1; i <= TRIALS; i++) {
    await ipadGoHome(client);
    await new Promise((r) => setTimeout(r, 900));
    const shot = await client.screenshot();
    const file = path.join(dir, `${String(i).padStart(2, '0')}-pre.jpg`);
    await fs.writeFile(file, shot.buffer);
    console.error(
      `${target.name} trial ${i}/${TRIALS}: ` +
      `saved ${file} (${shot.buffer.length} bytes)`,
    );
  }
}

console.error(`\nDone. Frames at ${ROOT}/`);
