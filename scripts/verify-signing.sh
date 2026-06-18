#!/bin/bash
set -euo pipefail
# Verify Authenticode signatures on LabTrax desktop artifacts.
#
# Called by desktop-build-publish.sh; also runnable standalone and in tests.
#
# Usage:
#   bash scripts/verify-signing.sh <exe_path> [<installer_path>]
#
#   <exe_path>       Path to win-unpacked/LabTrax.exe  (always verified)
#   <installer_path> Path to LabTrax-Setup.exe  (optional; must be a PE file —
#                    do NOT pass a .zip, which is not Authenticode-signable)
#
# Environment (read-only — do not export from here, caller already has them):
#   CSC_LINK               — triggers signing path; absent → skipped (exit 0)
#   CSC_KEY_PASSWORD       — must accompany CSC_LINK; absent → exit 1
#   CSC_EXPECTED_PUBLISHER — optional CN substring; mismatch → exit 1
#
# Verification tools (tried in order):
#   signtool     — Windows SDK; present on windows-latest GitHub Actions runners.
#   osslsigncode — Linux / macOS; install: apt-get install -y osslsigncode
#                  (or: brew install osslsigncode)
#
# Exit codes:
#   0 — verification skipped (CSC_LINK absent) OR all files verified OK
#   1 — misconfiguration, invalid/expired/revoked signature, publisher
#       mismatch, no verification tool available, or missing file

EXE_PATH="${1:-}"
INSTALLER_PATH="${2:-}"

# ── Gate: CSC_LINK absent → unsigned build path ───────────────────────────────
if [[ -z "${CSC_LINK:-}" ]]; then
  echo "[signing] Signing disabled; verification skipped."
  echo "[signing]   (Set CSC_LINK + CSC_KEY_PASSWORD to enable code-signing.)"
  exit 0
fi

# ── Sanity: CSC_KEY_PASSWORD must accompany CSC_LINK ──────────────────────────
if [[ -z "${CSC_KEY_PASSWORD:-}" ]]; then
  echo "[signing] ERROR: CSC_LINK is set but CSC_KEY_PASSWORD is absent."
  echo "[signing]   Both must be present for electron-builder to sign the binary."
  echo "[signing]   Set CSC_KEY_PASSWORD as a Replit / CI secret and re-run."
  exit 1
fi

echo ""
echo "[signing] ── Authenticode signature verification ──────────────────────"
echo "[signing]   CSC_LINK        : set (${#CSC_LINK} chars)"
echo "[signing]   CSC_KEY_PASSWORD: set"
echo "[signing]   Expected publisher: ${CSC_EXPECTED_PUBLISHER:-"(not set — publisher name check skipped)"}"
echo "[signing] ──────────────────────────────────────────────────────────────"

# ── Select verification tool ──────────────────────────────────────────────────
USE_SIGNTOOL=false
USE_OSSLSIGNCODE=false

if command -v signtool &>/dev/null; then
  USE_SIGNTOOL=true
  echo "[signing] Tool: signtool (Windows SDK)"
elif command -v osslsigncode &>/dev/null; then
  USE_OSSLSIGNCODE=true
  echo "[signing] Tool: osslsigncode (cross-platform PE verifier)"
else
  echo "[signing] ERROR: No signature verification tool found."
  echo "[signing]   CSC_LINK is set so verification is mandatory."
  echo "[signing]   Install one of:"
  echo "[signing]     • signtool     — Windows SDK (auto-present on windows-latest CI)"
  echo "[signing]     • osslsigncode — Linux: apt-get install -y osslsigncode"
  echo "[signing]                       macOS: brew install osslsigncode"
  exit 1
fi

# ── Shared helpers ─────────────────────────────────────────────────────────────

_extract_cn() {
  # Extract the CN= value from a Subject line, e.g.
  # "/C=US/O=Acme Dental/CN=Acme Dental Software LLC" → "Acme Dental Software LLC"
  local subject="$1"
  echo "$subject" | sed -n 's/.*CN=\([^/]*\).*/\1/p' | sed 's/[[:space:]]*$//'
}

_check_publisher() {
  local publisher="$1"
  if [[ -n "${CSC_EXPECTED_PUBLISHER:-}" ]]; then
    if echo "$publisher" | grep -qi "${CSC_EXPECTED_PUBLISHER}"; then
      echo "[signing]   ✓ Publisher matches CSC_EXPECTED_PUBLISHER (\"${CSC_EXPECTED_PUBLISHER}\")."
    else
      echo "[signing]   ✗ Publisher mismatch!"
      echo "[signing]       Expected (CSC_EXPECTED_PUBLISHER): \"${CSC_EXPECTED_PUBLISHER}\""
      echo "[signing]       Actual publisher                 : \"${publisher}\""
      echo "[signing]     A build signed with the wrong certificate must never be published."
      echo "[signing]     Check that CSC_LINK contains the correct certificate."
      return 1
    fi
  else
    echo "[signing]   CSC_EXPECTED_PUBLISHER not set — publisher name check skipped."
    echo "[signing]   (Set it to the certificate CN to guard against wrong-cert builds.)"
  fi
  return 0
}

# ── signtool verifier ──────────────────────────────────────────────────────────

_verify_with_signtool() {
  local label="$1"
  local file="$2"

  echo ""
  echo "[signing] ── $label ──"
  echo "[signing]   Path: $file"

  local out
  local exit_code=0
  out=$(signtool verify /pa /v "$file" 2>&1) || exit_code=$?

  # Always emit the structured details before checking exit code.
  local subject issued_to timestamp_by signing_time
  issued_to=$(echo "$out" | grep "Issued to:" | head -1 | sed 's/.*Issued to: *//')
  timestamp_by=$(echo "$out" | grep -A3 "Timestamp Verified by:" | grep "Issued to:" | head -1 | sed 's/.*Issued to: *//')
  signing_time=$(echo "$out" | grep "The signature is timestamped:" | sed 's/.*The signature is timestamped: *//')

  echo "[signing]   Certificate subject  : ${issued_to:-"(not found in output)"}"
  echo "[signing]   Publisher (CN)       : ${issued_to:-"(unknown)"}"
  echo "[signing]   Timestamp authority  : ${timestamp_by:-"(not found in output)"}"
  echo "[signing]   Signing time         : ${signing_time:-"(not found in output)"}"

  if [[ $exit_code -ne 0 ]]; then
    echo "[signing]   Signature status     : ✗ FAILED (exit ${exit_code})"
    echo ""
    echo "[signing] Full signtool output:"
    echo "$out" | sed 's/^/[signing]   /'
    echo ""
    # Annotate known failure modes.
    if echo "$out" | grep -qi "not within its validity period\|expired\|revoked"; then
      echo "[signing] DIAGNOSIS: Certificate is expired, revoked, or not yet valid."
    elif echo "$out" | grep -qi "not trusted\|chain was issued by an authority"; then
      echo "[signing] DIAGNOSIS: Certificate chain is not trusted on this machine."
    elif echo "$out" | grep -qi "no signature"; then
      echo "[signing] DIAGNOSIS: No Authenticode signature found. electron-builder may have"
      echo "[signing]   failed to sign (check CSC_LINK encoding and electron-builder logs)."
    fi
    echo "[signing] Aborting publish — do not upload an unverified artifact."
    return 1
  fi

  echo "[signing]   Signature status     : ✓ VALID (Authenticode chain trusted)"

  # Publisher check.
  _check_publisher "$issued_to" || return 1

  return 0
}

# ── osslsigncode verifier ─────────────────────────────────────────────────────

_verify_with_osslsigncode() {
  local label="$1"
  local file="$2"

  echo ""
  echo "[signing] ── $label ──"
  echo "[signing]   Path: $file"

  local out
  local exit_code=0
  out=$(osslsigncode verify -verbose "$file" 2>&1) || exit_code=$?

  # Parse structured fields regardless of outcome (for diagnostics).
  local subject cn tsa_subject signing_time
  subject=$(echo "$out" | grep -i "Subject:" | head -1 | sed 's/.*Subject: *//')
  cn=$(_extract_cn "$subject")
  tsa_subject=$(echo "$out" | awk '/TSA|Timestamp/,/^$/' | grep -i "Subject:" | head -1 | sed 's/.*Subject: *//')
  signing_time=$(echo "$out" | grep -i "Signing time\|timestamp" | grep -iv "TSA\|Subject" | head -1 | sed 's/.*: *//')

  echo "[signing]   Certificate subject  : ${subject:-"(not found in output)"}"
  echo "[signing]   Publisher (CN)       : ${cn:-"(unknown)"}"
  echo "[signing]   Timestamp authority  : ${tsa_subject:-"(not found in output)"}"
  echo "[signing]   Signing time         : ${signing_time:-"(not found in output)"}"

  if [[ $exit_code -ne 0 ]] || ! echo "$out" | grep -q "Signature verification: ok"; then
    echo "[signing]   Signature status     : ✗ FAILED"
    echo ""
    echo "[signing] Full osslsigncode output:"
    echo "$out" | sed 's/^/[signing]   /'
    echo ""
    if echo "$out" | grep -qi "expired\|not yet valid\|validity period\|revoked"; then
      echo "[signing] DIAGNOSIS: Certificate is expired, revoked, or not yet valid."
    elif echo "$out" | grep -qi "no signature\|not signed"; then
      echo "[signing] DIAGNOSIS: No Authenticode signature found. electron-builder may have"
      echo "[signing]   failed to sign (check CSC_LINK encoding and electron-builder logs)."
    elif echo "$out" | grep -qi "chain\|trust\|ca"; then
      echo "[signing] DIAGNOSIS: Certificate chain could not be validated."
    fi
    echo "[signing] Aborting publish — do not upload an unverified artifact."
    return 1
  fi

  echo "[signing]   Signature status     : ✓ VALID (Authenticode signature OK)"

  # Publisher check.
  _check_publisher "$cn" || return 1

  return 0
}

# ── Dispatch to the available tool ────────────────────────────────────────────

verify_file() {
  local label="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    echo "[signing] ERROR: $label not found at expected path."
    echo "[signing]   Path: $file"
    echo "[signing]   Ensure electron-builder completed successfully before this step."
    exit 1
  fi

  if $USE_SIGNTOOL; then
    _verify_with_signtool "$label" "$file" || exit 1
  else
    _verify_with_osslsigncode "$label" "$file" || exit 1
  fi
}

# ── Verify EXE (always required) ──────────────────────────────────────────────

if [[ -z "$EXE_PATH" ]]; then
  echo "[signing] ERROR: No EXE path supplied. Usage: verify-signing.sh <exe> [<installer>]"
  exit 1
fi

verify_file "LabTrax.exe (win-unpacked)" "$EXE_PATH"

# ── Verify installer if provided ──────────────────────────────────────────────

if [[ -n "$INSTALLER_PATH" ]]; then
  INSTALLER_EXT="${INSTALLER_PATH##*.}"
  if [[ "${INSTALLER_EXT,,}" == "exe" ]]; then
    verify_file "Installer package (LabTrax-Setup.exe)" "$INSTALLER_PATH"
  else
    echo ""
    echo "[signing] Installer is a .${INSTALLER_EXT} — not an Authenticode-signable PE file."
    echo "[signing]   ZIP/DMG packages are containers, not PE executables; Authenticode"
    echo "[signing]   applies to the EXE inside them. EXE verification above is sufficient."
  fi
fi

# ── All checks passed ─────────────────────────────────────────────────────────
echo ""
echo "[signing] ✓ All signature checks passed — safe to publish."
