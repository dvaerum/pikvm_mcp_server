/**
 * Phase 295: validate Phase 294 across DIVERSE icon-center targets.
 *
 * Phase 294 showed 95% near (905, 800) which is the Settings vicinity.
 * The user's acceptance gate is "≥4/5 trials within 30 px on diverse
 * cursor positions". This bench tests four ICON-CENTER targets at
 * N=10 each. Inter-icon positions (like Phase 291's far at 757, 832)
 * are SNAP ZONES and known to be physically unreachable on this iPad.
 *
 * Targets — bottom-row visible icons:
 *   (642, 810) Books
 *   (773, 810) TV
 *   (905, 810) Settings
 * Plus one mid-screen:
 *   (1027, 660) Maps (right-hand icon row, mid-height)
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = `./data/phase295-diverse/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 295 diverse-target bench at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGETS = [
  { x: 642, y: 810, label: 'Books'    },
  { x: 773, y: 810, label: 'TV'       },
  { x: 905, y: 810, label: 'Settings' },
  { x: 1027, y: 660, label: 'Maps'    },
];
const N = 10;
const TOL = 30;

const summary: { target: string; hits: number; details: (string | number)[] }[] = [];

for (const target of TARGETS) {
  console.error(`\n>>> Target ${target.label}: (${target.x}, ${target.y}) <<<`);
  let hits = 0;
  const details: (string | number)[] = [];
  for (let i = 1; i <= N; i++) {
    await ipadGoHome(client, { forceHomeViaSwipe: true });
    await sleep(1200);
    let residual: number | string = 'n/a';
    let withinTol = false;
    try {
      const r = await moveToPixel(client, target, {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      });
      if (r.finalDetectedPosition && r.finalResidualPx !== null) {
        residual = Math.round(r.finalResidualPx);
        withinTol = r.finalResidualPx <= TOL;
      }
    } catch {/* keep null */}
    if (withinTol) hits++;
    details.push(residual);
    console.error(`  t${i.toString().padStart(2, '0')}: r=${typeof residual === 'number' ? residual.toString().padStart(3) + 'px' : 'null  '} ${withinTol ? '✓' : '✗'}`);
  }
  console.error(`  >>> ${target.label}: ${hits}/${N} within ${TOL} px`);
  summary.push({ target: `${target.label} (${target.x},${target.y})`, hits, details });
}

console.error(`\n=== RESULT (N=${N} per target, within ${TOL} px) ===`);
for (const r of summary) {
  console.error(`  ${r.target.padEnd(28)} ${r.hits}/${N}  details=[${r.details.join(', ')}]`);
}
await fs.writeFile(`${ROOT}/summary.json`, JSON.stringify(summary, null, 2));
process.exit(0);
