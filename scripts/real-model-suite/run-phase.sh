#!/usr/bin/env bash
# Saved operator entrypoint for the real-model suite.
# Usage: scripts/real-model-suite/run-phase.sh <cli|tools|session|agents|safeguard|all> [extra run.sh args...]
# Defaults: MODEL=spark25-4b, PARALLEL=4, --keep, fresh OUT_ROOT under /tmp.
set -euo pipefail

PHASE=${1:?usage: run-phase.sh <cli|tools|session|agents|safeguard|all> [extra run.sh args...]}
shift || true

SUITE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SUITE_DIR/../.." && pwd)
export MODEL=${MODEL:-spark25-4b}
export PARALLEL=${PARALLEL:-4}
OUT_ROOT=${OUT_ROOT:-/tmp/real-model-${PHASE}-$(date -u +%Y%m%dT%H%M%SZ)}
export OUT_ROOT

echo "MODEL=$MODEL PARALLEL=$PARALLEL OUT_ROOT=$OUT_ROOT" >&2
python3 "$SUITE_DIR/score.py" --self-test
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  cargo build -p xai-grok-pager-bin --bin xai-grok-pager
fi
git -C "$REPO_ROOT" status --porcelain
rc=0
"$SUITE_DIR/run.sh" --phase "$PHASE" --keep "$@" || rc=$?
echo "=== SCORE $OUT_ROOT ==="
cat "$OUT_ROOT/score.txt" || true
echo "=== FAILURES $OUT_ROOT ==="
cat "$OUT_ROOT/failures.md" 2>/dev/null || true
echo "OUT_ROOT=$OUT_ROOT"
exit "$rc"
