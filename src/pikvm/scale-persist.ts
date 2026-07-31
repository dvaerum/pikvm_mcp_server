/**
 * Persistence for the passive scale learner (task #41).
 *
 * The learned per-axis scales survive restarts so a fresh process warm-starts from
 * the last-known-good value instead of re-learning (and clicking uncorrected) each
 * session. Writes are PERIODIC/debounced, never per-move.
 *
 * Location precedence (pikvm-nixos wires the first; the rest are safe fallbacks):
 *   PIKVM_MCP_STATE_DIR  →  $XDG_STATE_HOME/pikvm-mcp  →  ~/.local/state/pikvm-mcp
 * NOT ./data/ballistics.json — that resolves under cwd and is inert against the
 * read-only nix store the appliance/wrapper runs from.
 *
 * Everything here is FAIL-SAFE: an unreadable/corrupt file → start from defaults; an
 * unwritable dir → learn in-memory only (logged once). The learner never blocks or
 * throws on I/O.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Axis } from './scale-learner.js';

const FILE = 'mover-scale.json';

export interface PersistedProvenance {
  /** detected iPad HDMI region at last write, {w,h}, for drift diagnosis; null if unknown. */
  region: { w: number; h: number } | null;
  /** wall-clock ISO of the last write (caller supplies; module never calls Date.now itself). */
  savedAt: string | null;
}
export interface PersistedState {
  version: 1;
  scales: Record<Axis, { applied: number; accepted: number; lastUpdate: number | null }>;
  provenance: PersistedProvenance;
}

/** Resolve the state directory by the documented precedence. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PIKVM_MCP_STATE_DIR) return env.PIKVM_MCP_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'pikvm-mcp');
  return path.join(os.homedir(), '.local', 'state', 'pikvm-mcp');
}
export function statePath(env?: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), FILE);
}

/** Load the persisted state, or null if absent/unreadable/corrupt (never throws). */
export async function loadPersisted(env?: NodeJS.ProcessEnv): Promise<PersistedState | null> {
  try {
    const raw = await fs.readFile(statePath(env), 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && parsed.version === 1 && parsed.scales) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the state (creating the dir). Returns true on success, false if unwritable —
 * the caller then degrades to in-memory. Never throws.
 */
export async function savePersisted(state: PersistedState, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const dir = stateDir(env);
    await fs.mkdir(dir, { recursive: true });
    // atomic-ish: write a temp then rename, so a crash mid-write can't corrupt the file.
    const tmp = path.join(dir, `${FILE}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, path.join(dir, FILE));
    return true;
  } catch {
    return false;
  }
}

/** Delete the persisted file (for reset). Absent file is success. Never throws. */
export async function deletePersisted(env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await fs.rm(statePath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}
