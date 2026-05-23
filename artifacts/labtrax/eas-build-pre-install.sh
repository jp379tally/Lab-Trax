#!/usr/bin/env bash
# Runs on the EAS Build worker before `npm/pnpm install`.
# Bumps app.json's iOS buildNumber + Android versionCode to a unique,
# monotonically-increasing value so every submitted build is higher than
# the previous one — without requiring a commit-back to the repo.
#
# Strategy: minutes-since-epoch (offset to keep number compact).
# Yields a fresh integer that always increases over time.

set -euo pipefail

node -e "
  const fs = require('fs');
  const path = './app.json';
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  // Minutes since 2025-01-01 — compact and always increasing.
  const epoch = Date.UTC(2025, 0, 1);
  const next = Math.floor((Date.now() - epoch) / 60000);
  j.expo.ios = { ...(j.expo.ios || {}), buildNumber: String(next) };
  j.expo.android = { ...(j.expo.android || {}), versionCode: next };
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
  console.log('[pre-install] Bumped buildNumber/versionCode to', next);
"
