/**
 * N=80 click success bench for the SHIPPED default (curve-one-shot + correction).
 * Automated hit detection: an opened app fills the screen, a MISS stays on home.
 * So hit = post-click frame (cropped to iPad region) differs substantially from
 * the home baseline. Not "did the RIGHT app open" (residual+visual spot-checks
 * cover that) but "did SOMETHING open vs stayed home" — the miss signal.
 */
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRIALS = 10;
const TARGETS: Record<string, { x: number; y: number }> = {
  FaceTime: { x: 1027, y: 435 }, Files: { x: 1162, y: 435 },
  Reminders: { x: 1027, y: 570 }, Maps: { x: 1162, y: 570 },
  AppStore: { x: 1027, y: 702 }, Games: { x: 1162, y: 702 },
  Books: { x: 757, y: 837 }, Settings: { x: 1027, y: 837 },
};
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function grayThumb(buf: Buffer, region: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  return sharp(buf).extract({ left: Math.round(region.x), top: Math.round(region.y), width: Math.round(region.w), height: Math.round(region.h) })
    .greyscale().resize(80, 110, { fit: 'fill' }).raw().toBuffer();
}
function changedFraction(a: Buffer, b: Buffer): number {
  let ch = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) ch++;
  return ch / a.length;
}

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const dir = `scratch/click-bench80-${ts}`; await fs.mkdir(dir, { recursive: true });
  await ipadGoHome(client); await sleep(1800);
  const homeShot = await client.screenshot();
  const region0 = await detectIpadRegion(homeShot.buffer);
  const region = { x: region0.x + NATIVE_MARGIN, y: region0.y + NATIVE_MARGIN, w: region0.w - 2 * NATIVE_MARGIN, h: region0.h - 2 * NATIVE_MARGIN };
  const homeThumb = await grayThumb(homeShot.buffer, region);
  console.error(`home baseline captured, region=${JSON.stringify(region0)}`);

  const HIT_THRESHOLD = 0.15; // >15% of iPad-region pixels changed = an app opened
  const out = `${dir}/results.tsv`;
  await fs.writeFile(out, 'trial\ttarget\thit\tchanged_frac\tresid\toutcome\n');
  const perTarget: Record<string, { hit: number; n: number; resids: number[] }> = {};
  let hits = 0, n = 0, badPre = 0;

  for (let t = 1; t <= TRIALS; t++) {
    for (const [name, target] of Object.entries(TARGETS)) {
      await client.mouseMoveRelative(40, 40); await sleep(80); await client.mouseMoveRelative(-40, -40); await sleep(80);
      await ipadGoHome(client); await sleep(1600);
      // verify we actually reset to home before clicking
      const preShot = await client.screenshot({ quality: 80 });
      const preFrac = changedFraction(await grayThumb(preShot.buffer, region), homeThumb);
      if (preFrac > HIT_THRESHOLD) { badPre++; await ipadGoHome(client); await sleep(1500); }
      let resid = 'NA', outcome = 'threw';
      try {
        const r = await clickAtWithRetry(client, target, { moveToOptions: { strategy: 'curve-one-shot' }, maxRetries: 3 });
        resid = r.finalMoveResult.finalResidualPx != null ? r.finalMoveResult.finalResidualPx.toFixed(1) : 'null';
        outcome = r.success ? 'SUCCESS' : (r.attemptHistory.at(-1)?.skippedClickReason ?? 'UNVERIFIED');
      } catch (e) { outcome = `threw:${(e as Error).message.slice(0, 30)}`; }
      await sleep(1400);
      const postShot = await client.screenshot({ quality: 80 });
      const frac = changedFraction(await grayThumb(postShot.buffer, region), homeThumb);
      const hit = frac > HIT_THRESHOLD;
      if (hit) hits++; n++;
      (perTarget[name] ??= { hit: 0, n: 0, resids: [] });
      perTarget[name].n++; if (hit) perTarget[name].hit++;
      const rn = parseFloat(resid); if (Number.isFinite(rn)) perTarget[name].resids.push(rn);
      // save only MISSES for inspection (keeps disk sane)
      if (!hit) await fs.writeFile(`${dir}/MISS-t${t}-${name}-frac${frac.toFixed(2)}-r${resid}.jpg`, postShot.buffer);
      await fs.appendFile(out, `${t}\t${name}\t${hit ? 'HIT' : 'MISS'}\t${frac.toFixed(3)}\t${resid}\t${outcome}\n`);
    }
    console.error(`  after trial ${t}: hit-rate ${(hits / n * 100).toFixed(0)}% (${hits}/${n})`);
  }
  await ipadGoHome(client);
  console.error(`\n=== N=${n} SHIPPED-DEFAULT click bench (curve-one-shot + correction) ===`);
  console.error(`OVERALL app-open (hit) rate: ${(hits / n * 100).toFixed(1)}% (${hits}/${n})   [badPre resets: ${badPre}]`);
  for (const [name, s] of Object.entries(perTarget)) {
    console.error(`  ${name}: ${(s.hit / s.n * 100).toFixed(0)}% (${s.hit}/${s.n})  resid median=${median(s.resids).toFixed(1)}px`);
  }
  console.error(`MISS frames saved to ${dir}/ for inspection.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
