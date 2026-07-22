/**
 * openLoopShape OFFLINE locate-blind-spot sweep (no iPad).
 *
 * Reproduces + localizes the @georgs-mac-mini live finding — openLoopShape
 * "~48% locate on grey, 0% upper-right, ~6px accurate on hit" — without hardware,
 * by compositing the real cursor sprite (ml/cursor-sprite.png, label point =
 * centre (90,90)) onto a solid grey-0.55 frame at a grid of positions and running
 * the SAME pure detectors the `openLoopShape` CursorLocator profile uses:
 *   - findCursorByMLMultiHint(minConfidence 0.5)  [ML — see note below]
 *   - findCursorByShape(expectedNear=hint, radius 100)          (dark)
 *   - findCursorByShape(expectedNear=hint, radius 100, bright)  (bright, thr 120)
 * gated exactly like locateOpenLoopShape (shapeScore>=0.05 OR prox<=30). The live
 * wiggle-verify layer is a SEPARATE gate that needs a device and is intentionally
 * excluded — this isolates the DETECTION recall, which is what the finding measures.
 *
 * Diagnostic decomposition: sweeping with a PERFECT hint (predicted = true tip)
 * isolates a genuine detector edge/coordinate blind-spot from an upstream
 * hint-geometry cause. Use --hint-offset N to inject a hint error like production.
 *
 * NOTE (repro-relevant): only ml/crop-heatmap.onnx is committed; the single-stage
 * models findCursorByMLMultiHint loads (cursor-v1/v5/v12.onnx) are NOT in the repo,
 * so offline the ML sub-detector returns null and openLoopShape degrades to
 * shape-only. The harness reports whether ML loaded so this is explicit.
 *
 * Usage:
 *   npx tsx benches/bench-openloopshape-offline-sweep.ts [--w 1920] [--h 1080]
 *        [--cols 7] [--rows 5] [--grey 140] [--hit 35] [--hint-offset 0]
 * Output: data/bench-openloopshape-offline/results.json + an ASCII locate grid.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { findCursorByMLMultiHint, buildMLHints } from '../src/pikvm/cursor-ml-detect.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

// Letterbox mode: model a portrait-iPad grey scene inset in a black HDMI frame,
// so detectIpadRegion + the cascade's NATIVE_MARGIN inset actually run (tests
// suspect #1 — region-crop clipping the upper-right on a real letterboxed frame).
const LB = process.argv.includes('--letterbox');

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const W = arg('w', 1920);
const H = arg('h', 1080);
const COLS = arg('cols', 7);
const ROWS = arg('rows', 5);
const GREY = arg('grey', 140); // 0.55 * 255 ≈ 140 (setupGreyScene default)
const HIT_PX = arg('hit', 35);
const HINT_OFFSET = arg('hint-offset', 0); // px error injected into the hint
const SPRITE = 180;
const CENTER = 90; // sprite label point (getCursor position)

// Tight iPad-content region (letterbox mode). Default: portrait 3:4 inset on all
// sides in the landscape HDMI frame → black bars top/bottom/left/right, so the
// upper-right content corner sits near a real letterbox edge.
const TW = arg('tw', Math.round(H * 0.75 * 0.75)); // portrait width
const TH = arg('th', Math.round(H * 0.86));
const TX = arg('tx', Math.round((W - TW) / 2));
const TY = arg('ty', Math.round((H - TH) / 2));

async function greyFrameWithCursor(tipX: number, tipY: number): Promise<Buffer> {
  // Base: full grey, or (letterbox) a grey tight-region inset in a black frame.
  const base = LB
    ? sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite([{
          input: {
            create: { width: TW, height: TH, channels: 3, background: { r: GREY, g: GREY, b: GREY } },
          },
          left: TX, top: TY,
        }])
    : sharp({
        create: { width: W, height: H, channels: 3, background: { r: GREY, g: GREY, b: GREY } },
      });
  // sharp only allows one composite() chain per pipeline; re-wrap for the cursor.
  const canvas = LB ? sharp(await base.png().toBuffer()) : base;
  // Composite the sprite so its centre lands at (tipX, tipY), cropping the part
  // that would fall off-canvas (models a cursor near/over the frame edge).
  const spriteLeft = tipX - CENTER;
  const spriteTop = tipY - CENTER;
  const cropLeft = Math.max(0, -spriteLeft);
  const cropTop = Math.max(0, -spriteTop);
  const destLeft = Math.max(0, spriteLeft);
  const destTop = Math.max(0, spriteTop);
  const cropW = Math.min(SPRITE - cropLeft, W - destLeft);
  const cropH = Math.min(SPRITE - cropTop, H - destTop);
  if (cropW <= 0 || cropH <= 0) {
    return canvas.jpeg({ quality: 80 }).toBuffer(); // fully off-frame — no cursor
  }
  const spriteCrop = await sharp(path.resolve('ml/cursor-sprite.png'))
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .png()
    .toBuffer();
  return canvas
    .composite([{ input: spriteCrop, left: destLeft, top: destTop }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

interface Cell {
  col: number; row: number;
  tip: { x: number; y: number };
  quadrant: string;
  mlLoaded: boolean; mlHit: boolean; mlResidual: number | null;
  darkHit: boolean; darkResidual: number | null;
  brightHit: boolean; brightResidual: number | null;
  located: boolean; residual: number | null; // openLoopShape gate outcome (pre-wiggle)
}

function quadrantOf(x: number, y: number): string {
  // Relative to the tight-region centre in letterbox mode, else the frame centre.
  const cx = LB ? TX + TW / 2 : W / 2;
  const cy = LB ? TY + TH / 2 : H / 2;
  const right = x > cx, bottom = y > cy;
  return `${bottom ? 'lower' : 'upper'}-${right ? 'right' : 'left'}`;
}

async function main() {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  // Suspect #1 crux: does detectIpadRegion + NATIVE_MARGIN cover the upper-right?
  if (LB) {
    const probe = await greyFrameWithCursor(-999, -999); // cursorless letterbox frame
    try {
      const r = await detectIpadRegion(probe);
      const inset = { x: r.x + NATIVE_MARGIN, y: r.y + NATIVE_MARGIN, w: r.w - 2 * NATIVE_MARGIN, h: r.h - 2 * NATIVE_MARGIN };
      const urTip = { x: Math.round(TX + TW * 0.75), y: Math.round(TY + TH * 0.25) };
      const urCovered = urTip.x >= inset.x && urTip.x <= inset.x + inset.w &&
                        urTip.y >= inset.y && urTip.y <= inset.y + inset.h;
      console.log(`[region] true tight = (${TX},${TY},${TW},${TH})`);
      console.log(`[region] detectIpadRegion = (${r.x},${r.y},${r.w},${r.h}); cascade inset(-${NATIVE_MARGIN}px) = (${inset.x},${inset.y},${inset.w},${inset.h})`);
      console.log(`[region] upper-right target ${JSON.stringify(urTip)} covered by cascade region: ${urCovered}`);
    } catch (e) {
      console.log(`[region] detectIpadRegion FAILED: ${(e as Error).message}`);
    }
  }

  const cells: Cell[] = [];

  // Grid of tip positions across the frame (10% margin so most sprites fit, but
  // the 0.75w/0.25h upper-right point — the finding's target — is well inside).
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const fx = c / (COLS - 1), fy = r / (ROWS - 1);
      const tipX = LB ? Math.round(TX + TW * (0.08 + 0.84 * fx)) : Math.round(W * (0.08 + 0.84 * fx));
      const tipY = LB ? Math.round(TY + TH * (0.08 + 0.84 * fy)) : Math.round(H * (0.08 + 0.84 * fy));
      const tip = { x: tipX, y: tipY };
      // Perfect hint by default; inject a fixed downward-right offset if asked.
      const hint = { x: tipX + HINT_OFFSET, y: tipY + HINT_OFFSET };

      const jpeg = await greyFrameWithCursor(tipX, tipY);
      const shot = await decodeScreenshot(jpeg);

      // ML multi-hint (may be null offline — no single-stage model committed).
      let mlLoaded = false, mlHit = false, mlResidual: number | null = null;
      try {
        const hints = buildMLHints(hint, shot.width, shot.height, hint);
        const ml = await findCursorByMLMultiHint(shot.buffer, shot.width, shot.height, hints, {
          minConfidence: 0.5,
        });
        if (ml) {
          mlLoaded = true;
          mlResidual = dist({ x: ml.x, y: ml.y }, tip);
          mlHit = mlResidual <= HIT_PX;
        }
      } catch { /* model absent / inference error → treat as null */ }

      // Shape dark + bright, exactly as locateOpenLoopShape calls them.
      const dark = findCursorByShape(shot.rgb, shot.width, shot.height, {
        expectedNear: hint, expectedNearRadius: 100,
      });
      const bright = findCursorByShape(shot.rgb, shot.width, shot.height, {
        expectedNear: hint, expectedNearRadius: 100, brightThreshold: 120,
      });

      // openLoopShape candidate gate (pre-wiggle): shapeScore>=0.05 OR prox<=30.
      const candidates: Array<{ pos: { x: number; y: number }; score: number }> = [];
      for (const cand of [dark, bright]) {
        if (!cand) continue;
        const pos = { x: Math.round(cand.centroidX), y: Math.round(cand.centroidY) };
        const prox = dist(pos, hint);
        if (cand.shapeScore >= 0.05 || prox <= 30) candidates.push({ pos, score: cand.shapeScore });
      }
      candidates.sort((a, b) => b.score - a.score);

      const darkResidual = dark ? dist({ x: dark.centroidX, y: dark.centroidY }, tip) : null;
      const brightResidual = bright ? dist({ x: bright.centroidX, y: bright.centroidY }, tip) : null;
      const chosen = candidates[0] ?? (mlHit ? { pos: tip, score: 1 } : null);
      const residual = chosen ? dist(chosen.pos, tip) : null;
      const located = chosen !== null && residual !== null && residual <= HIT_PX;

      cells.push({
        col: c, row: r, tip, quadrant: quadrantOf(tipX, tipY),
        mlLoaded, mlHit, mlResidual,
        darkHit: darkResidual !== null && darkResidual <= HIT_PX, darkResidual,
        brightHit: brightResidual !== null && brightResidual <= HIT_PX, brightResidual,
        located, residual,
      });
    }
  }

  // --- Report ---
  const anyMl = cells.some((c) => c.mlLoaded);
  const locateRate = cells.filter((c) => c.located).length / cells.length;
  const hits = cells.filter((c) => c.located && c.residual !== null).map((c) => c.residual!) as number[];
  hits.sort((a, b) => a - b);
  const p50 = hits.length ? hits[Math.floor(hits.length / 2)] : null;

  const byQuad = new Map<string, { n: number; hit: number }>();
  for (const c of cells) {
    const q = byQuad.get(c.quadrant) ?? { n: 0, hit: 0 };
    q.n++; if (c.located) q.hit++;
    byQuad.set(c.quadrant, q);
  }

  console.log(`\nopenLoopShape OFFLINE sweep — ${W}x${H} grey ${GREY}, ${COLS}x${ROWS} grid, HIT<=${HIT_PX}px, hint-offset ${HINT_OFFSET}`);
  console.log(`ML sub-detector loaded: ${anyMl ? 'YES' : 'NO (single-stage model absent → shape-only path)'}`);
  console.log(`Overall locate rate: ${(locateRate * 100).toFixed(0)}%  (p50 residual on hit: ${p50 ?? 'n/a'}px)`);
  console.log('\nPer-quadrant locate rate:');
  for (const [q, v] of [...byQuad.entries()].sort()) {
    console.log(`  ${q.padEnd(12)} ${((v.hit / v.n) * 100).toFixed(0)}%  (${v.hit}/${v.n})`);
  }
  console.log('\nLocate grid (row 0 = top; ✓=located ·=miss), tip col→:');
  for (let r = 0; r < ROWS; r++) {
    let line = '  ';
    for (let c = 0; c < COLS; c++) {
      const cell = cells.find((x) => x.col === c && x.row === r)!;
      line += cell.located ? ' ✓ ' : ' · ';
    }
    console.log(line);
  }

  const outDir = path.resolve('data/bench-openloopshape-offline');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'results.json'),
    JSON.stringify({
      params: { W, H, COLS, ROWS, GREY, HIT_PX, HINT_OFFSET },
      mlLoaded: anyMl, locateRate, p50Residual: p50,
      quadrants: Object.fromEntries([...byQuad.entries()].map(([q, v]) => [q, v.hit / v.n])),
      cells,
    }, null, 2),
  );
  console.log(`\nWrote ${path.join(outDir, 'results.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
