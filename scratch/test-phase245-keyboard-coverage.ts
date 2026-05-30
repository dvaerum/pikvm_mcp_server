/**
 * Phase 245 keyboard-workflow coverage smoke test: live-verify
 * launchIpadApp across multiple apps (not just Settings) to confirm
 * the keyboard-first recipe generalizes.
 *
 * Phase 234 only verified Settings. Real callers use launchIpadApp
 * for Files, App Store, Maps, Safari etc. This extends coverage to
 * a representative subset.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { launchIpadApp } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase245-keyboard-coverage';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 245 keyboard-workflow coverage at v${VERSION} ===\n`);

const apps = ['Files', 'App Store', 'Maps', 'Settings'];
for (const app of apps) {
  const r = await launchIpadApp(client, app);
  const slug = app.toLowerCase().replace(/ /g, '-');
  await fs.writeFile(`${ROOT}/${slug}.jpg`, r.screenshot);
  console.error(`${app}: ${r.message.split('.')[0]}`);
}
process.exit(0);
