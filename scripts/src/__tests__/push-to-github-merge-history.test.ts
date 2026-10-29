import { describe, it, expect, vi } from "vitest";
import { run, type GitLike } from "../push-to-github.js";

type Commit = { oid: string; commit: { parent: string[] } };
const mergeGraph: Commit[] = [
  { oid: "merge", commit: { parent: ["remote", "side"] } },
  { oid: "remote", commit: { parent: ["root"] } },
  { oid: "side", commit: { parent: ["root"] } },
  { oid: "root", commit: { parent: [] } },
];
function fixture(commits: unknown[] = mergeGraph, remote: string | undefined = "remote") {
  const push = vi.fn().mockResolvedValue({ ok: true });
  const listFiles = vi.fn().mockResolvedValue(["src/app.ts"]);
  const client = {
    resolveRef: vi.fn().mockResolvedValue("merge"),
    getRemoteInfo: vi.fn()
      .mockResolvedValueOnce({ refs: { heads: remote ? { main: remote } : {} } })
      .mockResolvedValue({ refs: { heads: { main: "merge" } } }),
    log: vi.fn().mockResolvedValue(commits), listFiles, push,
  };
  return { client, push, listFiles, options: {
    git: client as unknown as GitLike, http: {}, fs: {}, dir: "/synthetic",
    remoteUrl: "https://github.com/example/synthetic.git", branch: "main",
    chunkSize: 1, timeBudgetMs: 0, onAuth: () => ({ username: "test", password: "test" }),
  } };
}
describe("complete outgoing merge-history privacy", () => {
  it.each([false, true])("blocks deleted private data on a later merge parent, force=%s", async force => {
    const f = fixture();
    f.listFiles.mockImplementation(async ({ ref }: { ref: string }) =>
      ref === "side" ? ["uploads/synthetic.txt"] : ["src/app.ts"]);
    await expect(run({ ...f.options, force })).rejects.toMatchObject({ code: 5 });
    expect(f.listFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: "side" }));
    expect(f.push).not.toHaveBeenCalled();
  });
  it("validates every outgoing merge parent before pushing only the merge tip", async () => {
    const f = fixture();
    await expect(run(f.options)).resolves.toEqual({ pushedChunks: 1 });
    expect(f.listFiles.mock.calls.map(([args]) => args.ref).sort()).toEqual(["merge", "side"]);
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.push).toHaveBeenCalledWith(expect.objectContaining({ ref: "merge", force: false }));
  });
  it.each([false, true])("rejects truncated parent history before upload, force=%s", async force => {
    const f = fixture(mergeGraph.filter(c => c.oid !== "side"));
    await expect(run({ ...f.options, force })).rejects.toMatchObject({ code: 5 });
    expect(f.push).not.toHaveBeenCalled();
  });
  it("rejects missing parent metadata rather than treating it as a root", async () => {
    const f = fixture(mergeGraph.map(c => c.oid === "side" ? { oid: "side" } : c));
    await expect(run(f.options)).rejects.toMatchObject({ code: 5 });
    expect(f.push).not.toHaveBeenCalled();
  });
  it("rejects a cyclic history before upload", async () => {
    const f = fixture(mergeGraph.map(c => c.oid === "side" ? { oid: "side", commit: { parent: ["merge"] } } : c));
    await expect(run(f.options)).rejects.toMatchObject({ code: 5 });
    expect(f.push).not.toHaveBeenCalled();
  });
  it("scans all local history on forced divergence", async () => {
    const f = fixture(mergeGraph, "unrelated-remote");
    f.listFiles.mockImplementation(async ({ ref }: { ref: string }) =>
      ref === "root" ? ["backup.dump"] : ["src/app.ts"]);
    await expect(run({ ...f.options, force: true })).rejects.toMatchObject({ code: 5 });
    expect(f.push).not.toHaveBeenCalled();
  });
  it("scans all local history when the remote branch is absent", async () => {
    const f = fixture(mergeGraph, "");
    f.listFiles.mockImplementation(async ({ ref }: { ref: string }) =>
      ref === "root" ? [".env.production"] : ["src/app.ts"]);
    await expect(run(f.options)).rejects.toMatchObject({ code: 5 });
    expect(f.push).not.toHaveBeenCalled();
  });
});
