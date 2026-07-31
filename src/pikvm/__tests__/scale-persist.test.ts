import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stateDir, statePath, loadPersisted, savePersisted, deletePersisted, type PersistedState } from '../scale-persist.js';

const mkState = (y = 1.031): PersistedState => ({
  version: 1,
  scales: { x: { applied: 1.0, lastUpdate: 1 }, y: { applied: y, lastUpdate: 2 } },
  provenance: { region: { w: 680, h: 968 }, savedAt: '2026-07-31T00:00:00Z' },
});

describe('scale-persist — location contract (PIKVM_STATE_DIR)', () => {
  it('reads PIKVM_STATE_DIR as an opaque abs path (else cwd) and joins data/mover-scale.json', () => {
    expect(stateDir({ PIKVM_STATE_DIR: '/Users/georg/.local/share/pikvm-mcp' } as NodeJS.ProcessEnv))
      .toBe('/Users/georg/.local/share/pikvm-mcp');
    expect(stateDir({} as NodeJS.ProcessEnv)).toBe(process.cwd()); // dev fallback
    expect(statePath({ PIKVM_STATE_DIR: '/base' } as NodeJS.ProcessEnv))
      .toBe(path.join('/base', 'data', 'mover-scale.json')); // sibling of ballistics.json, NOT merged into it
  });
});

describe('scale-persist — round-trip + fail-safe (temp dir)', () => {
  let dir: string | null = null;
  const envFor = (d: string) => ({ PIKVM_STATE_DIR: d } as NodeJS.ProcessEnv);
  afterEach(async () => { if (dir) { await fs.rm(dir, { recursive: true, force: true }); dir = null; } });

  it('save → load round-trips the state', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scalep-'));
    const env = envFor(dir);
    expect(await savePersisted(mkState(1.031), env)).toBe(true);
    const loaded = await loadPersisted(env);
    expect(loaded?.scales.y.applied).toBeCloseTo(1.031, 5);
    expect(loaded?.provenance.region).toEqual({ w: 680, h: 968 });
  });

  it('load returns null on an absent or corrupt file (never throws)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scalep-'));
    const env = envFor(dir);
    expect(await loadPersisted(env)).toBeNull();          // absent
    await fs.mkdir(path.dirname(statePath(env)), { recursive: true });
    await fs.writeFile(statePath(env), '{ not json');       // corrupt
    expect(await loadPersisted(env)).toBeNull();
  });

  it('delete removes the file; deleting an absent file is still success', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scalep-'));
    const env = envFor(dir);
    await savePersisted(mkState(), env);
    expect(await deletePersisted(env)).toBe(true);
    expect(await loadPersisted(env)).toBeNull();
    expect(await deletePersisted(env)).toBe(true);          // idempotent
  });

  it('save returns false (does not throw) when the dir is unwritable → caller degrades to in-memory', async () => {
    // point at a path under a regular FILE so mkdir fails
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scalep-'));
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'x');
    const env = { PIKVM_STATE_DIR: path.join(blocker, 'sub') } as NodeJS.ProcessEnv; // under a file
    expect(await savePersisted(mkState(), env)).toBe(false);
  });
});
