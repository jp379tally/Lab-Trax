#!/usr/bin/env bash
# Submit a specific EAS iOS build to App Store Connect by build ID.
# Usage: EAS_BUILD_ID=<id> bash scripts/eas-ios-submit-only.sh
# If EAS_BUILD_ID is unset, submits --latest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/artifacts/labtrax"

python3 scripts/write-asc-key.py

export EAS_NO_VCS=1
export EAS_BUILD_NO_EXPO_GO_WARNING=true
export EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8
export EXPO_ASC_KEY_ID=RV23AJ8V62
export EXPO_ASC_ISSUER_ID=1d2faabc-3d66-4e64-b514-c234043e143a
export EXPO_APPLE_TEAM_ID=2D9XT8L3D2
export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION

if [ -n "${EAS_BUILD_ID:-}" ]; then
  echo "==> Submitting build $EAS_BUILD_ID to App Store Connect..."
  eas submit --platform ios --id "$EAS_BUILD_ID" --non-interactive
else
  echo "==> Submitting latest iOS build to App Store Connect..."
  eas submit --platform ios --latest --non-interactive
fi

echo ""
echo "==> Submit complete."
