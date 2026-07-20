/**
 * Target localization — Stage 1 (OCR text). TAP A UI ELEMENT BY ITS TEXT, no
 * hand-picked coordinates: screenshot → Apple Vision OCR (tools/ocr/ocr) → fuzzy-match
 * the query to a text element → click its centre via the shipped mover+cascade.
 * Usage: tsx tap-by-text.ts "Continue"   (or --locate-only to just print the match)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';

type El = { text: string; conf: number; x: number; y: number; w: number; h: number; cx: number; cy: number };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// tiny Levenshtein for near-matches
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function ocr(imgPath: string): El[] {
  const out = execFileSync('./tools/ocr/ocr', [imgPath], { maxBuffer: 8 << 20 }).toString();
  return JSON.parse(out) as El[];
}

/** Best text element for a query. Exact > substring > fuzzy (normalized edit distance). */
export function matchQuery(els: El[], query: string): { el: El; how: string; score: number } | null {
  const q = norm(query);
  const scored = els.map((el) => {
    const t = norm(el.text);
    let score: number, how: string;
    if (t === q) { score = 1.0; how = 'exact'; }
    else if (t.includes(q) || q.includes(t)) { score = 0.8 - Math.abs(t.length - q.length) / 100; how = 'substring'; }
    else { const dist = lev(t, q); score = 0.7 - dist / Math.max(t.length, q.length); how = `fuzzy(d=${dist})`; }
    return { el, how, score: score * (0.5 + 0.5 * el.conf) };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score > 0.35 ? best : null;
}

async function main() {
  const args = process.argv.slice(2);
  const locateOnly = args.includes('--locate-only');
  const query = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) { console.error('usage: tap-by-text.ts "<text>" [--locate-only]'); process.exit(1); }
  const client = new PiKVMClient(loadConfig().pikvm);
  await client.mouseMoveRelative(8, 8); await new Promise((r) => setTimeout(r, 60)); await client.mouseMoveRelative(-8, -8);  // wake cursor
  const shot = await client.screenshot();
  const tmp = 'scratch/tap-shot.jpg'; writeFileSync(tmp, shot.buffer);
  const els = ocr(tmp);
  const m = matchQuery(els, query);
  if (!m) { console.error(`NO MATCH for "${query}" among ${els.length} text elements`); process.exit(2); }
  console.error(`match "${m.el.text}" @(${m.el.cx},${m.el.cy}) via ${m.how} score=${m.score.toFixed(2)}`);
  if (locateOnly) return;
  const r = await clickAtWithRetry(client, { x: m.el.cx, y: m.el.cy }, { moveToOptions: { strategy: 'curve-one-shot' }, maxRetries: 3 });
  console.error(`click success=${r.success} resid=${r.finalMoveResult.finalResidualPx?.toFixed(1)}px`);
  await new Promise((r) => setTimeout(r, 1200));
  writeFileSync('scratch/explore-shot.jpg', (await client.screenshot()).buffer);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
