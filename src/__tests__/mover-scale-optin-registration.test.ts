/**
 * #41 acceptance: the 3 experimental pikvm_mover_scale_* tools are registered ONLY
 * under the opt-in (PIKVM_MOVER_LEARN=1). Off is the genuine TS default — not
 * env-absent-means-on. it-03400's pre-#41 appliance baseline over /mcp tools/list is
 * exactly 54 tools with the learner tools absent; opted in it is 54+3 = 57. Asserting
 * both here makes "off by default" a falsifiable number, per the manager's spec.
 *
 * Uses vi.resetModules() + a fresh dynamic import of the real server module per env, so
 * the module-level tool registry (fixed at import from scaleLearner.isFeatureEnabled())
 * is rebuilt under each PIKVM_MOVER_LEARN value. Drives the REAL createMcpServer over an
 * in-memory MCP transport — the same surface a client sees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const MOVER = ['pikvm_mover_scale_status', 'pikvm_mover_scale_control', 'pikvm_mover_scale_reset'];
const DEFAULT_TOOL_COUNT = 54; // it-03400's pre-#41 appliance baseline (learner tools absent)
const OPTED_IN_TOOL_COUNT = 57; // + the 3 pikvm_mover_scale_* tools

async function toolNamesFromFreshImport(): Promise<string[]> {
  const { createMcpServer } = await import('../index.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverSide);
  const client = new Client({ name: 'count', version: '0' });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

describe('#41 experimental opt-in gates the 3 mover_scale tools', () => {
  const prev = process.env.PIKVM_MOVER_LEARN;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKVM_MOVER_LEARN;
    else process.env.PIKVM_MOVER_LEARN = prev;
  });

  it('DEFAULT (env absent): tools/list = 54, mover_scale ABSENT — a genuine no-op default', async () => {
    vi.resetModules();
    delete process.env.PIKVM_MOVER_LEARN;
    const names = await toolNamesFromFreshImport();
    expect(names.filter((n) => MOVER.includes(n))).toEqual([]);
    expect(names.length).toBe(DEFAULT_TOOL_COUNT);
  });

  it('PIKVM_MOVER_LEARN=1 (opted in): tools/list = 57, all 3 mover_scale present', async () => {
    vi.resetModules();
    process.env.PIKVM_MOVER_LEARN = '1';
    const names = await toolNamesFromFreshImport();
    expect(names.filter((n) => MOVER.includes(n)).sort()).toEqual([...MOVER].sort());
    expect(names.length).toBe(OPTED_IN_TOOL_COUNT);
    expect(names.length).toBe(DEFAULT_TOOL_COUNT + 3);
  });

  it('PIKVM_MOVER_LEARN=0 (belt-and-suspenders): still OFF — 54, mover_scale absent', async () => {
    vi.resetModules();
    process.env.PIKVM_MOVER_LEARN = '0';
    const names = await toolNamesFromFreshImport();
    expect(names.filter((n) => MOVER.includes(n))).toEqual([]);
    expect(names.length).toBe(DEFAULT_TOOL_COUNT);
  });
});
