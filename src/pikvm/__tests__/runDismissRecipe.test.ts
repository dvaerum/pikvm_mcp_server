/**
 * Phase 165 — tests for runDismissRecipe.
 *
 * The Phase 141 hidden-popup-dismiss recipe (Escape, 60ms, Enter,
 * 60ms) is now extracted as a callable so the MCP
 * pikvm_dismiss_popup tool and the inline retry-loop dismiss share
 * the same implementation. Phase 162 live-validated that Escape
 * dismisses system-modal popups (Low Battery 10%) cleanly.
 */

import { describe, expect, it } from 'vitest';
import { runDismissRecipe } from '../click-verify.js';

class CapturingClient {
  keys: string[] = [];
  errOnKey?: string;
  errMessage = 'simulated';
  async sendKey(key: string): Promise<void> {
    if (this.errOnKey === key) {
      throw new Error(this.errMessage);
    }
    this.keys.push(key);
  }
}

describe('runDismissRecipe', () => {
  it('sends Escape then Enter in order', async () => {
    const client = new CapturingClient();
    const result = await runDismissRecipe(client);
    expect(client.keys).toEqual(['Escape', 'Enter']);
    expect(result.keysSent).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('continues to Enter even if Escape fails (defensive)', async () => {
    const client = new CapturingClient();
    client.errOnKey = 'Escape';
    const result = await runDismissRecipe(client);
    expect(client.keys).toEqual(['Enter']);
    expect(result.keysSent).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Escape');
  });

  it('reports an error when Enter fails', async () => {
    const client = new CapturingClient();
    client.errOnKey = 'Enter';
    const result = await runDismissRecipe(client);
    expect(client.keys).toEqual(['Escape']);
    expect(result.keysSent).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Enter');
  });

  it('reports BOTH errors when sendKey is broken on the client', async () => {
    // Defensive: a client where sendKey always throws should not
    // crash the recipe — both errors should be captured.
    class AllFailClient {
      async sendKey(key: string): Promise<void> {
        throw new Error(`broken: ${key}`);
      }
    }
    const result = await runDismissRecipe(new AllFailClient());
    expect(result.keysSent).toBe(0);
    expect(result.errors).toHaveLength(2);
  });

  it('REGRESSION: does not throw — recipe is best-effort', async () => {
    // Phase 141's inline original swallowed all errors; the helper
    // must preserve that contract so callers can fire it
    // unconditionally without try/catch.
    class AllFailClient {
      async sendKey(key: string): Promise<void> {
        throw new Error(`broken: ${key}`);
      }
    }
    await expect(runDismissRecipe(new AllFailClient())).resolves.toBeDefined();
  });

  it('REGRESSION: order is Escape then Enter (not the reverse)', async () => {
    // The order matters: Escape is the primary dismiss for cancel-
    // affordance popups (the dominant case); Enter is the fallback
    // for OK-affordance prompts. Reversing would press the OK
    // button on a Cancel-default modal, potentially confirming an
    // unwanted action.
    const client = new CapturingClient();
    await runDismissRecipe(client);
    expect(client.keys[0]).toBe('Escape');
    expect(client.keys[1]).toBe('Enter');
  });
});
