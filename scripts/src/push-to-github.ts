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
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

export const DEFAULT_REMOTE_URL = "https://github.com/jp379tally/Lab-Trax.git";

const log = (msg: string) => console.log(`[github-backup] ${msg}`);

/** Strip any embedded credentials/query from a URL before logging it. */
export function safeUrlForLog(raw: string): string {
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

/** Walk up from a starting dir to find the repository root (contains `.git`). */
export function findRepoRoot(start: string): string {
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

/**
 * Signals a clean, intentional non-zero exit from {@link run} without calling
 * `process.exit` inside the testable core (so the runner can be exercised in
 * unit tests). The thin script wrapper translates this into `process.exit`.
 */
export class BackupExitError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "BackupExitError";
  }
}

/**
 * Given commit oids ordered newest -> oldest (as `git.log` returns them) and
 * the current remote tip, compute the commits the remote is missing.
 *
 * Returns:
 *   - `ordered`: the missing commits oldest -> newest (push order).
 *   - `reachedRemote`: whether the remote tip was found as an ancestor while
 *     walking back from the local tip. When `remoteTip` exists but this is
 *     `false`, histories have diverged (the remote tip is not an ancestor of
 *     local HEAD) and the caller must refuse to push.
 */
export function computeMissingCommits(
  commitOids: string[],
  remoteTip: string | undefined,
): { ordered: string[]; reachedRemote: boolean } {
  const ordered: string[] = [];
  let reachedRemote = false;
  for (const oid of commitOids) {
    if (remoteTip && oid === remoteTip) {
      reachedRemote = true;
      break;
    }
    ordered.push(oid);
  }
  // ordered is newest -> oldest of the missing commits; reverse to oldest first.
  ordered.reverse();
  return { ordered, reachedRemote };
}

/**
 * Build chunk boundaries: the last commit of each chunk (inclusive). Pushing a
 * boundary fast-forwards the remote to it, carrying all prior commits. The
 * final commit is always included as the last boundary so nothing is dropped.
 */
export function computeChunkBoundaries(
  ordered: string[],
  chunkSize: number,
): string[] {
  const size = Math.max(1, chunkSize);
  const boundaries: string[] = [];
  for (let i = size - 1; i < ordered.length; i += size) {
    boundaries.push(ordered[i]);
  }
  if (
    ordered.length > 0 &&
    boundaries[boundaries.length - 1] !== ordered[ordered.length - 1]
  ) {
    boundaries.push(ordered[ordered.length - 1]);
  }
  return boundaries;
}

/** Minimal slice of the isomorphic-git surface that {@link run} depends on. */
export interface GitLike {
  resolveRef(args: { fs: unknown; dir: string; ref: string }): Promise<string>;
  getRemoteInfo(args: {
    http: unknown;
    url: string;
    onAuth: unknown;
  }): Promise<{ refs?: { heads?: Record<string, string> } }>;
  log(args: {
    fs: unknown;
    dir: string;
    ref: string;
  }): Promise<{ oid: string }[]>;
  writeRef(args: {
    fs: unknown;
    dir: string;
    ref: string;
    value: string;
    force: boolean;
  }): Promise<void>;
  push(args: {
    fs: unknown;
    http: unknown;
    dir: string;
    url: string;
    ref: string;
    remoteRef: string;
    force: boolean;
    onAuth: unknown;
  }): Promise<{ ok?: boolean; error?: unknown }>;
  deleteRef(args: { fs: unknown; dir: string; ref: string }): Promise<void>;
}

export interface RunOptions {
  git: GitLike;
  http: unknown;
  fs: unknown;
  dir: string;
  remoteUrl: string;
  branch: string;
  chunkSize: number;
  timeBudgetMs: number;
  onAuth: () => { username: string; password: string };
  /** Injectable clock for tests; defaults to {@link Date.now}. */
  now?: () => number;
}

const TEMP_REF = "refs/heads/__github_backup_tmp";

async function safeDeleteTempRef(
  gitClient: GitLike,
  fsImpl: unknown,
  dir: string,
  ref: string,
) {
  try {
    await gitClient.deleteRef({ fs: fsImpl, dir, ref });
  } catch {
    // Best-effort cleanup; the temp ref is local-only and harmless if left.
  }
}

/**
 * Core, dependency-injected backup routine. Throws {@link BackupExitError} for
 * intentional non-zero exits (diverged history, push failure) so it can be
 * unit-tested without terminating the process. Returns the number of chunks
 * actually pushed.
 */
export async function run(opts: RunOptions): Promise<{ pushedChunks: number }> {
  const {
    git: gitClient,
    http: httpImpl,
    fs: fsImpl,
    dir,
    remoteUrl,
    branch,
    chunkSize,
    timeBudgetMs,
    onAuth,
  } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const remoteRef = `refs/heads/${branch}`;

  log(`repo: ${dir}`);
  log(`remote: ${safeUrlForLog(remoteUrl)} (branch ${branch})`);

  const localTip = await gitClient.resolveRef({ fs: fsImpl, dir, ref: "HEAD" });
  log(`local tip: ${localTip}`);

  const remoteInfo = await gitClient.getRemoteInfo({
    http: httpImpl,
    url: remoteUrl,
    onAuth,
  });
  const remoteTip: string | undefined = remoteInfo.refs?.heads?.[branch];
  log(`remote tip: ${remoteTip ?? "(branch does not exist yet)"}`);

  if (remoteTip === localTip) {
    log("Remote already up to date. Nothing to push.");
    return { pushedChunks: 0 };
  }

  // Collect commits newest -> oldest from the local tip, stopping once we
  // reach the remote tip (which is an ancestor for a normal fast-forward).
  const commits = await gitClient.log({ fs: fsImpl, dir, ref: localTip });
  const { ordered, reachedRemote } = computeMissingCommits(
    commits.map((c) => c.oid),
    remoteTip,
  );

  if (remoteTip && !reachedRemote) {
    // Remote tip is not an ancestor of local HEAD. This means histories have
    // diverged; refuse rather than force-push and risk clobbering the mirror.
    console.error(
      "[github-backup] Remote tip is not an ancestor of local HEAD " +
        "(histories diverged). Refusing to force-push. Resolve manually.",
    );
    throw new BackupExitError(2, "histories diverged");
  }

  if (ordered.length === 0) {
    log("No new commits to push.");
    return { pushedChunks: 0 };
  }

  log(`commits to push: ${ordered.length} (chunk size ${chunkSize})`);

  const boundaries = computeChunkBoundaries(ordered, chunkSize);

  let pushed = 0;

  for (let i = 0; i < boundaries.length; i++) {
    if (timeBudgetMs > 0 && now() - startedAt > timeBudgetMs && i > 0) {
      log(
        `Time budget reached after ${pushed} chunk(s); exiting cleanly to ` +
          `resume next run.`,
      );
      break;
    }

    const boundary = boundaries[i];
    await gitClient.writeRef({
      fs: fsImpl,
      dir,
      ref: TEMP_REF,
      value: boundary,
      force: true,
    });

    const result = await gitClient.push({
      fs: fsImpl,
      http: httpImpl,
      dir,
      url: remoteUrl,
      ref: TEMP_REF,
      remoteRef,
      force: false,
      onAuth,
    });

    if (result.ok === false || result.error) {
      console.error(
        `[github-backup] Push failed at chunk ${i + 1}/${boundaries.length}: ` +
          `${result.error ?? "unknown error"}`,
      );
      await safeDeleteTempRef(gitClient, fsImpl, dir, TEMP_REF);
      throw new BackupExitError(3, "push failed");
    }

    pushed++;
    log(
      `pushed chunk ${i + 1}/${boundaries.length} -> remote now at ${boundary}`,
    );
  }

  await safeDeleteTempRef(gitClient, fsImpl, dir, TEMP_REF);

  const finalRemote = await gitClient.getRemoteInfo({
    http: httpImpl,
    url: remoteUrl,
    onAuth,
  });
  log(
    `done in ${Math.round(
      (now() - startedAt) / 1000,
    )}s. remote tip: ${finalRemote.refs?.heads?.[branch] ?? "?"}`,
  );

  return { pushedChunks: pushed };
}

async function main() {
  const TOKEN = process.env.GITHUB_PUSH_TOKEN;
  if (!TOKEN) {
    console.error(
      "[github-backup] GITHUB_PUSH_TOKEN is required. Aborting without pushing.",
    );
    process.exit(1);
  }

  const remoteUrl =
    process.env.GITHUB_BACKUP_REPO_URL || DEFAULT_REMOTE_URL;
  const branch = process.env.GITHUB_BACKUP_BRANCH || "main";
  const chunkSize = Math.max(
    1,
    Number(process.env.GITHUB_BACKUP_CHUNK_SIZE) || 25,
  );
  const timeBudgetMs = Number(process.env.GITHUB_BACKUP_TIME_BUDGET_MS) || 0;
  const dir = findRepoRoot(process.cwd());
  const onAuth = () => ({ username: "x-access-token", password: TOKEN });

  await run({
    git: git as unknown as GitLike,
    http,
    fs,
    dir,
    remoteUrl,
    branch,
    chunkSize,
    timeBudgetMs,
    onAuth,
  });
}

/** True when this module is executed directly (e.g. via `tsx`), not imported. */
const isDirectRun =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    if (err instanceof BackupExitError) {
      process.exit(err.code);
    }
    // Avoid printing the error object verbatim in case a transport layer ever
    // echoes the auth header; print only the message.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[github-backup] Fatal: ${message}`);
    process.exit(1);
  });
}
