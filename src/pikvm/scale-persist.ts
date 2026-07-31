/**
 * Persistence for the passive scale learner (task #41).
 *
 * The learned per-axis scales survive restarts so a fresh process warm-starts from
 * the last-known-good value instead of re-learning (and clicking uncorrected) each
 * session. Writes are PERIODIC/debounced, never per-move.
 *
 * Location (contract locked with pikvm-nixos 2026-07-31): the wrapper sets
 *   PIKVM_STATE_DIR = the pikvm-mcp home-manager dataDir (~/.local/share/pikvm-mcp)
 * — the dir that ALREADY survives darwin-rebuild switches and holds the production
 * data/ (ballistics.json, cursor templates). We persist a SEPARATE file
 *   ${PIKVM_STATE_DIR}/data/mover-scale.json
 * in that same surviving data/ dir — deliberately NOT merged into ballistics.json:
 * that file is the ballistics PROFILE (loadProfile requires version:1 and rethrows
 * on a malformed parse), and mixing the unrelated curveScale-learner state into it
 * risks breaking the profile loader for zero benefit. A sibling file survives
 * identically and orphans nothing. Dev fallback: cwd/data. (Env unset ⇒ cwd.)
 *
 * Everything here is FAIL-SAFE: an unreadable/corrupt file → start from defaults; an
 * unwritable dir → learn in-memory only (logged once). The learner never blocks or
 * throws on I/O.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
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

/** The base dir the wrapper provides (PIKVM_STATE_DIR), else cwd for dev. Read as an
 *  OPAQUE absolute path — do not assume XDG_STATE vs XDG_DATA. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIKVM_STATE_DIR ?? process.cwd();
}
/** The persisted file, a sibling of ballistics.json in the surviving data/ dir. */
export function statePath(env?: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'data', FILE);
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
    const file = statePath(env);
    const dir = path.dirname(file); // the surviving data/ dir
    await fs.mkdir(dir, { recursive: true });
    // atomic-ish: write a temp then rename, so a crash mid-write can't corrupt the file.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, file);
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
