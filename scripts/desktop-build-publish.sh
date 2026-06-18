#!/bin/bash
set -euo pipefail
# Desktop Build + Publish Script
#
# Builds the LabTrax Desktop Electron app and publishes the resulting
# installer (and latest.yml auto-update manifest) to App Storage so the API
# server can serve it:
#
#   Preferred (NSIS installer — built by CI on windows-latest or locally on Windows):
#     GET /downloads/LabTrax-Setup.exe
#     GET /downloads/latest.yml          ← references LabTrax-Setup.exe
#
#   Fallback (portable ZIP — produced by this script on Linux/Replit):
#     GET /downloads/LabTrax-Windows-Portable.zip
#     GET /downloads/latest.yml          ← references LabTrax-Windows-Portable.zip
#
# Called automatically from post-merge.sh when a merge touches desktop-relevant
# files. Can also be run manually at any time:
#
#   bash scripts/desktop-build-publish.sh
#
# Required (auto-set by Replit):
#   REPLIT_DEV_DOMAIN or VITE_API_BASE_URL  — baked into the renderer bundle
#   DEFAULT_OBJECT_STORAGE_BUCKET_ID        — App Storage target
#   PRIVATE_OBJECT_DIR                      — App Storage path prefix
#
# Optional:
#   PUBLISH_API_BASE_URL      — production base URL; used as the electron-updater
#                               feed base (preferred over VITE_API_BASE_URL for
#                               UPDATE_FEED_URL so live installs point at prod)
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

echo ""
echo "========================================="
echo " LabTrax Desktop — Build + Publish"
echo "========================================="

# Resolve VITE_API_BASE_URL -----------------------------------------------
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

# Set UPDATE_FEED_URL so electron-builder bakes app-update.yml into the
# packaged app pointing at our /downloads directory. electron-updater reads
# this file at runtime to know where to fetch latest.yml. Use the production
# base URL when available (so shipped installs check the live server), and
# fall back to the dev domain.
BASE_URL="${PUBLISH_API_BASE_URL:-${VITE_API_BASE_URL}}"
export UPDATE_FEED_URL="${BASE_URL%/}/downloads"
echo "[build] UPDATE_FEED_URL=${UPDATE_FEED_URL} (baked into app-update.yml)"

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

# Generate latest.yml for electron-updater generic provider -------------------
# electron-updater fetches GET /downloads/latest.yml to compare the available
# version against the running version. We generate it from the installer's
# SHA-512 digest (base64) and byte size so the hash matches exactly.
#
# If electron-builder already wrote latest.yml (Windows or Linux + Wine), we
# keep that file — it contains the correct blockmap reference for NSIS delta
# patches. We only generate a synthetic latest.yml for the portable ZIP path
# (Linux without Wine), where electron-builder skips it.
#
# NOTE: latest.yml is generated AFTER signature verification. If verification
# failed, set -euo pipefail has already stopped the script — a failed build
# never produces a manifest that could reach the auto-update feed.
if [[ ! -f "$LATEST_YML" ]]; then
  echo ""
  echo "[publish] Generating latest.yml auto-update manifest …"
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
  echo ""
  echo "[publish] Using existing latest.yml from electron-builder (${LATEST_YML})."
fi

# Upload installer + latest.yml to App Storage --------------------------------
# NOTE: upload runs AFTER signature verification. If verification failed,
# set -euo pipefail has already stopped the script — no artifact is uploaded.
echo ""
echo "[publish] Uploading installer and latest.yml to App Storage …"
cd "$ROOT_DIR"
pnpm --filter @workspace/scripts run upload-desktop-installer -- "$INSTALLER_PATH"
echo "[publish] ✓ Upload complete."

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
else
  echo " Download (portable ZIP):   /downloads/LabTrax-Windows-Portable.zip"
fi
echo " Auto-update feed: ${UPDATE_FEED_URL}/latest.yml"
echo "========================================="
echo ""
