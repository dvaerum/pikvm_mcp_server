/** WAKE NET-DISPLACEMENT measurement (post-wake 25.3px re-diagnosis).
 *
 * Question: does the M2 faded-cursor wake leave the pointer displaced from where
 * it faded, and if so is that displacement (a) still SETTLING when we re-detect
 * at 200ms, or (b) a stable net-nonzero offset of the jiggle pattern itself?
 *
 * Per trial:
 *   1. wake+park the pointer at a known spot, detect P0 (cursor visible)
 *   2. wait FADE_MS so the pointer fully fades IN PLACE (it does not move while
 *      fading, so P0 stays valid as the "before")
 *   3. run the PRODUCTION wake pattern (planWakeEmits, same pace)
 *   4. re-detect at a LADDER of settle times after the last emit:
 *      200ms (= production WAKE_SETTLE_MS), then +400, +800, +1600
 *   delta_i = |P_i - P0| = net displacement measured at that settle.
 *
 * Reading: deltas SHRINK down the ladder ⇒ coasting/settling ⇒ fix is settle-time.
 *          deltas STABLE and ~25px ⇒ the "net-zero" jiggle is not net-zero.
 *          deltas ~0 at every settle ⇒ wake is innocent; look elsewhere.
 * usage: npx tsx scratch/wake-displacement.ts <trials> [outPrefix]
 */
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { planWakeEmits } from '../src/pikvm/curve-mover.js';
import { CursorLocator, type CursorLocatorDeps } from '../src/pikvm/cursor-locator.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';

// Same deps curve-mover.ts builds for locate('curve') — only belief + the V8
// cascade are reached, so detection here is identical to production's.
const makeCurveLocatorDeps = (client: PiKVMClient): CursorLocatorDeps => {
  const notWired = (name: string) => (): never => { throw new Error(`not wired: ${name}`); };
  return {
    belief: client.belief, screenshot: notWired('screenshot'), decode: notWired('decode'),
    mouseMoveRelative: notWired('mouseMoveRelative'), sleep: notWired('sleep'),
    getCachedTemplates: notWired('getCachedTemplates'), isMlDisabled: notWired('isMlDisabled'),
    findCursorByV8FullFrame, locateCursor: notWired('locateCursor'),
    findCursorByTemplateSet: notWired('findCursorByTemplateSet'),
  } as unknown as CursorLocatorDeps;
};

const DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', APP = 'dk.vammencamping.sumuppayment';
const PARK = { x: 960, y: 300 };
const FADE_MS = 15000;                 // > the 10-12s fade, so the wake path is real
const WAKE_PACE_MS = 70;               // production WAKE_EMIT_PACE_MS
const LADDER = [200, 400, 800, 1600];  // 200 = production WAKE_SETTLE_MS, then cumulative
const TRIALS = Number(process.argv[2] ?? 8);
const PREFIX = process.argv[3] ?? '/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/wake-disp';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

async function detect(c: PiKVMClient): Promise<{ x: number; y: number } | null> {
  const shot = await c.screenshot({ quality: 80 });
  const locator = new CursorLocator(makeCurveLocatorDeps(c));
  const fix = await locator.locate(shot.buffer, shot.screenshotWidth, shot.screenshotHeight, 'curve', undefined, { minPresence: 0.5 });
  return fix ? { x: fix.position.x, y: fix.position.y } : null;
}

async function main() {
  const c = new PiKVMClient(loadConfig().pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const out = `${PREFIX}.jsonl`;
  await fs.writeFile(out, '');
  console.error(`WAKE DISPLACEMENT: ${TRIALS} trials, fade ${FADE_MS}ms, settle ladder ${LADDER.join('/')}ms (cumulative)\n`);

  const cols: number[][] = LADDER.map(() => []);
  for (let t = 1; t <= TRIALS; t++) {
    execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', DEVICE, APP], { stdio: 'ignore' });
    await sleep(2600);
    // wake + park so we have a visible, known "before" position
    for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(WAKE_PACE_MS); }
    await sleep(300);
    try { await moveToPixel(c, PARK, { strategy: 'curve-one-shot', profile: profile ?? undefined }); } catch {}
    await sleep(400);
    const p0 = await detect(c);
    if (!p0) { console.error(`t${t}: no P0 (park detect failed) — skipping`); continue; }

    await sleep(FADE_MS);                       // fade in place
    const fadedShot = await c.screenshot({ quality: 80 });
    const stillDetectable = await (async () => {
      const locator = new CursorLocator(makeCurveLocatorDeps(c));
      const fix = await locator.locate(fadedShot.buffer, fadedShot.screenshotWidth, fadedShot.screenshotHeight, 'curve', undefined, { minPresence: 0.5 });
      return fix ? { x: fix.position.x, y: fix.position.y } : null;
    })();

    for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(WAKE_PACE_MS); }

    const marks: Array<{ settleMs: number; pos: { x: number; y: number } | null; delta: number | null }> = [];
    let waited = 0;
    for (let i = 0; i < LADDER.length; i++) {
      await sleep(LADDER[i]); waited += LADDER[i];
      const p = await detect(c);
      const d = p ? dist(p, p0) : null;
      marks.push({ settleMs: waited, pos: p, delta: d });
      if (d !== null) cols[i].push(d);
    }
    await fs.appendFile(out, JSON.stringify({ trial: t, p0, fadedStillDetectable: stillDetectable, marks }) + '\n');
    console.error(`t${String(t).padStart(2)}: P0 (${p0.x.toFixed(0)},${p0.y.toFixed(0)}) faded=${stillDetectable ? 'STILL-VISIBLE' : 'gone'} | ` +
      marks.map((m) => `${m.settleMs}ms:${m.delta === null ? '  ?  ' : m.delta.toFixed(1).padStart(5)}px`).join(' '));
  }

  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.error('\n===== NET WAKE DISPLACEMENT vs pre-fade position =====');
  LADDER.forEach((_, i) => {
    const cum = LADDER.slice(0, i + 1).reduce((a, b) => a + b, 0);
    const v = cols[i];
    console.error(`  settle ${String(cum).padStart(4)}ms: n=${v.length} median ${med(v).toFixed(1)}px  [${v.map((x) => x.toFixed(1)).join(', ')}]`);
  });
  console.error(`  raw: ${out}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
