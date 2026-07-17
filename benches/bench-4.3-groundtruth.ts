/**
 * 4.3' Live A/B v13 vs v12 with iPadCollector ground-truth pairing.
 *
 * Each invocation runs ONE model (read via PIKVM_ML_V8_MODEL or the
 * auto-loader default). Run twice for A/B:
 *
 *   PIKVM_ML_V8_MODEL=ml/cursor-v12.onnx npx tsx benches/bench-4.3-groundtruth.ts --label v12 --trials 20
 *   PIKVM_ML_V8_MODEL=ml/cursor-v13.onnx npx tsx benches/bench-4.3-groundtruth.ts --label v13 --trials 20
 *
 * Then `tsx benches/bench-4.3-analyze.ts <v12-dir> <v13-dir>` for
 * the head-to-head.
 *
 * Per cross-cutting rule "pair every live A/B with an iPadCollector
 * ground-truth bench" (memory feedback_ipadcollector_ground_truth):
 * the production detector under test cannot be the oracle for "where
 * cursor actually is" — it judges itself. Instead each per-attempt
 * record carries BOTH the detector's reported position AND
 * iPadCollector.getCursor()'s position (mapped through the calibrated
 * iPad-region transform back to HDMI px). The two-source comparison
 * is what 1.13b proved is necessary to catch hallucinations.
 *
 * Setup per trial:
 *   1. Slam to top-left so cursor starts at a known position
 *   2. Call moveToPixel toward TARGET — the production detect-then-move
 *      path runs, picks the model from env, reports a detected_xy
 *   3. Take PiKVM screenshot — visual ground truth
 *   4. Query sess.getCursor() — iPadCollector ground truth
 *   5. Record (detector_xy, ipad_xy_hdmi, target_xy, residuals)
 *
 * No clicking — positioning diagnostic only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { killOrphansOnPort, startIpadAppServer, type IpadSession } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767;
const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';

interface Args {
  label: string;
  trials: number;
  target: string;
  attempts: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const parsePositiveInt = (flag: string, fallback: string): number => {
    const raw = get(flag, fallback);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      console.error(`FATAL: ${flag} must be a positive integer, got '${raw}'`);
      process.exit(2);
    }
    return n;
  };
  return {
    label: get('--label', 'unlabeled'),
    trials: parsePositiveInt('--trials', '20'),
    target: get('--target', 'Books'),
    attempts: parsePositiveInt('--attempts', '4'),
  };
}

const TARGETS_HDMI: Record<string, { x: number; y: number }> = {
  Settings: { x: 1027, y: 837 },
  Books:    { x: 757,  y: 837 },
  AppStore: { x: 1027, y: 702 },
  Files:    { x: 1162, y: 435 },
};

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function relaunchIpadApp(): void {
  try {
    execSync(
      `xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`,
      { stdio: 'pipe' },
    );
  } catch { /* best effort */ }
}

async function waitForSession(
  timeoutMs = 30_000,
): Promise<{ sess: IpadSession; closeServer: () => Promise<void> }> {
  // Only the first inbound connection is captured — the bench assumes
  // one iPadCollector session for the whole run. If iPadCollector
  // reconnects mid-run (e.g. brief background cycle, Xcode double-
  // launch), the second session is accepted by startIpadAppServer but
  // ignored here; the caller will observe the original `sess` closing
  // (getCursor throws 'WebSocket closed') and bail via lifecycleAbort
  // or the outer error path. We deliberately do NOT rebind sess mid-
  // run because the `sess.onLifecycle` handler binding would be lost.
  let firstSession: IpadSession | null = null;
  return new Promise<{ sess: IpadSession; closeServer: () => Promise<void> }>((resolve, reject) => {
    const stop = startIpadAppServer({
      port: PORT,
      onSession: async (sess) => {
        if (firstSession) return;  // ignore reconnects
        firstSession = sess;
        const startedAt = Date.now();
        while (!sess.hello && Date.now() - startedAt < 5000) await sleep(20);
        resolve({ sess, closeServer: async () => { (await stop).close(); } });
      },
    });
    setTimeout(() => {
      if (!firstSession) {
        stop.then((s) => s.close()).catch(() => undefined);
        reject(new Error(
          `iPadCollector did not connect within ${timeoutMs}ms. ` +
          `Check: xcrun devicectl launch succeeded, iPad is awake+unlocked, ` +
          `and the collectorURL in the app points at this Mac's ws://…:${PORT}.`,
        ));
      }
    }, timeoutMs);
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Use hasOwnProperty to reject inherited Object.prototype keys
  // (--target toString / constructor / hasOwnProperty would otherwise
  // pass `in` and spread into an object with undefined x/y, producing
  // NaN residuals everywhere).
  if (!Object.prototype.hasOwnProperty.call(TARGETS_HDMI, args.target)) {
    console.error(`unknown --target ${args.target}; choose: ${Object.keys(TARGETS_HDMI).join(', ')}`);
    process.exit(2);
  }
  const TARGET = { name: args.target, ...TARGETS_HDMI[args.target] };
  // Treat empty-string PIKVM_ML_V8_MODEL as unset, matching the
  // falsy-check in cursor-ml-detect.ts:89 (which auto-loads v12 for
  // empty string). Otherwise manifest.json records model='' while the
  // actual detector under test is cursor-v12.onnx — the analyzer then
  // attributes results to the wrong arm.
  const envModel = process.env.PIKVM_ML_V8_MODEL?.trim();
  const model = envModel ? envModel : '(auto)';

  killOrphansOnPort(PORT);
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  console.error(`4.3' groundtruth bench  label=${args.label}  model=${model}`);
  console.error(`target=${TARGET.name} (${TARGET.x},${TARGET.y})  trials=${args.trials}  attempts/trial=${args.attempts}`);

  // Step 1: home-screen capture from PiKVM with iPadCollector NOT
  // foreground (so the real home screen is visible). This becomes
  // the visual scene we'll show inside iPadCollector — so detector
  // input looks like a real home screen during the bench.
  await ipadGoHome(client);
  await sleep(1500);
  console.error('[4.3] capturing home-screen baseline…');
  const homeShot = await client.screenshot();
  const region = await detectIpadRegion(homeShot.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
  };
  console.error(`[4.3] iPad tight region: ${JSON.stringify(tight)}`);

  // Step 2: launch iPadCollector + wait for WS handshake.
  relaunchIpadApp();
  await sleep(3000);
  console.error('[4.3] waiting for iPadCollector to connect…');
  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello payload');
  console.error(`[4.3] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

  // Lifecycle abort: if iPadCollector backgrounds mid-run we want to
  // stop loudly (Fire 6 protocol; gated on user's Xcode rebuild). If
  // the deployed binary is the pre-Fire-6 version, this listener is
  // silent — the bench falls back to old behavior (stale getCursor).
  let lifecycleAbort: string | null = null;
  let lastGoodTrial = 0;
  const setAbort = (state: string): void => {
    if (lifecycleAbort !== null) return;
    lifecycleAbort = state;
    console.error(`[4.3] ABORT: iPadCollector backgrounded (state=${state}) — last good trial=${lastGoodTrial}`);
  };
  sess.onLifecycle = (ev) => {
    if (ev.state === 'background') setAbort(ev.state);
  };
  // Race guard: a 'background' event that arrived between the WS
  // handshake and this handler registration would have set
  // sess.currentLifecycle but fired no callback. Sweep it now so a
  // background-at-launch aborts the run immediately instead of
  // silently producing 20 trials of stale data.
  if (sess.currentLifecycle === 'background') setAbort(sess.currentLifecycle);

  // iPad-logical → HDMI px transform (same as bench-collect-on-icon).
  const ipadToHdmi = (x: number, y: number) => ({
    x: tight.x + (x / sess.hello!.logicalW) * tight.w,
    y: tight.y + (y / sess.hello!.logicalH) * tight.h,
  });

  // Wake the pointer system: iPadCollector.PointerTracker doesn't
  // fire until .onContinuousHover sees a real event. Slam-then-wiggle
  // until getCursor reports tracked=true (or a non-(0,0) reading on
  // legacy binaries without the `tracked` field).
  console.error('[4.3] waking pointer…');
  for (let s = 0; s < 4; s++) await client.mouseMoveRelative(-2000, -2000);
  await sleep(200);
  await client.mouseMoveRelative(800, 1000);  // toward iPad center
  await sleep(300);
  let pointerAlive = false;
  for (let attempt = 0; attempt < 8 && !pointerAlive; attempt++) {
    await client.mouseMoveRelative(50, 50);
    await sleep(80);
    await client.mouseMoveRelative(-50, -50);
    await sleep(200);
    try {
      const probe = await sess.getCursor();
      if (probe.tracked === true) pointerAlive = true;
      else if (probe.tracked === undefined && (probe.x !== 0 || probe.y !== 0)) {
        pointerAlive = true;  // legacy binary fallback
      }
    } catch { /* keep trying */ }
  }
  // Fail hard rather than run a full bench that silently produces
  // null/skipped ipad_xy rows — the entire ground-truth A/B is
  // worthless without a live pointer.
  if (!pointerAlive) {
    await closeServer().catch(() => undefined);
    throw new Error(
      'iPadCollector connected but its PointerTracker never fired hover events after ' +
      '8 wake attempts. Check that iPadCollector is foreground + covers the iPad screen ' +
      '(TapCaptureView above SceneRendererView routes UIHoverGestureRecognizer to the tracker). ' +
      'Running the bench in this state would produce a full run of empty ipad_x/ipad_y rows.',
    );
  }

  // Output dir.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `bench-4.3-groundtruth-${args.label}-${ts}`);
  await fs.mkdir(outDir, { recursive: true });
  const summaryPath = path.join(outDir, 'summary.tsv');
  const manifestPath = path.join(outDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    ts,
    label: args.label,
    model,
    target: TARGET,
    trials: args.trials,
    attempts_per_trial: args.attempts,
    tight,
    logicalW: sess.hello.logicalW,
    logicalH: sess.hello.logicalH,
  }, null, 2));
  await fs.writeFile(
    summaryPath,
    'trial\tattempt\tdetector_x\tdetector_y\tipad_x_hdmi\tipad_y_hdmi\tresidual_detector\tresidual_ipad\tdetector_minus_ipad\tframe\n',
  );
  console.error(`[4.3] output: ${outDir}`);

  // Main loop.
  for (let trial = 1; trial <= args.trials; trial++) {
    if (lifecycleAbort) break;
    const trialDir = path.join(outDir, `trial-${String(trial).padStart(2, '0')}`);
    await fs.mkdir(trialDir, { recursive: true });
    console.error(`=== trial ${trial}/${args.trials} ===`);

    // Reset cursor to a known corner so attempts start from similar
    // initial state across trials (matches the 1.13 pattern).
    for (let s = 0; s < 4; s++) await client.mouseMoveRelative(-2000, -2000);
    await sleep(200);
    await client.mouseMoveRelative(800, 1000);
    await sleep(300);

    const startShot = await client.screenshot({ quality: 75 });
    await fs.writeFile(path.join(trialDir, '00-start.jpg'), startShot.buffer);

    for (let attempt = 1; attempt <= args.attempts; attempt++) {
      if (lifecycleAbort) break;
      let detected: { x: number; y: number } | null = null;
      let errMsg: string | null = null;
      try {
        const r = await moveToPixel(client, TARGET, {
          profile: profile ?? undefined,
          forbidSlamFallback: true,
          strategy: 'detect-then-move',
        });
        detected = r.finalDetectedPosition;
      } catch (e) {
        errMsg = (e as Error).message;
      }

      // Take the PiKVM screenshot AND query iPadCollector at as close
      // to the same moment as possible (the cursor can drift between
      // them if there's a settle delay, but we're well under the iPad
      // pointer fade window).
      const shot = await client.screenshot({ quality: 75 });
      let ipadHdmi: { x: number; y: number } | null = null;
      try {
        const cur = await sess.getCursor();
        // Trust the explicit `tracked` field when the app sends it
        // (post-2026-06-18 rebuild). On legacy binaries `tracked` is
        // undefined; fall back to the (0,0)=not-tracked heuristic —
        // acknowledged to drop legitimate top-left cursor positions
        // but far less noisy than trusting the sentinel as data.
        const isValid = cur.tracked === true
          || (cur.tracked === undefined && (cur.x !== 0 || cur.y !== 0));
        if (isValid) {
          ipadHdmi = ipadToHdmi(cur.x, cur.y);
        }
      } catch (e) {
        // iPadCollector unresponsive — record null, keep going.
        console.error(`  a${attempt}: getCursor failed: ${(e as Error).message.slice(0, 80)}`);
      }

      const residDet = detected
        ? Math.hypot(detected.x - TARGET.x, detected.y - TARGET.y)
        : Number.NaN;
      const residIpad = ipadHdmi
        ? Math.hypot(ipadHdmi.x - TARGET.x, ipadHdmi.y - TARGET.y)
        : Number.NaN;
      const detVsIpad = detected && ipadHdmi
        ? Math.hypot(detected.x - ipadHdmi.x, detected.y - ipadHdmi.y)
        : Number.NaN;

      const frameName =
        `a${attempt}-det${detected ? `_${detected.x},${detected.y}` : '_null'}` +
        `-ipad${ipadHdmi ? `_${Math.round(ipadHdmi.x)},${Math.round(ipadHdmi.y)}` : '_null'}` +
        `-resD${Number.isFinite(residDet) ? residDet.toFixed(0) : 'NA'}` +
        `-resI${Number.isFinite(residIpad) ? residIpad.toFixed(0) : 'NA'}.jpg`;
      await fs.writeFile(path.join(trialDir, frameName), shot.buffer);

      await fs.appendFile(
        summaryPath,
        [
          trial, attempt,
          detected?.x ?? '', detected?.y ?? '',
          ipadHdmi ? Math.round(ipadHdmi.x * 10) / 10 : '',
          ipadHdmi ? Math.round(ipadHdmi.y * 10) / 10 : '',
          Number.isFinite(residDet) ? residDet.toFixed(1) : '',
          Number.isFinite(residIpad) ? residIpad.toFixed(1) : '',
          Number.isFinite(detVsIpad) ? detVsIpad.toFixed(1) : '',
          `trial-${String(trial).padStart(2, '0')}/${frameName}`,
        ].join('\t') + '\n',
      );

      if (errMsg) {
        console.error(`  a${attempt}: moveToPixel THREW — ${errMsg.slice(0, 80)}`);
      } else {
        console.error(
          `  a${attempt}: ` +
          `det=${detected ? `(${detected.x},${detected.y})` : 'null'} ` +
          `ipad=${ipadHdmi ? `(${Math.round(ipadHdmi.x)},${Math.round(ipadHdmi.y)})` : 'null'} ` +
          `resD=${Number.isFinite(residDet) ? residDet.toFixed(1) : 'NA'} ` +
          `resI=${Number.isFinite(residIpad) ? residIpad.toFixed(1) : 'NA'} ` +
          `detVsIpad=${Number.isFinite(detVsIpad) ? detVsIpad.toFixed(1) : 'NA'}px`,
        );
      }
    }
    // Only advance lastGoodTrial when the attempt loop ran to completion.
    // On lifecycleAbort the inner loop breaks mid-trial and the trial is
    // incomplete — bumping lastGoodTrial here would contradict the ABORT
    // log's "last good trial=N" and overstate coverage.
    if (!lifecycleAbort) lastGoodTrial = trial;
  }

  const aborted = lifecycleAbort !== null;
  console.error(
    `\n[4.3] ${aborted ? 'ABORTED' : 'DONE'} label=${args.label}: ` +
    `ran ${lastGoodTrial}/${args.trials} trials` +
    (aborted ? ` (reason: iPadCollector ${lifecycleAbort})` : ''),
  );
  console.error(`Output: ${outDir}`);
  // await the close so the WS server flushes and releases port 8767
  // before the next invocation — otherwise rapid back-to-back v12/v13
  // runs can hit EADDRINUSE under the OS TIME_WAIT window.
  try { await closeServer(); } catch { /* ignore */ }
  // Non-zero exit on lifecycleAbort so a wrapper script running both
  // arms can distinguish a partial run from a complete one.
  process.exit(aborted ? 3 : 0);
}

main().catch((e) => { console.error(`FATAL: ${e}`); process.exit(2); });
