/**
 * Auto-backup: push new local commits on the default branch to the GitHub
 * mirror using isomorphic-git (pure JS) instead of the `git` CLI.
 *
 * Why isomorphic-git? The main-agent / managed Replit environment hard-blocks
 * destructive `git` CLI operations (push, reset). isomorphic-git speaks the
 * git smart-HTTP protocol directly over HTTPS, so the block does not apply.
 * See `.agents/memory/main-agent-git-push-block.md` for the full background.
 *
 * The job is idempotent and resumable: it reads the remote tip first, computes
 * only the commits the remote is missing, and pushes them in small chunks
 * (each successful chunk is persisted on the remote, so a crash/timeout just
 * resumes from the new remote tip on the next run).
 *
 * Intended to run as a Replit Scheduled Deployment (e.g. nightly). Can also be
 * triggered manually with `pnpm --filter @workspace/scripts run push-to-github`.
 *
 * Environment variables:
 *   GITHUB_PUSH_TOKEN        (required) GitHub PAT with `repo`/contents write.
 *                            Never logged.
 *   GITHUB_BACKUP_REPO_URL   remote URL (default:
 *                            https://github.com/jp379tally/Lab-Trax.git)
 *   GITHUB_BACKUP_BRANCH     branch to mirror (default: main)
 *   GITHUB_BACKUP_CHUNK_SIZE commits per push (default: 25). Keep small —
 *                            binary-heavy history fails in large packs.
 *   GITHUB_BACKUP_TIME_BUDGET_MS  optional soft time budget in ms; when set,
 *                            stop starting new chunks after it elapses and
 *                            exit 0 so the next scheduled run resumes.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

const TOKEN = process.env.GITHUB_PUSH_TOKEN;
const REMOTE_URL =
  process.env.GITHUB_BACKUP_REPO_URL ||
  "https://github.com/jp379tally/Lab-Trax.git";
const BRANCH = process.env.GITHUB_BACKUP_BRANCH || "main";
const CHUNK_SIZE = Math.max(
  1,
  Number(process.env.GITHUB_BACKUP_CHUNK_SIZE) || 25,
);
const TIME_BUDGET_MS = Number(process.env.GITHUB_BACKUP_TIME_BUDGET_MS) || 0;

const log = (msg: string) => console.log(`[github-backup] ${msg}`);

/** Strip any embedded credentials/query from a URL before logging it. */
function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^@/]*@/, "//");
  }
}

if (!TOKEN) {
  console.error(
    "[github-backup] GITHUB_PUSH_TOKEN is required. Aborting without pushing.",
  );
  process.exit(1);
}

const onAuth = () => ({ username: "x-access-token", password: TOKEN });

/** Walk up from a starting dir to find the repository root (contains `.git`). */
function findRepoRoot(start: string): string {
  let dir = start;
  // Walk up until we find a directory that contains a `.git` entry.
  // (Stop at filesystem root.)
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate a .git directory walking up from ${start}.`,
  );
}

const remoteRef = `refs/heads/${BRANCH}`;

async function main() {
  const startedAt = Date.now();
  const dir = findRepoRoot(process.cwd());
  log(`repo: ${dir}`);
  log(`remote: ${safeUrlForLog(REMOTE_URL)} (branch ${BRANCH})`);

  const localTip = await git.resolveRef({ fs, dir, ref: "HEAD" });
  log(`local tip: ${localTip}`);

  const remoteInfo = await git.getRemoteInfo({
    http,
    url: REMOTE_URL,
    onAuth,
  });
  const remoteTip: string | undefined = remoteInfo.refs?.heads?.[BRANCH];
  log(`remote tip: ${remoteTip ?? "(branch does not exist yet)"}`);

  if (remoteTip === localTip) {
    log("Remote already up to date. Nothing to push.");
    return;
  }

  // Collect commits newest -> oldest from the local tip, stopping once we
  // reach the remote tip (which is an ancestor for a normal fast-forward).
  const ordered: string[] = [];
  let reachedRemote = false;
  const commits = await git.log({ fs, dir, ref: localTip });
  for (const c of commits) {
    if (remoteTip && c.oid === remoteTip) {
      reachedRemote = true;
      break;
    }
    ordered.push(c.oid);
  }
  // ordered is newest -> oldest of the missing commits; reverse to oldest first.
  ordered.reverse();

  if (remoteTip && !reachedRemote) {
    // Remote tip is not an ancestor of local HEAD. This means histories have
    // diverged; refuse rather than force-push and risk clobbering the mirror.
    console.error(
      "[github-backup] Remote tip is not an ancestor of local HEAD " +
        "(histories diverged). Refusing to force-push. Resolve manually.",
    );
    process.exit(2);
  }

  if (ordered.length === 0) {
    log("No new commits to push.");
    return;
  }

  log(`commits to push: ${ordered.length} (chunk size ${CHUNK_SIZE})`);

  // Build chunk boundaries: the last commit of each chunk (inclusive). Pushing
  // a boundary fast-forwards the remote to it, carrying all prior commits.
  const boundaries: string[] = [];
  for (let i = CHUNK_SIZE - 1; i < ordered.length; i += CHUNK_SIZE) {
    boundaries.push(ordered[i]);
  }
  // Always include the final commit as the last boundary.
  if (boundaries[boundaries.length - 1] !== ordered[ordered.length - 1]) {
    boundaries.push(ordered[ordered.length - 1]);
  }

  const tempRef = "refs/heads/__github_backup_tmp";
  let pushed = 0;

  for (let i = 0; i < boundaries.length; i++) {
    if (
      TIME_BUDGET_MS > 0 &&
      Date.now() - startedAt > TIME_BUDGET_MS &&
      i > 0
    ) {
      log(
        `Time budget reached after ${pushed} chunk(s); exiting cleanly to ` +
          `resume next run.`,
      );
      break;
    }

    const boundary = boundaries[i];
    await git.writeRef({
      fs,
      dir,
      ref: tempRef,
      value: boundary,
      force: true,
    });

    const result = await git.push({
      fs,
      http,
      dir,
      url: REMOTE_URL,
      ref: tempRef,
      remoteRef,
      force: false,
      onAuth,
    });

    if (result.ok === false || result.error) {
      console.error(
        `[github-backup] Push failed at chunk ${i + 1}/${boundaries.length}: ` +
          `${result.error ?? "unknown error"}`,
      );
      await safeDeleteTempRef(dir, tempRef);
      process.exit(3);
    }

    pushed++;
    log(
      `pushed chunk ${i + 1}/${boundaries.length} -> remote now at ${boundary}`,
    );
  }

  await safeDeleteTempRef(dir, tempRef);

  const finalRemote = await git.getRemoteInfo({ http, url: REMOTE_URL, onAuth });
  log(
    `done in ${Math.round(
      (Date.now() - startedAt) / 1000,
    )}s. remote tip: ${finalRemote.refs?.heads?.[BRANCH] ?? "?"}`,
  );
}

async function safeDeleteTempRef(dir: string, ref: string) {
  try {
    await git.deleteRef({ fs, dir, ref });
  } catch {
    // Best-effort cleanup; the temp ref is local-only and harmless if left.
  }
}

main().catch((err) => {
  // Avoid printing the error object verbatim in case a transport layer ever
  // echoes the auth header; print only the message.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[github-backup] Fatal: ${message}`);
  process.exit(1);
});
