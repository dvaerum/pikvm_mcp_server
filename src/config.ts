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

export interface Config {
  pikvm: {
    host: string;
    username: string;
    password: string;
    verifySsl: boolean;
    defaultKeymap: string;
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
    },
  };
}
