/**
 * Command-line option parsing for the MCP server entry point.
 *
 * Transport is chosen by (in precedence order): the --transport/--http flag,
 * then the PIKVM_MCP_TRANSPORT env var, then the stdio default. Host/port fall
 * back the same way (flag > env > default) and only matter in http mode.
 * Kept as a pure function of (argv, env) so it is fully unit-testable.
 */
import { parseArgs } from 'node:util';

export type TransportKind = 'stdio' | 'http';

/**
 * Which control path to use (REQUIRED — no auto-detect):
 *  - 'ipad'    — relative-mouse target: curve-one-shot mover + the cascade detector.
 *  - 'desktop' — absolute-mouse target: the legacy detect-then-move path.
 */
export type TargetKind = 'ipad' | 'desktop';

export interface CliOptions {
  transport: TransportKind;
  host: string;
  port: number;
  /** undefined when neither --target nor PIKVM_TARGET was given; main() then errors. */
  target: TargetKind | undefined;
  help: boolean;
}

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      transport: { type: 'string' },
      http: { type: 'boolean' }, // shorthand for --transport http
      host: { type: 'string' },
      port: { type: 'string' },
      target: { type: 'string' }, // ipad | desktop | auto
      help: { type: 'boolean', short: 'h' },
    },
  });

  let transport = values.http ? 'http' : (values.transport as string | undefined);
  transport = transport ?? env.PIKVM_MCP_TRANSPORT ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`Invalid --transport "${transport}" (expected "stdio" or "http")`);
  }

  const host = (values.host as string | undefined) ?? env.PIKVM_MCP_HOST ?? DEFAULT_HTTP_HOST;

  const portRaw = (values.port as string | undefined) ?? env.PIKVM_MCP_PORT ?? String(DEFAULT_HTTP_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${portRaw}" (expected an integer 1-65535)`);
  }

  // Required (enforced in main so --help still works without it); no default.
  const target = (values.target as string | undefined) ?? env.PIKVM_TARGET;
  if (target !== undefined && target !== 'ipad' && target !== 'desktop') {
    throw new Error(`Invalid --target "${target}" (expected "ipad" or "desktop")`);
  }

  return { transport, host, port, target, help: Boolean(values.help) };
}

export function helpText(binName = 'pikvm-mcp-server'): string {
  return [
    `${binName} — MCP server for controlling remote machines via PiKVM`,
    '',
    'Usage:',
    `  ${binName} [options]`,
    '',
    'Options:',
    '  --transport <stdio|http>     Transport to serve on (default: stdio)',
    '  --http                       Shorthand for --transport http',
    '  --host <addr>                HTTP bind address (default: 127.0.0.1)',
    '  --port <n>                   HTTP port (default: 3000)',
    '  --target <ipad|desktop>      Control path (REQUIRED):',
    '                                 ipad    = curve-one-shot mover + cascade detector',
    '                                 desktop = legacy detect-then-move (absolute mouse)',
    '  -h, --help                   Show this help and exit',
    '',
    'Environment (used when the matching flag is absent):',
    '  PIKVM_MCP_TRANSPORT, PIKVM_MCP_HOST, PIKVM_MCP_PORT, PIKVM_TARGET',
    '  PIKVM_HOST, PIKVM_PASSWORD   (required to reach the PiKVM)',
    '',
    'In http mode the modern Streamable HTTP transport is served at',
    'POST/GET/DELETE /mcp, with a health check at GET /health.',
  ].join('\n');
}
