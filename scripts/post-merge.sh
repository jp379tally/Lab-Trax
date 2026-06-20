#!/bin/bash
set -euo pipefail

# Post-merge reconciliation.
#
# Runs automatically after a task is merged to bring the workspace into a
# runnable state. Keep this FAST, idempotent, and NON-INTERACTIVE — stdin is
# closed (/dev/null), so any command that prompts will get EOF and fail.
#
# NOTE: Desktop installer builds/publishes are intentionally NOT performed here.
# That pipeline needs Wine (for the NSIS installer) and a running, reachable
# server (for the post-publish download check), neither of which exists in the
# merge sandbox. Desktop releases are handled by GitHub Actions
# (auto-tag-desktop-release.yml -> release.yml). Doing it here only produced a
# guaranteed failure (Wine missing + HTTP 502 on the reachability probe).

# 1. Install dependencies for every workspace package, exactly per the lockfile.
pnpm install --frozen-lockfile

# 2. Apply any Drizzle schema changes brought in by the merge (non-interactive).
pnpm --filter @workspace/db run push-force
