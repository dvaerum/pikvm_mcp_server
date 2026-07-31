// #41 runtime proof: the 3 pikvm_mover_scale_* tools are ABSENT by default and PRESENT
// only when opted in (PIKVM_MOVER_LEARN=1). Drives the REAL built binary over stdio MCP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BIN = './result/bin/pikvm-mcp-server';
const MOVER = ['pikvm_mover_scale_status', 'pikvm_mover_scale_control', 'pikvm_mover_scale_reset'];

async function listTools(env) {
  const transport = new StdioClientTransport({ command: BIN, args: ['--target', 'ipad'], env: { ...process.env, PIKVM_HOST: '127.0.0.1', ...env } });
  const client = new Client({ name: 'verify', version: '0' });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

const off = await listTools({ PIKVM_MOVER_LEARN: '' });      // default (not opted in)
const on = await listTools({ PIKVM_MOVER_LEARN: '1' });      // opted in

const offHas = MOVER.filter((n) => off.includes(n));
const onHas = MOVER.filter((n) => on.includes(n));

console.log(`OFF (default): ${off.length} tools, mover_scale present: [${offHas.join(', ')}]`);
console.log(`ON  (LEARN=1): ${on.length} tools, mover_scale present: [${onHas.join(', ')}]`);

const pass = offHas.length === 0 && onHas.length === 3 && on.length === off.length + 3;
console.log(pass ? 'PASS: no-op by default, 3 tools appear on opt-in' : 'FAIL');
process.exit(pass ? 0 : 1);
