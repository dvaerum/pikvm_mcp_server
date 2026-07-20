/**
 * End-to-end CLICK test using curve-one-shot, on the REAL home screen (no
 * iPadCollector — clicking must actually open apps). For each target: go home,
 * click via clickAtWithRetry({moveToOptions:{strategy:'curve-one-shot'}}),
 * screenshot after, save for visual verification (screenshots = source of truth).
 */
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGETS: Record<string, { x: number; y: number }> = {
  FaceTime: { x: 1027, y: 435 }, Files: { x: 1162, y: 435 },
  Reminders: { x: 1027, y: 570 }, Maps: { x: 1162, y: 570 },
  AppStore: { x: 1027, y: 702 }, Games: { x: 1162, y: 702 },
  Books: { x: 757, y: 837 }, Settings: { x: 1027, y: 837 },
};

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const dir = `scratch/click-test-${ts}`;
  await fs.mkdir(dir, { recursive: true });
  try { const s = await client.screenshot(); console.error(`health: ${s.screenshotWidth}x${s.screenshotHeight}`); } catch { console.error('health FAIL'); return; }

  for (let trial = 1; trial <= 2; trial++) {
    for (const [name, target] of Object.entries(TARGETS)) {
      // keepalive: wiggle resets the idle-lock timer, then go home
      await client.mouseMoveRelative(40, 40); await sleep(100); await client.mouseMoveRelative(-40, -40); await sleep(100);
      await ipadGoHome(client); await sleep(1800);
      let outcome = 'threw', resid = 'NA';
      let postShot: Buffer | null = null;
      try {
        const r = await clickAtWithRetry(client, target, {
          moveToOptions: { strategy: 'curve-one-shot', oneShotCorrectGatePx: 30 },
          maxRetries: 0,
        });
        resid = r.finalMoveResult.finalResidualPx != null ? r.finalMoveResult.finalResidualPx.toFixed(1) : 'null';
        const skip = r.attemptHistory[r.attemptHistory.length - 1]?.skippedClickReason;
        outcome = r.success ? 'SUCCESS' : skip ? `SKIP-${skip}` : 'CLICKED-UNVERIFIED';
        postShot = r.postClickScreenshot;
      } catch (e) { outcome = `threw:${(e as Error).message.slice(0, 40)}`; }
      await sleep(1200);
      const shot = postShot ?? (await client.screenshot({ quality: 80 })).buffer;
      const fname = `${dir}/t${trial}-${name}-${outcome.split(':')[0]}-r${resid}.jpg`;
      await fs.writeFile(fname, shot);
      console.error(`  t${trial} ${name}: ${outcome} resid=${resid}px → ${fname.split('/').pop()}`);
    }
  }
  await ipadGoHome(client);
  console.error(`\nSaved post-click frames to ${dir}/ — inspect to confirm the CORRECT app opened.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
