#!/bin/bash
set -uo pipefail
# Automated test suite for scripts/verify-signing.sh
#
# Tests all five required scenarios using a mock osslsigncode injected via PATH.
# Designed to run on Linux / Replit without real certificates or Windows tools.
#
# Usage:
#   bash scripts/test-signing-verification.sh
#
# Exit code:
#   0 — all tests passed
#   1 — one or more tests failed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-signing.sh"

if [[ ! -f "$VERIFY_SCRIPT" ]]; then
  echo "ERROR: verify-signing.sh not found at $VERIFY_SCRIPT"
  exit 1
fi

# ── Test infrastructure ───────────────────────────────────────────────────────

PASS=0
FAIL=0
ERRORS=()

# Temp dir — cleaned up on exit
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Dummy binary file (content irrelevant; mock ignores it)
DUMMY_EXE="$TMPDIR_TEST/LabTrax.exe"
DUMMY_INSTALLER="$TMPDIR_TEST/LabTrax-Setup.exe"
touch "$DUMMY_EXE" "$DUMMY_INSTALLER"

# Mock bin directory — prepended to PATH for all tests
MOCK_BIN="$TMPDIR_TEST/bin"
mkdir -p "$MOCK_BIN"

# Control file: mock osslsigncode reads this to decide what to output/return
MOCK_CONTROL="$TMPDIR_TEST/mock_control"

# Write the single configurable mock osslsigncode script
cat > "$MOCK_BIN/osslsigncode" <<'MOCK_EOF'
#!/bin/bash
# Configurable mock for osslsigncode used by test-signing-verification.sh
CONTROL="${TMPDIR_TEST}/mock_control"
if [[ -f "$CONTROL" ]]; then
  source "$CONTROL"
fi
echo "${MOCK_OUTPUT:-Signature verification: ok}"
exit "${MOCK_EXIT:-0}"
MOCK_EOF
chmod +x "$MOCK_BIN/osslsigncode"

# signtool is not installed on Linux/Replit, so no stub is needed.
# Prepending $MOCK_BIN gives us a real osslsigncode mock while leaving
# signtool absent, so verify-signing.sh always takes the osslsigncode path.
export PATH="$MOCK_BIN:$PATH"
export TMPDIR_TEST  # needed by the mock script

run_test() {
  local name="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  shift 3
  # remaining args are passed to verify-signing.sh as env + args
  local -a cmd=("$@")

  local actual_output actual_exit=0
  actual_output=$(env "${cmd[@]}" bash "$VERIFY_SCRIPT" "$DUMMY_EXE" 2>&1) || actual_exit=$?

  local ok=true

  if [[ $actual_exit -ne $expected_exit ]]; then
    ok=false
    ERRORS+=("  Expected exit $expected_exit, got $actual_exit")
  fi

  if [[ -n "$expected_pattern" ]]; then
    if ! echo "$actual_output" | grep -qi "$expected_pattern"; then
      ok=false
      ERRORS+=("  Expected output to contain: \"$expected_pattern\"")
      ERRORS+=("  Actual output: $actual_output")
    fi
  fi

  if $ok; then
    echo "  ✓ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL: $name"
    for err in "${ERRORS[@]}"; do
      echo "$err"
    done
    ERRORS=()
    FAIL=$((FAIL + 1))
  fi
}

run_test_with_installer() {
  local name="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  shift 3
  local -a env_vars=("$@")

  local actual_output actual_exit=0
  actual_output=$(env "${env_vars[@]}" bash "$VERIFY_SCRIPT" "$DUMMY_EXE" "$DUMMY_INSTALLER" 2>&1) || actual_exit=$?

  local ok=true

  if [[ $actual_exit -ne $expected_exit ]]; then
    ok=false
    ERRORS+=("  Expected exit $expected_exit, got $actual_exit")
  fi

  if [[ -n "$expected_pattern" ]]; then
    if ! echo "$actual_output" | grep -qi "$expected_pattern"; then
      ok=false
      ERRORS+=("  Expected output to contain: \"$expected_pattern\"")
      ERRORS+=("  Actual output: $actual_output")
    fi
  fi

  if $ok; then
    echo "  ✓ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL: $name"
    for err in "${ERRORS[@]}"; do
      echo "$err"
    done
    ERRORS=()
    FAIL=$((FAIL + 1))
  fi
}

# ── Test cases ────────────────────────────────────────────────────────────────

echo ""
echo "=================================================="
echo " Desktop Signed Build Verification — Test Suite"
echo "=================================================="
echo ""

# ── Test case 1: CSC_LINK absent ──────────────────────────────────────────────
echo "Test 1: CSC_LINK absent"
echo "  Expectation: build succeeds; log shows 'Signing disabled; verification skipped.'"

# No MOCK_CONTROL needed (mock not reached when CSC_LINK is absent)
run_test \
  "CSC_LINK absent → exit 0 with explicit skip log" \
  0 \
  "Signing disabled; verification skipped" \
  "CSC_LINK=" \
  "CSC_KEY_PASSWORD="

# ── Test case 2: Valid certificate, publisher matches ─────────────────────────
echo ""
echo "Test 2: Valid certificate, publisher matches"
echo "  Expectation: verification succeeds; publisher check passes"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=0
MOCK_OUTPUT="Signature verification: ok
Number of signers: 1
    Signer #0:
        Subject: /C=US/O=Acme Dental Software LLC/CN=Acme Dental Software LLC
        Issuer : /O=DigiCert Inc/CN=DigiCert Trusted Code Signing RSA4096 SHA384 2021 CA1
        Not before: Mon Jan  1 00:00:00 2024 GMT
        Not after : Thu Dec 31 23:59:59 2026 GMT
TSA's Time Stamp Info:
    Signing time: Jun 18 12:00:00 2026 GMT
    Subject: /CN=Sectigo RSA Time Stamping CA"
CTRL

run_test \
  "Valid cert + matching publisher → exit 0" \
  0 \
  "All signature checks passed" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass" \
  "CSC_EXPECTED_PUBLISHER=Acme Dental Software LLC"

run_test \
  "Valid cert + matching publisher → logs cert subject" \
  0 \
  "Acme Dental Software LLC" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass" \
  "CSC_EXPECTED_PUBLISHER=Acme Dental Software LLC"

# ── Test case 3: Invalid certificate (signature bad) ──────────────────────────
echo ""
echo "Test 3: Invalid certificate"
echo "  Expectation: build fails; publish is aborted"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=1
MOCK_OUTPUT="osslsigncode: verification failure
No signature found."
CTRL

run_test \
  "Invalid cert → exit 1" \
  1 \
  "" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass"

run_test \
  "Invalid cert → logs abort message" \
  1 \
  "Aborting publish" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass"

# ── Test case 4: Corrupted certificate payload ────────────────────────────────
echo ""
echo "Test 4: Corrupted certificate payload"
echo "  Expectation: build fails; publish is aborted"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=1
MOCK_OUTPUT="osslsigncode: error parsing signature data
Signature verification: failed"
CTRL

run_test \
  "Corrupted cert payload (tool exit 1) → exit 1" \
  1 \
  "" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass"

run_test \
  "Corrupted cert payload → logs abort message" \
  1 \
  "Aborting publish" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass"

# ── Test case 5: Publisher mismatch ───────────────────────────────────────────
echo ""
echo "Test 5: Publisher mismatch"
echo "  Expectation: build fails; mismatch logged"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=0
MOCK_OUTPUT="Signature verification: ok
Number of signers: 1
    Signer #0:
        Subject: /C=US/O=Wrong Company LLC/CN=Wrong Company LLC
        Issuer : /O=DigiCert Inc/CN=DigiCert Trusted Code Signing RSA4096 SHA384 2021 CA1
        Not before: Mon Jan  1 00:00:00 2024 GMT
        Not after : Thu Dec 31 23:59:59 2026 GMT
TSA's Time Stamp Info:
    Signing time: Jun 18 12:00:00 2026 GMT
    Subject: /CN=Sectigo RSA Time Stamping CA"
CTRL

run_test \
  "Publisher mismatch → exit 1" \
  1 \
  "" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass" \
  "CSC_EXPECTED_PUBLISHER=Acme Dental Software LLC"

run_test \
  "Publisher mismatch → logs mismatch details" \
  1 \
  "Publisher mismatch" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass" \
  "CSC_EXPECTED_PUBLISHER=Acme Dental Software LLC"

# ── Bonus: CSC_LINK set but CSC_KEY_PASSWORD absent ──────────────────────────
echo ""
echo "Bonus: CSC_LINK set but CSC_KEY_PASSWORD absent"
echo "  Expectation: hard failure (misconfiguration)"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=0
MOCK_OUTPUT="Signature verification: ok"
CTRL

run_test \
  "CSC_LINK set, CSC_KEY_PASSWORD absent → exit 1" \
  1 \
  "CSC_KEY_PASSWORD is absent" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD="

# ── Bonus: Installer verified alongside EXE ───────────────────────────────────
echo ""
echo "Bonus: Both EXE and installer (PE) are verified when CSC_LINK is set"
echo "  Expectation: both files verified; combined success logged"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=0
MOCK_OUTPUT="Signature verification: ok
Number of signers: 1
    Signer #0:
        Subject: /C=US/O=Acme Dental Software LLC/CN=Acme Dental Software LLC
        Not after : Thu Dec 31 23:59:59 2026 GMT
TSA's Time Stamp Info:
    Signing time: Jun 18 12:00:00 2026 GMT
    Subject: /CN=Sectigo RSA Time Stamping CA"
CTRL

run_test_with_installer \
  "EXE + installer (.exe) — both verified → exit 0" \
  0 \
  "All signature checks passed" \
  "CSC_LINK=dGVzdA==" \
  "CSC_KEY_PASSWORD=testpass" \
  "CSC_EXPECTED_PUBLISHER=Acme Dental Software LLC"

# ── ZIP installer path: only EXE verified ─────────────────────────────────────
echo ""
echo "Bonus: ZIP installer — only EXE verified (ZIP is not Authenticode-signable)"

cat > "$MOCK_CONTROL" <<'CTRL'
MOCK_EXIT=0
MOCK_OUTPUT="Signature verification: ok
    Signer #0:
        Subject: /CN=Acme Dental Software LLC"
CTRL

DUMMY_ZIP="$TMPDIR_TEST/LabTrax-Windows-Portable.zip"
touch "$DUMMY_ZIP"

actual_output=$(CSC_LINK=dGVzdA== CSC_KEY_PASSWORD=testpass \
  bash "$VERIFY_SCRIPT" "$DUMMY_EXE" "$DUMMY_ZIP" 2>&1)
actual_exit=$?

if [[ $actual_exit -eq 0 ]] && echo "$actual_output" | grep -qi "not an Authenticode-signable PE file"; then
  echo "  ✓ PASS: ZIP installer skips PE verification with explanatory log"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL: ZIP installer — unexpected exit ($actual_exit) or missing log message"
  echo "          Output: $actual_output"
  FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=================================================="
TOTAL=$((PASS + FAIL))
echo " Results: $PASS/$TOTAL passed"
echo "=================================================="
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "FAIL — $FAIL test(s) failed."
  exit 1
else
  echo "PASS — all $TOTAL tests passed."
  exit 0
fi
