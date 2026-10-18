#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/run-serialized-validation.sh '<validation command>'" >&2
  exit 64
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "Release validation requires flock; refusing to run without serialization." >&2
  exit 69
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -m 700 -p "$REPO_ROOT/generated-artifacts"

# Only the heavyweight release gates use this lock. Their original commands,
# assertions and exit statuses are unchanged. It is separate from the database
# advisory lock, which still protects database-writing tests.
lock_file="${LABTRAX_VALIDATION_LOCK_FILE:-$REPO_ROOT/generated-artifacts/labtrax-release-validation.lock}"
lock_wait_seconds="${LABTRAX_VALIDATION_LOCK_WAIT_SECONDS:-7200}"
if [[ ! "$lock_wait_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "LABTRAX_VALIDATION_LOCK_WAIT_SECONDS must be a positive whole number of seconds." >&2
  exit 64
fi

echo "[release-validation] Waiting for the shared CPU/memory gate..."
# Close the lock descriptor in the child: a detached subprocess must not retain
# the lock after the validation command exits. flock holds it in the parent.
if flock --exclusive --close --timeout "$lock_wait_seconds" --conflict-exit-code 75 \
  "$lock_file" bash "$REPO_ROOT/scripts/with-workspace-test-scratch.sh" --bash-command "$1"; then
  exit 0
else
  status=$?
  if [[ "$status" -eq 75 ]]; then
    echo "[release-validation] Timed out after ${lock_wait_seconds}s waiting for the shared CPU/memory gate; the current holder was not interrupted." >&2
  fi
  exit "$status"
fi
