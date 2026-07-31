import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stateDir, statePath, loadPersisted, savePersisted, deletePersisted, type PersistedState } from '../scale-persist.js';

const mkState = (y = 1.031): PersistedState => ({
  version: 1,
  scales: { x: { applied: 1.0, accepted: 10, lastUpdate: 1 }, y: { applied: y, accepted: 40, lastUpdate: 2 } },
  provenance: { region: { w: 680, h: 968 }, savedAt: '2026-07-31T00:00:00Z' },
});

describe('scale-persist — location precedence', () => {
  it('prefers PIKVM_MCP_STATE_DIR, then $XDG_STATE_HOME/pikvm-mcp, then ~/.local/state/pikvm-mcp', () => {
    expect(stateDir({ PIKVM_MCP_STATE_DIR: '/custom' } as NodeJS.ProcessEnv)).toBe('/custom');
    expect(stateDir({ XDG_STATE_HOME: '/xdg' } as NodeJS.ProcessEnv)).toBe(path.join('/xdg', 'pikvm-mcp'));
    expect(stateDir({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.local', 'state', 'pikvm-mcp'));
    expect(statePath({ PIKVM_MCP_STATE_DIR: '/custom' } as NodeJS.ProcessEnv)).toBe(path.join('/custom', 'mover-scale.json'));
  });
});

describe('scale-persist — round-trip + fail-safe (temp dir)', () => {
  let dir: string | null = null;
  const envFor = (d: string) => ({ PIKVM_MCP_STATE_DIR: d } as NodeJS.ProcessEnv);
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
    const env = { PIKVM_MCP_STATE_DIR: path.join(blocker, 'sub') } as NodeJS.ProcessEnv; // under a file
    expect(await savePersisted(mkState(), env)).toBe(false);
  });
});
