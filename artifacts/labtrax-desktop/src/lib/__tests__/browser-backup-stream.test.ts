import { describe, expect, it, vi } from "vitest";
import { streamVerifiedBackupToWritable } from "../local-backup-execution";

function response(kind = "complete-non-production", corrupt = false) {
  const bytes = new Uint8Array(76);
  bytes.set(new TextEncoder().encode("LTR2"));
  bytes.set(new TextEncoder().encode(corrupt ? "FAIL" : "LTF1"), 64);
  new DataView(bytes.buffer).setBigUint64(68, 64n, false);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3, 70));
      controller.enqueue(bytes.subarray(70));
      controller.close();
    },
  }), { headers: {
    "content-type": "application/octet-stream",
    "content-length": "76",
    "x-backup-archive-kind": kind,
    "x-backup-coverage-version": kind === "database-only" ? "0" : "1",
    "x-backup-media-file-count": kind === "database-only" ? "0" : "3",
    "x-backup-attachment-row-count": "2",
    "x-backup-missing-file-count": kind.startsWith("partial-") ? "526" : "0",
  } });
}

describe("browser-selected backup streaming", () => {
  it.each(["complete-non-production", "partial-production"])(
    "streams and closes a verified %s archive without buffering", async (kind) => {
      let size = 0;
      const close = vi.fn();
      const abort = vi.fn();
      const writable = new WritableStream<Uint8Array>({
        write(chunk) { size += chunk.byteLength; }, close, abort,
      });
      await expect(streamVerifiedBackupToWritable(response(kind), writable)).resolves.toBe(76);
      expect(size).toBe(76);
      expect(close).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it("aborts an incomplete stream rather than closing the selected file", async () => {
    const close = vi.fn();
    const abort = vi.fn();
    await expect(streamVerifiedBackupToWritable(response("complete-non-production", true),
      new WritableStream({ close, abort }))).rejects.toThrow(/integrity footer/);
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("only permits database-only when explicitly requested", async () => {
    const abort = vi.fn();
    await expect(streamVerifiedBackupToWritable(response("database-only"),
      new WritableStream({ abort }))).rejects.toThrow(/recovery evidence/);
    expect(abort).toHaveBeenCalledOnce();
    await expect(streamVerifiedBackupToWritable(response("database-only"),
      new WritableStream(), "database-only")).resolves.toBe(76);
  });
});
