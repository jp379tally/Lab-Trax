#!/usr/bin/env bash
# Bump the iOS/Android build number, run the EAS build, persist the bump as soon
# as the build succeeds, then submit to TestFlight / App Store Connect.
#
# WHY build first, then persist, then submit (instead of `--auto-submit`):
# App Store Connect consumes a build number the moment the build's IPA is
# uploaded. If we bundle build+submit and the *submit* step fails (e.g. the
# version was already submitted), reverting the bump leaves the next run reusing
# a number Apple has already seen — producing a permanent
# "CFBundleVersion already used / must be higher than NNN" collision loop.
# So we commit the bumped number right after a successful build and only revert
# when the build itself never completed. Build-number gaps are harmless to
# Apple; collisions are not.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APP_JSON="$REPO_ROOT/artifacts/labtrax/app.json"

# ── 0. Manual-approval gate ─────────────────────────────────────────────────
# EAS/TestFlight builds are MANUAL-ONLY and require explicit approval.
#
# This workflow auto-restarts after every Replit merge and package install.
# Without this gate, each merge would burn a pay-as-you-go build credit.
# The gate is a one-shot sentinel file: create it to approve exactly one build,
# then it is consumed (deleted) at the start of that run so future auto-restarts
# continue to no-op.
#
# To approve and run a build:
#   1. Confirm all automated gates pass (see REGRESSION_GUARDRAILS.md)
#   2. Walk the TestFlight smoke-test checklist (see REGRESSION_GUARDRAILS.md)
#   3. Drop the approval token:
#        touch .local/.eas-build-approved
#   4. Restart the "EAS iOS Build + Submit" workflow in the Replit workflow pane
#
SUBMIT_ONLY_TOKEN="$REPO_ROOT/.local/.eas-submit-only"
if [ -f "$SUBMIT_ONLY_TOKEN" ]; then
  BUILD_ID_FILE="$REPO_ROOT/.local/.eas-submit-build-id"
  BUILD_ID=""
  if [ -f "$BUILD_ID_FILE" ]; then
    BUILD_ID=$(cat "$BUILD_ID_FILE")
    rm -f "$BUILD_ID_FILE"
  fi
  rm -f "$SUBMIT_ONLY_TOKEN"
  echo "==> Submit-only mode activated (no build consumed)."
  echo ""
  cd "$REPO_ROOT/artifacts/labtrax"
  python3 scripts/write-asc-key.py
  export EAS_NO_VCS=1
  export EAS_BUILD_NO_EXPO_GO_WARNING=true
  export EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8
  export EXPO_ASC_KEY_ID=RV23AJ8V62
  export EXPO_ASC_ISSUER_ID=1d2faabc-3d66-4e64-b514-c234043e143a
  export EXPO_APPLE_TEAM_ID=2D9XT8L3D2
  export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION
  IPA_URL_FILE="$REPO_ROOT/.local/.eas-submit-ipa-url"
  if [ -n "$BUILD_ID" ] && [ -f "$IPA_URL_FILE" ]; then
    IPA_URL=$(cat "$IPA_URL_FILE")
    rm -f "$IPA_URL_FILE"
    echo "==> Downloading IPA from EAS artifact store..."
    curl -sL -H "Authorization: Bearer $EXPO_TOKEN" "$IPA_URL" -o /tmp/build-submit.ipa
    IPA_SIZE=$(wc -c < /tmp/build-submit.ipa)
    echo "    Downloaded: $IPA_SIZE bytes"
    echo "==> Submitting via local IPA path (bypasses pre-signed URL expiry)..."
    eas submit --platform ios --path /tmp/build-submit.ipa --non-interactive
  elif [ -n "$BUILD_ID" ]; then
    echo "==> Submitting build $BUILD_ID to App Store Connect..."
    eas submit --platform ios --id "$BUILD_ID" --non-interactive
  else
    echo "==> Submitting latest iOS build to App Store Connect..."
    eas submit --platform ios --latest --non-interactive
  fi
  echo "==> Submit complete."
  exit 0
fi

APPROVAL_TOKEN="$REPO_ROOT/.local/.eas-build-approved"
if [ ! -f "$APPROVAL_TOKEN" ]; then
  echo "==> EAS build requires manual approval."
  echo ""
  echo "    This workflow auto-restarts on every merge and package install."
  echo "    To prevent accidental credit usage, builds are gated behind a"
  echo "    one-shot approval token."
  echo ""
  echo "    To approve a build:"
  echo "      touch .local/.eas-build-approved"
  echo "      (then restart the 'EAS iOS Build + Submit' workflow)"
  echo ""
  echo "    See REGRESSION_GUARDRAILS.md > Mobile Beta Protected Workflows"
  echo "    for the full pre-build checklist that must pass first."
  echo ""
  echo "==> Exiting without building (no credit consumed)."
  exit 0
fi

# Consume the token immediately — this build is approved, but future
# auto-restarts will not be (they see no token and exit cleanly above).
rm -f "$APPROVAL_TOKEN"
echo "==> Build approved (token consumed). Proceeding with EAS build..."
echo ""

# Stays false until the build completes; the trap reverts the bump only on a
# pre-build failure so we don't burn a slot when nothing was uploaded.
persisted=false

cleanup() {
  if [ "$persisted" = "false" ]; then
    echo ""
    echo "Build did not complete — reverting app.json to pre-bump state..."
    git -C "$REPO_ROOT" checkout -- artifacts/labtrax/app.json
    echo "app.json reverted."
  fi
}

trap cleanup EXIT

# ── 1. Bump build number ────────────────────────────────────────────────────
echo "==> Bumping build number..."
pnpm --filter @workspace/scripts run bump-build-number

# ── 2. Write ASC key + run the EAS build (no auto-submit) ────────────────────
echo ""
echo "==> Starting EAS iOS build..."
cd "$REPO_ROOT/artifacts/labtrax"

python3 scripts/write-asc-key.py

# Exported so both the build and the later submit step inherit ASC credentials.
export EAS_NO_VCS=1
export EAS_BUILD_NO_EXPO_GO_WARNING=true
export EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8
export EXPO_ASC_KEY_ID=RV23AJ8V62
export EXPO_ASC_ISSUER_ID=1d2faabc-3d66-4e64-b514-c234043e143a
export EXPO_APPLE_TEAM_ID=2D9XT8L3D2
export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION

eas build --platform ios --profile production --non-interactive

# ── 3. Persist the bumped build number BEFORE submitting ────────────────────
# The moment the build above succeeds, App Store Connect has effectively
# consumed this build number — a later commit/push/submit failure must NEVER
# roll it back, or the next run reuses a number Apple has already seen and
# collides forever ("CFBundleVersion must be higher than NNN"). So flip the
# persisted flag RIGHT NOW, before any fallible git/submit step, so the cleanup
# trap never reverts a spent number.
persisted=true

echo ""
echo "==> Build succeeded. Committing bumped build number..."
cd "$REPO_ROOT"

# Ensure a git identity is present (no-op if already configured globally).
git config user.email "ci@labtrax.app" 2>/dev/null || true
git config user.name "LabTrax CI" 2>/dev/null || true

build_num=$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON','utf8')).expo.ios.buildNumber")

git add "$APP_JSON"
git commit -m "chore: bump iOS build number to $build_num [skip ci]" \
  || echo "Nothing to commit (build number already committed)."

# Push only when an 'origin' remote exists (e.g. GitHub Actions CI). In the
# Replit workspace there is no 'origin' remote (the checkpoint system persists
# the commit), so a missing or failing push must NOT abort the run before the
# submit step below — that is exactly what stranded a successful build 155.
if git remote get-url origin >/dev/null 2>&1; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  git push origin "$branch" \
    || echo "WARNING: git push failed — continuing (build number committed locally)."
else
  echo "No 'origin' remote — skipping push (commit persisted locally / via checkpoint)."
fi

echo ""
echo "==> Build number $build_num committed."

# ── 4. Submit the latest build to App Store Connect ─────────────────────────
echo ""
echo "==> Submitting latest iOS build to App Store Connect..."
cd "$REPO_ROOT/artifacts/labtrax"

eas submit --platform ios --latest --non-interactive

echo ""
echo "==> Done. Build number $build_num built and submitted."
