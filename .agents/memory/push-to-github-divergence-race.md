---
name: push-to-github divergence race
description: How to safely resume push-to-github when histories diverge due to a CI build-counter commit landing mid-push.
---

## The pattern

GitHub Actions workflows (e.g. `build-macos.yml`) push a build-counter commit to main immediately after a push triggers them. If `push-to-github` is doing a **force-push from the very beginning of history** (because the remote tip isn't found locally), the chunked push races against CI: CI inserts a new commit while chunks are still in flight, which makes the remote tip diverge again for the next run.

## Why force-push starts from scratch

`computeMissingCommits` walks backwards from local HEAD and stops when it sees the remote tip. If the remote tip is a CI commit not in the local ODB, it is never found, so **all 2953 commits are considered "missing"** and the script pushes from the oldest chunk first. This takes many minutes, during which CI can insert another commit.

## Safe recovery procedure

1. **Let the zombie finish first** — if a previous push process returned exit -1, wait 60s and poll `gh api repos/.../git/refs/heads/main --jq '.object.sha'` until the tip stops changing.
2. **Use 45s time budget + chunk_size=25** — exits cleanly before OOM, advances ~150–175 commits per run (6–7 chunks). Two back-to-back runs per bash call (total ~92s) stay under the 120s bash timeout.
3. **Chain pairs until done**: `GH_TOKEN=... GITHUB_BACKUP_CHUNK_SIZE=25 GITHUB_BACKUP_TIME_BUDGET_MS=45000 pnpm --filter @workspace/scripts run push-to-github ... && GH_TOKEN=... GITHUB_BACKUP_CHUNK_SIZE=25 ...` — repeat until the script reports "Remote already up to date" or "done" with remote tip = local HEAD.
4. **Avoid budget >50s** — causes exit -1 (OOM) with a zombie that continues pushing asynchronously, creating lock conflicts with new attempts.

**Why:**  Past incident: zombie force-push from oldest history took 30+ minutes, triggered multiple CI counter commits, and created repeated divergence loops requiring 14+ sequential bash calls to resolve.
