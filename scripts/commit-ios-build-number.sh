#!/usr/bin/env bash
# Persist and verify the iOS build number for an already completed EAS build.
set -euo pipefail

if [[ "$#" -ne 2 || -z "$2" ]]; then
  echo "Usage: commit-ios-build-number.sh <app.json> <build-number>" >&2
  exit 2
fi

APP_JSON="$(realpath "$1")"
EXPECTED_BUILD_NUM="$2"
REPO_ROOT="$(git -C "$(dirname "$APP_JSON")" rev-parse --show-toplevel)"
APP_REL="${APP_JSON#"$REPO_ROOT"/}"
if [[ "$APP_REL" == "$APP_JSON" || "$APP_REL" == "$APP_JSON/" ]]; then
  echo "app.json must be inside the Git repository." >&2
  exit 2
fi

read_committed_build_number() {
  git -C "$REPO_ROOT" show "$1:$APP_REL" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(input).expo.ios.buildNumber;
    if (value === undefined || value === null) process.exitCode = 1;
    else process.stdout.write(String(value));
  } catch {
    process.exitCode = 1;
  }
});
'
}

git -C "$REPO_ROOT" add -- "$APP_REL"

# A clean staged path is only a no-op if HEAD already contains this exact
# number. Do not mistake an unrelated Git failure for "nothing to commit."
if git -C "$REPO_ROOT" diff --cached --quiet -- "$APP_REL"; then
  COMMITTED_BUILD_NUM="$(read_committed_build_number HEAD)" || {
    echo "Could not verify the committed iOS build number." >&2
    exit 1
  }
  if [[ "$COMMITTED_BUILD_NUM" != "$EXPECTED_BUILD_NUM" ]]; then
    echo "No app.json version diff exists, but HEAD does not record build number $EXPECTED_BUILD_NUM." >&2
    exit 1
  fi
  echo "Build number $EXPECTED_BUILD_NUM was already committed and verified."
  exit 0
fi

PREVIOUS_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if ! git -C "$REPO_ROOT" commit \
  -m "chore: bump iOS build number to $EXPECTED_BUILD_NUM [skip ci]" \
  --only -- "$APP_REL"; then
  echo "ERROR: Could not commit build number $EXPECTED_BUILD_NUM. The completed EAS build ID is retained for recovery; no upload was attempted." >&2
  exit 1
fi

SAVED_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ "$SAVED_HEAD" == "$PREVIOUS_HEAD" ]]; then
  echo "ERROR: Git reported success but did not create a build-number commit." >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" diff --quiet "$PREVIOUS_HEAD" "$SAVED_HEAD" -- "$APP_REL"; then
  SAVED_BUILD_NUM="$(read_committed_build_number "$SAVED_HEAD")" || {
    echo "ERROR: Could not verify build number $EXPECTED_BUILD_NUM in the saved commit." >&2
    exit 1
  }
  if [[ "$SAVED_BUILD_NUM" != "$EXPECTED_BUILD_NUM" ]]; then
    echo "ERROR: Saved commit contains build number $SAVED_BUILD_NUM, expected $EXPECTED_BUILD_NUM." >&2
    exit 1
  fi
else
  echo "ERROR: Git reported success but the saved commit did not change app.json." >&2
  exit 1
fi

echo "Build number $EXPECTED_BUILD_NUM commit verified."
