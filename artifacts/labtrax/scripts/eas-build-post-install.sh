#!/usr/bin/env bash
set -euo pipefail

if [ "${EAS_BUILD_PLATFORM:-}" != "ios" ]; then
  echo "Skipping iOS depth tests for ${EAS_BUILD_PLATFORM:-unknown} build."
  exit 0
fi

echo "==> Running iOS depth extraction regression tests..."
pnpm run test:ios-depth