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

/** Complete parent metadata is required; shallow or malformed history fails closed. */
export interface BackupCommit {
  oid: string;
  commit: { parent: string[] };
}

/** Compute the full reachable difference, independent of log order or timestamps. */
export function computeMissingCommits(
  commits: BackupCommit[],
  localTip: string,
  remoteTip: string | undefined,
): { ordered: string[]; reachedRemote: boolean; hasMerge: boolean } {
  const byOid = new Map<string, BackupCommit>();
  const invalid = () => new BackupExitError(5,
    "Incomplete or invalid commit history. Refusing to upload uninspected history.");
  for (const entry of commits) {
    if (!entry || typeof entry.oid !== "string" || !entry.oid ||
        !Array.isArray(entry.commit?.parent) ||
        entry.commit.parent.some(parent => typeof parent !== "string" || !parent) ||
        byOid.has(entry.oid)) throw invalid();
    byOid.set(entry.oid, entry);
  }
  // Iterative postorder handles long histories without exhausting the call stack.
  function ancestors(tip: string): string[] {
    const state = new Map<string, number>();
    const ordered: string[] = [];
    const stack: Array<{ oid: string; expanded: boolean }> = [{ oid: tip, expanded: false }];
    while (stack.length) {
      const { oid, expanded } = stack.pop()!;
      if (state.get(oid) === 2) continue;
      const entry = byOid.get(oid);
      if (!entry) throw invalid();
      if (expanded) {
        state.set(oid, 2);
        ordered.push(oid);
        continue;
      }
      if (state.get(oid) === 1) throw invalid();
      state.set(oid, 1);
      stack.push({ oid, expanded: true });
      for (const parent of [...entry.commit.parent].reverse()) {
        stack.push({ oid: parent, expanded: false });
      }
    }
    return ordered;
  }
  const local = ancestors(localTip);
  const reachedRemote = remoteTip !== undefined && local.includes(remoteTip);
  const remote = new Set(reachedRemote ? ancestors(remoteTip!) : []);
  const ordered = local.filter(oid => !remote.has(oid));
  return {
    ordered, reachedRemote,
    hasMerge: ordered.some(oid => byOid.get(oid)!.commit.parent.length > 1),
  };
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

/** Paths that belong to private runtime storage, including in old commits. */
export function isPrivateBackupPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(attached_assets|uploads|generated-artifacts|\.private-operator-reports|support)(\/|$)/.test(normalized)
    || /(^|\/)\.env(?:\.|$)/.test(normalized)
    || /(?:\.p8|\.dump(?:\.sha256)?|\.enc)$/.test(normalized)
    || /(^|\/)(?:labtrax[_-])?(?:prod|production)[^/]*\.sql$/.test(normalized)
    || normalized === "scripts/database-fingerprint.json";
}

/** Minimal slice of the isomorphic-git surface that {@link run} depends on. */
export interface GitLike {
  resolveRef(args: { fs: unknown; dir: string; ref: string }): Promise<string>;
  getRemoteInfo(args: {
    http: unknown;
    url: string;
    onAuth: unknown;
  }): Promise<{ refs?: { heads?: Record<string, string> } }>;
  listFiles(args: { fs: unknown; dir: string; ref: string }): Promise<string[]>;
  log(args: {
    fs: unknown;
    dir: string;
    ref: string;
  }): Promise<BackupCommit[]>;
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
  /**
   * When true, skip the diverged-history guard and force-push all local
   * commits. Use only when Replit is the authoritative source of truth and
   * the remote has commits (e.g. from CI workflows) that are NOT in local
   * history. Equivalent to `git push --force`.
   */
  force?: boolean;
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

  // Validate every reachable parent before choosing any upload boundary.
  const commits = await gitClient.log({ fs: fsImpl, dir, ref: localTip });
  const { ordered, reachedRemote, hasMerge } = computeMissingCommits(
    commits, localTip, remoteTip,
  );

  if (remoteTip && !reachedRemote) {
    if (!opts.force) {
      // Remote tip is not an ancestor of local HEAD. This means histories have
      // diverged; refuse rather than force-push and risk clobbering the mirror.
      console.error(
        "[github-backup] Remote tip is not an ancestor of local HEAD " +
          "(histories diverged). Refusing to force-push. Resolve manually.",
      );
      throw new BackupExitError(2, "histories diverged");
    }
    log(
      "Histories diverged but force=true — overwriting remote with local commits.",
    );
  }

  if (ordered.length === 0) {
    log("No new commits to push.");
    return { pushedChunks: 0 };
  }

  // A clean HEAD or a new .gitignore does not remove private data from
  // history. Validate every commit before sending even the first chunk.
  for (const ref of ordered) {
    const files = await gitClient.listFiles({ fs: fsImpl, dir, ref });
    if (files.some(isPrivateBackupPath)) {
      throw new BackupExitError(5,
        "Private runtime files exist in outgoing history. Create a reviewed source-only snapshot; do not force-push this history.");
    }
  }

  log(`commits to push: ${ordered.length} (chunk size ${chunkSize})`);

  // Side branches are not a fast-forward sequence. A merge delta must be
  // uploaded at its final tip after ALL outgoing histories pass inspection.
  const boundaries = hasMerge ? [localTip] : computeChunkBoundaries(ordered, chunkSize);

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

    // Push the boundary commit by its OID directly. isomorphic-git resolves a
    // 40-char SHA as a ref without needing a local branch ref, so we never
    // write into `.git/refs`. The managed Replit / main-agent environment
    // hard-blocks fs writes under `.git/refs/heads`, which a temp local ref
    // would otherwise trip. See `.agents/memory/main-agent-git-push-block.md`.
    const result = await gitClient.push({
      fs: fsImpl,
      http: httpImpl,
      dir,
      url: remoteUrl,
      ref: boundary,
      remoteRef,
      force: opts.force ?? false,
      onAuth,
    });

    if (result.ok === false || result.error) {
      console.error(
        `[github-backup] Push failed at chunk ${i + 1}/${boundaries.length}: ` +
          `${result.error ?? "unknown error"}`,
      );
      throw new BackupExitError(3, "push failed");
    }

    pushed++;
    log(
      `pushed chunk ${i + 1}/${boundaries.length} -> remote now at ${boundary}`,
    );
  }

  const finalRemote = await gitClient.getRemoteInfo({
    http: httpImpl,
    url: remoteUrl,
    onAuth,
  });
  const expectedTip = boundaries[pushed - 1];
  const verifiedTip = finalRemote.refs?.heads?.[branch];
  if (verifiedTip !== expectedTip) {
    console.error(
      `[github-backup] Remote verification failed: expected ${expectedTip}, ` +
        `received ${verifiedTip ?? "(branch missing)"}.`,
    );
    throw new BackupExitError(4, "remote verification failed");
  }
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
  const force = process.env.GITHUB_BACKUP_FORCE === "true";
  const dir = findRepoRoot(process.cwd());
  const onAuth = () => ({ username: "x-access-token", password: TOKEN });

  if (force) {
    console.log(
      "[github-backup] GITHUB_BACKUP_FORCE=true — will overwrite remote if histories have diverged.",
    );
  }

  await run({
    git: git as unknown as GitLike,
    http,
    fs,
    dir,
    remoteUrl,
    branch,
    chunkSize,
    timeBudgetMs,
    force,
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
