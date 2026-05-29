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
# Once the build above returns successfully the number is effectively spent, so
# commit it now. A submit failure after this point must NOT revert it.
echo ""
echo "==> Build succeeded. Committing bumped build number..."
cd "$REPO_ROOT"

# Ensure a git identity is present (no-op if already configured globally).
git config user.email "ci@labtrax.app" 2>/dev/null || true
git config user.name "LabTrax CI" 2>/dev/null || true

git add "$APP_JSON"

build_num=$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON','utf8')).expo.ios.buildNumber")

git commit -m "chore: bump iOS build number to $build_num [skip ci]"

# Push to the current branch's upstream explicitly to avoid detached-HEAD surprises.
branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch"

# Build number is now persisted; the cleanup trap will skip the revert even if
# the submit step below fails.
persisted=true

echo ""
echo "==> Build number $build_num committed and pushed to origin/$branch."

# ── 4. Submit the latest build to App Store Connect ─────────────────────────
echo ""
echo "==> Submitting latest iOS build to App Store Connect..."
cd "$REPO_ROOT/artifacts/labtrax"

eas submit --platform ios --latest --non-interactive

echo ""
echo "==> Done. Build number $build_num built and submitted."
