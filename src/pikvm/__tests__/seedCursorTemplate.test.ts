/**
 * Phase 59 — unit tests for seedCursorTemplate.
 *
 * The Phase 58 MCP tool wraps seedCursorTemplate; the orchestration is
 * pulled out as a pure function so it can be tested with a mock client.
 *
 * Test cases pin each branch:
 *   - success: cursor cluster detected, looksLikeCursor passes, template
 *     persisted (decision = 'added').
 *   - failure: motion-diff produces no clusters → reason mentions
 *     "no motion-diff clusters detected".
 *   - failure: looksLikeCursor rejects the template → reason mentions
 *     looksLikeCursor and ok=false.
 *   - duplicate: persistTemplate returns 'duplicate' → ok=false,
 *     templatePersisted=false, reason mentions "perceptually similar".
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { seedCursorTemplate } from '../seed-template.js';
import type { CursorTemplate } from '../cursor-detect.js';

/** Build a 256×256 PNG with optional bright cluster at (cx, cy). The
 *  cluster is a `size`×`size` square at brightness `gray`. */
async function pngWithCluster(
  cx: number | null,
  cy: number | null,
  gray: number = 220,
  size: number = 12,
): Promise<Buffer> {
  const w = 256, h = 256;
  const raw = Buffer.alloc(w * h * 3, 30); // dark grey background
  if (cx !== null && cy !== null) {
    const half = Math.floor(size / 2);
    for (let y = cy - half; y < cy - half + size; y++) {
      for (let x = cx - half; x < cx - half + size; x++) {
        const idx = (y * w + x) * 3;
        raw[idx] = gray;
        raw[idx + 1] = gray;
        raw[idx + 2] = gray;
      }
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

class ScriptedClient {
  callIndex = 0;
  shots: Buffer[] = [];
  emits: Array<{ dx: number; dy: number }> = [];
  async screenshot() {
    const buf = this.shots[Math.min(this.callIndex++, this.shots.length - 1)];
    return { buffer: buf, screenshotWidth: 256, screenshotHeight: 256 };
  }
  async mouseMoveRelative(dx: number, dy: number) {
    this.emits.push({ dx, dy });
  }
}

describe('seedCursorTemplate', () => {
  it('happy path: cursor cluster detected, template added', async () => {
    const before = await pngWithCluster(null, null);              // no cursor (faded)
    const after = await pngWithCluster(100, 100);                  // bright cluster appears
    const client = new ScriptedClient();
    client.shots = [before, after];

    let persistCalled = false;
    const result = await seedCursorTemplate(client, {
      sleep: async () => {},
      loadExisting: async () => [],
      persist: async (_dir, t, _existing) => {
        persistCalled = true;
        return { kept: [t], decision: 'added' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.cursorPosition).not.toBeNull();
    expect(result.cursorPosition!.x).toBeGreaterThanOrEqual(95);
    expect(result.cursorPosition!.x).toBeLessThanOrEqual(105);
    expect(result.templatePersisted).toBe(true);
    expect(result.decision).toBe('added');
    expect(persistCalled).toBe(true);
    expect(client.emits).toEqual([{ dx: 100, dy: 0 }]);
  });

  it('returns failure when motion-diff finds no clusters', async () => {
    // Both screenshots identical → no diff → no clusters.
    const same = await pngWithCluster(null, null);
    const client = new ScriptedClient();
    client.shots = [same, same];

    const result = await seedCursorTemplate(client, {
      sleep: async () => {},
      loadExisting: async () => [],
      persist: async () => {
        throw new Error('persist should not be called when there are no clusters');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.cursorPosition).toBeNull();
    expect(result.templatePersisted).toBe(false);
    expect(result.reason).toContain('no motion-diff clusters detected');
  });

  it('returns failure when looksLikeCursor rejects the extracted template', async () => {
    // Use a 3×3 cluster (9 bright pixels) — enough for motion-diff
    // (minClusterSize=4) but below the 4% threshold (≥23 px) that
    // looksLikeCursor requires of a 24×24 template. The cluster is
    // detected, the template is extracted, but looksLikeCursor rejects.
    //
    // Phase 53/56 keeps small clusters / text fragments / dim regions
    // out of the template set even when motion-diff produces a
    // candidate.
    const before = await pngWithCluster(null, null);
    const after = await pngWithCluster(100, 100, 220, 3);  // 3×3 = 9 px
    const client = new ScriptedClient();
    client.shots = [before, after];

    const result = await seedCursorTemplate(client, {
      sleep: async () => {},
      loadExisting: async () => [],
      persist: async () => {
        throw new Error('persist should not be called when looksLikeCursor rejects');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.templatePersisted).toBe(false);
    expect(result.reason).toContain('looksLikeCursor');
    // Motion-diff DID find the cluster — cursorPosition is reported even
    // though the template was rejected.
    expect(result.cursorPosition).not.toBeNull();
  });

  it('returns ok=false on duplicate but reports the cursor position', async () => {
    const before = await pngWithCluster(null, null);
    const after = await pngWithCluster(100, 100);
    const client = new ScriptedClient();
    client.shots = [before, after];

    const result = await seedCursorTemplate(client, {
      sleep: async () => {},
      loadExisting: async () => [{ rgb: Buffer.alloc(0), width: 0, height: 0 } as CursorTemplate],
      persist: async (_dir, _t, existing) => ({ kept: existing, decision: 'duplicate' }),
    });

    expect(result.ok).toBe(false);
    expect(result.templatePersisted).toBe(false);
    expect(result.decision).toBe('duplicate');
    expect(result.reason).toContain('perceptually similar');
    expect(result.cursorPosition).not.toBeNull();
  });

  it('emit override: passes custom emitDx/emitDy through to mouseMoveRelative', async () => {
    const before = await pngWithCluster(null, null);
    const after = await pngWithCluster(100, 100);
    const client = new ScriptedClient();
    client.shots = [before, after];

    await seedCursorTemplate(client, {
      emitDx: 50,
      emitDy: 80,
      sleep: async () => {},
      loadExisting: async () => [],
      persist: async (_dir, t) => ({ kept: [t], decision: 'added' }),
    });

    expect(client.emits).toEqual([{ dx: 50, dy: 80 }]);
  });
});
