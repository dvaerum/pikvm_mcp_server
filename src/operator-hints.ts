/**
 * Phase 190 (v0.5.179): operator-hint enrichment for MCP tool error
 * messages.
 *
 * When a tool throws, the central catch handler in `src/index.ts` returns
 * the raw error message to the MCP client. Some error patterns are
 * actionable but their raw form doesn't say so:
 *
 * - "PiKVM API error 503 ... UnavailableError ... Service Unavailable"
 *   means the streamer source is offline (the device behind the HDMI
 *   cable is off / mid-reboot / unplugged), not that PiKVM is down. The
 *   LLM agent should call `pikvm_health_check` first to see
 *   `streamer.source.online` (Phase 189) before retrying or escalating.
 *
 * `appendOperatorHint(message)` matches against known patterns and
 * appends a one-line hint when a match fires. Pure: no I/O, no state,
 * deterministic. The contract is pinned by `__tests__/operator-hints.test.ts`.
 *
 * Adding a new hint = add a regex + line below. Order matters: more
 * specific patterns first (we return on the first match).
 */

export function appendOperatorHint(message: string): string {
  const hint = matchHint(message);
  if (hint === null) return message;
  // Newline + bullet keeps the hint visually separate from the raw
  // error in MCP clients that render Markdown.
  return `${message}\n  → ${hint}`;
}

function matchHint(message: string): string | null {
  // 503 / UnavailableError → source-side outage (Phase 189 streamer state).
  if (/\b503\b/.test(message) && /UnavailableError/i.test(message)) {
    return (
      'Source-side outage suspected: the device behind the HDMI cable ' +
      '(iPad in our setup) is likely off, mid-reboot, or unplugged. Run ' +
      'pikvm_health_check first — it reports streamer.source.online and ' +
      'lets you confirm before retrying.'
    );
  }

  // Bare "Service Unavailable" (the user-visible part of the 503 body)
  // can appear without the numeric code on some error paths. Same hint.
  if (/Service Unavailable/i.test(message)) {
    return (
      'Source-side outage suspected: streamer reports unavailable. Run ' +
      'pikvm_health_check first to see whether the device behind the ' +
      'HDMI cable is offline before retrying.'
    );
  }

  return null;
}
