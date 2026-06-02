/**
 * 1.12 Phase 2 debug — single-emit sign check on v2-wider.
 *
 * Phase 2 replay failed catastrophically on +y commands; production
 * `learnedBallisticsPxPerMickey` uses Math.abs() to defend against
 * exactly this. Check whether v2-wider really sign-flips on +y, or
 * whether the planner has a different bug.
 */
import { predictDisplacement, buildFeatures, resolveDefaultModelPath } from '../src/pikvm/pointer-accel.js';

async function probeOne(label: string, dx: number, dy: number, dt: number) {
  const feats = buildFeatures(
    [],
    { vxPxPerMs: 0, vyPxPerMs: 0 },
    { dx, dy, t: 0 },
    dt,
  );
  const pred = await predictDisplacement(feats);
  console.error(`${label.padEnd(28)} emit=(${dx},${dy}) dt=${dt} -> pred=${pred ? `(${pred.dx.toFixed(2)}, ${pred.dy.toFixed(2)})` : 'null'}`);
}

async function main() {
  const modelPath = resolveDefaultModelPath();
  console.error(`Probing model: ${modelPath}\n`);

  // Cardinal single-emit @ chunkMag=20, varying dt_prev to see if
  // cold-start (dt=0) is the issue.
  for (const dt of [0, 30, 100]) {
    console.error(`--- dt_prev=${dt} ---`);
    await probeOne('+x_20', 20, 0, dt);
    await probeOne('-x_20', -20, 0, dt);
    await probeOne('+y_20', 0, 20, dt);
    await probeOne('-y_20', 0, -20, dt);
    console.error('');
  }

  // Diagonal single-emit (out of training distribution but should
  // still return something sensible).
  console.error('--- dt_prev=30, diagonal probes (OOD) ---');
  await probeOne('+x+y_20', 20, 20, 30);
  await probeOne('-x-y_20', -20, -20, 30);
}

main().catch((e) => {
  console.error(`FATAL: ${e}`);
  process.exit(2);
});
