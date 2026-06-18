#!/bin/bash
set -e

pnpm install --frozen-lockfile
pnpm --filter db push

# ── Desktop Build + Publish ──────────────────────────────────────────────────
# If the most recent commit touches desktop-relevant source files, rebuild
# and republish the LabTrax Desktop installer so the web and desktop clients
# always ship the same code.
#
# Desktop-relevant paths (any change here triggers a rebuild):
#   artifacts/labtrax-desktop/**   — Electron renderer + main process
#   lib/**                         — Shared TS libraries (db schema, api client)
#   artifacts/api-server/src/**    — API contracts desktop talks to
#
# To skip the desktop rebuild on a specific merge, include
# [skip desktop-release] in the merge commit message.

COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")

if echo "$COMMIT_MSG" | grep -q '\[skip desktop-release\]\|\[skip ci\]'; then
  echo "[post-merge] Desktop rebuild skipped ([skip desktop-release] in commit message)."
else
  # ORIG_HEAD is set by git after a merge and points to the pre-merge HEAD,
  # so diff ORIG_HEAD..HEAD covers ALL commits pulled in by the merge, not
  # just the last one.  Fall back to HEAD~1 when ORIG_HEAD is absent (e.g.
  # the very first commit or a manual script invocation).
  BASE_REF=$(git rev-parse ORIG_HEAD 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo "")
  CHANGED_FILES=$([ -n "$BASE_REF" ] && git diff --name-only "$BASE_REF" HEAD 2>/dev/null || echo "")
  if echo "$CHANGED_FILES" | grep -qE '^(artifacts/labtrax-desktop/|lib/|artifacts/api-server/src/)'; then
    echo "[post-merge] Desktop-relevant files changed — rebuilding desktop app ..."
    bash scripts/desktop-build-publish.sh
  else
    echo "[post-merge] No desktop-relevant files changed — skipping desktop rebuild."
  fi
fi
