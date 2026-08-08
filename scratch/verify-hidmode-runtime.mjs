// #51 runtime proof against the REAL built binary: the HID-mode source rules +
// derive/fail-closed behaviour, end-to-end over stdio MCP.
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BIN = './result/bin/pikvm-mcp-server';
const HID = ['pikvm_hidmode_status', 'pikvm_hidmode_set'];

// (1) config errors: spawn, expect exit 2 + message. No MCP handshake.
function bootExit(args, env, expectMsg) {
  return new Promise((resolve) => {
    const p = spawn(BIN, args, { env: { ...process.env, PIKVM_HOST: '127.0.0.1', ...env } });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, ok: code === 2 && expectMsg.test(err), err: err.split('\n')[0] }));
  });
}

async function session(args, env, fn) {
  const transport = new StdioClientTransport({ command: BIN, args, env: { ...process.env, PIKVM_HOST: '127.0.0.1', ...env } });
  const client = new Client({ name: 'verify-hidmode', version: '0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

let pass = true;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra ? ' — ' + extra : ''}`); if (!cond) pass = false; };

const DEAD = 'http://127.0.0.1:59999/hidmode'; // full endpoint (contract shape), closed port → refused fast

// 1. NEITHER source → exit 2
const neither = await bootExit([], { PIKVM_TARGET: '' }, /HID-mode source is required/);
check('NEITHER (no --target, no URL) → exit 2', neither.code === 2 && neither.ok, neither.err);

// 2. BOTH sources → exit 2
const both = await bootExit(['--target', 'ipad'], { PIKVM_HIDMODE_URL: DEAD }, /mutually exclusive/);
check('BOTH (--target AND URL) → exit 2', both.code === 2 && both.ok, both.err);

// 3. DECLARED (--target ipad, no URL): boots; status source=declared, mode=ipad, moverAllowed
await session(['--target', 'ipad'], {}, async (c) => {
  const names = (await c.listTools()).tools.map((t) => t.name);
  check('declared: both hidmode tools registered', HID.every((n) => names.includes(n)));
  const st = JSON.parse((await c.callTool({ name: 'pikvm_hidmode_status', arguments: {} })).content[0].text);
  check('declared: source=declared, mode=ipad, moverAllowed', st.source === 'declared' && st.mode === 'ipad' && st.moverAllowed === true, JSON.stringify(st));
  const set = await c.callTool({ name: 'pikvm_hidmode_set', arguments: { mode: 'desktop' } });
  check('declared: set refuses (fixed, no endpoint)', set.isError === true && /no.*endpoint|fixed/i.test(set.content[0].text));
});

// 4. ENDPOINT with a DEAD url: boots; status source=endpoint, unreachable, mode=null, mover REFUSES
await session([], { PIKVM_HIDMODE_URL: DEAD }, async (c) => {
  const st = JSON.parse((await c.callTool({ name: 'pikvm_hidmode_status', arguments: {} })).content[0].text);
  check('endpoint(dead): source=endpoint, reachable=false, mode=null, moverAllowed=false',
    st.source === 'endpoint' && st.reachable === false && st.mode === null && st.moverAllowed === false, JSON.stringify(st));
  const mv = await c.callTool({ name: 'pikvm_mouse_move', arguments: { x: 100, y: 100 } });
  check('endpoint(dead): FAIL-CLOSED — pikvm_mouse_move refused with unknown-mode reason',
    mv.isError === true && /unknown|unreachable/i.test(mv.content[0].text), mv.content?.[0]?.text?.slice(0, 80));
});

console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
process.exit(pass ? 0 : 1);
