import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from '../src/pikvm/click-verify.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const r = await clickAtWithRetry(client, { x: 960, y: 740 }, {
  maxRetries: defaultMaxRetriesFor(false),
  moveToOptions: { forbidSlamFallback: true, strategy: 'detect-then-move' },
  maxResidualPx: 100,  // loose — big button
  requireVerifiedCursor: true,
  verifyOptions: { region: { x: 960, y: 740, halfWidth: 150, halfHeight: 60 }, minChangedFraction: 0.05 },
});
console.log(`${r.success ? 'HIT' : 'FAIL'} attempts=${r.attempts}`);
