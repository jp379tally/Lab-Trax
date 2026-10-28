import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import archiver from "archiver";
import { planBackupMedia } from "./backup-media-producer";
const progress = vi.hoisted(() => vi.fn());
vi.mock("./backup-phase", () => ({
  setBackupLiveProgress: progress,
  measureBackupPhase: async (_name: string, work: () => Promise<unknown>) => work(),
}));
afterEach(() => { vi.useRealTimers(); progress.mockClear(); });
async function fixture(reader: Readable, size = 32_768) {
  const root = await mkdtemp(join(tmpdir(), "backup-live-test-"));
  const media = await planBackupMedia(root, [{ relativeName: "synthetic.bin", size,
    openStream: () => reader, copyTo: async () => { throw new Error("unexpected staging"); } }]);
  const archive = archiver("zip");
  archive.on("error", () => {});
  archive.resume();
  return { media, archive, cleanup: async () => { archive.destroy(); reader.destroy(); await rm(root, { recursive: true, force: true }); } };
}
describe("live media progress and stalled-stream cleanup", () => {
  it("reports bytes before a large file finishes, then preserves its full content size", async () => {
    let start!: () => void;
    const began = new Promise<void>(resolve => { start = resolve; });
    const reader = new Readable({ read() { start(); } });
    const f = await fixture(reader);
    const capture = f.media.append(f.archive);
    try {
      await began;
      reader.push(Buffer.alloc(16_384));
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ completedFiles: 0, completedBytes: 16_384, totalBytes: 32_768 })));
      reader.push(Buffer.alloc(16_384)); reader.push(null);
      await capture;
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completedFiles: 1, completedBytes: 32_768 }));
    } finally { await f.cleanup(); }
  });
  it("fails a stalled archive after two minutes and destroys its source", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let start!: () => void;
    const began = new Promise<void>(resolve => { start = resolve; });
    const reader = new Readable({ read() { start(); } });
    const f = await fixture(reader);
    const capture = f.media.append(f.archive);
    const failure = expect(capture).rejects.toThrow("no progress for two minutes");
    try {
      await began;
      await vi.advanceTimersByTimeAsync(122_000);
      await failure;
      expect(reader.destroyed).toBe(true);
      expect(progress.mock.calls.some(([value]) => value.completedFiles > 0)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it("cancels even a source that ignores its AbortSignal", async () => {
    const controller = new AbortController();
    let start!: () => void;
    const began = new Promise<void>(resolve => { start = resolve; });
    const reader = new Readable({ read() { start(); } });
    const root = await mkdtemp(join(tmpdir(), "backup-cancel-test-"));
    const media = await planBackupMedia(root, [{ relativeName: "synthetic.bin", size: 1,
      openStream: () => reader, copyTo: async () => {} }], controller.signal);
    const archive = archiver("zip"); archive.on("error", () => {}); archive.resume();
    const capture = media.append(archive);
    const failure = expect(capture).rejects.toThrow("aborted");
    try { await began; controller.abort(); await failure; expect(reader.destroyed).toBe(true); }
    finally { archive.destroy(); reader.destroy(); await rm(root, { recursive: true, force: true }); }
  });
});
