#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_STAGE="$ROOT_DIR/.production-api"
RUNTIME_STAGE="$ROOT_DIR/.production-runtime"
PNPM_STORE="$(pnpm store path)"

rm -rf "$API_STAGE" "$RUNTIME_STAGE"
pnpm --filter @workspace/api-server deploy "$API_STAGE" --prod --legacy

rm -rf "$API_STAGE/src" "$API_STAGE/test-plans"
cp -a "$ROOT_DIR/artifacts/api-server/dist" "$API_STAGE/dist"

test -f "$API_STAGE/dist/index.mjs"
test -d "$API_STAGE/node_modules"

# Every complete recovery set records the source revision that created it.
# Embed this in the packaged API because the published runtime does not include
# the workspace's .git directory.
SOURCE_REVISION="${GIT_COMMIT_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
if [[ ! "$SOURCE_REVISION" =~ ^[a-fA-F0-9]{40}$ ]] ||
   [[ "${SOURCE_REVISION,,}" != "$(git rev-parse HEAD)" ]]; then
  echo "prepare-production-image: the exact full checked-out source revision is required for recovery provenance." >&2
  exit 1
fi
SOURCE_REVISION="${SOURCE_REVISION,,}"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ sourceRevision: process.argv[2] }) + "\n")' \
  "$API_STAGE/dist/build-identity.json" "$SOURCE_REVISION"
echo "prepare-production-image: source revision ${SOURCE_REVISION}"

# Artifact processes start with a minimal PATH that does not include the Nix
# toolchain, and absolute symlinks into /nix/store are not retained in the
# published image. Package the real Node executable with its ELF loader and
# direct shared-library dependencies, then expose a /bin/sh launcher at the
# stable project-relative path used by both artifact manifests.
REAL_NODE="$(node -p 'process.execPath')"
mapfile -t NODE_LIBRARIES < <(
  ldd "$REAL_NODE" |
    awk '$2 == "=>" && $3 ~ /^\// { print $3 }' |
    sort -u
)
NODE_LOADER="$(patchelf --print-interpreter "$REAL_NODE")"
NODE_SYSTEM_LIB_DIR="$(dirname "$NODE_LOADER")"

# Production dependencies can include native Node add-ons whose transitive
# libraries are not dependencies of Node itself. Collect those now while the
# complete build environment is still available. Prefer matching libraries
# from Node's glibc directory below so the packaged loader and libc family stay
# on the same version.
mapfile -t NATIVE_LIBRARIES < <(
  find "$API_STAGE/node_modules" -type f \
    \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) -print0 |
    while IFS= read -r -d '' native_file; do
      ldd "$native_file" 2>/dev/null || true
    done |
    awk '$2 == "=>" && $3 ~ /^\// { print $3 }' |
    sort -u
)

test -x "$REAL_NODE"
test -x "$NODE_LOADER"
test "${#NODE_LIBRARIES[@]}" -gt 0

mkdir -p "$RUNTIME_STAGE/bin" "$RUNTIME_STAGE/lib"
cp -L "$REAL_NODE" "$RUNTIME_STAGE/bin/node.bin"
cp -L "$NODE_LOADER" "$RUNTIME_STAGE/lib/ld-linux.so"
for library in "${NODE_LIBRARIES[@]}"; do
  cp -L "$library" "$RUNTIME_STAGE/lib/$(basename "$library")"
done
for library in "${NATIVE_LIBRARIES[@]}"; do
  case "$library" in
    "$API_STAGE"/*)
      # Package-owned shared objects remain beside their native add-on.
      continue
      ;;
  esac

  library_name="$(basename "$library")"
  if [[ -e "$RUNTIME_STAGE/lib/$library_name" ]]; then
    continue
  fi

  if [[ -e "$NODE_SYSTEM_LIB_DIR/$library_name" ]]; then
    cp -L "$NODE_SYSTEM_LIB_DIR/$library_name" \
      "$RUNTIME_STAGE/lib/$library_name"
  else
    cp -L "$library" "$RUNTIME_STAGE/lib/$library_name"
  fi
done

cat >"$RUNTIME_STAGE/bin/node" <<'EOF'
#!/bin/sh
set -eu

# The build shell can inject a Nix compatibility audit module and library path.
# They must not override the self-contained runtime's matching loader and libs.
unset LD_AUDIT LD_LIBRARY_PATH

script_dir="${0%/*}"
if [ "$script_dir" = "$0" ]; then
  script_dir="."
fi
runtime_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"

exec "$runtime_dir/lib/ld-linux.so" \
  --library-path "$runtime_dir/lib" \
  "$runtime_dir/bin/node.bin" \
  "$@"
EOF
chmod 0755 "$RUNTIME_STAGE/bin/node" "$RUNTIME_STAGE/bin/node.bin" \
  "$RUNTIME_STAGE/lib/ld-linux.so"

test -x "$RUNTIME_STAGE/bin/node"
"$RUNTIME_STAGE/bin/node" --version

# Scheduled backups shell out to pg_dump and restores shell out to pg_restore.
# Without these packaged alongside Node, the published server fails every
# backup with "spawn pg_dump ENOENT" while the dev workspace (which has the
# Nix toolchain on PATH) keeps working. They are staged in their own directory
# because PostgreSQL is linked against a different glibc than Node, and mixing
# the two loaders and libc families in one directory breaks both.
PG_STAGE="$RUNTIME_STAGE/pgsql"
mkdir -p "$PG_STAGE/bin" "$PG_STAGE/lib"
PG_LOADER=""

for pg_tool in pg_dump pg_restore; do
  pg_tool_path="$(command -v "$pg_tool" || true)"
  if [[ -z "$pg_tool_path" ]]; then
    echo "prepare-production-image: $pg_tool was not found on PATH — the published server could not take or restore a backup." >&2
    exit 1
  fi
  pg_real="$(readlink -f "$pg_tool_path")"
  test -x "$pg_real"

  pg_tool_loader="$(patchelf --print-interpreter "$pg_real")"
  test -x "$pg_tool_loader"
  if [[ -z "$PG_LOADER" ]]; then
    PG_LOADER="$pg_tool_loader"
    cp -L "$PG_LOADER" "$PG_STAGE/lib/ld-linux.so"
    chmod 0755 "$PG_STAGE/lib/ld-linux.so"
  elif [[ "$pg_tool_loader" != "$PG_LOADER" ]]; then
    echo "prepare-production-image: $pg_tool expects a different ELF loader ($pg_tool_loader) than $PG_LOADER." >&2
    exit 1
  fi

  mapfile -t PG_LIBRARIES < <(
    ldd "$pg_real" |
      awk '$2 == "=>" && $3 ~ /^\// { print $3 }' |
      sort -u
  )
  test "${#PG_LIBRARIES[@]}" -gt 0
  for library in "${PG_LIBRARIES[@]}"; do
    library_name="$(basename "$library")"
    if [[ -e "$PG_STAGE/lib/$library_name" ]]; then
      continue
    fi
    cp -L "$library" "$PG_STAGE/lib/$library_name"
  done

  cp -L "$pg_real" "$PG_STAGE/bin/$pg_tool.bin"
  chmod 0755 "$PG_STAGE/bin/$pg_tool.bin"

  # One launcher body serves both tools: it derives which binary to exec from
  # the name it was invoked as, so the two stay in lockstep.
  cat >"$RUNTIME_STAGE/bin/$pg_tool" <<'EOF'
#!/bin/sh
set -eu

# The build shell can inject a Nix compatibility audit module and library path.
# They must not override the self-contained runtime's matching loader and libs.
unset LD_AUDIT LD_LIBRARY_PATH

script_dir="${0%/*}"
if [ "$script_dir" = "$0" ]; then
  script_dir="."
fi
runtime_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
tool_name="${0##*/}"

exec "$runtime_dir/pgsql/lib/ld-linux.so" \
  --library-path "$runtime_dir/pgsql/lib" \
  "$runtime_dir/pgsql/bin/$tool_name.bin" \
  "$@"
EOF
  chmod 0755 "$RUNTIME_STAGE/bin/$pg_tool"
done

# Prove the packaged binaries actually run with the published process's minimal
# environment, not with the build shell's Nix PATH and library variables. A
# missing transitive library must fail the image build, not the first backup.
for pg_tool in pg_dump pg_restore; do
  test -x "$RUNTIME_STAGE/bin/$pg_tool"
  env -i PATH=/usr/bin:/bin HOME="$HOME" \
    "$RUNTIME_STAGE/bin/$pg_tool" --version
done

# Prescription vision uses page images, not the unsupported Files API. Retain
# Poppler with its own loader/library family just like the PostgreSQL tools.
bash "$ROOT_DIR/scripts/stage-pdf-runtime.sh" "$RUNTIME_STAGE"

# Exercise native add-on loading, not just the Node executable. Sharp is loaded
# by the API during startup and previously exposed a missing transitive
# libresolv dependency only after the published VM started.
"$RUNTIME_STAGE/bin/node" \
  -e 'import(process.argv[1])' \
  "$API_STAGE/node_modules/sharp/dist/index.mjs"

if [[ "${PREPARE_IMAGE_DRY_RUN:-0}" == "1" ]]; then
  echo "Production image dry run prepared:"
  du -sh "$API_STAGE" \
    "$RUNTIME_STAGE" \
    "$ROOT_DIR/artifacts/api-server/dist" \
    "$ROOT_DIR/artifacts/labtrax/static-build" \
    "$ROOT_DIR/artifacts/labtrax-desktop/dist/public"
  exit 0
fi

# The API is the only production service that needs third-party Node packages.
# Both runnable services use the retained Node entry point above; the desktop
# artifact is served statically. Keep the API's isolated production dependency
# tree and remove the build-only monorepo installation before Replit snapshots
# the image.
find "$ROOT_DIR" \
  -path "$API_STAGE" -prune -o \
  -type d -name node_modules -prune -exec rm -rf {} +

# pnpm's content-addressable store is needed to assemble API_STAGE, but not by
# the running services. Removing it saves several gigabytes from the image.
rm -rf "$PNPM_STORE"
# Cache writers can race deletion. A disposable cache must not invalidate
# already verified production artifacts; every other preparation error is fatal.
bash "$ROOT_DIR/scripts/cleanup-build-cache.sh" "$ROOT_DIR"

echo "Production image prepared:"
du -sh "$API_STAGE" \
  "$RUNTIME_STAGE" \
  "$ROOT_DIR/artifacts/api-server/dist" \
  "$ROOT_DIR/artifacts/labtrax/static-build" \
  "$ROOT_DIR/artifacts/labtrax-desktop/dist/public"