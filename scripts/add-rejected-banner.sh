#!/usr/bin/env bash
# Prepend the rejected-claims banner to any troubleshooting doc that
# asserts one of the rejected phrases.
set -euo pipefail
cd "$(dirname "$0")/.."

BANNER='> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

'

while IFS= read -r f; do
  if head -3 "$f" | grep -q "REJECTED_CLAIMS"; then
    echo "skip (already banner): $f"
    continue
  fi
  printf '%s' "$BANNER" | cat - "$f" > "$f.new"
  mv "$f.new" "$f"
  echo "banner added: $f"
done < <(grep -l -E "pointer-effect snap|pointer effect snap|iPad ignores|dead zone|stuck in dock" docs/troubleshooting/*.md | grep -v REJECTED_CLAIMS)
