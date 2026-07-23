/**
 * True end-to-end test of the Streamable HTTP transport, driven by the real MCP
 * SDK client against the REAL server (createMcpServer from index.ts). Proves:
 *   - a client can complete the initialize handshake, list tools, and CALL a
 *     tool over HTTP (round-trip through the actual server handlers);
 *   - the tool set exposed over HTTP is identical (1:1) to the stdio path — both
 *     mount the same createMcpServer, just over different transports;
 *   - the session tears down cleanly (client.close -> DELETE /mcp).
 *
 * Importing createMcpServer is side-effect-free thanks to the entry-point guard
 * in index.ts (main() only runs when the module is executed directly).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../index.js';
import { startHttpServer, type HttpServerHandle } from '../http-server.js';
import { makeStaticAuthorizer } from '../auth.js';

let handle: HttpServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

/** Sorted tool names via an in-process client (the stdio-equivalent path: same
 *  createMcpServer, linked transport instead of HTTP). */
async function toolsViaInMemory(): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverSide);
  const client = new Client({ name: 'inmem', version: '0' });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
}

describe('E2E — Streamable HTTP via the real MCP client + real server', () => {
  it('initializes, lists + calls a tool, matches stdio 1:1, and tears down', async () => {
    handle = await startHttpServer(createMcpServer, { host: '127.0.0.1', port: 0 });

    const client = new Client({ name: 'e2e', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(transport); // full initialize handshake over HTTP

    // Tools are listable over HTTP and include the device-free version tool.
    const httpTools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(httpTools.length).toBeGreaterThan(0);
    expect(httpTools).toContain('pikvm_version');

    // ONE-TO-ONE: the HTTP tool surface equals the stdio (in-memory) surface.
    const stdioTools = await toolsViaInMemory();
    expect(httpTools).toEqual(stdioTools);

    // A real tool call round-trips through the server over HTTP.
    const res = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(res.content[0].text).toMatch(/pikvm-mcp-server v/);

    // Clean session teardown (sends DELETE /mcp).
    await client.close();
  });

  it('tool-login: header-less connect → only login → authenticate → full toolset (real HTTP)', async () => {
    const authorize = makeStaticAuthorizer({ username: 'admin', password: 'pw' });
    handle = await startHttpServer(createMcpServer, {
      host: '127.0.0.1',
      port: 0,
      authorize,
      allowToolLogin: true,
    });

    // Connect with NO Authorization header — admitted as a pre-auth session.
    const client = new Client({ name: 'e2e-login', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));

    // Pre-auth: only `pikvm_login` is visible, and other tools are refused.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['pikvm_login']);
    const gated = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(gated.isError).toBe(true);

    // Authenticate in-band with the same credentials the header would carry.
    const login = (await client.callTool({
      name: 'pikvm_login',
      arguments: { username: 'admin', password: 'pw' },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(login.isError).toBeFalsy();

    // Full toolset unlocks and a real tool call round-trips over HTTP.
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('pikvm_version');
    const ver = (await client.callTool({ name: 'pikvm_version', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(ver.content[0].text).toMatch(/pikvm-mcp-server v/);

    await client.close();
  });
});
