/**
 * HTTP authentication for the Streamable HTTP transport.
 *
 * The MCP HTTP endpoint drives real keyboard/mouse/screen input on a physical
 * machine, so anyone who can reach it can take over that machine. When
 * `--security yes` is chosen, every request to /mcp must present credentials.
 *
 * Auth model ("Both"):
 *   - A request is authorized if it carries a valid HTTP Basic `Authorization`
 *     header (checked on EVERY request), OR
 *   - it carries an `Mcp-Session-Id` for a session that was opened with a valid
 *     header (a validated `initialize` authorizes the session for its lifetime).
 * `initialize` has no session id yet, so it can only be authorized by the
 * header — you cannot open a session without credentials.
 */
import { timingSafeEqual } from 'node:crypto';

export interface HttpAuth {
  username: string;
  password: string;
}

/** Constant-time string compare that doesn't leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal-length buffers; hash-free length guard by
  // comparing against a fixed-length digest of both would be overkill here, so
  // pad to the max length. The padding makes lengths equal without revealing
  // which input was shorter through timing.
  const len = Math.max(ab.length, bb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  // Still fold in the real-length equality so "pass" vs "pass\0" don't match.
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/**
 * Parse an HTTP Basic `Authorization` header into its username/password.
 * Returns undefined for a missing/non-Basic/malformed header.
 */
export function parseBasicAuthHeader(
  header: string | undefined,
): { username: string; password: string } | undefined {
  if (!header) return undefined;
  const [scheme, encoded] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  // Only the FIRST colon separates user from pass (passwords may contain ':').
  const idx = decoded.indexOf(':');
  if (idx < 0) return undefined;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

/**
 * True when the supplied Basic-auth header matches the configured credentials.
 * Both fields are compared in constant time.
 */
export function headerMatches(auth: HttpAuth, header: string | undefined): boolean {
  const creds = parseBasicAuthHeader(header);
  if (!creds) return false;
  // Evaluate both comparisons (no short-circuit) so timing doesn't reveal
  // which field was wrong.
  const userOk = safeEqual(creds.username, auth.username);
  const passOk = safeEqual(creds.password, auth.password);
  return userOk && passOk;
}
