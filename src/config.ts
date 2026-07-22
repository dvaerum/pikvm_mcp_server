/**
 * Configuration management for PiKVM MCP Server
 *
 * Reads configuration from environment variables.
 * Supports .env file via dotenv.
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { HttpAuth } from './auth.js';

// Load .env file from project root
// - quiet: true prevents stdout output that would corrupt MCP protocol
// - override: true ensures .env values take precedence over any existing env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
loadEnv({ path: envPath, quiet: true, override: true });

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
}

function readSecretFile(path: string): string {
  // Secret files (sops-nix, systemd credentials, docker secrets) conventionally
  // carry a trailing newline from `echo`; strip trailing newlines only.
  return readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
}

/**
 * Resolve a config/secret value from, in precedence order:
 *   1. the direct env var `name` (e.g. PIKVM_PASSWORD),
 *   2. a file named by `${name}_FILE` (e.g. PIKVM_PASSWORD_FILE) — its contents,
 *   3. `$CREDENTIALS_DIRECTORY/<credName>` — the directory systemd populates from
 *      LoadCredential / LoadCredentialEncrypted (and where sops-nix secrets can be
 *      pointed). Returns undefined when none is set.
 *
 * This lets the username and password each come from a SEPARATE file (sops-nix
 * secret paths, or two systemd credentials) with no plaintext in the unit/env.
 */
export function resolveSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  credName?: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;

  const filePath = env[`${name}_FILE`];
  if (filePath) return readSecretFile(filePath);

  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir && credName) {
    const credPath = join(credDir, credName);
    if (existsSync(credPath)) return readSecretFile(credPath);
  }
  return undefined;
}

/**
 * Resolve the MCP HTTP auth credentials (for `--security yes`). Password comes
 * from, in precedence order: the --auth-password flag, the --auth-password-file
 * flag, then PIKVM_MCP_AUTH_PASSWORD / _FILE / the `pikvm-mcp-auth-password`
 * systemd credential (via resolveSecret). Username: --auth-username / env /
 * "operator". Returns undefined when no password is configured (main() then
 * refuses to serve `--security yes`).
 */
export function resolveHttpAuth(
  env: NodeJS.ProcessEnv,
  cli: { authUsername?: string; authPassword?: string; authPasswordFile?: string },
): HttpAuth | undefined {
  const username = cli.authUsername || env.PIKVM_MCP_AUTH_USERNAME || 'operator';

  let password: string | undefined = cli.authPassword;
  if ((password === undefined || password === '') && cli.authPasswordFile) {
    password = readSecretFile(cli.authPasswordFile);
  }
  if (password === undefined || password === '') {
    password = resolveSecret(env, 'PIKVM_MCP_AUTH_PASSWORD', 'pikvm-mcp-auth-password');
  }
  if (password === undefined || password === '') return undefined;

  return { username, password };
}

export function loadConfig(): Config {
  const host = resolveSecret(process.env, 'PIKVM_HOST', 'pikvm-host');
  if (!host) {
    throw new Error(
      'PiKVM host is required — set PIKVM_HOST, PIKVM_HOST_FILE, or provide a ' +
        'systemd credential named "pikvm-host" (LoadCredential).',
    );
  }

  // The PiKVM password is OPTIONAL at startup: when the server runs on the
  // PiKVM itself (or acts purely as an authenticated MCP gateway) the operator
  // may not want to embed device credentials. It defaults to empty; kvmd then
  // returns a clear auth error only if/when a tool actually drives the device.
  const password = resolveSecret(process.env, 'PIKVM_PASSWORD', 'pikvm-password') ?? '';

  return {
    pikvm: {
      host,
      username: resolveSecret(process.env, 'PIKVM_USERNAME', 'pikvm-username') || 'admin',
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
  };
}
