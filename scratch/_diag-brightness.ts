import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { analyzeBrightness, DIM_THRESHOLD, MIN_STDDEV_FOR_CONTRAST } from '../src/pikvm/brightness.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const jpg = await takeRawScreenshot(client);
const b = await analyzeBrightness(jpg, {});
console.log(`mean=${b.mean.toFixed(1)} stddev=${b.stddev.toFixed(1)} ` +
  `(gate: mean ≥ ${DIM_THRESHOLD}, stddev ≥ ${MIN_STDDEV_FOR_CONTRAST})`);
console.log(b.mean >= DIM_THRESHOLD && b.stddev >= MIN_STDDEV_FOR_CONTRAST ? 'OK' : 'DIM — would abort');
