#!/usr/bin/env bash
set -euo pipefail

# Only the disposable workspace cache is best-effort. Production dependencies,
# runtime binaries and their validation remain strict in the caller.
if [[ "$#" -ne 1 || -z "$1" || ! -d "$1" ]]; then
  echo "cleanup-build-cache: expected an existing workspace directory." >&2
  exit 64
fi
ROOT_DIR="$(cd -- "$1" && pwd -P)"
if [[ "$ROOT_DIR" == "/" ]]; then
  echo "cleanup-build-cache: refusing filesystem root." >&2
  exit 64
fi
CACHE_DIR="$ROOT_DIR/.cache"

for attempt in 1 2 3; do
  if [[ ! -e "$CACHE_DIR" && ! -L "$CACHE_DIR" ]]; then
    exit 0
  fi
  # A background writer can recreate entries while rm traverses the cache.
  # Also check absence: a successful rm can be followed by immediate recreation.
  if rm -rf -- "$CACHE_DIR" && [[ ! -e "$CACHE_DIR" && ! -L "$CACHE_DIR" ]]; then
    exit 0
  fi
  if [[ "$attempt" -lt 3 ]]; then
    echo "Build cache cleanup incomplete (attempt $attempt/3); retrying." >&2
    sleep 1
  fi
done

echo "WARNING: Disposable build cache remains after 3 cleanup attempts; continuing production packaging." >&2
exit 0
