/**
 * Pointer-acceleration trajectory collector.
 *
 * Drives PiKVM HID through a library of mouse-emit sequences while the
 * iPad collector app streams cursor events back over WebSocket. Saves
 * timestamp-aligned `emits.jsonl` + `cursor.jsonl` + `manifest.json`
 * for downstream pointer-acceleration model fitting (intended to
 * replace PiKVM's hard-coded 1.4 px/mickey constant).
 *
 * Usage:
 *   npx tsx bench-collect-trajectory.ts                       # short smoke run (~30s, ~30 events)
 *   npx tsx bench-collect-trajectory.ts --full                # one full pass (~60s, ~90 events)
 *   npx tsx bench-collect-trajectory.ts --full --repeats 12   # 12 passes (~12min, ~1000+ events)
 *   npx tsx bench-collect-trajectory.ts --port 8767
 *
 * Each outer pass runs linearity + burst + direction sweeps once.
 * iPadOS coalesces pointer events ~22% of the time (PA38), so 1 pass
 * yields ~78% of emit count as cursor events. The forward ballistics
 * model needs many samples per (direction, magnitude) condition, so use
 * --repeats to multiply.
 *
 * Requires PiKVM env vars set (same as other bench-* scripts) and the
 * iPad app already connected to ws://<this-mac>:{PORT}.
 *
 * Output: data/cursor-trajectory-{TS}/
 *   emits.jsonl   {t, dx, dy, sequenceLabel}
 *   cursor.jsonl  {t, x_logical, y_logical, phase}
 *   manifest.json {ts, iPadHello, region, scale, clockOffsetMs, rttMs, sequenceLabels}
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  killOrphansOnPort,
  startIpadAppServer,
  type CursorEvent,
  type IpadSession,
} from '../src/pikvm/ipad-app-ws.js';
import {
  buildTransform,
  detectIpadRegion,
  NATIVE_MARGIN,
} from '../src/pikvm/ipad-region-detect.js';

// Default true so a quick `npx tsx bench-collect-trajectory.ts` finishes
// fast. `--full` flips this off for the full library.
let SHORT_RUN = true;

let PORT = 8767;
let REPEATS = 1;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--full') SHORT_RUN = false;
  else if (a === '--port' && process.argv[i + 1]) {
    PORT = Number(process.argv[i + 1]);
    i++;
  } else if (a === '--repeats' && process.argv[i + 1]) {
    REPEATS = Math.max(1, Number(process.argv[i + 1]));
    i++;
  }
}

const FLUSH_EVERY = 100;
const RESYNC_INTERVAL_MS = 30_000;

interface EmitRow {
  t: number;
  dx: number;
  dy: number;
  sequenceLabel: string;
}

interface CursorRow {
  t: number;
  x_logical: number;
  y_logical: number;
  phase: CursorEvent['phase'];
}

interface Direction {
  label: string;
  dx: number;
  dy: number;
}

const DIRS_4: Direction[] = [
  { label: '+x', dx: 1, dy: 0 },
  { label: '-x', dx: -1, dy: 0 },
  { label: '+y', dx: 0, dy: 1 },
  { label: '-y', dx: 0, dy: -1 },
];

// 8 cardinal + diagonal directions; unit vectors scaled to magnitude later.
const DIRS_8: Direction[] = [
  { label: 'N', dx: 0, dy: -1 },
  { label: 'NE', dx: Math.SQRT1_2, dy: -Math.SQRT1_2 },
  { label: 'E', dx: 1, dy: 0 },
  { label: 'SE', dx: Math.SQRT1_2, dy: Math.SQRT1_2 },
  { label: 'S', dx: 0, dy: 1 },
  { label: 'SW', dx: -Math.SQRT1_2, dy: Math.SQRT1_2 },
  { label: 'W', dx: -1, dy: 0 },
  { label: 'NW', dx: -Math.SQRT1_2, dy: -Math.SQRT1_2 },
];

const LINEARITY_MAGS_FULL = [1, 2, 5, 10, 15, 20, 25, 30, 50, 80, 100, 127];
const LINEARITY_MAGS_SHORT = [10, 50, 127];
const BURST_DELAYS_FULL = [0, 5, 10, 25, 50, 100, 200];
const BURST_DELAYS_SHORT = [0, 25, 200];
const BURST_COUNT = 8;
const BURST_MAG = 20;

const LINEARITY_SETTLE_MS = 800;
const BURST_SETTLE_MS = 1500;
const DIRECTION_SETTLE_MS = 800;

// chunkedBurst sequence (added 2026-06-01, post-1.6 failure analysis): the
// linearity/burst/direction sweeps don't cover the regime move-to actually
// uses — chunkMag=20 at 30 ms inter-emit pace, repeated 4-16 times to
// span a target. Without samples in this regime the pointer-accel model
// extrapolates ~4× the steady-state ratio (see
// docs/troubleshooting/2026-05-31-pointer-accel-1.6-fails.md). Each
// chunk is (dir × mag × pace × chainLen).
// 2026-06-02: shrunk from 4×4×3 = 192 sequences to 2×2×2 = 32 because
// the original load (~1900 emits per pass over 4-5 min sustained) reliably
// killed the iPad WS session inside chunkedBurst — three attempts in a
// row hit the same wall at ~1100 cursor events. Hypothesis: iPad-side
// buffer overflow under sustained ~50 emit/sec inner loop, or iPadOS
// backgrounding iPadCollector. The dropped corners (mag=10/50, pace=20/
// 100, chain=16) are out-of-regime anyway — move-to.ts:1439-1440 uses
// chunkMag=20 + chunkPaceMs=30, so the kept (20|30) × (30|50) × (4|8)
// nest brackets it without overshoot.
const CHUNKED_BURST_MAGS_FULL = [20, 30];
const CHUNKED_BURST_MAGS_SHORT = [20];
const CHUNKED_BURST_PACES_FULL = [30, 50];
const CHUNKED_BURST_PACES_SHORT = [30];
const CHUNKED_BURST_CHAINS_FULL = [4, 8];
const CHUNKED_BURST_CHAINS_SHORT = [8];
const CHUNKED_BURST_SETTLE_MS = 1000;

// randomWalk sequence (added 2026-06-01): one long chain of varied
// (magnitude, direction, inter-emit delay) drawn from a seeded PRNG, so
// the model sees state transitions it would never see from the
// well-isolated dir/mag sweeps. Reproducible via SEED.
const RANDOM_WALK_LENGTH_FULL = 500;
const RANDOM_WALK_LENGTH_SHORT = 50;
const RANDOM_WALK_SEED_BASE = 12345;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSession(): Promise<{ sess: IpadSession; closeServer: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = startIpadAppServer({
      port: PORT,
      async onSession(sess) {
        resolve({ sess, closeServer: () => server.close() });
      },
    });
    setTimeout(() => reject(new Error('timed out waiting for iPad app to connect')), 120_000);
  });
}

class JsonlWriter<T> {
  private buf: T[] = [];
  constructor(private readonly filePath: string, private readonly flushEvery: number) {}

  push(row: T): void {
    this.buf.push(row);
    if (this.buf.length >= this.flushEvery) {
      // Fire-and-forget flush; no await so producer isn't back-pressured.
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const rows = this.buf;
    this.buf = [];
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.appendFile(this.filePath, text);
  }
}

async function runLinearitySweep(
  client: PiKVMClient,
  emits: JsonlWriter<EmitRow>,
): Promise<string[]> {
  const mags = SHORT_RUN ? LINEARITY_MAGS_SHORT : LINEARITY_MAGS_FULL;
  const labels: string[] = [];
  for (const dir of DIRS_4) {
    for (const mag of mags) {
      const dx = Math.round(dir.dx * mag);
      const dy = Math.round(dir.dy * mag);
      const label = `linearity:${dir.label}:m${mag}`;
      labels.push(label);
      try {
        const t = Date.now();
        await client.mouseMoveRelative(dx, dy);
        emits.push({ t, dx, dy, sequenceLabel: label });
      } catch (e) {
        console.error(`[traj] ${label}: mouseMoveRelative failed: ${(e as Error).message}`);
      }
      await sleep(LINEARITY_SETTLE_MS);
    }
  }
  return labels;
}

async function runBurstCoalescing(
  client: PiKVMClient,
  emits: JsonlWriter<EmitRow>,
): Promise<string[]> {
  const delays = SHORT_RUN ? BURST_DELAYS_SHORT : BURST_DELAYS_FULL;
  const labels: string[] = [];
  for (const delay of delays) {
    const label = `burst:+x:m${BURST_MAG}:n${BURST_COUNT}:d${delay}`;
    labels.push(label);
    for (let i = 0; i < BURST_COUNT; i++) {
      try {
        const t = Date.now();
        await client.mouseMoveRelative(BURST_MAG, 0);
        emits.push({ t, dx: BURST_MAG, dy: 0, sequenceLabel: label });
      } catch (e) {
        console.error(`[traj] ${label}: mouseMoveRelative failed: ${(e as Error).message}`);
      }
      if (delay > 0 && i < BURST_COUNT - 1) await sleep(delay);
    }
    await sleep(BURST_SETTLE_MS);
  }
  return labels;
}

async function runDirectionSweep(
  client: PiKVMClient,
  emits: JsonlWriter<EmitRow>,
): Promise<string[]> {
  const dirs = SHORT_RUN ? DIRS_4 : DIRS_8;
  const mag = 100;
  const labels: string[] = [];
  for (const dir of dirs) {
    const dx = Math.round(dir.dx * mag);
    const dy = Math.round(dir.dy * mag);
    const label = `direction:${dir.label}:m${mag}`;
    labels.push(label);
    try {
      const t = Date.now();
      await client.mouseMoveRelative(dx, dy);
      emits.push({ t, dx, dy, sequenceLabel: label });
    } catch (e) {
      console.error(`[traj] ${label}: mouseMoveRelative failed: ${(e as Error).message}`);
    }
    await sleep(DIRECTION_SETTLE_MS);
  }
  return labels;
}

async function runChunkedBurst(
  client: PiKVMClient,
  emits: JsonlWriter<EmitRow>,
): Promise<string[]> {
  const mags = SHORT_RUN ? CHUNKED_BURST_MAGS_SHORT : CHUNKED_BURST_MAGS_FULL;
  const paces = SHORT_RUN ? CHUNKED_BURST_PACES_SHORT : CHUNKED_BURST_PACES_FULL;
  const chains = SHORT_RUN ? CHUNKED_BURST_CHAINS_SHORT : CHUNKED_BURST_CHAINS_FULL;
  const labels: string[] = [];
  for (const dir of DIRS_4) {
    for (const mag of mags) {
      for (const pace of paces) {
        for (const chain of chains) {
          const dx = Math.round(dir.dx * mag);
          const dy = Math.round(dir.dy * mag);
          const label = `chunkedBurst:${dir.label}:m${mag}:n${chain}:p${pace}`;
          labels.push(label);
          for (let i = 0; i < chain; i++) {
            try {
              const t = Date.now();
              await client.mouseMoveRelative(dx, dy);
              emits.push({ t, dx, dy, sequenceLabel: label });
            } catch (e) {
              console.error(`[traj] ${label}: mouseMoveRelative failed: ${(e as Error).message}`);
            }
            if (pace > 0 && i < chain - 1) await sleep(pace);
          }
          await sleep(CHUNKED_BURST_SETTLE_MS);
        }
      }
    }
  }
  return labels;
}

async function runRandomWalk(
  client: PiKVMClient,
  emits: JsonlWriter<EmitRow>,
  passIndex: number,
): Promise<string[]> {
  // LCG so the bench is byte-deterministic given (seed, pass); useful for
  // reproducing bug-reports against a specific trajectory.
  let s = (RANDOM_WALK_SEED_BASE + passIndex) >>> 0;
  function rand(): number {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  }
  function pickMag(): number {
    // Skew toward 20-40 by squaring uniform — matches move-to's working range.
    const u = rand();
    return Math.round(10 + u * u * 70);
  }
  function pickDelayMs(): number {
    return Math.round(10 + rand() * 190);
  }
  function pickDir(): Direction {
    return DIRS_8[Math.floor(rand() * DIRS_8.length)];
  }
  const length = SHORT_RUN ? RANDOM_WALK_LENGTH_SHORT : RANDOM_WALK_LENGTH_FULL;
  const label = `randomWalk:s${RANDOM_WALK_SEED_BASE + passIndex}:n${length}`;
  for (let i = 0; i < length; i++) {
    const dir = pickDir();
    const mag = pickMag();
    const delay = pickDelayMs();
    const dx = Math.round(dir.dx * mag);
    const dy = Math.round(dir.dy * mag);
    try {
      const t = Date.now();
      await client.mouseMoveRelative(dx, dy);
      emits.push({ t, dx, dy, sequenceLabel: label });
    } catch (e) {
      console.error(`[traj] ${label}: mouseMoveRelative failed: ${(e as Error).message}`);
    }
    if (delay > 0 && i < length - 1) await sleep(delay);
  }
  return [label];
}

async function main() {
  killOrphansOnPort(PORT);
  console.log(`[traj] starting WS server on ws://0.0.0.0:${PORT} (SHORT_RUN=${SHORT_RUN})`);
  console.log('[traj] waiting for iPad app to connect…');

  const { sess, closeServer } = await waitForSession();
  console.log(`[traj] connected: ${JSON.stringify(sess.hello)}`);
  if (!sess.hello) throw new Error('no hello payload');

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Calibration screenshot (same pattern as bench-collect-synthetic.ts).
  console.log('[traj] lighting screen for calibration…');
  await sess.showScene({
    kind: 'procedural',
    params: { proc_kind: 'solid', r: 0.95, g: 0.95, b: 0.95 },
  });
  await sleep(400);
  console.log('[traj] taking calibration screenshot…');
  const shot0 = await client.screenshot();
  const region = await detectIpadRegion(shot0.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
    frameW: region.frameW,
    frameH: region.frameH,
  };
  const xform = buildTransform(tight, sess.hello.logicalW, sess.hello.logicalH);
  void xform; // exposed via scale in manifest; per-event coords stay logical
  const scale = {
    x: tight.w / sess.hello.logicalW,
    y: tight.h / sess.hello.logicalH,
  };
  console.log(
    `[traj] iPad region (tight): x=${tight.x} y=${tight.y} w=${tight.w} h=${tight.h} (frame ${region.frameW}×${region.frameH})`,
  );
  console.log(`[traj] logical → screenshot scale: x=${scale.x.toFixed(3)} y=${scale.y.toFixed(3)}`);

  // Output dir + writers.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `cursor-trajectory-${ts}`);
  await fs.mkdir(outDir, { recursive: true });
  const emitsPath = path.join(outDir, 'emits.jsonl');
  const cursorPath = path.join(outDir, 'cursor.jsonl');
  const manifestPath = path.join(outDir, 'manifest.json');
  console.log(`[traj] output dir: ${outDir}`);

  const emits = new JsonlWriter<EmitRow>(emitsPath, FLUSH_EVERY);
  const cursor = new JsonlWriter<CursorRow>(cursorPath, FLUSH_EVERY);

  // Clock sync before streaming starts.
  console.log('[traj] syncing clock (10 samples)…');
  const sync0 = await sess.syncClock(10);
  console.log(`[traj] clock offset = ${sync0.offsetMs.toFixed(1)} ms, rtt = ${sync0.rttMs.toFixed(1)} ms`);

  // Wake the iPad pointer system. SwiftUI .onContinuousHover doesn't fire
  // until a pointer event arrives; without warmup the first cursor events
  // may be missing or report (0,0). Same pattern as bench-collect-synthetic.
  console.log('[traj] waking pointer…');
  for (let attempt = 0; attempt < 5; attempt++) {
    await client.mouseMoveRelative(30, 30);
    await client.mouseMoveRelative(-30, -30);
    await sleep(200);
    try {
      const probe = await sess.getCursor();
      if (probe.x !== 0 || probe.y !== 0) {
        console.log(`[traj] pointer alive at (${probe.x.toFixed(1)}, ${probe.y.toFixed(1)})`);
        break;
      }
    } catch {}
    if (attempt === 4) console.error('[traj] WARNING: pointer never woke; early events may be (0,0)');
  }

  // Stream cursor events.
  let cursorCount = 0;
  sess.onCursorEvent = (ev: CursorEvent) => {
    cursorCount++;
    cursor.push({
      t: sess.ipadToCollectorMs(ev.t_ipad),
      x_logical: ev.x,
      y_logical: ev.y,
      phase: ev.phase,
    });
  };
  await sess.subscribeCursor();
  console.log('[traj] cursor subscription active');

  // Periodic clock resync (drift ~ms over minutes).
  const resyncTimer = setInterval(() => {
    sess.syncClock(5).then(
      ({ offsetMs, rttMs }) => {
        console.log(`[traj] resync: offset=${offsetMs.toFixed(1)} ms rtt=${rttMs.toFixed(1)} ms`);
      },
      (err: Error) => {
        console.error(`[traj] resync failed: ${err.message}`);
      },
    );
  }, RESYNC_INTERVAL_MS);

  const t0 = Date.now();
  const sequenceLabels: string[] = [];

  try {
    for (let pass = 1; pass <= REPEATS; pass++) {
      const prefix = REPEATS > 1 ? `[pass ${pass}/${REPEATS}] ` : '';
      console.log(`${prefix}[traj] sequence 1/5: linearity sweep`);
      sequenceLabels.push(...(await runLinearitySweep(client, emits)));
      console.log(`${prefix}[traj] sequence 2/5: burst-coalescing matrix`);
      sequenceLabels.push(...(await runBurstCoalescing(client, emits)));
      console.log(`${prefix}[traj] sequence 3/5: direction sweep`);
      sequenceLabels.push(...(await runDirectionSweep(client, emits)));
      console.log(`${prefix}[traj] sequence 4/5: chunked-burst (move-to regime)`);
      sequenceLabels.push(...(await runChunkedBurst(client, emits)));
      console.log(`${prefix}[traj] sequence 5/5: random walk`);
      sequenceLabels.push(...(await runRandomWalk(client, emits, pass)));
    }
  } finally {
    clearInterval(resyncTimer);
    try {
      await sess.unsubscribeCursor();
    } catch (e) {
      console.error(`[traj] unsubscribeCursor failed: ${(e as Error).message}`);
    }
    sess.onCursorEvent = null;
    await emits.flush();
    await cursor.flush();
  }

  // Final manifest (includes the *final* clock offset for the record).
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        ts,
        iPadHello: sess.hello,
        region,
        scale,
        clockOffsetMs: sess.clockOffsetMs,
        rttMs: sync0.rttMs,
        sequenceLabels,
      },
      null,
      2,
    ),
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[traj] done in ${elapsed}s. cursor events=${cursorCount}, sequences=${sequenceLabels.length}`);
  console.log(`[traj] emits: ${emitsPath}`);
  console.log(`[traj] cursor: ${cursorPath}`);
  console.log(`[traj] manifest: ${manifestPath}`);

  await closeServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
