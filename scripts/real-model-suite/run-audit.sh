#!/usr/bin/env bash
# Saved audit runner: safeguard phase + session regression, default spark25-4b PARALLEL=4.
# Usage: scripts/real-model-suite/run-audit.sh
set -euo pipefail

SUITE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export MODEL=${MODEL:-spark25-4b}
export PARALLEL=${PARALLEL:-4}
KEEP_FLAG=--keep
BASE=${AUDIT_OUT_BASE:-/tmp/audit-$(date -u +%Y%m%dT%H%M%SZ)}

"$SUITE_DIR/run-phase.sh" safeguard || true
"$SUITE_DIR/run-phase.sh" session || true
echo "Audit evidence roots under $BASE-*/ if OUT_ROOT was unset; see printed OUT_ROOT lines."
