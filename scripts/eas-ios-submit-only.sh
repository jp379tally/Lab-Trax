#!/usr/bin/env bash
# One exact-build retry path, sharing the main lock and durable receipts.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${EAS_SUBMIT_APPROVED:-}" != "1" ]; then
  echo "Submission requires separate explicit approval (EAS_SUBMIT_APPROVED=1)." >&2
  exit 2
fi
exec bash "$REPO_ROOT/scripts/eas-ios-build.sh" --submit-approved "${EAS_BUILD_ID:-}"
