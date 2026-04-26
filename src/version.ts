/**
 * Single source of truth for the MCP server version.
 *
 * Bump this AND `package.json` together. A test
 * (`src/__tests__/version.test.ts`) asserts they stay in sync; CI fails if
 * they drift.
 *
 * The constant is also surfaced via the `pikvm_version` MCP tool and the
 * MCP protocol's server-info `version` field, so a stale-deployment can
 * be detected by querying the running server instead of having to inspect
 * its filesystem.
 */
export const VERSION = '0.5.57';
