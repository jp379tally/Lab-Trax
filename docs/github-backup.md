# GitHub Backup (Auto-Mirror)

The full project is mirrored to **github.com/jp379tally/Lab-Trax**. Because the managed Replit environment hard-blocks the `git` CLI's destructive ops (push/reset), the mirror is kept current with a pure-JS pusher built on **isomorphic-git** that speaks git smart-HTTP directly over HTTPS — it never shells out to `git`.

- **Script:** `scripts/src/push-to-github.ts` → `pnpm --filter @workspace/scripts run push-to-github`
- **What it does:** reads the remote `main` tip, computes only the commits the remote is missing, and pushes them in small chunks (default 25). Each chunk is fast-forward only (`force:false`) — it refuses to push if histories have diverged. It is **idempotent and resumable**: a crash/timeout just resumes from the new remote tip on the next run, and a run with nothing new pushes nothing.
- **Auth:** reads the `GITHUB_PUSH_TOKEN` secret (GitHub PAT). The token is never logged.
- **Scheduling:** run it as a **Replit Scheduled Deployment** on a nightly cadence (build command `pnpm install`, run command `pnpm --filter @workspace/scripts run push-to-github`). Configure/publish the scheduled deployment from the main version of the project (a task agent cannot publish).
- **Manual trigger:** run the `push-to-github` command above any time to sync immediately.
- **Env overrides (all optional):** `GITHUB_BACKUP_REPO_URL` (default the Lab-Trax repo), `GITHUB_BACKUP_BRANCH` (default `main`), `GITHUB_BACKUP_CHUNK_SIZE` (default `25` — keep small for binary-heavy history), `GITHUB_BACKUP_TIME_BUDGET_MS` (soft budget; stop starting new chunks after it elapses and exit cleanly to resume next run).
- Background: `.agents/memory/main-agent-git-push-block.md`.
