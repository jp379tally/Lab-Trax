#!/usr/bin/env bash
# Development-only release verification. Never starts a production backup,
# restores a configured database, deploys, or contacts EAS/Apple.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
assert_clean_source() {
  if [[ "${1:-}" == "--backup-schedule" ]]; then
    # Unrelated documentation edits are preserved and are not application source.
    git diff --quiet -- . ":(exclude)*.md" && git diff --cached --quiet -- . ":(exclude)*.md"
  else
    git diff --quiet && git diff --cached --quiet
  fi
}
assert_clean_source "${1:-}" || {
  echo "Save tracked source before running source-bound release verification." >&2
  exit 1
}
REVISION="$(git rev-parse HEAD)"
REPORT_ROOT="$REPO_ROOT/generated-artifacts/record-repair-release-${REVISION:0:12}"
mkdir -p "$REPORT_ROOT"
printf '%s\n' "$REVISION" > "$REPORT_ROOT/source-revision.txt"
git rev-parse 'HEAD^{tree}' > "$REPORT_ROOT/source-tree.txt"
: > "$REPORT_ROOT/check-status.tsv"
FAILED=0
run_check() {
  local label="$1" result=0
  shift
  echo "Starting $label on $REVISION"
  if "$@" > "$REPORT_ROOT/$label.log" 2>&1; then
    echo "$label passed"
  else
    result=$?
    FAILED=1
    echo "$label failed with exit $result; see its retained development log."
  fi
  printf '%s\t%s\n' "$label" "$result" >> "$REPORT_ROOT/check-status.tsv"
  return "$result"
}


if [[ "${1:-}" == "--backup-schedule" ]]; then
  run_check schedule-types pnpm run typecheck || true
  run_check schedule-ui pnpm --filter @workspace/labtrax-desktop exec vitest run src/pages/__tests__/settings-backup-intervals.test.tsx --reporter=json --outputFile="$REPORT_ROOT/schedule-ui.json" || true
  run_check schedule-provider pnpm --filter @workspace/api-server exec vitest run src/lib/database-protection-job.test.ts src/lib/google-drive-protection.test.ts src/lib/backup-source.test.ts --reporter=json --outputFile="$REPORT_ROOT/schedule-provider.json" || true
  run_check schedule-api env API_TEST_REQUIRE_DATABASE=1 LABTRAX_ISOLATED_TEST_CONFIG=vitest.restore.config.ts bash scripts/run-isolated-backup-restore.sh src/routes/backup-destinations.test.ts src/routes/offsite-job.test.ts --reporter=json --outputFile.json="$REPORT_ROOT/schedule-api.json" || true
  run_check schedule-api-build pnpm --filter @workspace/api-server run build || true
  run_check schedule-desktop-build pnpm --filter @workspace/labtrax-desktop run build || true
  [[ "$(git rev-parse HEAD)" == "$REVISION" ]] && assert_clean_source --backup-schedule || { echo "Source changed; results do not certify the new source." >&2; exit 1; }
  echo "Backup schedule verification complete; skipped or failed checks are not passes."
  exit "$FAILED"
fi

run_check desktop-arch pnpm --filter @workspace/labtrax-desktop exec vitest run \
  src/components/__tests__/ToothChart.approved-layout.test.tsx \
  --reporter=json --outputFile="$REPORT_ROOT/desktop-arch.json" || true
run_check mobile-finance pnpm --filter @workspace/labtrax exec vitest run \
  app/__tests__/finance-live-refresh.test.tsx \
  --reporter=json --outputFile="$REPORT_ROOT/mobile-finance.json" || true
run_check pinned-media pnpm --filter @workspace/api-server exec vitest run \
  src/lib/case-media-object-storage.test.ts src/lib/production-media-pinned-read.test.ts \
  --reporter=json --outputFile="$REPORT_ROOT/pinned-media.json" || true
run_check harness-policy pnpm --filter @workspace/scripts run check-test-harness || true
run_check workspace-types pnpm run typecheck || true
run_check desktop-timing pnpm --filter @workspace/labtrax-desktop run test:timing-sensitive || true
run_check desktop-register-browser pnpm --filter @workspace/labtrax-desktop run test:register-browser || true
run_check desktop-chart-browser pnpm --filter @workspace/labtrax-desktop run test:tooth-chart-browser || true
run_check api-build pnpm --filter @workspace/api-server run build || true
run_check desktop-build pnpm --filter @workspace/labtrax-desktop run build || true

# A focused failure rehearsal catches initialization problems before spending
# time on the broad API suite. Both invocations use independent empty local
# databases, fresh ephemeral secrets, owned filesystem scratch and no lab data.
if run_check api-initialization env API_TEST_REQUIRE_DATABASE=1 \
  LABTRAX_ISOLATED_TEST_CONFIG=vitest.config.ts \
  bash scripts/run-isolated-backup-restore.sh \
  src/routes/lab-inbox-storagepath-normalization.test.ts \
  src/auth-desktop.test.ts src/lib/lab-scoped-backup.test.ts \
  src/routes/cases-ai-intake-carry-through.test.ts \
  src/routes/cases-ai-reader.test.ts src/routes/cases-ai-repair-warning.test.ts \
  src/routes/cases-itero-ai-extraction.test.ts src/routes/cases-itero-practice-link-route.test.ts \
  src/routes/cases-itero-remake.test.ts src/routes/cases-material-normalization-e2e.test.ts \
  src/routes/cases-provider-portal.test.ts src/routes/cases-removable-invoice-qty.test.ts \
  --reporter=json --outputFile.json="$REPORT_ROOT/api-initialization.json" && \
  run_check offsite-rehearsal env API_TEST_REQUIRE_DATABASE=1 \
    LABTRAX_ISOLATED_TEST_CONFIG=vitest.restore.config.ts \
    bash scripts/run-isolated-backup-restore.sh src/routes/offsite-job.test.ts \
    --reporter=json --outputFile.json="$REPORT_ROOT/offsite-rehearsal.json"; then
  if run_check api-full env API_TEST_REQUIRE_DATABASE=1 \
    LABTRAX_ISOLATED_TEST_CONFIG=vitest.config.ts \
    bash scripts/run-isolated-backup-restore.sh \
    --reporter=json --outputFile.json="$REPORT_ROOT/api-full.json"; then
    run_check backup-recovery env API_TEST_REQUIRE_DATABASE=1 \
      LABTRAX_ISOLATED_TEST_CONFIG=vitest.restore.config.ts \
      bash scripts/run-isolated-backup-restore.sh \
      --reporter=json --outputFile.json="$REPORT_ROOT/backup-recovery.json" || true
  fi
fi

[[ "$(git rev-parse HEAD)" == "$REVISION" ]] && git diff --quiet && git diff --cached --quiet || {
  echo "Source changed during verification; results do not certify the new source." >&2
  exit 1
}
echo "Source-bound verification complete; skipped or failed checks are not passes."
exit "$FAILED"
