/**
 * Command-line option parsing for the MCP server entry point.
 *
 * Transport is chosen by (in precedence order): the --transport/--http flag,
 * then the PIKVM_MCP_TRANSPORT env var, then the stdio default. Host/port fall
 * back the same way (flag > env > default) and only matter in http mode.
 * Kept as a pure function of (argv, env) so it is fully unit-testable.
 *
 * The HTTP endpoint drives real input on a physical machine, so http mode
 * REQUIRES an explicit --security yes|no choice (there is deliberately no
 * default): `yes` enforces authentication (see auth.ts), `no` serves it open.
 */
import { parseArgs } from 'node:util';

export type TransportKind = 'stdio' | 'http';

/**
 * Which control path to use (REQUIRED — no auto-detect):
 *  - 'ipad'    — relative-mouse target: curve-one-shot mover + the cascade detector.
 *  - 'desktop' — absolute-mouse target: the legacy detect-then-move path.
 */
export type TargetKind = 'ipad' | 'desktop';

export type SecurityChoice = 'yes' | 'no' | 'kvmd';

export interface CliOptions {
  transport: TransportKind;
  host: string;
  port: number;
  /** undefined when neither --target nor PIKVM_TARGET was given; main() then errors. */
  target: TargetKind | undefined;
  /**
   * http-mode auth switch (flag > PIKVM_MCP_SECURITY). REQUIRED in http mode —
   * undefined here makes main() error rather than silently pick a default.
   */
  security: SecurityChoice | undefined;
  /** Username for the MCP HTTP Basic auth (default resolved in config). */
  authUsername: string | undefined;
  /** Literal auth password from the flag (prefer --auth-password-file / env for secrets). */
  authPassword: string | undefined;
  /** Path to a file holding the auth password. */
  authPasswordFile: string | undefined;
  /**
   * Opt-in (default false): also expose an in-band `login` MCP tool so a client
   * can authenticate its session without an Authorization header. Only meaningful
   * with --security yes|kvmd. Flag > PIKVM_MCP_ALLOW_TOOL_LOGIN.
   */
  allowToolLogin: boolean;
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
      security: { type: 'string' }, // yes | no | kvmd (required in http mode)
      'auth-username': { type: 'string' },
      'auth-password': { type: 'string' },
      'auth-password-file': { type: 'string' },
      'allow-tool-login': { type: 'boolean' }, // opt-in in-band login tool
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

  const securityRaw = (values.security as string | undefined) ?? env.PIKVM_MCP_SECURITY;
  if (
    securityRaw !== undefined &&
    securityRaw !== 'yes' &&
    securityRaw !== 'no' &&
    securityRaw !== 'kvmd'
  ) {
    throw new Error(`Invalid --security "${securityRaw}" (expected "yes", "no", or "kvmd")`);
  }

  // Opt-in in-band login tool (flag > env). Env is truthy on "true"/"1".
  const allowToolLoginEnv =
    env.PIKVM_MCP_ALLOW_TOOL_LOGIN === 'true' || env.PIKVM_MCP_ALLOW_TOOL_LOGIN === '1';
  const allowToolLogin =
    values['allow-tool-login'] !== undefined ? Boolean(values['allow-tool-login']) : allowToolLoginEnv;

  return {
    transport,
    host,
    port,
    target,
    security: securityRaw as SecurityChoice | undefined,
    authUsername: (values['auth-username'] as string | undefined) ?? env.PIKVM_MCP_AUTH_USERNAME,
    authPassword: values['auth-password'] as string | undefined,
    authPasswordFile: values['auth-password-file'] as string | undefined,
    allowToolLogin,
    help: Boolean(values.help),
  };
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
    '  --security <yes|no|kvmd>     REQUIRED in http mode. yes = require auth on /mcp',
    '                               against a static credential; kvmd = clients log in with',
    '                               their PiKVM (kvmd) username/password;',
    '                                 no = serve /mcp with NO auth (anyone who can reach',
    '                                 the port controls the machine).',
    '  --auth-username <name>       Username for http auth (default: operator).',
    '  --auth-password <pw>         Password for http auth (prefer the file/env forms).',
    '  --auth-password-file <path>  Read the http auth password from a file.',
    '  --allow-tool-login           Also expose an in-band `login` MCP tool so a client can',
    '                               authenticate its session without an Authorization header.',
    '                               Opt-in (default off); only meaningful with --security yes|kvmd.',
    '                               A pre-auth session may connect but can call ONLY `login`',
    '                               until it authenticates. The header path stays recommended.',
    '  -h, --help                   Show this help and exit',
    '',
    'Environment (used when the matching flag is absent):',
    '  PIKVM_MCP_TRANSPORT, PIKVM_MCP_HOST, PIKVM_MCP_PORT, PIKVM_TARGET',
    '  PIKVM_MCP_SECURITY           yes|no|kvmd',
    '  PIKVM_MCP_ALLOW_TOOL_LOGIN   true|1 to enable the in-band login tool',
    '  PIKVM_MCP_AUTH_USERNAME, PIKVM_MCP_AUTH_PASSWORD[_FILE]   http auth credentials',
    '  PIKVM_HOST                   required to reach the PiKVM',
    '  PIKVM_PASSWORD[_FILE]        needed only to actually drive the PiKVM device',
    '',
    'In http mode the modern Streamable HTTP transport is served at',
    'POST/GET/DELETE /mcp, with a health check at GET /health.',
    'With --security yes, /mcp requires HTTP Basic auth (Authorization header) on',
    'every request; a validated initialize also authorizes its session. /health is',
    'always open.',
  ].join('\n');
}
