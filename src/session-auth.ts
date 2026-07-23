/**
 * Per-session authentication state + the in-band `login` tool gate for the
 * Streamable HTTP transport (opt-in via `--allow-tool-login`).
 *
 * The transport mints one MCP Server per session, so auth state is naturally
 * per-session: a plain mutable flag the login tool flips and the tool-gating
 * reads. Two ways a session becomes authenticated, unified on ONE authorizer:
 *   - header-at-connect (the DEFAULT, stricter path): a valid Basic
 *     `Authorization` header on the `initialize` request marks the session
 *     authenticated at creation; a session cannot even be opened without it
 *     (unless tool-login is enabled).
 *   - the `login` tool (opt-in): an agent authenticates a pre-auth session
 *     in-band, WITHOUT setting a custom header — same credentials, validated by
 *     the SAME authorizer (kvmd round-trip in kvmd mode, constant-time static
 *     compare in `yes` mode).
 *
 * The password is only ever encoded into a throwaway Basic header handed to the
 * authorizer; it is never logged or stored.
 */
import { type HeaderAuthorizer } from './auth.js';

export interface SessionAuthState {
  /** True once this session presented valid creds (header at connect, or `login`). */
  authenticated: boolean;
}

/** What createMcpServer needs to expose + enforce the `login` tool for one session. */
export interface LoginGate {
  /** The mutable per-session auth flag this gate guards. */
  session: SessionAuthState;
  /**
   * Validate `{username, password}` via the shared authorizer; on success mark
   * the session authenticated. Returns whether the credentials were accepted.
   */
  login(username: string, password: string): Promise<boolean>;
}

/** Build a Basic `Authorization` header value from raw credentials. */
export function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

/**
 * Make a {@link LoginGate} backed by the same {@link HeaderAuthorizer} the header
 * path uses, so login-tool credentials are validated identically. The password
 * only lives in the throwaway Basic header passed to the authorizer.
 */
export function makeLoginGate(
  authorize: HeaderAuthorizer,
  session: SessionAuthState,
): LoginGate {
  return {
    session,
    async login(username, password) {
      const ok = await authorize(basicAuthHeader(username, password));
      if (ok) session.authenticated = true;
      return ok;
    },
  };
}
