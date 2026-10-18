#!/usr/bin/env bash
# Submit a specific EAS iOS build to App Store Connect by build ID.
# Usage after separate approval:
# EAS_SUBMIT_APPROVED=1 EAS_BUILD_ID=<id> bash scripts/eas-ios-submit-only.sh
# Never implicitly select the latest build.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${EAS_SUBMIT_APPROVED:-}" != "1" ]; then
  echo "Submission requires separate explicit approval (EAS_SUBMIT_APPROVED=1)." >&2
  exit 1
fi
if [[ ! "${EAS_BUILD_ID:-}" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]]; then
  echo "Specify the exact approved EAS_BUILD_ID; refusing an implicit latest-build upload." >&2
  exit 1
fi
mkdir -p "$REPO_ROOT/.local"
exec 9>"$REPO_ROOT/.local/.eas-ios-release.lock"
flock --nonblock 9 || { echo "Another iOS release operation is running." >&2; exit 75; }
trap 'rm -f /tmp/AuthKey_RV23AJ8V62.p8' EXIT
cd "$REPO_ROOT/artifacts/labtrax"

python3 scripts/write-asc-key.py

export EAS_NO_VCS=1
export EAS_BUILD_NO_EXPO_GO_WARNING=true
export EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8
export EXPO_ASC_KEY_ID=RV23AJ8V62
export EXPO_ASC_ISSUER_ID=1d2faabc-3d66-4e64-b514-c234043e143a
export EXPO_APPLE_TEAM_ID=2D9XT8L3D2
export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION

echo "==> Submitting build $EAS_BUILD_ID to App Store Connect..."
eas submit --platform ios --profile production --id "$EAS_BUILD_ID" --non-interactive

# A successful helper retry must not leave its own pending build blocking the
# next release. Never clear a different build's pending state.
BUILD_ID_FILE="$REPO_ROOT/.local/.eas-submit-build-id"
if PENDING_BUILD_ID="$(cat "$BUILD_ID_FILE" 2>/dev/null)" &&
   [[ "${PENDING_BUILD_ID,,}" == "${EAS_BUILD_ID,,}" ]]; then
  rm -f "$REPO_ROOT/.local/.eas-submit-only" "$BUILD_ID_FILE" "$REPO_ROOT/.local/.eas-submit-ipa-url" \
    || echo "Upload succeeded, but matching retry metadata could not be fully cleared." >&2
fi

echo ""
echo "==> Submit complete."
