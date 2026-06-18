#!/bin/bash
set -euo pipefail
# Desktop Build + Publish Script
#
# Builds the LabTrax Desktop Electron app and publishes the resulting
# LabTrax-Windows-Portable.zip (and latest.yml auto-update manifest) to App
# Storage so the API server can serve them at:
#   GET /downloads/LabTrax-Windows-Portable.zip
#   GET /downloads/latest.yml
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

# Build -----------------------------------------------------------------------
echo ""
echo "[build] Running electron:build …"
cd "$DESKTOP_DIR"
pnpm run electron:build

ZIP_PATH="${DESKTOP_DIR}/electron-dist/LabTrax-Windows-Portable.zip"
if [[ ! -f "$ZIP_PATH" ]]; then
  echo "[build] ERROR: ZIP not found at ${ZIP_PATH} after build."
  exit 1
fi
ZIP_SIZE=$(du -sh "$ZIP_PATH" | cut -f1)
echo "[build] ✓ Build complete — ${ZIP_PATH} (${ZIP_SIZE})"

# Generate latest.yml for electron-updater generic provider -------------------
# electron-updater fetches GET /downloads/latest.yml to compare the available
# version against the running version.  We generate it from the actual ZIP's
# SHA-512 digest (base64) and byte size so the hash matches exactly.
echo ""
echo "[publish] Generating latest.yml auto-update manifest …"
SHA512=$(openssl dgst -sha512 -binary "$ZIP_PATH" | base64 --wrap=0)
BYTE_SIZE=$(stat -c%s "$ZIP_PATH")
RELEASE_DATE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
LATEST_YML="${DESKTOP_DIR}/electron-dist/latest.yml"
cat > "$LATEST_YML" <<EOF
version: ${VERSION}
files:
  - url: LabTrax-Windows-Portable.zip
    sha512: ${SHA512}
    size: ${BYTE_SIZE}
path: LabTrax-Windows-Portable.zip
sha512: ${SHA512}
releaseDate: '${RELEASE_DATE}'
EOF
echo "[publish] ✓ latest.yml generated (sha512=${SHA512:0:16}…, size=${BYTE_SIZE}B)"

# Upload ZIP + latest.yml to App Storage --------------------------------------
echo ""
echo "[publish] Uploading ZIP and latest.yml to App Storage …"
cd "$ROOT_DIR"
pnpm --filter @workspace/scripts run upload-desktop-installer
echo "[publish] ✓ Upload complete."

# Update system_settings version record ---------------------------------------
# The API reads system_settings.desktop_installer_version to display the
# current published version. If PLATFORM_ADMIN_SECRET is set, the upload
# script already called PUT /api/admin/settings/desktop-installer above.
# When it is not set (Replit dev environment), update the DB directly.
if [[ -z "${PLATFORM_ADMIN_SECRET:-}" && -n "${DATABASE_URL:-}" ]]; then
  echo ""
  echo "[publish] Updating system_settings.desktop_installer_version → ${VERSION} (via psql) …"
  psql "$DATABASE_URL" -q -c "
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('desktop_installer_version', '${VERSION}', NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW();
  "
  echo "[publish] ✓ system_settings updated."
fi

echo ""
echo "========================================="
echo " LabTrax Desktop v${VERSION} published."
echo " Download: /downloads/LabTrax-Windows-Portable.zip"
echo " Auto-update feed: ${UPDATE_FEED_URL}/latest.yml"
echo "========================================="
echo ""
