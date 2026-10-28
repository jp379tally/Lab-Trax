import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { File, FileMetadata } from "@google-cloud/storage";
import { openPinnedProductionObject } from "./production-media-object-write";

const expected: FileMetadata = { generation: "7", size: "4", md5Hash: "synthetic-checksum" };
const saved: FileMetadata = { generation: "9", size: "4", md5Hash: "synthetic-checksum" };
const missing = () => Object.assign(new Error("missing pinned version"), { code: 404 });
const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

function fixture(primary: Readable, retained: Readable, metadata: () => Promise<[FileMetadata]> = async () => [saved]) {
  const getMetadata = vi.fn(metadata);
  const retainedRead = vi.fn(() => retained);
  const pinnedRead = vi.fn(() => primary);
  const fileLookup = vi.fn((name: string, options?: { generation?: string }) => options?.generation === "7"
    ? { createReadStream: pinnedRead }
    : { getMetadata, createReadStream: retainedRead });
  const file = { name: "private/case-media/synthetic.bin", bucket: { file: fileLookup } } as unknown as File;
  return { file, getMetadata, retainedRead, pinnedRead };
}

describe("pinned production provider read cancellation", () => {
  it("destroys the active provider read before awaiting a stalled iterator", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const provider = new Readable({ read() { markStarted(); } });
    const f = fixture(provider, Readable.from([Buffer.from("kept")]));
    const stream = openPinnedProductionObject(f.file, "7", expected);
    const pending = collect(stream);
    const checked = expect(pending).rejects.toThrow("operator cancellation");
    await started;
    stream.destroy(new Error("operator cancellation"));
    await checked;
    expect(provider.destroyed).toBe(true);
    expect(f.retainedRead).not.toHaveBeenCalled();
  });

  it("also cancels a stalled independently retained version", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const retained = new Readable({ read() { markStarted(); } });
    const f = fixture(Readable.from((async function* () { throw missing(); })()), retained);
    const stream = openPinnedProductionObject(f.file, "7", expected);
    const pending = collect(stream);
    const checked = expect(pending).rejects.toThrow("retained read cancelled");
    await started;
    stream.destroy(new Error("retained read cancelled"));
    await checked;
    expect(retained.destroyed).toBe(true);
    expect(f.retainedRead).toHaveBeenCalledWith({ validation: "crc32c" });
  });

  it("never reopens retained bytes after cancellation during metadata lookup", async () => {
    let markLookup!: () => void;
    const lookupStarted = new Promise<void>(resolve => { markLookup = resolve; });
    let resolveMetadata!: (metadata: [FileMetadata]) => void;
    const metadata = new Promise<[FileMetadata]>(resolve => { resolveMetadata = resolve; });
    const f = fixture(Readable.from((async function* () { throw missing(); })()), Readable.from([Buffer.from("kept")]),
      () => { markLookup(); return metadata; });
    const stream = openPinnedProductionObject(f.file, "7", expected);
    const pending = collect(stream);
    const checked = expect(pending).rejects.toThrow("lookup cancelled");
    await lookupStarted;
    stream.destroy(new Error("lookup cancelled"));
    resolveMetadata([saved]);
    await checked;
    expect(f.retainedRead).not.toHaveBeenCalled();
  });

  it("does not restart an interrupted read that already emitted bytes", async () => {
    const f = fixture(Readable.from((async function* () { yield Buffer.from("part"); throw missing(); })()),
      Readable.from([Buffer.from("kept")]));
    await expect(collect(openPinnedProductionObject(f.file, "7", expected))).rejects.toThrow("missing pinned version");
    expect(f.getMetadata).not.toHaveBeenCalled();
    expect(f.retainedRead).not.toHaveBeenCalled();
  });

  it("reads the verified retained version only when no original bytes were emitted", async () => {
    const f = fixture(Readable.from((async function* () { throw missing(); })()), Readable.from([Buffer.from("kept")]));
    await expect(collect(openPinnedProductionObject(f.file, "7", expected))).resolves.toEqual(Buffer.from("kept"));
    expect(f.pinnedRead).toHaveBeenCalledWith({ validation: "crc32c" });
    expect(f.retainedRead).toHaveBeenCalledWith({ validation: "crc32c" });
  });

  it("rejects inconsistent retained metadata without opening its body", async () => {
    const f = fixture(Readable.from((async function* () { throw missing(); })()), Readable.from([Buffer.from("wrong")]),
      async () => [{ ...saved, md5Hash: "different-content" }]);
    await expect(collect(openPinnedProductionObject(f.file, "7", expected))).rejects.toThrow("verified retained version are unavailable");
    expect(f.retainedRead).not.toHaveBeenCalled();
  });
});
