#!/usr/bin/env bash
# Direct Expo release path; independent of Replit's hosted Expo Launch wizard.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:---check}"
case "$MODE" in --check|--run-approved) ;; *) echo "Usage: $0 [--check|--run-approved]" >&2; exit 2;; esac
mkdir -p .local/ios-release-checks
exec 8>.local/.eas-ios-prepare.lock
flock --nonblock 8 || { echo "Another iOS preparation is running." >&2; exit 75; }
source_id() {
  python3 -c 'import hashlib,subprocess,pathlib; h=hashlib.sha256(); h.update(subprocess.check_output(["git","rev-parse","HEAD"])); h.update(subprocess.check_output(["git","diff","HEAD","--binary"])); files=subprocess.check_output(["git","ls-files","--others","--exclude-standard","-z"]).split(b"\0"); [(h.update(f+b"\0"),h.update(pathlib.Path(f.decode()).read_bytes())) for f in sorted(files) if f]; print(h.hexdigest())'
}
SOURCE="$(source_id)"
REPORT=".local/ios-release-checks/$SOURCE"
mkdir -p "$REPORT"
assert_source() {
  [[ "$(source_id)" == "$SOURCE" ]] || { echo "Source changed during verification. No build started; rerun preparation." >&2; exit 2; }
}
check() {
  local name="$1"; shift
  assert_source
  echo "==> $name (log: $REPORT/$name.log)"
  if "$@" > "$REPORT/$name.log" 2>&1; then
    assert_source
    bash scripts/eas-ios-build.sh --record-check "$name" pass
  else
    local result=$?
    assert_source
    bash scripts/eas-ios-build.sh --record-check "$name" fail
    tail -40 "$REPORT/$name.log"
    echo "BLOCKED: $name failed (exit $result). No build or upload started." >&2
    exit "$result"
  fi
}
# Fail fast on account/configuration errors before an explicitly approved release.
if [[ "$MODE" == --run-approved ]]; then
  node scripts/eas-ios-readiness.mjs
  assert_source
fi

check test-harness pnpm --filter @workspace/scripts run check-test-harness:collect
check typecheck pnpm run typecheck
check mobile-tests pnpm --filter @workspace/labtrax run test
check scripts-tests pnpm --filter @workspace/scripts run test
check desktop-tests pnpm --filter @workspace/labtrax-desktop run test
check legacy-path-fence pnpm --filter @workspace/scripts run lint-mobile-legacy-paths
check protected-tables pnpm --filter @workspace/scripts run lint-protected-tables
check api-tests env API_TEST_REQUIRE_DATABASE=1 LABTRAX_ISOLATED_TEST_CONFIG=vitest.config.ts bash scripts/run-isolated-backup-restore.sh
check backup-restore env API_TEST_REQUIRE_DATABASE=1 LABTRAX_ISOLATED_TEST_CONFIG=vitest.restore.config.ts bash scripts/run-isolated-backup-restore.sh
assert_source
if [[ "$MODE" == --check ]]; then
  bash scripts/eas-ios-build.sh --status
  echo "CHECKS COMPLETE. No build or upload started. Explicit release: pnpm run ios:release"
  exit 0
fi
# Only this explicit invocation grants one build. Automatic workflow restarts
# run --check and cannot arm or consume a build approval.
[[ ! -e .local/.eas-submit-only ]] || { echo "Resolve the pending submission before a new build." >&2; exit 2; }
touch .local/.eas-build-approved
exec bash scripts/eas-ios-build.sh --run-approved
