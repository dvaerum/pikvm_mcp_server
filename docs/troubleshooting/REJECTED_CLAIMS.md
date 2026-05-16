# Rejected unverified claims (2026-05-15)

The user has explicitly rejected the following causation claims that
older troubleshooting docs and Claude session memories asserted as
facts. They are hypotheses, not observed mechanisms. **Do not quote
them as established without fresh visual or code-path verification
in the current session.**

## Rejected as causal mechanisms

- **"iPadOS pointer-effect snap glues cursor to dock/icons"** — never
  directly observed. Inferred from frames where the detector reported
  the cursor in dock area. Could equally be detector noise, edge
  clamping, or the cursor genuinely not moving for unrelated reasons.

- **"iPad ignores tap at residual=Npx"** — derived from the detector's
  own residual self-report. Tautological — same detector that has
  76-89% FP on cursor-absent frames is being used to validate that
  it correctly placed the cursor. Not evidence the tap was ignored.

- **"Rate-limit dead zone at 15-60 mickeys"** — pattern in
  data/emit-residuals/ bench data. Pattern is real; causation is not.
  Could be iPadOS rate-limiting, OR detector failing to see small
  motion, OR cursor near edge being clamped. Visually unverified.

- **"Cursor stuck in dock area"** — claimed from sampling 3 of 27
  frames where 2 happened to be in the bottom-row band. Not from
  exhaustive classification.

- **"Cursor fade is a bottleneck"** — fade exists but any +1 mickey
  emit makes the cursor visible again. `cursor-keepalive.ts` already
  handles this. Not a real obstacle for the click pipeline.

## Why these keep coming back

Old troubleshooting docs (esp. Phase 291-292, 294, 307, 308) assert
these mechanisms as if they were observed facts. Memory notes
referencing those docs reinforce them. Each new Claude session
pattern-matches to the existing assertions and re-quotes them.

## What to do instead

When you encounter one of these claims in an older doc:

1. Note that the claim is in the "rejected" list and is unverified.
2. If the current investigation needs to address the same phenomenon,
   start from raw data (screenshots, code paths) — NOT from the
   doc's framing.
3. If the current work generates new data that supports OR rejects
   the claim, add a dated note here.

## Memory rule

`feedback_rejected_unverified_claims.md` in the user's auto-memory
directory contains the corresponding self-stop list of phrases.
Triggering those phrases in any output without fresh verification
is a regression.
