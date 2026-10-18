#!/usr/bin/env bash
# Diagnostic audit only. A failed gate blocks release, even though this runner
# continues collecting other failures. Never builds/submits via EAS.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="${1:-$ROOT/generated-artifacts/workspace-audit}"
mkdir -p "$OUT"
chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd)"
umask 077
printf 'check\tstarted_utc\tfinished_utc\texit_code\n' > "$OUT/results.tsv"
failed=0
check() {
  local name="$1" command="$2" started result=0
  started="$(date -u +%FT%TZ)"
  echo "AUDIT START $name"
  bash scripts/run-serialized-validation.sh "$command" > "$OUT/$name.log" 2>&1 || result=$?
  printf '%s\t%s\t%s\t%s\n' "$name" "$started" "$(date -u +%FT%TZ)" "$result" >> "$OUT/results.tsv"
  echo "AUDIT END $name exit=$result"
  if [[ "$result" -ne 0 ]]; then failed=1; fi
}

check 00-harness 'pnpm --filter @workspace/scripts run check-test-harness:collect'
check 01-typecheck 'pnpm run typecheck'
check 02-api 'pnpm --filter @workspace/scripts run check-practice-authorization-schema && pnpm --filter @workspace/scripts run with-db-lock "pnpm --filter @workspace/api-server exec vitest run"'
check 03-desktop 'pnpm --filter @workspace/labtrax-desktop run lint && pnpm --filter @workspace/labtrax-desktop run test'
check 04-mobile 'pnpm --filter @workspace/scripts run check-test-harness && pnpm --filter @workspace/labtrax run test'
check 05-scripts 'pnpm --filter @workspace/scripts run test'
# Destructive validation must ONLY use this disposable schema/upload runner.
check 06-restore 'bash scripts/run-isolated-backup-restore.sh'
check 07-legacy 'pnpm --filter @workspace/scripts run lint-mobile-legacy-paths'
check 08-protected 'pnpm --filter @workspace/scripts run lint-protected-tables'
check 09-provider 'pnpm --filter @workspace/scripts run lint-provider-account-creation'
check 10-keyboard 'pnpm --filter @workspace/scripts run lint-mobile-keyboard-dismiss'
check 11-sweep 'pnpm --filter @workspace/scripts run lint-maintenance-sweep-scope'
check 12-shared 'pnpm -r --no-bail --workspace-concurrency=1 --filter "./lib/**" --if-present run test'
check 13-publish-schema 'pnpm --filter @workspace/scripts run check-publish-schema-safety'
check 14-expo-deps 'cd artifacts/labtrax && CI=1 pnpm exec expo install --check'
check 15-web-export 'pnpm --filter @workspace/labtrax run test:build-web-export'
check 16-asc-key 'python3 artifacts/labtrax/scripts/test-write-asc-key.py'
echo "AUDIT COMPLETE failures=$failed (see $OUT/results.tsv; this is not release approval)"
exit "$failed"
