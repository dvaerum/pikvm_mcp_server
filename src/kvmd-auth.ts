/**
 * kvmd-backed client authentication for `--security kvmd` (unified auth).
 *
 * Instead of checking the incoming /mcp client's HTTP Basic credentials against a
 * static file (`--security yes`), validate them against KVMD's own user store so
 * a user logs into /mcp with their **PiKVM** username/password — one shared
 * authority (`/etc/kvmd/htpasswd`). KVMD hashes are passlib `{SSHA512}`, so
 * validation MUST go through kvmd (`GET /api/auth/check`), not a local hash check.
 *
 * This validates the CLIENT's credentials — a SEPARATE check from the service
 * credentials the PiKVMClient uses for the server's own kvmd calls.
 *
 * Cost control: the transport's "Both" session model authorizes a session once
 * (at `initialize`), so kvmd is hit ~once per client session. A short-TTL POSITIVE
 * cache coalesces any header-only requests. Failures are never cached (so a
 * password change isn't locked out) — they just re-hit kvmd, which applies its
 * own throttling.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { createHash } from 'node:crypto';
import { parseBasicAuthHeader, type HeaderAuthorizer } from './auth.js';

export interface KvmdAuthOptions {
  /** PiKVM base URL (PIKVM_HOST) — the same host the service client talks to. */
  host: string;
  /** Verify the kvmd TLS cert (usually false for PiKVM's self-signed cert). */
  verifySsl: boolean;
  /** Optional loopback proxy (PIKVM_PROXY), same as the service client. */
  proxyUrl?: string;
  /** Positive-cache TTL in ms. Default 60_000 (1 min). */
  ttlMs?: number;
}

export interface KvmdAuthDeps {
  /** Override the kvmd validation call (tests). Default: real GET /api/auth/check. */
  check?: (username: string, password: string) => Promise<boolean>;
  /** Clock injection (tests). Default: Date.now. */
  now?: () => number;
}

/**
 * Build a {@link HeaderAuthorizer} that validates the incoming Basic credentials
 * against kvmd. Returns true iff kvmd accepts the (client) credentials.
 */
export function makeKvmdAuthorizer(opts: KvmdAuthOptions, deps: KvmdAuthDeps = {}): HeaderAuthorizer {
  const check = deps.check ?? defaultKvmdCheck(opts);
  const now = deps.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 60_000;
  // key -> expiry timestamp. Keyed on user + a hash of the password (never the
  // plaintext password) so a rotated password expires the entry naturally.
  const positiveCache = new Map<string, number>();

  return async (header: string | undefined): Promise<boolean> => {
    const creds = parseBasicAuthHeader(header);
    if (!creds) return false;
    const key = `${creds.username}:${sha256(creds.password)}`;
    const expiry = positiveCache.get(key);
    if (expiry !== undefined) {
      if (expiry > now()) return true; // fresh positive hit
      positiveCache.delete(key); // stale (e.g. rotated password) — don't let it linger
    }
    const ok = await check(creds.username, creds.password);
    if (ok) positiveCache.set(key, now() + ttlMs);
    return ok;
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** The real kvmd validation: GET {host}/api/auth/check with the client's creds. */
function defaultKvmdCheck(opts: KvmdAuthOptions): (u: string, p: string) => Promise<boolean> {
  const dispatcher = makeDispatcher(opts);
  const url = `${opts.host.replace(/\/+$/, '')}/api/auth/check`;
  return async (username, password) => {
    try {
      const res = await undiciFetch(url, {
        method: 'GET',
        headers: { 'X-KVMD-User': username, 'X-KVMD-Passwd': password },
        dispatcher,
      });
      // Drain the body so the connection can be reused.
      await res.body?.cancel?.();
      return res.status === 200;
    } catch {
      return false;
    }
  };
}

function makeDispatcher(opts: KvmdAuthOptions): Dispatcher {
  if (opts.proxyUrl) {
    return new ProxyAgent({ uri: opts.proxyUrl, requestTls: { rejectUnauthorized: opts.verifySsl } });
  }
  return new Agent({ connect: { rejectUnauthorized: opts.verifySsl } });
}
