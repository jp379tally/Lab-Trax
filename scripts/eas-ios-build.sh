#!/usr/bin/env bash
# Bump the iOS/Android build number, run the EAS build+submit, then commit the
# updated app.json back to git on success.  If the build fails (or is
# interrupted — including a failed git push) the bump is reverted so the next
# retry starts from the same number and doesn't skip a slot.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APP_JSON="$REPO_ROOT/artifacts/labtrax/app.json"

# Stays false until the commit+push both succeed; trap reverts the bump otherwise.
persisted=false

cleanup() {
  if [ "$persisted" = "false" ]; then
    echo ""
    echo "Build did not fully succeed — reverting app.json to pre-bump state..."
    git -C "$REPO_ROOT" checkout -- artifacts/labtrax/app.json
    echo "app.json reverted."
  fi
}

trap cleanup EXIT

# ── 1. Bump build number ────────────────────────────────────────────────────
echo "==> Bumping build number..."
pnpm --filter @workspace/scripts run bump-build-number

# ── 2. Write ASC key + run EAS build ────────────────────────────────────────
echo ""
echo "==> Starting EAS iOS build + submit..."
cd "$REPO_ROOT/artifacts/labtrax"

python3 scripts/write-asc-key.py

EAS_NO_VCS=1 \
EAS_BUILD_NO_EXPO_GO_WARNING=true \
EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8 \
EXPO_ASC_KEY_ID=RV23AJ8V62 \
EXPO_ASC_ISSUER_ID=1d2faabc-3d66-4e64-b514-c234043e143a \
EXPO_APPLE_TEAM_ID=2D9XT8L3D2 \
EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION \
  eas build --platform ios --profile production --non-interactive --auto-submit

# ── 3. Commit and push the bumped app.json back to git ──────────────────────
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

# Mark fully persisted — cleanup trap will now skip the revert.
persisted=true

echo ""
echo "==> Done. Build number $build_num committed and pushed to origin/$branch."
