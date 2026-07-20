/**
 * OFFLINE GENERALIZATION GATE for cursor-v14 vs v13 (production-faithful: cubic
 * resize + ImageNet norm, exactly matching the live detector path).
 *
 * Two hold-outs (neither in v14's training set):
 *  1. HOME-FP (must NOT fire): hc13/15/17/18 — verified no-cursor current-home
 *     frames with the Maps widget. Reports presence + argmax peak location and
 *     flags if the peak lands ON the Maps widget (~1110,297 native, r<120).
 *  2. BOOKS-POS (must detect): the exact frame v13 MISSED (real cursor on the
 *     orange Books icon @757,846, v13 heatmap 0.0012). Reports presence + peak
 *     distance to the true cursor.
 *
 * PASS for v14 = home-FP peaks OFF the widget / low presence AND books detected
 * near 757,846 with high peak. Prints a side-by-side v13-vs-v14 table.
 */
import ort from 'onnxruntime-node';
import sharp from 'sharp';

const IW = 768, IH = 480, HW = 192, HH = 120;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const FW = 1920, FH = 1080;
const sig = (z: number) => 1 / (1 + Math.exp(-z));

const HOME = [13, 15, 17, 18].map((n) => `scratch/hc${n}.jpg`);
const MAPS_WIDGET = { x: 1110, y: 297 };
const BOOKS = { path: 'scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg', x: 757, y: 846 };
// EASY positive: the SAME real home screen as the hc frames but WITH the cursor,
// on plain blue wallpaper at the left edge (verified by eye, v13 scored 0.9993).
// Pairs with the home-FP frames: same screen, cursor present vs absent — the exact
// separation we want. Guards against the more-negatives model regressing easy detect.
const CLEAN = { path: 'scratch/clean-cursor.jpg', x: 620, y: 432 };

async function infer(sess: ort.InferenceSession, src: string) {
  const { data: rgb } = await sharp(src).resize(IW, IH, { fit: 'fill', kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * IW * IH), plane = IW * IH;
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const s = (y * IW + x) * 3, d = y * IW + x;
    inp[d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
    inp[plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
    inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
  }
  const r = await sess.run({ frame: new ort.Tensor('float32', inp, [1, 3, IH, IW]) });
  const hm = r.heatmap_logits.data as Float32Array;
  const pres = sig((r.presence_logit.data as Float32Array)[0]);
  let bi = 0; for (let i = 1; i < hm.length; i++) if (hm[i] > hm[bi]) bi = i;
  const peak = sig(hm[bi]);
  const nx = Math.round((bi % HW) / HW * FW), ny = Math.round(Math.floor(bi / HW) / HH * FH);
  // also read heatmap sigmoid AT a given native location
  const at = (px: number, py: number) => {
    const hx = Math.min(HW - 1, Math.round(px / FW * HW)), hy = Math.min(HH - 1, Math.round(py / FH * HH));
    return sig(hm[hy * HW + hx]);
  };
  return { pres, peak, nx, ny, at };
}

async function evalModel(tag: string, onnxPath: string) {
  const sess = await ort.InferenceSession.create(onnxPath);
  console.log(`\n===== ${tag} (${onnxPath}) =====`);
  console.log('-- HOME-FP hold-out (want: peak OFF Maps widget, low presence) --');
  let widgetFPs = 0;
  for (const f of HOME) {
    const r = await infer(sess, f);
    const dWidget = Math.hypot(r.nx - MAPS_WIDGET.x, r.ny - MAPS_WIDGET.y);
    const onWidget = dWidget < 120;
    if (onWidget && r.pres > 0.5) widgetFPs++;
    console.log(`  ${f.padEnd(16)} pres=${r.pres.toFixed(3)} peak=${r.peak.toFixed(3)} @(${r.nx},${r.ny}) ` +
      `${onWidget ? `<-- ON MAPS WIDGET (${dWidget.toFixed(0)}px)` : `off-widget (${dWidget.toFixed(0)}px)`}  ` +
      `hm@widget=${r.at(MAPS_WIDGET.x, MAPS_WIDGET.y).toFixed(3)}`);
  }
  console.log(`  => widget false-positives: ${widgetFPs}/${HOME.length}`);
  console.log('-- BOOKS-POS hold-out (want: detected near 757,846, high peak) --');
  const b = await infer(sess, BOOKS.path);
  const dist = Math.hypot(b.nx - BOOKS.x, b.ny - BOOKS.y);
  console.log(`  pres=${b.pres.toFixed(3)} peak=${b.peak.toFixed(3)} @(${b.nx},${b.ny})  ` +
    `dist-to-cursor=${dist.toFixed(0)}px  hm@cursor=${b.at(BOOKS.x, BOOKS.y).toFixed(4)}` +
    `  ${dist < 80 ? '<-- DETECTED' : '<-- MISS'}`);
  console.log('-- CLEAN-POS hold-out (same home screen, cursor on blue wallpaper @620,432) --');
  const c = await infer(sess, CLEAN.path);
  const cdist = Math.hypot(c.nx - CLEAN.x, c.ny - CLEAN.y);
  console.log(`  pres=${c.pres.toFixed(3)} peak=${c.peak.toFixed(3)} @(${c.nx},${c.ny})  ` +
    `dist-to-cursor=${cdist.toFixed(0)}px  hm@cursor=${c.at(CLEAN.x, CLEAN.y).toFixed(4)}` +
    `  ${cdist < 80 ? '<-- DETECTED' : '<-- MISS'}`);
}

// Optional: pass a v14 onnx path as the first non-flag arg (e.g. a snapshot
// ml/cursor-v14-ep05.onnx) so we can gate a checkpoint without racing the live
// cursor-v14.onnx. `--v14-only` skips the v13 baseline.
const v14only = process.argv.includes('--v14-only');
const v14Path = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'ml/cursor-v14.onnx';
if (!v14only) await evalModel('v13 (baseline)', 'ml/cursor-v13.onnx');
await evalModel(`v14 (${v14Path})`, v14Path);
