#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH_BASE="$REPO_ROOT/generated-artifacts"
OWNER_MARKER=".labtrax-test-scratch-owner"
OWNER_VALUE="labtrax-workspace-test-scratch-v1"

fail() {
  echo "[test-scratch] $*" >&2
  exit 1
}

new_scratch_root() {
  local require_restore_socket_short_path="${1:-1}"
  [[ ! -L "$SCRATCH_BASE" ]] || fail "generated-artifacts must not be a symlink."
  mkdir -m 700 -p -- "$SCRATCH_BASE"
  local root
  root="$(mktemp -d "$SCRATCH_BASE/t.XXX")" ||
    fail "Could not create workspace scratch under generated-artifacts."
  chmod 700 "$root"
  printf '%s\n' "$OWNER_VALUE" >"$root/$OWNER_MARKER"
  chmod 600 "$root/$OWNER_MARKER"
  mkdir -m 700 "$root/cache"

  local relative="${root#"$REPO_ROOT"/}"
  [[ "$relative" == generated-artifacts/t.* && "$relative" != *"/."* ]] ||
    fail "Scratch path is not a non-hidden workspace path."

  local probe
  probe="$(mktemp "$root/probe.XXXX")" ||
    fail "Workspace scratch is not writable."
  printf '#!/bin/sh\nexit 0\n' >"$probe"
  chmod 700 "$probe"
  "$probe" || fail "Workspace scratch is not executable."
  rm -f -- "$probe"

  if [[ "$require_restore_socket_short_path" == "1" && "${GITHUB_ACTIONS:-}" != "true" ]]; then
    local socket_path="$root/labtrax-restore-gate.XXXXXXXX/socket/.s.PGSQL.65535.lock"
    (( ${#socket_path} <= 107 )) ||
      fail "Workspace path is too long for the isolated restore harness PostgreSQL socket."
  fi

  printf '%s' "$root"
}

cleanup_owned_root() {
  local root="${1:-}"
  [[ -n "$root" ]] || return 0
  case "$root" in
    "$SCRATCH_BASE"/t.*) ;;
    *) fail "Refusing to clean a path outside this task's workspace scratch." ;;
  esac
  [[ ! -L "$root" && -f "$root/$OWNER_MARKER" ]] ||
    fail "Refusing to clean unowned or linked scratch."
  [[ "$(<"$root/$OWNER_MARKER")" == "$OWNER_VALUE" ]] ||
    fail "Refusing to clean scratch with an unknown owner marker."

  local pgdata="$root/labtrax-api-test-postgres/data"
  if [[ -f "$pgdata/postmaster.pid" ]] && command -v pg_ctl >/dev/null 2>&1; then
    pg_ctl -D "$pgdata" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$root"
}

write_github_environment() {
  local root="$1"
  : "${GITHUB_ENV:?GITHUB_ENV is required for --prepare-github}"
  printf 'LABTRAX_TEST_SCRATCH_ROOT=%s\nTMPDIR=%s\nTMP=%s\nTEMP=%s\nXDG_CACHE_HOME=%s\n' \
    "$root" "$root" "$root" "$root" "$root/cache" >>"$GITHUB_ENV"
}

usage() {
  cat >&2 <<'EOF'
Usage:
  bash scripts/with-workspace-test-scratch.sh -- COMMAND [ARG ...]
  bash scripts/with-workspace-test-scratch.sh --bash-command 'shell command'
  bash scripts/with-workspace-test-scratch.sh --prepare-github
  bash scripts/with-workspace-test-scratch.sh --cleanup-github

The command form supplies isolated TMPDIR/TMP/TEMP and XDG_CACHE_HOME settings.
Use it for API tests, scripts tests, or scripts/run-isolated-backup-restore.sh.
EOF
  exit 64
}

mode="${1:-}"
case "$mode" in
  --prepare-github)
    root="$(new_scratch_root 0)"
    if ! write_github_environment "$root"; then
      cleanup_owned_root "$root"
      exit 1
    fi
    echo "[test-scratch] Prepared private workspace scratch for this CI job."
    ;;
  --cleanup-github)
    if [[ -z "${LABTRAX_TEST_SCRATCH_ROOT:-}" ]]; then
      echo "[test-scratch] No workspace scratch was prepared; nothing to clean."
      exit 0
    fi
    cleanup_owned_root "$LABTRAX_TEST_SCRATCH_ROOT"
    ;;
  --bash-command)
    [[ $# -eq 2 && -n "$2" ]] || usage
    root="$(new_scratch_root)"
    export LABTRAX_TEST_SCRATCH_ROOT="$root"
    export TMPDIR="$root" TMP="$root" TEMP="$root"
    export XDG_CACHE_HOME="$root/cache"
    export RUNNER_TEMP="$root"
    if [[ -z "${GITHUB_ENV:-}" ]]; then
      export GITHUB_ENV="$root/github-env"
      : >"$GITHUB_ENV"
    fi
    if [[ -z "${GITHUB_PATH:-}" ]]; then
      export GITHUB_PATH="$root/github-path"
      : >"$GITHUB_PATH"
    fi
    trap 'status=$?; trap - EXIT; cleanup_owned_root "$root"; exit "$status"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    bash -e -lc "$2"
    ;;
  --)
    shift
    [[ $# -gt 0 ]] || usage
    root="$(new_scratch_root)"
    export LABTRAX_TEST_SCRATCH_ROOT="$root"
    export TMPDIR="$root" TMP="$root" TEMP="$root"
    export XDG_CACHE_HOME="$root/cache"
    export RUNNER_TEMP="$root"
    if [[ -z "${GITHUB_ENV:-}" ]]; then
      export GITHUB_ENV="$root/github-env"
      : >"$GITHUB_ENV"
    fi
    if [[ -z "${GITHUB_PATH:-}" ]]; then
      export GITHUB_PATH="$root/github-path"
      : >"$GITHUB_PATH"
    fi
    trap 'status=$?; trap - EXIT; cleanup_owned_root "$root"; exit "$status"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "$@"
    ;;
  *)
    usage
    exit 64
    ;;
esac
