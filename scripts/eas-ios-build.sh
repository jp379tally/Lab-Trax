#!/usr/bin/env bash
# After manual approval, reserve the next configured build number, build iOS,
# persist a completed build's bump, then upload that exact artifact.
#
# WHY build first, then persist, then submit (instead of `--auto-submit`):
# App Store Connect consumes a build number the moment the build's IPA is
# uploaded. If we bundle build+submit and the *submit* step fails (e.g. the
# version was already submitted), reverting the bump leaves the next run reusing
# a number Apple has already seen — producing a permanent
# "CFBundleVersion already used / must be higher than NNN" collision loop.
# Commit after a successful build, but restore the pre-bump snapshot ONLY when
# the remote command never started. A remote error may hide an accepted build.
# Build-number gaps are harmless to Apple; collisions are not.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APP_JSON="$REPO_ROOT/artifacts/labtrax/app.json"
ASC_KEY="/tmp/AuthKey_RV23AJ8V62.p8"

# Serialize approved release operations: the approval file, version bump and
# ASC key path are shared with the submit-only helper.
if [ -f "$REPO_ROOT/.local/.eas-build-approved" ] || [ -f "$REPO_ROOT/.local/.eas-submit-only" ]; then
  exec 9>"$REPO_ROOT/.local/.eas-ios-release.lock"
  flock --nonblock 9 || { echo "Another iOS release operation is running." >&2; exit 75; }
  if [ -f "$REPO_ROOT/.local/.eas-build-approved" ] && [ -f "$REPO_ROOT/.local/.eas-submit-only" ]; then
    echo "Choose one release operation: both build and submit-only approvals exist." >&2
    exit 1
  fi
fi

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
  fi
  rm -f "$SUBMIT_ONLY_TOKEN"
  if [[ ! "$BUILD_ID" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]]; then
    echo "Submit-only requires the exact approved build ID in .local/.eas-submit-build-id." >&2
    exit 1
  fi
  echo "==> Submit-only mode activated (no build consumed)."
  echo ""
  cd "$REPO_ROOT/artifacts/labtrax"
  SUBMIT_TMP="$(mktemp -d)"
  trap 'rm -f "$ASC_KEY"; rm -rf "$SUBMIT_TMP"' EXIT
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
    # Never send the Expo bearer credential to an operator-supplied host.
    IPA_URL="$IPA_URL" node -e 'try { const u = new URL(process.env.IPA_URL); if (u.protocol !== "https:" || u.hostname !== "expo.dev" || u.username || u.password) process.exit(1); } catch { process.exit(1); }' \
      || { echo "IPA URL must be an HTTPS Expo artifact URL." >&2; exit 1; }
    # A valid archive alone does not prove it is the approved build. Fetch
    # read-only metadata and bind the URL to that exact project's store build.
    eas build:view "$BUILD_ID" --json > "$SUBMIT_TMP/approved-build.json"
    BUILD_ID="$BUILD_ID" IPA_URL="$IPA_URL" node - "$SUBMIT_TMP/approved-build.json" <<'NODE' \
      || { echo "IPA artifact does not match the exact approved production iOS build." >&2; exit 1; }
try {
  const fs = require("node:fs");
  const build = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const projectId = JSON.parse(fs.readFileSync("app.json", "utf8")).expo.extra?.eas?.projectId;
  if (!projectId || build.id !== process.env.BUILD_ID ||
      build.project?.id !== projectId || build.platform !== "IOS" ||
      build.status !== "FINISHED" || build.distribution !== "STORE" ||
      build.buildProfile !== "production" ||
      build.artifacts?.buildUrl !== process.env.IPA_URL) process.exit(1);
} catch { process.exit(1); }
NODE
    echo "==> Downloading IPA from EAS artifact store..."
    curl -fsSL --proto '=https' --proto-redir '=https' \
      -H "Authorization: Bearer $EXPO_TOKEN" "$IPA_URL" -o "$SUBMIT_TMP/build.ipa"
    # A 200 response can still be HTML or a corrupt/expired download.
    unzip -tqq "$SUBMIT_TMP/build.ipa" >/dev/null \
      || { echo "Downloaded IPA is not a valid ZIP archive." >&2; exit 1; }
    unzip -Z1 "$SUBMIT_TMP/build.ipa" | grep '^Payload/[^/]*\.app/Info\.plist$' >/dev/null \
      || { echo "Downloaded archive has no iOS app payload." >&2; exit 1; }
    IPA_SIZE=$(wc -c < "$SUBMIT_TMP/build.ipa")
    echo "    Downloaded: $IPA_SIZE bytes"
    echo "==> Submitting via local IPA path (bypasses pre-signed URL expiry)..."
    eas submit --platform ios --profile production --path "$SUBMIT_TMP/build.ipa" --non-interactive
  elif [ -n "$BUILD_ID" ]; then
    echo "==> Submitting build $BUILD_ID to App Store Connect..."
    eas submit --platform ios --profile production --id "$BUILD_ID" --non-interactive
  fi
  rm -f "$BUILD_ID_FILE" "$IPA_URL_FILE"
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
if [ -s "$REPO_ROOT/.local/.eas-submit-build-id" ]; then
  echo "An existing upload retry needs reconciliation before a new paid build." >&2
  echo "Inspect the recorded build in .local/.eas-submit-build-id; retry its upload or clear the metadata only after resolving it." >&2
  exit 1
fi
echo "==> Build approved (token consumed). Proceeding with EAS build..."
echo ""

# Stays false until the remote command starts. Preflight failures restore the
# exact worktree snapshot; ambiguous remote outcomes keep the reserved number.
persisted=false
BUILD_TMP="$(mktemp -d)"
cp "$APP_JSON" "$BUILD_TMP/app.json"
chmod 600 "$BUILD_TMP/app.json"

cleanup() {
  rm -f "$ASC_KEY"
  if [ "$persisted" = "false" ]; then
    echo ""
    echo "Remote build did not start — restoring app.json to pre-bump state..."
    cp "$BUILD_TMP/app.json" "$APP_JSON"
    echo "app.json reverted."
  fi
  rm -rf "$BUILD_TMP"
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

# Once the remote command starts, a lost response does not prove the build
# failed. Reserve the number even on command failure; never collide on retry.
persisted=true
if ! eas build --platform ios --profile production --non-interactive --wait --json > "$BUILD_TMP/build.json"; then
  echo "Remote build outcome needs inspection. The reserved build number was retained; no upload was attempted." >&2
  exit 1
fi
BUILD_ID="$(node -e '
const fs = require("fs");
const builds = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(builds) || builds.length !== 1) process.exit(1);
const build = builds[0];
if (build.platform !== "IOS" || build.status !== "FINISHED" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(build.id ?? "")) process.exit(1);
console.log(build.id);
' "$BUILD_TMP/build.json")" || {
  echo "Could not identify one completed iOS build. Number retained; inspect EAS before any upload." >&2
  exit 1
}
printf '%s\n' "$BUILD_ID" > "$REPO_ROOT/.local/.eas-submit-build-id"
# An old downloaded-artifact URL must never be paired with this new build ID.
rm -f "$REPO_ROOT/.local/.eas-submit-ipa-url"

# ── 3. Persist the bumped build number BEFORE submitting ────────────────────
# The completed build's number stays reserved even if git or upload fails.
# Building alone is not an Apple upload, but reusing the completed artifact's
# number creates a collision as soon as either artifact reaches Apple.
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

# ── 4. Submit this exact completed build to App Store Connect ───────────────
echo ""
echo "==> Submitting completed iOS build $BUILD_ID to App Store Connect..."
cd "$REPO_ROOT/artifacts/labtrax"

eas submit --platform ios --profile production --id "$BUILD_ID" --non-interactive
rm -f "$REPO_ROOT/.local/.eas-submit-build-id"

echo ""
echo "==> Done. Build number $build_num built and submitted."
