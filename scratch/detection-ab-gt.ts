/**
 * DETECTION-ACCURACY A/B vs getCursor ground truth — the SENSITIVE proof of the
 * cascade's FP-fix (the click bench can't see a 1-2pp lift; this measures detection
 * error directly). At each of N diverse cursor positions on the REAL home screen
 * (incl. the failure surface: clean wallpaper away from the widget, on/near the Maps
 * widget, over icons), we read getCursor (ground truth, mapped to HDMI), screenshot,
 * and run BOTH detectors on that same frame:
 *   v13   = single-stage full-frame argmax (the shipped detector that FPs on widgets)
 *   casc  = cursor-v14 proposer top-K -> crop-verifier -> best (the new cascade)
 * Reports per-detector median error + GROSS-MISS rate (err>50px OR null-when-present)
 * — the gross misses are the widget FPs the cascade is meant to eliminate.
 *
 * NOT detector-residual-as-truth: error is vs getCursor (iPadCollector), the real
 * ground truth. Placement uses curve-one-shot; wherever the cursor actually lands,
 * getCursor gives truth, so every frame is a valid paired data point.
 */
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { startIpadAppServer, killOrphansOnPort, type IpadSession } from '../src/pikvm/ipad-app-ws.js';

const PORT = 8767, DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', BUNDLE = 'com.bb.iPadCollector';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IW = 768, IH = 480, HW = 192, HH = 120, CROP = 96;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const FW = 1920, FH = 1080, K = 20, NMS = 70, THRESH = 0.5, GROSS = 50;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// Diverse HDMI targets: clean wallpaper (FP bait), on/near Maps widget, on icons, widgets.
const TARGETS: { x: number; y: number; note: string }[] = [
  { x: 680, y: 430, note: 'clean-wallpaper-left' }, { x: 700, y: 900, note: 'clean-lower-left' },
  { x: 950, y: 950, note: 'clean-bottom-mid' }, { x: 1240, y: 880, note: 'clean-lower-right' },
  { x: 660, y: 620, note: 'clean-mid-left' }, { x: 900, y: 500, note: 'weather-widget' },
  { x: 1110, y: 297, note: 'MAPS-WIDGET' }, { x: 1130, y: 324, note: 'maps-button' },
  { x: 757, y: 837, note: 'Books-icon' }, { x: 1162, y: 570, note: 'Maps-icon' },
  { x: 1027, y: 702, note: 'AppStore-icon' }, { x: 1027, y: 837, note: 'Settings-icon' },
  { x: 760, y: 180, note: 'Clock-widget' }, { x: 830, y: 290, note: 'Calendar-widget' },
  { x: 1162, y: 435, note: 'Files-icon' }, { x: 1027, y: 435, note: 'FaceTime-icon' },
];

async function rawInput(buf: Buffer, w: number, h: number, box?: { left: number; top: number; width: number; height: number }) {
  let s = sharp(buf);
  if (box) s = s.extract(box);
  const { data } = await s.resize(w, h, { fit: 'fill', kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = w * h; const inp = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) { inp[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0]; inp[plane + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1]; inp[2 * plane + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2]; }
  return inp;
}

// v13 single-stage: argmax of heatmap, gated by presence>0.5 (production behavior).
async function detectV13(sess: ort.InferenceSession, buf: Buffer) {
  const inp = await rawInput(buf, IW, IH);
  const r = await sess.run({ frame: new ort.Tensor('float32', inp, [1, 3, IH, IW]) });
  const hm = r.heatmap_logits.data as Float32Array;
  const presence = sig((r.presence_logit.data as Float32Array)[0]);
  if (presence < 0.5) return null;
  let bi = 0; for (let i = 1; i < hm.length; i++) if (hm[i] > hm[bi]) bi = i;
  return { x: Math.round((bi % HW) / HW * FW), y: Math.round(Math.floor(bi / HW) / HH * FH) };
}

async function detectCascade(prop: ort.InferenceSession, ver: ort.InferenceSession, buf: Buffer) {
  const inp = await rawInput(buf, IW, IH);
  const r = await prop.run({ frame: new ort.Tensor('float32', inp, [1, 3, IH, IW]) });
  const hm = r.heatmap_logits.data as Float32Array;
  const order = [...hm.keys()].sort((a, b) => hm[b] - hm[a]);
  const peaks: { x: number; y: number }[] = [];
  for (const i of order) { const nx = Math.round((i % HW) / HW * FW), ny = Math.round(Math.floor(i / HW) / HH * FH); if (peaks.some((p) => Math.hypot(p.x - nx, p.y - ny) < NMS)) continue; peaks.push({ x: nx, y: ny }); if (peaks.length >= K) break; }
  let best: { x: number; y: number; v: number } | null = null;
  for (const p of peaks) {
    const left = Math.max(0, Math.min(FW - CROP, p.x - CROP / 2)), top = Math.max(0, Math.min(FH - CROP, p.y - CROP / 2));
    const ci = await rawInput(buf, CROP, CROP, { left, top, width: CROP, height: CROP });
    const cr = await ver.run({ crop: new ort.Tensor('float32', ci, [1, 3, CROP, CROP]) });
    const v = sig((cr.logit.data as Float32Array)[0]);
    if (!best || v > best.v) best = { ...p, v };
  }
  return best && best.v >= THRESH ? { x: best.x, y: best.y } : null;
}

function waitForSession(timeoutMs = 30000): Promise<{ sess: IpadSession; close: () => Promise<void> }> {
  let first: IpadSession | null = null;
  return new Promise((resolve, reject) => {
    const stop = startIpadAppServer({ port: PORT, onSession: async (sess) => { if (first) return; first = sess; const t0 = Date.now(); while (!sess.hello && Date.now() - t0 < 5000) await sleep(20); resolve({ sess, close: async () => { (await stop).close(); } }); } });
    setTimeout(() => { if (!first) { stop.then((s) => s.close()).catch(() => undefined); reject(new Error('no connect')); } }, timeoutMs);
  });
}

async function main() {
  killOrphansOnPort(PORT);
  const client = new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(client); await sleep(1500);
  const home = await client.screenshot();
  const reg = await detectIpadRegion(home.buffer);
  const tight = { x: reg.x + NATIVE_MARGIN, y: reg.y + NATIVE_MARGIN, w: reg.w - 2 * NATIVE_MARGIN, h: reg.h - 2 * NATIVE_MARGIN };
  try { execSync(`xcrun devicectl device process launch --terminate-existing --device ${DEVICE} ${BUNDLE}`, { stdio: 'pipe' }); } catch { /* */ }
  await sleep(3000);
  const { sess, close } = await waitForSession();
  if (!sess.hello) { await close(); throw new Error('no hello'); }
  const toHdmi = (x: number, y: number) => ({ x: tight.x + (x / sess.hello!.logicalW) * tight.w, y: tight.y + (y / sess.hello!.logicalH) * tight.h });
  const v13 = await ort.InferenceSession.create('ml/cursor-v13.onnx');
  const prop = await ort.InferenceSession.create('ml/cursor-v14-ep05.onnx');
  const ver = await ort.InferenceSession.create('ml/crop-verifier.onnx');

  const rows: string[] = ['note\ttruth_x\ttruth_y\tv13_err\tv13_gross\tcasc_err\tcasc_gross'];
  const v13errs: number[] = [], cascErrs: number[] = []; let v13gross = 0, cascGross = 0, n = 0;
  for (const t of TARGETS) {
    await moveToPixel(client, t, { strategy: 'curve-one-shot' }).catch(() => undefined);
    await sleep(500);
    let g = null; for (let i = 0; i < 5; i++) { const c = await sess.getTrackedCursor(); if (c) { g = toHdmi(c.x, c.y); break; } await sleep(150); }
    if (!g) { console.error(`  ${t.note}: no getCursor, skip`); continue; }
    const shot = await client.screenshot();
    const dv13 = await detectV13(v13, shot.buffer);
    const dc = await detectCascade(prop, ver, shot.buffer);
    const ev = dv13 ? Math.hypot(dv13.x - g.x, dv13.y - g.y) : Infinity;
    const ec = dc ? Math.hypot(dc.x - g.x, dc.y - g.y) : Infinity;
    const gv = ev > GROSS, gc = ec > GROSS;
    if (Number.isFinite(ev)) v13errs.push(ev); if (Number.isFinite(ec)) cascErrs.push(ec);
    if (gv) v13gross++; if (gc) cascGross++; n++;
    rows.push(`${t.note}\t${g.x.toFixed(0)}\t${g.y.toFixed(0)}\t${Number.isFinite(ev) ? ev.toFixed(0) : 'NULL'}\t${gv ? 'GROSS' : '.'}\t${Number.isFinite(ec) ? ec.toFixed(0) : 'NULL'}\t${gc ? 'GROSS' : '.'}`);
    console.error(`  ${t.note.padEnd(20)} truth(${g.x.toFixed(0)},${g.y.toFixed(0)})  v13 err=${Number.isFinite(ev) ? ev.toFixed(0) : 'NULL'}${gv ? ' GROSS' : ''}  casc err=${Number.isFinite(ec) ? ec.toFixed(0) : 'NULL'}${gc ? ' GROSS' : ''}`);
  }
  await close().catch(() => undefined);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  await fs.writeFile(`scratch/detection-ab-${ts}.tsv`, rows.join('\n') + '\n');
  console.error(`\n=== DETECTION A/B vs getCursor (N=${n}) ===`);
  console.error(`v13  : median err=${median(v13errs).toFixed(0)}px  gross-miss=${v13gross}/${n} (${(v13gross / n * 100).toFixed(0)}%)`);
  console.error(`casc : median err=${median(cascErrs).toFixed(0)}px  gross-miss=${cascGross}/${n} (${(cascGross / n * 100).toFixed(0)}%)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
