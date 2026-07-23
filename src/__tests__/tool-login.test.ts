/**
 * The in-band `login` tool + pre-auth tool-gating (--allow-tool-login), driven
 * by the REAL MCP client against the REAL server (createMcpServer) over a linked
 * in-memory transport. A static authorizer stands in for the shared validator
 * (kvmd/static are the same HeaderAuthorizer contract).
 *
 * Proves: a pre-auth session sees ONLY `login`; every other tool is refused;
 * a bad login stays gated; a valid login flips the session and unlocks the full
 * tool set; and with NO gate the surface is the ungated stdio surface (no login).
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../index.js';
import { makeLoginGate, type LoginGate, type SessionAuthState } from '../session-auth.js';
import { makeStaticAuthorizer } from '../auth.js';

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connectClient(gate?: LoginGate): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(gate).connect(serverSide);
  const client = new Client({ name: 'tool-login-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const authorizer = makeStaticAuthorizer({ username: 'admin', password: 'pw' });

describe('in-band login tool (--allow-tool-login)', () => {
  it('pre-auth session lists ONLY login and refuses every other tool', async () => {
    const session: SessionAuthState = { authenticated: false };
    const client = await connectClient(makeLoginGate(authorizer, session));

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['login']);

    const res = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/authentication required/i);

    await client.close();
  });

  it('a wrong-credential login fails and keeps the session gated', async () => {
    const session: SessionAuthState = { authenticated: false };
    const client = await connectClient(makeLoginGate(authorizer, session));

    const bad = (await client.callTool({
      name: 'login',
      arguments: { username: 'admin', password: 'nope' },
    })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/authentication failed/i);
    expect(session.authenticated).toBe(false);

    // Still only login is exposed and other tools stay blocked.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['login']);
    const still = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as ToolResult;
    expect(still.isError).toBe(true);

    await client.close();
  });

  it('a valid login flips the session and unlocks the full tool set', async () => {
    const session: SessionAuthState = { authenticated: false };
    const client = await connectClient(makeLoginGate(authorizer, session));

    const ok = (await client.callTool({
      name: 'login',
      arguments: { username: 'admin', password: 'pw' },
    })) as ToolResult;
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toMatch(/authentication successful/i);
    expect(session.authenticated).toBe(true);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('pikvm_version');
    expect(names).not.toContain('login'); // login no longer advertised once authed

    const ver = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as ToolResult;
    expect(ver.isError).toBeFalsy();
    expect(ver.content[0].text).toMatch(/pikvm-mcp-server v/);

    await client.close();
  });

  it('login is idempotent — calling it again on an authed session is a no-op success', async () => {
    const session: SessionAuthState = { authenticated: true };
    const client = await connectClient(makeLoginGate(authorizer, session));

    const again = (await client.callTool({
      name: 'login',
      arguments: { username: 'admin', password: 'pw' },
    })) as ToolResult;
    expect(again.isError).toBeFalsy();
    expect(again.content[0].text).toMatch(/already authenticated/i);

    await client.close();
  });

  it('rejects a malformed login (missing password) without consulting the authorizer', async () => {
    let consulted = false;
    const session: SessionAuthState = { authenticated: false };
    const gate = makeLoginGate(async () => {
      consulted = true;
      return true;
    }, session);
    const client = await connectClient(gate);

    const res = (await client.callTool({
      name: 'login',
      arguments: { username: 'admin' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/requires string/i);
    expect(consulted).toBe(false);
    expect(session.authenticated).toBe(false);

    await client.close();
  });

  it('with NO gate the surface matches the ungated stdio surface (no login tool)', async () => {
    const client = await connectClient(undefined);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('pikvm_version');
    expect(names).not.toContain('login');
    await client.close();
  });
});
