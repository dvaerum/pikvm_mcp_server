/**
 * Configuration management for PiKVM MCP Server
 *
 * Reads configuration from environment variables.
 * Supports .env file via dotenv.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env file from project root
// - quiet: true prevents stdout output that would corrupt MCP protocol
// - override: true ensures .env values take precedence over any existing env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
loadEnv({ path: envPath, quiet: true, override: true });

export type TransportKind = 'stdio' | 'http';

export interface Config {
  pikvm: {
    host: string;
    username: string;
    password: string;
    verifySsl: boolean;
    defaultKeymap: string;
    proxyUrl: string;
  };
  calibration: {
    rounds: number;
    verifyRounds: number;
    moveDelayMs: number;
  };
  transport: {
    kind: TransportKind;
    /** TCP host to bind when kind === 'http'. Defaults to 127.0.0.1 (loopback
     *  only) — loopback is exempt from macOS Local Network privacy, so a
     *  loopback-bound server is reachable even from a caller whose LAN access
     *  is otherwise blocked. Do NOT bind 0.0.0.0 without adding auth. */
    httpHost: string;
    /** TCP port to bind when kind === 'http'. */
    httpPort: number;
    /** Optional unix-socket path. When set (and kind === 'http'), the server
     *  also listens on this socket in addition to the TCP port. */
    httpSocketPath?: string;
  };
}

/** Resolve the transport config from env/argv. `--http` on argv or
 *  MCP_TRANSPORT=http selects the HTTP transport; otherwise stdio (the
 *  backward-compatible default the MCP stdio launcher relies on). */
function loadTransport(argv: string[]): Config['transport'] {
  const wantHttp =
    argv.includes('--http') ||
    (process.env.MCP_TRANSPORT || '').toLowerCase() === 'http';
  return {
    kind: wantHttp ? 'http' : 'stdio',
    httpHost: process.env.MCP_HTTP_HOST || '127.0.0.1',
    httpPort: parseInt(process.env.MCP_HTTP_PORT || '8390', 10),
    httpSocketPath: process.env.MCP_HTTP_SOCKET || undefined,
  };
}

export function loadConfig(): Config {
  const host = process.env.PIKVM_HOST;
  if (!host) {
    throw new Error('PIKVM_HOST environment variable is required');
  }

  const password = process.env.PIKVM_PASSWORD;
  if (!password) {
    throw new Error('PIKVM_PASSWORD environment variable is required');
  }

  return {
    pikvm: {
      host,
      username: process.env.PIKVM_USERNAME || 'admin',
      password,
      verifySsl: process.env.PIKVM_VERIFY_SSL === 'true',
      defaultKeymap: process.env.PIKVM_DEFAULT_KEYMAP || 'en-us',
      // Route outbound PiKVM requests through a proxy when configured. Only the
      // DEDICATED PIKVM_PROXY is honored — deliberately NOT the ambient
      // HTTPS_PROXY/ALL_PROXY, which shells commonly export for internet
      // traffic. The PiKVM is a LAN host; inheriting an unrelated corporate
      // proxy would silently reroute (and break) all device traffic with no
      // opt-in. Set PIKVM_PROXY explicitly (e.g. via .mcp.json `env`).
      proxyUrl: process.env.PIKVM_PROXY || '',
    },
    calibration: {
      rounds: parseInt(process.env.PIKVM_CALIBRATION_ROUNDS || '5', 10),
      verifyRounds: parseInt(process.env.PIKVM_CALIBRATION_VERIFY_ROUNDS || '5', 10),
      moveDelayMs: parseInt(process.env.PIKVM_CALIBRATION_MOVE_DELAY || '300', 10),
    },
    transport: loadTransport(process.argv.slice(2)),
  };
}
