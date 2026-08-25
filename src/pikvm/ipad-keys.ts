/**
 * Shared iPad key-recovery sequences.
 *
 * F7 (Round 2 Phase 4): the Phase-217 unlock triad and Phase-231 defensive
 * pair were duplicated verbatim in two places — ipad-unlock.ts's own
 * `unlockIpad`/`ipadGoHome` call sites, and cursor-anchor.ts's
 * `key-sequence-retry`/`defensive-keys` recovery kinds — with the tuned-
 * constant rationale living on only one of the two copies each time.
 * Extracted here rather than into either consuming module: ipad-unlock.ts
 * already imports `anchorCursor` from cursor-anchor.ts, so having
 * cursor-anchor.ts import back from ipad-unlock.ts would recreate the
 * exact import cycle F9 (Round 2 Phase 3b) spent an entire PR breaking.
 * Both modules import from here instead — pure mechanism, no policy about
 * when to call these.
 */

import { PiKVMClient } from './client.js';
import { sleep } from './util.js';

/**
 * Esc → Enter → Space, the Phase-217 (v0.5.x) iPad unlock/dismiss key
 * sequence:
 *
 * - Escape closes any Control Center/Notification overlay a prior failed
 *   gesture may have left open.
 * - Enter is the actual unlock key on iPadOS 26 lock screens.
 * - Space was the working unlock key on older iPadOS revisions and is
 *   kept as a fallback for targets on an older OS.
 *
 * The pacing (200ms / 600ms / 400ms) is empirically tuned, not arbitrary —
 * don't compress it without re-verifying live. Callers decide what to do
 * on failure (this function doesn't wrap itself in a try/catch — that's
 * caller-specific fallthrough logic, e.g. unlockIpad falling through to
 * the swipe-based unlock).
 */
export async function ipadUnlockKeySequence(client: PiKVMClient): Promise<void> {
  await client.sendKey('Escape');
  await sleep(200);
  await client.sendKey('Enter');
  await sleep(600);
  await client.sendKey('Space');
  await sleep(400);
}

/**
 * Esc → Enter, the Phase-231 (v0.5.207) defensive belt-and-suspenders
 * pair: a swipe-up gesture sometimes re-locks an already-unlocked iPad
 * (live-verified 2026-05-10) — the same hazard Phase 219 fixed for
 * unlockIpad's own swipe path. Esc + Enter is a no-op on an already-home
 * screen but unlocks again if the swipe accidentally re-locked. Cheap
 * (~800ms), no re-attempt of whatever triggered it — the caller inspects
 * its own returned screenshot to judge whether it worked.
 *
 * Pacing (200ms / 600ms) is the same tuned rationale as
 * {@link ipadUnlockKeySequence} minus the Space fallback (this pair runs
 * post-swipe, not pre-unlock, so the older-iPadOS Space fallback doesn't
 * apply here).
 */
export async function ipadDefensiveKeys(client: PiKVMClient): Promise<void> {
  await client.sendKey('Escape');
  await sleep(200);
  await client.sendKey('Enter');
  await sleep(600);
}
