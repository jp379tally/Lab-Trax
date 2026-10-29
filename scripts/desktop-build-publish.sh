#!/bin/bash
set -euo pipefail
# Desktop Build + Publish Script
#
# Builds the LabTrax Desktop Electron app and publishes the resulting
# installer to App Storage so the API server can serve it.
#
# ─── AUTO-UPDATE FEED POLICY ─────────────────────────────────────────────────
# latest.yml is the electron-updater manifest consumed by NSIS-installed copies
# of LabTrax to discover and download new versions. It MUST reference
# LabTrax-Setup.exe — NEVER the portable ZIP. If latest.yml points at the ZIP,
# NSIS-installed users' auto-updater extracts the ZIP to a temp dir and leaves
# the original %LOCALAPPDATA%\Programs\LabTrax\LabTrax.exe stale, breaking
# every pinned taskbar and Start Menu shortcut.
#
#   Signed NSIS installer path (Windows release):
#     GET /downloads/LabTrax-Setup.exe
#     GET /downloads/latest.yml          ← references LabTrax-Setup.exe ✓
#     Publish Draft Release updates the Windows + macOS generic feeds after review.
#
#   Portable ZIP path (this script on Linux/Replit — no Wine):
#     GET /downloads/LabTrax-Windows-Portable.zip
#     (no in-place update manifest is published or overwritten)
# ─────────────────────────────────────────────────────────────────────────────
#
# Run only from an explicitly approved release workspace, never post-merge:
#
#   bash scripts/desktop-build-publish.sh
#   bash scripts/desktop-build-publish.sh --prepare-only
#
# --prepare-only builds and verifies a signed Windows installer and writes its
# release-identity.json locally. It exits before upload, HTTP probes, settings
# writes or notifications. It is NOT a dry run: signing/building still runs.
#
# Required (auto-set by Replit):
#   REPLIT_DEV_DOMAIN or VITE_API_BASE_URL  — baked into the renderer bundle
#   DEFAULT_OBJECT_STORAGE_BUCKET_ID        — App Storage target
#   PRIVATE_OBJECT_DIR                      — App Storage path prefix
#
# Optional:
#   PUBLISH_API_BASE_URL      — production API URL; required to mark a build
#                               as an installed in-place update channel
#   PLATFORM_ADMIN_SECRET     — if set, metadata is pushed via the API;
#                               otherwise system_settings is updated via psql
#
# Code-signing (Windows — removes SmartScreen "Windows protected your PC" warning):
#   CSC_LINK              — base64-encoded PFX certificate (OV or EV).
#                           Encode your .pfx with:  base64 -w 0 certificate.pfx
#                           Store the result as the CSC_LINK Replit secret.
#   CSC_KEY_PASSWORD      — password protecting the PFX.
#                           Store it as the CSC_KEY_PASSWORD Replit secret.
#   CSC_EXPECTED_PUBLISHER — optional but strongly recommended. Exact CN from
#                           the code-signing certificate (e.g. "Acme Dental LLC").
#                           When set, the built EXE's signer subject must contain
#                           this string. Catches wrong-cert scenarios (expired cert
#                           renewed under a new name, dev cert in production, etc.).
#
#   electron-builder picks CSC_LINK / CSC_KEY_PASSWORD up automatically when
#   they are present in the environment. When absent, the build proceeds unsigned.
#   After every signed build, scripts/verify-signing.sh verifies BOTH
#   win-unpacked/LabTrax.exe AND the installer package (when it is a PE file)
#   before any upload or latest.yml generation. If verification fails, the
#   publish is aborted — unsigned or wrongly-signed builds never reach the feed.
#   The signing hash algorithm (sha256) and RFC 3161 timestamp server are
#   configured in artifacts/labtrax-desktop/electron-builder.yml.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/artifacts/labtrax-desktop"

PREPARE_ONLY=false
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    --prepare-only)
      [[ "$#" == 1 ]] || { echo "ERROR: --prepare-only accepts no additional arguments." >&2; exit 1; }
      PREPARE_ONLY=true
      ;;
    --help)
      echo "Usage: bash scripts/desktop-build-publish.sh [--prepare-only]"
      echo "--prepare-only: build and verify a signed Windows installer locally; do not upload or publish."
      echo "No option: build and publish immediately; requires explicit release approval."
      exit 0
      ;;
    *) echo "ERROR: unknown release option: $1" >&2; exit 1 ;;
  esac
fi

echo ""
echo "========================================="
if [[ "$PREPARE_ONLY" == true ]]; then
  echo " LabTrax Desktop — Prepare Only (no publication)"
else
  echo " LabTrax Desktop — Build + Publish"
fi
echo "========================================="

# Resolve VITE_API_BASE_URL -----------------------------------------------
if [[ "$PREPARE_ONLY" == true && -z "${VITE_API_BASE_URL:-}" && -n "${PUBLISH_API_BASE_URL:-}" ]]; then
  export VITE_API_BASE_URL="${PUBLISH_API_BASE_URL}"
fi
if [[ -z "${VITE_API_BASE_URL:-}" ]]; then
  if [[ -n "${REPLIT_DEV_DOMAIN:-}" ]]; then
    export VITE_API_BASE_URL="https://${REPLIT_DEV_DOMAIN}"
    echo "[build] VITE_API_BASE_URL set from REPLIT_DEV_DOMAIN → ${VITE_API_BASE_URL}"
  else
    echo "[build] ERROR: set VITE_API_BASE_URL or REPLIT_DEV_DOMAIN before running this script."
    exit 1
  fi
fi

VERSION=$(node -p "require('${DESKTOP_DIR}/package.json').version" 2>/dev/null || echo "0.0.0")
echo "[build] Version: ${VERSION}"

cd "$ROOT_DIR"
HEAD_REVISION="$(git rev-parse HEAD)"
REQUESTED_REVISION="${GIT_COMMIT_SHA:-${GITHUB_SHA:-$HEAD_REVISION}}"
if [[ "$PREPARE_ONLY" == true && ! "$REQUESTED_REVISION" =~ ^[a-fA-F0-9]{40}$ ]]; then
  echo "[build] ERROR: recovery release preparation requires a full 40-character source revision."
  exit 1
fi
if ! SOURCE_REVISION="$(git rev-parse --verify "${REQUESTED_REVISION}^{commit}" 2>/dev/null)" ||
   [[ "$SOURCE_REVISION" != "$HEAD_REVISION" ]]; then
  echo "[build] ERROR: release source revision must be the current checked-out commit."
  exit 1
fi
if ! git diff --quiet HEAD --; then
  echo "[build] ERROR: tracked source changes are present; release builds require the exact committed source."
  exit 1
fi
if [[ "$PREPARE_ONLY" == true && -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "[build] ERROR: untracked files are present; recovery release preparation requires a clean checkout."
  exit 1
fi
export GIT_COMMIT_SHA="$HEAD_REVISION"
echo "[build] Source revision: ${GIT_COMMIT_SHA}"

# Set UPDATE_FEED_URL so electron-builder bakes app-update.yml into the
# packaged app pointing at our /downloads directory. Only signed installer
# builds use this feed; portable and manual builds are stamped download-only.
# The installer channel requires the production API URL.
BASE_URL="${PUBLISH_API_BASE_URL:-${VITE_API_BASE_URL}}"
export UPDATE_FEED_URL="${BASE_URL%/}/downloads/"
if [[ -z "${ELECTRON_UPDATE_CHANNEL:-}" ]]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${PUBLISH_API_BASE_URL:-}" ]]; then
        if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
          echo "[build] ERROR: a production installer release requires CSC_LINK and CSC_KEY_PASSWORD."
          exit 1
        fi
        export ELECTRON_UPDATE_CHANNEL=installer
      else
        export ELECTRON_UPDATE_CHANNEL=manual
      fi
      ;;
    *) export ELECTRON_UPDATE_CHANNEL=portable ;;
  esac
fi
if [[ "$ELECTRON_UPDATE_CHANNEL" == "installer" && -z "${PUBLISH_API_BASE_URL:-}" ]]; then
  echo "[build] ERROR: PUBLISH_API_BASE_URL is required for installed updater builds."
  exit 1
fi
if [[ "$ELECTRON_UPDATE_CHANNEL" == "installer" && ( -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ) ]]; then
  echo "[build] ERROR: CSC_LINK and CSC_KEY_PASSWORD are required for signed installer update builds."
  exit 1
fi
if [[ "$PREPARE_ONLY" == true ]]; then
  if [[ "$ELECTRON_UPDATE_CHANNEL" != "installer" ]]; then
    echo "[build] ERROR: --prepare-only requires ELECTRON_UPDATE_CHANNEL=installer and a signed Windows NSIS build."
    exit 1
  fi
  if [[ "${VITE_API_BASE_URL%/}" != "${PUBLISH_API_BASE_URL%/}" ]]; then
    echo "[build] ERROR: prepared recovery installers must use the same API origin for the renderer and updater."
    exit 1
  fi
fi
export ELECTRON_PUBLISH=never
echo "[build] UPDATE_FEED_URL=${UPDATE_FEED_URL}"
if [[ "$ELECTRON_UPDATE_CHANNEL" == "portable" ]]; then
  echo "[build] Portable ZIP builds do not support in-place updates; updater is disabled."
elif [[ "$ELECTRON_UPDATE_CHANNEL" == "manual" ]]; then
  echo "[build] Manual installer builds do not check the in-place update feed."
fi

# Code-signing ----------------------------------------------------------------
# electron-builder reads CSC_LINK / CSC_KEY_PASSWORD directly from the
# environment. Child processes (pnpm run electron:build) inherit them
# automatically — no explicit export is needed.
echo ""
if [[ -n "${CSC_LINK:-}" && -n "${CSC_KEY_PASSWORD:-}" ]]; then
  echo "[signing] ✓ CSC_LINK and CSC_KEY_PASSWORD are set — build will be code-signed."
  echo "[signing]   SHA-256 + RFC 3161 timestamp via Sectigo (see electron-builder.yml)."
  echo "[signing]   Post-build: verify-signing.sh will verify both EXE and installer"
  echo "[signing]   before any upload or latest.yml generation."
else
  echo "[signing] ⚠ CSC_LINK or CSC_KEY_PASSWORD is not set — build will be UNSIGNED."
  echo "[signing]   SmartScreen will show a warning when users run the installer."
  echo "[signing]   To enable signing, add CSC_LINK and CSC_KEY_PASSWORD as Replit secrets."
fi

# Build -----------------------------------------------------------------------
echo ""
echo "[build] Running electron:build …"
cd "$DESKTOP_DIR"
pnpm run electron:build

# Determine which installer was produced --------------------------------------
# On Windows (or Linux + Wine): electron-builder produces LabTrax-Setup.exe.
# On Linux without Wine (Replit): electron-builder falls back to win-unpacked
# only, and electron-build.mjs zips it as LabTrax-Windows-Portable.zip.
#
# Prefer the NSIS installer when both exist (e.g. CI output was copied in).
UNPACKED_EXE="${DESKTOP_DIR}/electron-dist/win-unpacked/LabTrax.exe"
EXE_PATH="${DESKTOP_DIR}/electron-dist/LabTrax-Setup.exe"
ZIP_PATH="${DESKTOP_DIR}/electron-dist/LabTrax-Windows-Portable.zip"
LATEST_YML="${DESKTOP_DIR}/electron-dist/latest.yml"

if [[ -f "$EXE_PATH" ]]; then
  INSTALLER_PATH="$EXE_PATH"
  INSTALLER_KIND="exe"
  INSTALLER_FILENAME="LabTrax-Setup.exe"
  DOWNLOAD_URL="/downloads/LabTrax-Setup.exe"
  echo "[build] ✓ NSIS installer found: ${INSTALLER_PATH}"
elif [[ -f "$ZIP_PATH" ]]; then
  INSTALLER_PATH="$ZIP_PATH"
  INSTALLER_KIND="zip"
  INSTALLER_FILENAME="LabTrax-Windows-Portable.zip"
  DOWNLOAD_URL="/downloads/LabTrax-Windows-Portable.zip"
  echo "[build] ✓ Portable ZIP found (NSIS not available on this platform): ${INSTALLER_PATH}"
else
  echo "[build] ERROR: Neither LabTrax-Setup.exe nor LabTrax-Windows-Portable.zip found after build."
  exit 1
fi

INSTALLER_SIZE=$(du -sh "$INSTALLER_PATH" | cut -f1)
echo "[build] Installer: ${INSTALLER_PATH} (${INSTALLER_SIZE})"

if [[ "$INSTALLER_KIND" == "exe" && -n "${PUBLISH_API_BASE_URL:-}" && "$ELECTRON_UPDATE_CHANNEL" != "installer" ]]; then
  echo "[build] ERROR: refusing to publish a Windows installer to the production download/feed channel without the signed installer update channel."
  exit 1
fi
if [[ "$INSTALLER_KIND" == "zip" && "$ELECTRON_UPDATE_CHANNEL" == "installer" ]]; then
  echo "[build] ERROR: a portable ZIP cannot be marked as an installed in-place update channel."
  exit 1
fi

# Signature verification ------------------------------------------------------
# When CSC_LINK is set, electron-builder was asked to sign the binary.
# scripts/verify-signing.sh verifies:
#   1. win-unpacked/LabTrax.exe     — the unpacked main executable (always)
#   2. LabTrax-Setup.exe            — the NSIS installer package (when produced;
#                                     ZIP packages are not Authenticode-signable
#                                     so only the EXE inside them is verified)
#
# Verification outputs for each file:
#   • Certificate subject (CN)
#   • Publisher name
#   • Timestamp authority
#   • Signature status (valid / failed)
#
# Gating: if verification fails for ANY reason (invalid signature, expired or
# revoked certificate, publisher mismatch, no verification tool), the script
# exits non-zero and set -euo pipefail stops execution here — latest.yml is
# never generated and the upload step never runs.
echo ""
if [[ "$INSTALLER_KIND" == "exe" ]]; then
  bash "$SCRIPT_DIR/verify-signing.sh" "$UNPACKED_EXE" "$INSTALLER_PATH"
else
  # Portable ZIP: only the inner EXE is Authenticode-signable.
  bash "$SCRIPT_DIR/verify-signing.sh" "$UNPACKED_EXE"
fi
if [[ -n "${CSC_LINK:-}" && -n "${CSC_KEY_PASSWORD:-}" ]]; then
  if [[ "$INSTALLER_KIND" == "exe" ]]; then
    export LABTRAX_DESKTOP_SIGNATURE_VERIFICATION="verified-installer"
  else
    export LABTRAX_DESKTOP_SIGNATURE_VERIFICATION="verified-contained-executable"
  fi
else
  export LABTRAX_DESKTOP_SIGNATURE_VERIFICATION="unverified"
fi
if [[ "$LABTRAX_DESKTOP_SIGNATURE_VERIFICATION" == "unverified" ]]; then
  echo "[publish] ERROR: refusing to publish an unsigned Desktop artifact."
  exit 1
fi

# Auto-update manifest (latest.yml) handling ---------------------------------
# CRITICAL INVARIANT: latest.yml must ONLY reference LabTrax-Setup.exe (the
# NSIS installer). If it references the portable ZIP, NSIS-installed users who
# auto-update will have the ZIP extracted to a temp dir while their original
# install path goes stale — breaking every pinned taskbar and Start Menu
# shortcut with "The item 'LabTrax.exe' has been changed or moved."
#
# EXE (NSIS) path: electron-builder already wrote latest.yml referencing the
#   installer. Use it as-is (it includes the correct blockmap for NSIS delta
#   patches). If somehow absent, generate it from the EXE.
#
# ZIP (portable) path: DO NOT generate or overwrite latest.yml. The Replit /
#   Linux build cannot produce an NSIS installer. Updating the auto-update
#   feed from this path would break NSIS-installed users. Instead, write
#   latest-portable.yml as an informational record and log a clear notice.
#
# NOTE: runs AFTER signature verification — set -euo pipefail has already
# stopped the script on any verification failure, so a bad build never
# reaches this point.
echo ""
if [[ "$INSTALLER_KIND" == "exe" ]]; then
  if [[ ! -f "$LATEST_YML" ]]; then
    echo "[publish] Generating latest.yml auto-update manifest from NSIS installer …"
    SHA512=$(openssl dgst -sha512 -binary "$INSTALLER_PATH" | base64 --wrap=0)
    BYTE_SIZE=$(stat -c%s "$INSTALLER_PATH")
    RELEASE_DATE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    cat > "$LATEST_YML" <<EOF
version: ${VERSION}
files:
  - url: ${INSTALLER_FILENAME}
    sha512: ${SHA512}
    size: ${BYTE_SIZE}
path: ${INSTALLER_FILENAME}
sha512: ${SHA512}
releaseDate: '${RELEASE_DATE}'
EOF
    echo "[publish] ✓ latest.yml generated (sha512=${SHA512:0:16}…, size=${BYTE_SIZE}B, url=${INSTALLER_FILENAME})"
  else
    echo "[publish] Using existing latest.yml from electron-builder (${LATEST_YML})."
    # Safety check: ensure latest.yml does not reference the portable ZIP.
    if grep -q "LabTrax-Windows-Portable.zip" "$LATEST_YML"; then
      echo "[publish] ERROR: latest.yml references LabTrax-Windows-Portable.zip — this must"
      echo "[publish]   never be uploaded as the auto-update feed for NSIS-installed users."
      echo "[publish]   Delete electron-dist/latest.yml and re-run to regenerate from the EXE."
      exit 1
    fi
  fi
else
  # ── Portable ZIP path (Linux / Replit — no Wine, no NSIS installer) ──────
  # We cannot build an NSIS installer here. DO NOT generate or upload
  # latest.yml. If we wrote latest.yml pointing at the ZIP, auto-update on
  # NSIS installs would extract the ZIP to a temp dir and leave the stable
  # install path stale, breaking all pinned shortcuts.
  #
  # Write latest-portable.yml as an informational record of this build.
  # It is NOT consumed by electron-updater in standard NSIS installs.
  PORTABLE_YML="${DESKTOP_DIR}/electron-dist/latest-portable.yml"
  SHA512=$(openssl dgst -sha512 -binary "$INSTALLER_PATH" | base64 --wrap=0)
  BYTE_SIZE=$(stat -c%s "$INSTALLER_PATH")
  RELEASE_DATE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  cat > "$PORTABLE_YML" <<EOF
version: ${VERSION}
files:
  - url: ${INSTALLER_FILENAME}
    sha512: ${SHA512}
    size: ${BYTE_SIZE}
path: ${INSTALLER_FILENAME}
sha512: ${SHA512}
releaseDate: '${RELEASE_DATE}'
EOF
  echo "[publish] ✓ latest-portable.yml written (portable build record — NOT the auto-update feed)."

  # Defense in depth: remove any stale latest.yml from electron-dist so the
  # upload script cannot accidentally find and upload it.  The uploader also
  # guards against kind=zip, but an explicit removal here makes the protection
  # deterministic even if the installer is somehow passed as something other
  # than "LabTrax-Windows-Portable.zip".
  if [[ -f "$LATEST_YML" ]]; then
    echo "[publish] Removing stale electron-dist/latest.yml to prevent accidental feed overwrite …"
    rm -f "$LATEST_YML"
  fi

  echo ""
  echo "[publish] ⚠  NOTICE: Portable ZIP published. latest.yml was NOT updated."
  echo "[publish]    The generic update feed is reserved for signed installer releases."
  echo "[publish]    Run the release workflow and Publish Draft Release to publish"
  echo "[publish]    the verified Windows and macOS manifests after review."
  echo "[publish]    Until then, NSIS-installed users will not receive update notifications."
fi

# Build-freshness verification -------------------------------------------------
# CRITICAL: the v1.0.5 publish uploaded a STALE zip built from weeks-old code
# while every step below reported success. electron-builder had died before
# repacking app.asar, and the zip fallback re-zipped the previous build's
# win-unpacked. To make that impossible, electron-build.mjs embeds a unique
# per-run build stamp into the vite output (packed into app.asar) and records
# the expected token in electron-dist/build-stamp.txt. Here we grep the actual
# artifact about to be uploaded for that token and abort loudly if it is
# missing — stale bytes must never reach App Storage again.
echo ""
echo "[verify] Checking that the installer contains this run's build stamp …"
STAMP_FILE="${DESKTOP_DIR}/electron-dist/build-stamp.txt"
if [[ ! -f "$STAMP_FILE" ]]; then
  echo "[verify] ERROR: ${STAMP_FILE} not found."
  echo "[verify]   electron-build.mjs writes this file after a successful vite build."
  echo "[verify]   Its absence means the build did not complete — refusing to upload."
  exit 1
fi
BUILD_STAMP=$(head -n1 "$STAMP_FILE" | tr -d '[:space:]')
if [[ -z "$BUILD_STAMP" ]]; then
  echo "[verify] ERROR: ${STAMP_FILE} is empty — refusing to upload."
  exit 1
fi
echo "[verify] Expected stamp: ${BUILD_STAMP}"

stamp_failure() {
  echo ""
  echo "[verify] ERROR: the artifact about to be uploaded does NOT contain this"
  echo "[verify]   run's build stamp. The packaged app payload is STALE — it was"
  echo "[verify]   built from an earlier run, not from the code just compiled."
  echo "[verify]   This is exactly the failure that shipped old code in v1.0.5."
  echo "[verify]   Check the electron-builder output above: it must repack"
  echo "[verify]   app.asar (win-unpacked) BEFORE the wine/NSIS step fails."
  echo "[verify]   Nothing was uploaded."
  exit 1
}

if [[ "$INSTALLER_KIND" == "zip" ]]; then
  # Verify the exact bytes being uploaded: extract the packed app payload from
  # the zip and grep it for the stamp. Check the JSON file first — it is always
  # freshly written by electron-build.mjs and staged into win-unpacked/resources/app/.
  # The app.asar may be stale from a previous electron-builder run (electron-builder
  # packs the asar before hanging at the Wine/NSIS step, but if it hangs before
  # packing the asar the previous build's asar with the OLD stamp persists).
  if unzip -l "$INSTALLER_PATH" "LabTrax/resources/app/dist/electron-app/build-stamp.json" >/dev/null 2>&1; then
    unzip -p "$INSTALLER_PATH" "LabTrax/resources/app/dist/electron-app/build-stamp.json" \
      | grep -aqF "$BUILD_STAMP" || stamp_failure
    echo "[verify] ✓ Zip's build-stamp.json contains the fresh build stamp."
  elif unzip -l "$INSTALLER_PATH" "LabTrax/resources/app.asar" >/dev/null 2>&1; then
    unzip -p "$INSTALLER_PATH" "LabTrax/resources/app.asar" | grep -aqF "$BUILD_STAMP" || stamp_failure
    echo "[verify] ✓ Zip's app.asar contains the fresh build stamp."
  else
    echo "[verify] ERROR: zip contains neither LabTrax/resources/app/dist/electron-app/build-stamp.json"
    echo "[verify]   nor LabTrax/resources/app.asar —"
    echo "[verify]   cannot prove the payload is fresh. Refusing to upload."
    exit 1
  fi
else
  # NSIS installer: the compressed exe cannot be grepped reliably, but it was
  # packed from win-unpacked in this same run — verify that payload instead.
  UNPACKED_ASAR="${DESKTOP_DIR}/electron-dist/win-unpacked/resources/app.asar"
  UNPACKED_STAMP_JSON="${DESKTOP_DIR}/electron-dist/win-unpacked/resources/app/dist/electron-app/build-stamp.json"
  if [[ -f "$UNPACKED_ASAR" ]]; then
    grep -aqF "$BUILD_STAMP" "$UNPACKED_ASAR" || stamp_failure
    echo "[verify] ✓ win-unpacked app.asar contains the fresh build stamp."
  elif [[ -f "$UNPACKED_STAMP_JSON" ]]; then
    grep -aqF "$BUILD_STAMP" "$UNPACKED_STAMP_JSON" || stamp_failure
    echo "[verify] ✓ win-unpacked app payload contains the fresh build stamp."
  else
    echo "[verify] ERROR: win-unpacked contains no app.asar or build-stamp.json —"
    echo "[verify]   cannot prove the installer payload is fresh. Refusing to upload."
    exit 1
  fi
fi

# A prepared artifact is not a published release. Keep this exit before every
# upload, download probe and settings write below, even when publish credentials
# happen to exist in the operator's environment.
if [[ "$PREPARE_ONLY" == true ]]; then
  echo ""
  echo "[prepare] Writing the verified installer identity beside the local artifact …"
  cd "$ROOT_DIR"
  pnpm --filter @workspace/scripts run prepare-desktop-release-identity -- "$INSTALLER_PATH"
  echo "[prepare] Signed installer and release-identity.json are ready for release review."
  echo "[prepare] Nothing was uploaded, published or written to production settings."
  exit 0
fi

# Upload installer + latest.yml to App Storage --------------------------------
# NOTE: upload runs AFTER signature verification. If verification failed,
# set -euo pipefail has already stopped the script — no artifact is uploaded.
echo ""
echo "[publish] Uploading installer and latest.yml to App Storage …"
cd "$ROOT_DIR"
pnpm --filter @workspace/scripts run upload-desktop-installer -- "$INSTALLER_PATH"
echo "[publish] ✓ Upload complete."

# Post-upload verification ----------------------------------------------------
# Confirm the installer is actually reachable before declaring success.
# Without this check a silent misconfiguration (wrong PRIVATE_OBJECT_DIR,
# serving-route not wired up, proxy drop) leaves /downloads/ returning 404
# while the script reports "Published" — exactly the failure mode that caused
# the Settings → Desktop App page to show MISSING.
#
# Verification strategy:
#   1. If PUBLISH_API_BASE_URL is set: HEAD the download URL via the live API.
#      This catches serving failures that direct-GCS checks cannot reveal
#      (reverse-proxy misconfiguration, stale routing, etc.).
#      Exit 1 when the HEAD does not return 200 — the publish is not complete.
#   2. If PUBLISH_API_BASE_URL is unset: probe the local Replit proxy
#      at localhost:80 so the check still runs in dev-mode publishes.
#      A missing REPLIT_DEV_DOMAIN means we skip the probe with a notice.
VERIFY_BASE_URL=""
if [[ -n "${PUBLISH_API_BASE_URL:-}" ]]; then
  VERIFY_BASE_URL="${PUBLISH_API_BASE_URL%/}"
elif [[ -n "${REPLIT_DEV_DOMAIN:-}" ]]; then
  VERIFY_BASE_URL="https://${REPLIT_DEV_DOMAIN}"
fi

if [[ -n "$VERIFY_BASE_URL" ]]; then
  echo ""
  echo "[verify] Confirming installer is reachable at ${VERIFY_BASE_URL}${DOWNLOAD_URL} …"
  VERIFY_HTTP_STATUS=$(curl --silent --head --output /dev/null \
    --write-out '%{http_code}' \
    --max-time 30 \
    "${VERIFY_BASE_URL}${DOWNLOAD_URL}" 2>/dev/null || echo "000")
  if [[ "$VERIFY_HTTP_STATUS" == "200" ]]; then
    echo "[verify] ✓ HEAD ${DOWNLOAD_URL} → HTTP 200 — installer is live."
  else
    echo ""
    echo "[verify] ERROR: HEAD ${VERIFY_BASE_URL}${DOWNLOAD_URL} returned HTTP ${VERIFY_HTTP_STATUS} (expected 200)."
    echo "[verify]   The installer was uploaded to App Storage but the download URL is not"
    echo "[verify]   serving correctly. Common causes:"
    echo "[verify]     • DEFAULT_OBJECT_STORAGE_BUCKET_ID or PRIVATE_OBJECT_DIR is wrong"
    echo "[verify]     • The serving route in app.ts is not wired to the correct storage key"
    echo "[verify]     • A reverse-proxy or CDN layer is caching a stale 404"
    echo "[verify]   Check the API server logs for errors from serveInstaller()."
    exit 1
  fi
else
  echo ""
  echo "[verify] NOTICE: PUBLISH_API_BASE_URL and REPLIT_DEV_DOMAIN are both unset."
  echo "[verify]   Skipping post-upload download probe — set one of these to enable"
  echo "[verify]   automatic verification that the installer is reachable after publish."
fi

# Update system_settings version record ---------------------------------------
# The API reads system_settings.desktop_installer_version to display the
# current published version. If PLATFORM_ADMIN_SECRET is set, the upload
# script already called PUT /api/admin/settings/desktop-installer above.
# When it is not set (Replit dev environment), update the DB directly.
if [[ -z "${PLATFORM_ADMIN_SECRET:-}" && -n "${DATABASE_URL:-}" ]]; then
  echo ""
  echo "[publish] Updating system_settings (version → ${VERSION}, url → ${DOWNLOAD_URL}) via psql …"
  psql "$DATABASE_URL" -q -c "
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('desktop_installer_version', '${VERSION}', NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW();
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('desktop_installer_url', '${DOWNLOAD_URL}', NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW();
  "
  echo "[publish] ✓ system_settings updated."
fi

echo ""
echo "========================================="
echo " LabTrax Desktop v${VERSION} published."
if [[ "$INSTALLER_KIND" == "exe" ]]; then
  echo " Download (NSIS installer): /downloads/LabTrax-Setup.exe"
  if [[ "$ELECTRON_UPDATE_CHANNEL" == "installer" ]]; then
    echo " Auto-update feed updated: ${UPDATE_FEED_URL}latest.yml"
    echo " → latest.yml references LabTrax-Setup.exe (NSIS-safe ✓)"
  else
    echo " In-place updates are disabled for this manual installer build."
    echo " Use the signed installer release channel to enable them."
  fi
else
  echo " Download (portable ZIP):   /downloads/LabTrax-Windows-Portable.zip"
  echo " In-place updates are disabled for this portable build."
  echo "    Use the signed NSIS release channel for in-place updates."
fi
echo "========================================="
echo ""
