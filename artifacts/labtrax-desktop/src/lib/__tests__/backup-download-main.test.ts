import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Transform } from "node:stream";
const { downloadBackupToFolder } = createRequire(import.meta.url)("../../../electron/backup-download.cjs");

describe("Electron streaming backup download", () => {
  let folder: string;
  beforeEach(async () => { folder = await mkdtemp(path.join(os.tmpdir(), "backup-download-test-")); });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
  const url = "https://api.example/api/admin/backup/generate?deferRecord=1";
  const isAllowedUrl = (value: string) => new URL(value).origin === "https://api.example";
  // The server's complete-coverage evidence; without it no archive is kept.
  const completeEvidence = {
    "x-backup-archive-kind": "complete-production",
    "x-backup-coverage-version": "1",
    "x-backup-media-file-count": "3",
    "x-backup-attachment-row-count": "2",
  };
  const footerFor = (precedingBytes: number) => {
    const footer = Buffer.alloc(12);
    footer.write("LTF1", 0, "ascii");
    footer.writeBigUInt64BE(BigInt(precedingBytes), 4);
    return footer;
  };

  it("writes a 192 MiB stream to a verified local file without a renderer buffer", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x5a);
    let headerSent = false;
    let sent = 0;
    let trailerSent = false;
    const expectedBytesBeforeFooter = 4 + 12 + 192 * chunk.byteLength + 16;
    const body = new ReadableStream({
      pull(controller) {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(Buffer.concat([Buffer.from("LTR2"), Buffer.alloc(12)]));
        } else if (sent++ < 192) {
          controller.enqueue(chunk);
        } else if (!trailerSent) {
          trailerSent = true;
          controller.enqueue(Buffer.concat([Buffer.alloc(16), footerFor(expectedBytesBeforeFooter)]));
        } else {
          controller.close();
        }
      },
    });
    const result = await downloadBackupToFolder({ url, folderPath: folder, headers: { Authorization: "test-only", "X-Platform-Admin-Secret": "test-only" } }, {
      isAllowedUrl,
      fetch: async (_url: string, options: { redirect: string }) => {
        expect(options.redirect).toBe("error");
        return new Response(body, { headers: { ...completeEvidence, "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="full.zip"' } });
      },
    });
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBe(expectedBytesBeforeFooter + 12);
    expect((await stat(result.path)).size).toBe(result.sizeBytes);
    expect(await readdir(folder)).toEqual(["full.zip"]);
  }, 30_000);

  it("keeps a phase-specific server failure and never creates a success file", async () => {
    const downloadRunId = "0ad043e2-854a-4507-bec4-f99750738096";
    const onRunId = vi.fn();
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl,
      onRunId,
      fetch: async () => new Response(JSON.stringify({ error: "case-media transfer stalled" }), { status: 500, headers: { "X-Backup-Run-Id": downloadRunId } }),
    });
    expect(result).toMatchObject({ ok: false, status: 500, downloadRunId, error: expect.stringContaining("case-media transfer stalled") });
    expect(onRunId).toHaveBeenCalledWith(downloadRunId);
    expect(await readdir(folder)).toEqual([]);
  });

  it("refuses an archive the server does not confirm as complete database-and-files coverage", async () => {
    const archive = Buffer.concat([Buffer.from("LTR2"), Buffer.alloc(12), Buffer.alloc(16)]);
    const variants: Array<Record<string, string>> = [
      { ...completeEvidence, "x-backup-archive-kind": "database-only" },
      { ...completeEvidence, "x-backup-archive-kind": "full" },
      { ...completeEvidence, "x-backup-coverage-version": "0" },
      { "x-backup-archive-kind": "complete-production" },
    ];
    for (const evidence of variants) {
      const result = await downloadBackupToFolder({ url, folderPath: folder }, {
        isAllowedUrl,
        fetch: async () => new Response(Buffer.concat([archive, footerFor(archive.length)]), {
          headers: { ...evidence, "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="full.zip"' },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("complete database-and-files recovery evidence");
    }
    expect(await readdir(folder)).toEqual([]);
  });

  it("discards a truncated/wrong-container response", async () => {
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl, fetch: async () => new Response("not a backup", {
        headers: { ...completeEvidence, "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="full.zip"' },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("download and local write");
    expect(await readdir(folder)).toEqual([]);
  });

  it("rejects a cleanly ended response without Content-Length when its integrity footer is missing", async () => {
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl,
      fetch: async () => {
        const response = new Response("LTR2".padEnd(64, "x"), {
          headers: {
            ...completeEvidence,
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="full.zip"',
          },
        });
        expect(response.headers.get("content-length")).toBeNull();
        return response;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("integrity footer");
    expect(await readdir(folder)).toEqual([]);
  });

  it("rejects a footer whose declared byte count does not match the received archive", async () => {
    const prefix = Buffer.concat([Buffer.from("LTR2"), Buffer.alloc(12), Buffer.alloc(16)]);
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl,
      fetch: async () => new Response(Buffer.concat([prefix, footerFor(prefix.length - 1)]), {
        headers: {
          ...completeEvidence,
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="full.zip"',
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("integrity footer");
    expect(await readdir(folder)).toEqual([]);
  });

  it("discards a body shorter than its advertised content length", async () => {
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl, fetch: async () => new Response(Buffer.concat([
        Buffer.from("LTR2"),
        Buffer.alloc(12),
        Buffer.alloc(16),
        footerFor(32),
      ]), {
        headers: {
          ...completeEvidence,
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="full.zip"',
          "content-length": "128",
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("incomplete");
    expect(await readdir(folder)).toEqual([]);
  });

  it("cleans up a partially written file after an ENOSPC write failure", async () => {
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("LTR2".padEnd(64, "x")));
          controller.enqueue(new Uint8Array(64).fill(0x5a));
          controller.close();
        },
      }), {
        headers: {
          ...completeEvidence,
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="full.zip"',
        },
      }),
      writeGuard: () => {
        let hasWrittenChunk = false;
        return new Transform({
          transform(chunk, _encoding, callback) {
            if (hasWrittenChunk) {
              const error = Object.assign(new Error("Simulated disk full."), { code: "ENOSPC" });
              callback(error);
              return;
            }
            hasWrittenChunk = true;
            callback(null, chunk);
          },
        });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOSPC");
    expect(await readdir(folder)).toEqual([]);
  });

  it("does not request an archive when the destination folder is unavailable", async () => {
    const blocker = path.join(folder, "not-a-folder");
    await writeFile(blocker, "file");
    const fetch = vi.fn();
    const result = await downloadBackupToFolder({ url, folderPath: path.join(blocker, "nested") }, {
      isAllowedUrl, fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("local folder access");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual(["not-a-folder"]);
  });

  it("rejects third-party URLs, unexpected routes and path-traversal names before saving", async () => {
    for (const value of ["https://untrusted.example/api/admin/backup/generate?deferRecord=1", "https://api.example/api/cases?deferRecord=1"]) {
      expect((await downloadBackupToFolder({ url: value, folderPath: folder }, { isAllowedUrl })).ok).toBe(false);
    }
    const result = await downloadBackupToFolder({ url, folderPath: folder }, {
      isAllowedUrl, fetch: async () => new Response("LTR2".repeat(10), {
        headers: { ...completeEvidence, "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="../unsafe.zip"' },
      }),
    });
    expect(result.ok).toBe(false);
    expect(await readdir(folder)).toEqual([]);
  });
});
