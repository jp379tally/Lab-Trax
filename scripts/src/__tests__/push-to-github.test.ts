import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeMissingCommits,
  computeChunkBoundaries,
  run,
  BackupExitError,
  type GitLike,
} from "../push-to-github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully-mocked isomorphic-git client. By default it behaves like a
 * healthy, fast-forwardable repo; individual tests override fields as needed.
 */
function makeGitMock(
  overrides: Partial<{
    localTip: string;
    /** Sequence of remote tips returned by successive getRemoteInfo calls. */
    remoteTips: (string | undefined)[];
    /** Commit oids newest -> oldest, as git.log returns them. */
    logOids: string[];
    pushResult: { ok?: boolean; error?: unknown };
  }> = {},
): GitLike & {
  resolveRef: ReturnType<typeof vi.fn>;
  getRemoteInfo: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  writeRef: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  deleteRef: ReturnType<typeof vi.fn>;
} {
  const localTip = overrides.localTip ?? "local-tip";
  const remoteTips = overrides.remoteTips ?? ["remote-tip"];
  const logOids = overrides.logOids ?? [];
  const pushResult = overrides.pushResult ?? { ok: true };

  const getRemoteInfo = vi.fn();
  for (const tip of remoteTips) {
    getRemoteInfo.mockResolvedValueOnce({
      refs: { heads: tip === undefined ? {} : { main: tip } },
    });
  }
  // Any further calls (e.g. the final summary read) reuse the last tip.
  getRemoteInfo.mockResolvedValue({
    refs: {
      heads:
        remoteTips[remoteTips.length - 1] === undefined
          ? {}
          : { main: remoteTips[remoteTips.length - 1] },
    },
  });

  return {
    resolveRef: vi.fn().mockResolvedValue(localTip),
    getRemoteInfo,
    log: vi.fn().mockResolvedValue(logOids.map((oid) => ({ oid }))),
    writeRef: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(pushResult),
    deleteRef: vi.fn().mockResolvedValue(undefined),
  };
}

function baseOpts(gitMock: GitLike, extra: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    git: gitMock,
    http: {},
    fs: {},
    dir: "/repo",
    remoteUrl: "https://github.com/example/repo.git",
    branch: "main",
    chunkSize: 25,
    timeBudgetMs: 0,
    onAuth: () => ({ username: "x-access-token", password: "secret" }),
    ...extra,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// computeMissingCommits — pure
// ---------------------------------------------------------------------------

describe("computeMissingCommits", () => {
  it("returns missing commits oldest-first for a normal fast-forward", () => {
    // git.log order: newest -> oldest. Remote is at c2 (an ancestor).
    const { ordered, reachedRemote } = computeMissingCommits(
      ["c5", "c4", "c3", "c2", "c1"],
      "c2",
    );
    expect(reachedRemote).toBe(true);
    // Missing = c3,c4,c5; returned oldest -> newest (push order).
    expect(ordered).toEqual(["c3", "c4", "c5"]);
  });

  it("flags diverged history when the remote tip is not an ancestor", () => {
    const { ordered, reachedRemote } = computeMissingCommits(
      ["c5", "c4", "c3"],
      "not-an-ancestor",
    );
    expect(reachedRemote).toBe(false);
    // Whole local history is "missing" relative to a divergent remote.
    expect(ordered).toEqual(["c3", "c4", "c5"]);
  });

  it("treats a missing remote branch (undefined tip) as all-new, not diverged", () => {
    const { ordered, reachedRemote } = computeMissingCommits(
      ["c3", "c2", "c1"],
      undefined,
    );
    // reachedRemote stays false but the caller must not treat this as diverged
    // because there is no remote tip to diverge from.
    expect(reachedRemote).toBe(false);
    expect(ordered).toEqual(["c1", "c2", "c3"]);
  });

  it("returns no missing commits when the remote tip is the newest commit", () => {
    const { ordered, reachedRemote } = computeMissingCommits(
      ["c3", "c2", "c1"],
      "c3",
    );
    expect(reachedRemote).toBe(true);
    expect(ordered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeChunkBoundaries — pure
// ---------------------------------------------------------------------------

describe("computeChunkBoundaries", () => {
  const five = ["a", "b", "c", "d", "e"];

  it("splits with a trailing partial chunk (5 commits, size 2)", () => {
    // chunks: [a,b] [c,d] [e] -> boundaries are the last of each chunk.
    expect(computeChunkBoundaries(five, 2)).toEqual(["b", "d", "e"]);
  });

  it("does not duplicate the final boundary when count divides evenly", () => {
    // 4 commits, size 2 -> [a,b] [c,d] -> boundaries b, d (no extra).
    expect(computeChunkBoundaries(["a", "b", "c", "d"], 2)).toEqual(["b", "d"]);
  });

  it("returns a single boundary when fewer commits than the chunk size", () => {
    expect(computeChunkBoundaries(["a", "b", "c"], 25)).toEqual(["c"]);
  });

  it("returns the lone commit for a single-commit delta", () => {
    expect(computeChunkBoundaries(["only"], 25)).toEqual(["only"]);
  });

  it("emits one boundary per commit when chunk size is 1", () => {
    expect(computeChunkBoundaries(five, 1)).toEqual(five);
  });

  it("returns an empty boundary list for an empty delta", () => {
    expect(computeChunkBoundaries([], 25)).toEqual([]);
  });

  it("clamps a zero/negative chunk size to 1", () => {
    expect(computeChunkBoundaries(["a", "b"], 0)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// run — orchestration with isomorphic-git fully mocked
// ---------------------------------------------------------------------------

describe("run", () => {
  it("pushes nothing when the remote tip equals the local tip", async () => {
    const gitMock = makeGitMock({
      localTip: "same",
      remoteTips: ["same"],
    });

    const result = await run(baseOpts(gitMock));

    expect(result.pushedChunks).toBe(0);
    expect(gitMock.log).not.toHaveBeenCalled();
    expect(gitMock.push).not.toHaveBeenCalled();
    expect(gitMock.writeRef).not.toHaveBeenCalled();
  });

  it("pushes a fast-forward delta in correct chunk boundaries", async () => {
    const gitMock = makeGitMock({
      localTip: "e",
      // First read returns the ancestor "b"; later reads return the new tip.
      remoteTips: ["b", "e"],
      logOids: ["e", "d", "c", "b", "a"],
    });

    const result = await run(baseOpts(gitMock, { chunkSize: 2 }));

    // Missing = c,d,e (oldest-first). chunk size 2 -> boundaries d, e.
    expect(result.pushedChunks).toBe(2);
    expect(gitMock.push).toHaveBeenCalledTimes(2);
    expect(gitMock.writeRef).toHaveBeenCalledTimes(2);

    // writeRef stages each boundary before its push.
    expect(gitMock.writeRef.mock.calls[0][0]).toMatchObject({ value: "d" });
    expect(gitMock.writeRef.mock.calls[1][0]).toMatchObject({ value: "e" });

    // Every push is fast-forward only (force:false) to the real branch ref.
    for (const call of gitMock.push.mock.calls) {
      expect(call[0]).toMatchObject({
        force: false,
        remoteRef: "refs/heads/main",
      });
    }

    // Temp ref is cleaned up after a successful run.
    expect(gitMock.deleteRef).toHaveBeenCalled();
  });

  it("refuses to push and exits with code 2 when histories have diverged", async () => {
    const gitMock = makeGitMock({
      localTip: "x",
      remoteTips: ["zzz"], // not present in the local log => diverged
      logOids: ["x", "w", "v"],
    });

    const err = await run(baseOpts(gitMock)).catch((e) => e);
    expect(err).toBeInstanceOf(BackupExitError);
    expect(err.code).toBe(2);

    expect(gitMock.push).not.toHaveBeenCalled();
    expect(gitMock.writeRef).not.toHaveBeenCalled();
  });

  it("pushes the entire history when the remote branch does not exist yet", async () => {
    const gitMock = makeGitMock({
      localTip: "c",
      remoteTips: [undefined, "c"],
      logOids: ["c", "b", "a"],
    });

    const result = await run(baseOpts(gitMock, { chunkSize: 25 }));

    // All three commits, single chunk (boundary = newest "c").
    expect(result.pushedChunks).toBe(1);
    expect(gitMock.push).toHaveBeenCalledTimes(1);
    expect(gitMock.writeRef.mock.calls[0][0]).toMatchObject({ value: "c" });
  });

  it("exits with code 3 and cleans up the temp ref when a push fails", async () => {
    const gitMock = makeGitMock({
      localTip: "e",
      remoteTips: ["b"],
      logOids: ["e", "d", "c", "b", "a"],
      pushResult: { ok: false, error: "remote rejected" },
    });

    await expect(run(baseOpts(gitMock, { chunkSize: 2 }))).rejects.toMatchObject(
      { code: 3 },
    );
    // Temp ref cleanup still runs after the failure.
    expect(gitMock.deleteRef).toHaveBeenCalled();
  });

  it("stops starting new chunks once the time budget is exceeded", async () => {
    const gitMock = makeGitMock({
      localTip: "e",
      remoteTips: ["a", "e"],
      logOids: ["e", "d", "c", "b", "a"],
    });

    // Clock jumps past the budget after the first chunk; chunk 0 always runs.
    let calls = 0;
    const now = () => {
      calls += 1;
      // startedAt reads 0; subsequent reads are far in the future.
      return calls <= 1 ? 0 : 10_000;
    };

    const result = await run(
      baseOpts(gitMock, { chunkSize: 1, timeBudgetMs: 1000, now }),
    );

    // 5 commits at chunk size 1 would be 5 pushes, but the budget halts it
    // after the first chunk.
    expect(result.pushedChunks).toBe(1);
    expect(gitMock.push).toHaveBeenCalledTimes(1);
  });
});
