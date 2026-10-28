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
STATUS_HELPER="$REPO_ROOT/scripts/eas-ios-release-status.mjs"
OPERATION_HELPER="$REPO_ROOT/scripts/eas-ios-operation-state.mjs"
RELEASE_LOCK="$REPO_ROOT/.local/.eas-ios-release.lock"

submit_exact() {
  node "$OPERATION_HELPER" start-upload "$BUILD_ID"
  # Explicitly wait for the submission service's outcome. Enqueueing alone is
  # not delivery to Apple, and delivery is still not TestFlight availability.
  if ! eas submit --platform ios --profile production "$@" --non-interactive --wait; then
    echo "OUTCOME: UPLOAD_UNCONFIRMED — retain this exact build and reconcile the remote attempt before retrying." >&2
    return 1
  fi
  if ! node "$OPERATION_HELPER" accepted "$BUILD_ID"; then
    echo "OUTCOME: UPLOAD_ACCEPTED_RECEIPT_ERROR — do not repeat the remote upload." >&2
    return 1
  fi
  if ! node "$STATUS_HELPER" --record-uploaded "$BUILD_ID"; then
    echo "OUTCOME: UPLOAD_ACCEPTED_STATUS_PENDING — recover the local accepted receipt; do not upload again." >&2
    return 1
  fi
}

mkdir -p "$REPO_ROOT/.local"
exec 9>"$RELEASE_LOCK"
RELEASE_LOCK_STATE="pass"
if ! flock --nonblock 9; then
  RELEASE_LOCK_STATE="blocked"
fi

retry_state() {
  if [ -e "$REPO_ROOT/.local/.eas-submit-build-id" ] ||
     [ -e "$REPO_ROOT/.local/.eas-remote-build-started" ] ||
     [ -e "$REPO_ROOT/.local/.eas-upload-attempt.json" ] ||
     [ -e "$REPO_ROOT/.local/.eas-submit-ipa-url" ] ||
     [ -e "$REPO_ROOT/.local/.eas-submit-only" ]; then
    printf 'blocked'
  else
    printf 'pass'
  fi
}

approval_state="blocked"
[ -f "$REPO_ROOT/.local/.eas-build-approved" ] && approval_state="pass"

if [ "${1:-}" = "--status" ]; then
  node "$STATUS_HELPER" --summary \
    "--lock=$RELEASE_LOCK_STATE" "--approval=$approval_state" "--retry=$(retry_state)" || true
  exit 0
fi

case "${1:-}" in
  --record-check|--confirm-device-checklist|--record-apple-processing|--record-testflight-availability)
    if [ "$RELEASE_LOCK_STATE" != "pass" ]; then
      echo "Another iOS release operation is running; no release status was changed." >&2
      exit 75
    fi
    exec node "$STATUS_HELPER" "$@"
    ;;
esac

# Workflow restarts must never spend an approval retained by a blocked request.
# A paid operation requires BOTH the existing one-shot token and this explicit
# invocation. An idle green workflow is not a successful submission.
if [ "${1:-}" != "--run-approved" ] && [ "${1:-}" != "--submit-approved" ] &&
   [ "${1:-}" != "--recover-upload-record" ]; then
  node "$STATUS_HELPER" --summary "--lock=$RELEASE_LOCK_STATE" "--approval=$approval_state" "--retry=$(retry_state)" || true
  echo "OUTCOME: IDLE — no explicit release operation; no build or upload started."
  exit 0
fi

if [ "$RELEASE_LOCK_STATE" != "pass" ]; then
  node "$STATUS_HELPER" --summary \
    --lock=blocked "--approval=$approval_state" "--retry=$(retry_state)" || true
  echo "Another iOS release operation is running." >&2
  exit 75
fi

if [ "${1:-}" = "--submit-approved" ]; then
  BUILD_ID="${2:-}"
  [[ "$BUILD_ID" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] || {
    echo "OUTCOME: BLOCKED — an exact approved build ID is required." >&2; exit 2;
  }
  if [ -f "$REPO_ROOT/.local/.eas-submit-build-id" ] &&
     [ "$(cat "$REPO_ROOT/.local/.eas-submit-build-id")" != "$BUILD_ID" ]; then
    echo "OUTCOME: BLOCKED — a different pending build must be reconciled first." >&2; exit 2
  fi
  if [ ! -f "$REPO_ROOT/.local/.eas-submit-build-id" ]; then
    printf '%s\n' "$BUILD_ID" > "$REPO_ROOT/.local/.eas-submit-build-id"
  fi
  touch "$REPO_ROOT/.local/.eas-submit-only"
fi

if [ "${1:-}" = "--recover-upload-record" ]; then
  BUILD_ID="${2:-}"
  node "$OPERATION_HELPER" check-accepted "$BUILD_ID"
  node "$STATUS_HELPER" --record-uploaded "$BUILD_ID"
  # Clear retry markers before the receipt. A crash at any preceding step
  # leaves an accepted receipt and can safely repeat local recovery only.
  rm -f "$REPO_ROOT/.local/.eas-submit-build-id" "$REPO_ROOT/.local/.eas-submit-only" "$REPO_ROOT/.local/.eas-submit-ipa-url"
  node "$OPERATION_HELPER" finish "$BUILD_ID"
  echo "OUTCOME: UPLOADED — recovered accepted receipt; no remote upload repeated."
  exit 0
fi

if [ -e "$REPO_ROOT/.local/.eas-upload-attempt.json" ]; then
  if ! node "$OPERATION_HELPER" check-ready "$(cat "$REPO_ROOT/.local/.eas-submit-build-id" 2>/dev/null || true)"; then
    echo "OUTCOME: BLOCKED — prior upload must be reconciled; never retry an ambiguous receipt automatically." >&2
    exit 2
  fi
fi

# Serialize approved release operations: the approval file, version bump and
# ASC key path are shared with the submit-only helper.
if [ -f "$REPO_ROOT/.local/.eas-build-approved" ] && [ -f "$REPO_ROOT/.local/.eas-submit-only" ]; then
  echo "Choose one release operation: both build and submit-only approvals exist." >&2
  exit 1
fi

# ── 0. Manual-approval gate ─────────────────────────────────────────────────
# EAS/TestFlight builds are MANUAL-ONLY and require explicit approval.
#
# This workflow auto-restarts after every Replit merge and package install.
# Without this gate, each merge would burn a pay-as-you-go build credit.
# The gate is a one-shot sentinel file: create it to approve exactly one build,
# consumed only after preflight passes and an explicit invocation is made.
#
# To approve and run a build:
#   1. Run the required checks and record their results:
#        bash scripts/eas-ios-build.sh --record-check mobile-tests pass
#   2. Confirm the physical-device checklist against the exact tested build:
#        bash scripts/eas-ios-build.sh --confirm-device-checklist <build-id>
#   3. Review the complete status:
#        bash scripts/eas-ios-build.sh --status
#   4. Drop the separate one-shot approval token:
#        touch .local/.eas-build-approved
#   5. Run: bash scripts/eas-ios-build.sh --run-approved
#      Ordinary managed-workflow restarts always remain idle.
#
SUBMIT_ONLY_TOKEN="$REPO_ROOT/.local/.eas-submit-only"
if [ -f "$SUBMIT_ONLY_TOKEN" ]; then
  BUILD_ID_FILE="$REPO_ROOT/.local/.eas-submit-build-id"
  BUILD_ID=""
  if [ -f "$BUILD_ID_FILE" ]; then
    BUILD_ID=$(cat "$BUILD_ID_FILE")
  fi
  if [[ ! "$BUILD_ID" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]]; then
    echo "Submit-only requires the exact approved build ID in .local/.eas-submit-build-id." >&2
    exit 1
  fi
  echo "==> Submit-only mode activated (no build consumed)."
  echo ""
  cd "$REPO_ROOT/artifacts/labtrax"
  SUBMIT_TMP="$(mktemp -d)"
  trap 'rm -f "$ASC_KEY"; rm -rf "$SUBMIT_TMP"' EXIT
  # Read-only metadata is required for every retry, not only downloaded IPAs.
  eas build:view "$BUILD_ID" --json > "$SUBMIT_TMP/approved-build.json"
  BUILD_ID="$BUILD_ID" node - "$SUBMIT_TMP/approved-build.json" <<'NODE'
const fs = require("node:fs");
const build = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
if (build.id !== process.env.BUILD_ID || build.project?.id !== app.expo.extra?.eas?.projectId ||
    build.platform !== "IOS" || build.status !== "FINISHED" || build.distribution !== "STORE" ||
    build.buildProfile !== "production" || !/^\d+$/.test(build.appBuildVersion ?? "") ||
    !build.appVersion) process.exit(1);
NODE
  retry_version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).appVersion' "$SUBMIT_TMP/approved-build.json")
  retry_number=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).appBuildVersion' "$SUBMIT_TMP/approved-build.json")
  node "$OPERATION_HELPER" check-ready "$BUILD_ID"
  # Same-build metadata recovery must not reset an already accepted upload.
  node "$STATUS_HELPER" --record-built "$BUILD_ID" "$retry_version" "$retry_number"
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
    python3 - "$SUBMIT_TMP/build.ipa" "$APP_JSON" "$retry_version" "$retry_number" <<'PY'
import json, plistlib, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    paths = [p for p in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", p)]
    if len(paths) != 1:
        raise SystemExit("Downloaded artifact must contain exactly one main iOS app.")
    info = plistlib.loads(archive.read(paths[0]))
with open(sys.argv[2]) as config:
    app = json.load(config)["expo"]
if (info.get("CFBundleIdentifier") != app["ios"].get("bundleIdentifier") or
    str(info.get("CFBundleShortVersionString")) != sys.argv[3] or
    str(info.get("CFBundleVersion")) != sys.argv[4]):
    raise SystemExit("Downloaded artifact identity/build number differs from the approved app.")
PY
    IPA_SIZE=$(wc -c < "$SUBMIT_TMP/build.ipa")
    echo "    Downloaded: $IPA_SIZE bytes"
    echo "==> Submitting via local IPA path (bypasses pre-signed URL expiry)..."
    submit_exact --path "$SUBMIT_TMP/build.ipa"
  elif [ -n "$BUILD_ID" ]; then
    echo "==> Submitting build $BUILD_ID to App Store Connect..."
    submit_exact --id "$BUILD_ID"
  fi
  rm -f "$BUILD_ID_FILE" "$IPA_URL_FILE" "$SUBMIT_ONLY_TOKEN"
  node "$OPERATION_HELPER" finish "$BUILD_ID"
  echo "OUTCOME: UPLOADED — Apple processing and TestFlight availability are not confirmed."
  exit 0
fi

APPROVAL_TOKEN="$REPO_ROOT/.local/.eas-build-approved"
if [ ! -f "$APPROVAL_TOKEN" ]; then
  node "$STATUS_HELPER" --summary --lock=pass --approval=blocked "--retry=$(retry_state)" || true
  echo "==> EAS build is not approved; no build was started."
  echo ""
  echo "    This workflow auto-restarts on every merge and package install."
  echo "    To prevent accidental credit usage, builds are gated behind a"
  echo "    one-shot approval token."
  echo ""
  echo "    Resolve every BLOCKED release check shown above, then record"
  echo "    the device checklist and explicitly arm one build approval."
  echo ""
  echo "OUTCOME: BLOCKED — explicitly requested build lacks approval; no credit consumed."
  exit 2
fi

# Preserve authorization until all source-bound checks pass.
if ! node "$STATUS_HELPER" --summary --lock=pass --approval=pass "--retry=$(retry_state)"; then
  echo "OUTCOME: BLOCKED — approval retained. Resolve checks and invoke --run-approved; automatic restarts remain idle." >&2
  exit 2
fi
echo "==> Preflight passed. Approval remains armed until remote build reservation..."
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
node "$OPERATION_HELPER" reserve-build \
  "$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON')).expo.version")" \
  "$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON')).expo.ios.buildNumber")"
persisted=true
rm -f "$APPROVAL_TOKEN"
if ! eas build --platform ios --profile production --non-interactive --wait --json > "$BUILD_TMP/build.json"; then
  echo "Remote build outcome needs inspection. The reserved build number was retained; no upload was attempted." >&2
  exit 1
fi
BUILD_ID="$(node -e '
const fs = require("fs");
const builds = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(builds) || builds.length !== 1) process.exit(1);
const build = builds[0];
const app = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).expo;
if (build.platform !== "IOS" || build.status !== "FINISHED" ||
    build.project?.id !== app.extra?.eas?.projectId || build.distribution !== "STORE" ||
    build.buildProfile !== "production" || build.appVersion !== app.version ||
    String(build.appBuildVersion) !== String(app.ios.buildNumber) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(build.id ?? "")) process.exit(1);
console.log(build.id);
' "$BUILD_TMP/build.json" "$APP_JSON")" || {
  echo "Could not identify one completed iOS build. Number retained; inspect EAS before any upload." >&2
  exit 1
}
printf '%s\n' "$BUILD_ID" > "$REPO_ROOT/.local/.eas-submit-build-id"
# An old downloaded-artifact URL must never be paired with this new build ID.
rm -f "$REPO_ROOT/.local/.eas-submit-ipa-url"
build_num=$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON','utf8')).expo.ios.buildNumber")
app_version=$(node -p "JSON.parse(require('fs').readFileSync('$APP_JSON','utf8')).expo.version")
node "$STATUS_HELPER" --record-built "$BUILD_ID" "$app_version" "$build_num"
node "$OPERATION_HELPER" prepare-upload "$BUILD_ID"
node "$OPERATION_HELPER" built "$BUILD_ID"
echo "OUTCOME: BUILT — exact completed artifact pinned; upload has not started."

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

if ! bash "$REPO_ROOT/scripts/commit-ios-build-number.sh" "$APP_JSON" "$build_num"; then
  echo "Build number $build_num was not confirmed committed. The exact completed build ID remains saved for recovery; no upload was attempted." >&2
  exit 1
fi

# Push only when an 'origin' remote exists (e.g. GitHub Actions CI). In the
# Replit workspace there is no 'origin' remote (the checkpoint system persists
# the commit), so a missing or failing push must NOT abort the run before the
# submit step below — that is exactly what stranded a successful build 155.
echo "Source synchronization is separate; this release operation never pushes Git history."

echo ""
echo "==> Build number $build_num committed and verified."

# ── 4. Submit this exact completed build to App Store Connect ───────────────
echo ""
echo "==> Submitting completed iOS build $BUILD_ID to App Store Connect..."
cd "$REPO_ROOT/artifacts/labtrax"

submit_exact --id "$BUILD_ID"
rm -f "$REPO_ROOT/.local/.eas-submit-build-id"
node "$OPERATION_HELPER" finish "$BUILD_ID"

echo ""
echo "==> Uploaded to App Store Connect: LabTrax $app_version ($build_num), EAS build $BUILD_ID."
echo "OUTCOME: UPLOADED — not a confirmation of TestFlight availability."
echo "    Apple processing: pending owner confirmation in App Store Connect."
echo "    TestFlight availability: not confirmed; processing is not availability."
echo "    After checking App Store Connect, record the exact build status with:"
echo "      bash scripts/eas-ios-build.sh --record-apple-processing $BUILD_ID <processing|processed|failed>"
echo "      bash scripts/eas-ios-build.sh --record-testflight-availability $BUILD_ID <available|unavailable>"
