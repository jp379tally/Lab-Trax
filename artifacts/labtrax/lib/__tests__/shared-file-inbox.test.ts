// Tests for the shared-file inbox and the "save shared file to Unassigned
// Documents" pipeline in `lib/shared-file-inbox.ts`. We mock AsyncStorage and
// the query-client upload primitives so no real network/filesystem I/O
// happens.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getItem, setItem, removeItem } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem, removeItem },
}));

const { chunkedUploadCaseMedia, mediaFileNameFromUrl, resilientFetch } = vi.hoisted(() => ({
  chunkedUploadCaseMedia: vi.fn(),
  mediaFileNameFromUrl: vi.fn(),
  resilientFetch: vi.fn(),
}));

vi.mock("@/lib/query-client", () => ({
  chunkedUploadCaseMedia,
  mediaFileNameFromUrl,
  resilientFetch,
}));

import {
  deriveSharedFileMeta,
  removeSharedFiles,
  saveFileToUnassignedDocuments,
  saveSharedFilesToUnassignedDocuments,
  type InboxEntry,
} from "@/lib/shared-file-inbox";

beforeEach(() => {
  vi.clearAllMocks();
  mediaFileNameFromUrl.mockReturnValue(null);
});

describe("deriveSharedFileMeta", () => {
  it("derives the filename and mime type from a plain file URI", async () => {
    const meta = deriveSharedFileMeta("file:///var/mobile/Containers/Shared/screenshot.png");
    expect(meta).toEqual({ name: "screenshot.png", mimeType: "image/png" });
  });

  it("strips query strings and fragments before extracting the extension", async () => {
    const meta = deriveSharedFileMeta("file:///cache/report.pdf?token=abc#frag");
    expect(meta).toEqual({ name: "report.pdf", mimeType: "application/pdf" });
  });

  it("falls back to application/octet-stream for an unknown/missing extension", async () => {
    const meta = deriveSharedFileMeta("file:///cache/some-file-no-ext");
    expect(meta.mimeType).toBe("application/octet-stream");
    expect(meta.name).toBe("some-file-no-ext");
  });

  it("derives video MIME types for shared case attachments", async () => {
    expect(deriveSharedFileMeta("file:///cache/case-video.mov")).toEqual({
      name: "case-video.mov",
      mimeType: "video/quicktime",
    });
    expect(deriveSharedFileMeta("file:///cache/case-video.mp4")).toEqual({
      name: "case-video.mp4",
      mimeType: "video/mp4",
    });
  });
});

describe("removeSharedFiles", () => {
  const a: InboxEntry = { url: "file:///cache/a.png", receivedAt: 1 };
  const b: InboxEntry = { url: "file:///cache/b.pdf", receivedAt: 2 };

  it("does nothing when the removal list is empty", async () => {
    await removeSharedFiles([]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("removes only the given entries, leaving the rest (e.g. failed saves) in place", async () => {
    getItem.mockResolvedValue(JSON.stringify([a, b]));
    await removeSharedFiles([a]);
    expect(setItem).toHaveBeenCalledWith(
      "@labtrax_shared_file_inbox",
      JSON.stringify([b]),
    );
  });

  it("clears the storage key entirely when every entry is removed", async () => {
    getItem.mockResolvedValue(JSON.stringify([a]));
    await removeSharedFiles([a]);
    expect(removeItem).toHaveBeenCalledWith("@labtrax_shared_file_inbox");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("is a no-op when the stored inbox no longer contains the entry", async () => {
    getItem.mockResolvedValue(JSON.stringify([b]));
    await removeSharedFiles([a]);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});

describe("saveFileToUnassignedDocuments", () => {
  const baseParams = {
    fileUri: "file:///cache/screenshot.png",
    fileName: "screenshot.png",
    mimeType: "image/png",
    labOrganizationId: "lab-1",
  };

  it("fails fast without calling the upload pipeline when no lab org is available", async () => {
    const result = await saveFileToUnassignedDocuments({ ...baseParams, labOrganizationId: "" });
    expect(result.ok).toBe(false);
    expect(chunkedUploadCaseMedia).not.toHaveBeenCalled();
  });

  it("returns an error when the chunked upload throws", async () => {
    chunkedUploadCaseMedia.mockRejectedValue(new Error("network down"));
    const result = await saveFileToUnassignedDocuments(baseParams);
    expect(result).toEqual({ ok: false, error: "network down" });
    expect(resilientFetch).not.toHaveBeenCalled();
  });

  it("returns an error when the chunked upload resolves ok:false (including an undetermined file size)", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({ ok: false, error: "Could not determine file size" });
    const result = await saveFileToUnassignedDocuments(baseParams);
    expect(result).toEqual({ ok: false, error: "Could not determine file size" });
    expect(resilientFetch).not.toHaveBeenCalled();
  });

  it("finalizes the session with the uploaded filename, mime type, and the upload's own file size", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({
      ok: true,
      url: "https://host/api/cases/attachment-file/stored-name.png",
      filename: "stored-name.png",
      fileSize: 12345,
    });
    resilientFetch.mockResolvedValue({ ok: true });

    const result = await saveFileToUnassignedDocuments(baseParams);

    expect(result).toEqual({ ok: true });
    expect(resilientFetch).toHaveBeenCalledTimes(1);
    const [path, options] = resilientFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/lab-inbox/finalize-session");
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({
      storagePath: "stored-name.png",
      originalFilename: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12345,
      labOrganizationId: "lab-1",
    });
  });

  it("trims and forwards an optional inbox note while omitting blank notes", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({
      ok: true,
      url: "https://host/x.png",
      filename: "x.png",
      fileSize: 10,
    });
    resilientFetch.mockResolvedValue({ ok: true });

    await saveFileToUnassignedDocuments({ ...baseParams, note: "  Check shade  " });
    const [, options] = resilientFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string).note).toBe("Check shade");

    resilientFetch.mockClear();
    await saveFileToUnassignedDocuments({ ...baseParams, note: "   " });
    const [, blankOptions] = resilientFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(blankOptions.body as string)).not.toHaveProperty("note");
  });

  it("never sends a zero/falsy sizeBytes — the server's finalize schema requires a positive integer", async () => {
    // chunkedUploadCaseMedia is the single source of truth for file size and
    // already refuses to resolve ok:true without a valid positive size, so
    // this pipeline must always forward that same value, never a fallback 0.
    chunkedUploadCaseMedia.mockResolvedValue({
      ok: true,
      url: "https://host/x",
      filename: "x.png",
      fileSize: 42,
    });
    resilientFetch.mockResolvedValue({ ok: true });

    await saveFileToUnassignedDocuments(baseParams);

    const [, options] = resilientFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.sizeBytes).toBe(42);
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it("falls back to mediaFileNameFromUrl when the upload response omits filename", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({
      ok: true,
      url: "https://host/api/cases/attachment-file/derived-name.png",
      fileSize: 10,
    });
    mediaFileNameFromUrl.mockReturnValue("derived-name.png");
    resilientFetch.mockResolvedValue({ ok: true });

    await saveFileToUnassignedDocuments(baseParams);

    const [, options] = resilientFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.storagePath).toBe("derived-name.png");
  });

  it("returns an error including the status and body when finalize fails", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({ ok: true, url: "https://host/x", filename: "x.png", fileSize: 10 });
    resilientFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    });

    const result = await saveFileToUnassignedDocuments(baseParams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
      expect(result.error).toContain("Internal error");
    }
  });

  it("returns an error when the finalize call throws", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({ ok: true, url: "https://host/x", filename: "x.png", fileSize: 10 });
    resilientFetch.mockRejectedValue(new Error("finalize network error"));

    const result = await saveFileToUnassignedDocuments(baseParams);
    expect(result).toEqual({ ok: false, error: "finalize network error" });
  });
});

describe("saveSharedFilesToUnassignedDocuments", () => {
  const entryA: InboxEntry = { url: "file:///cache/a.png", receivedAt: 1 };
  const entryB: InboxEntry = { url: "file:///cache/b.pdf", receivedAt: 2 };
  const entries: InboxEntry[] = [entryA, entryB];

  it("uploads each entry serially and reports per-file failures without mutating the inbox itself", async () => {
    chunkedUploadCaseMedia
      .mockResolvedValueOnce({ ok: true, url: "https://host/a.png", filename: "a.png", fileSize: 10 })
      .mockResolvedValueOnce({ ok: false, error: "boom" });
    resilientFetch.mockResolvedValue({ ok: true });

    const progressCalls: [number, number][] = [];
    const summary = await saveSharedFilesToUnassignedDocuments(entries, "lab-1", (completed, total) =>
      progressCalls.push([completed, total]),
    );

    expect(summary.savedCount).toBe(1);
    expect(summary.succeeded).toEqual([entryA]);
    expect(summary.failures).toEqual([{ entry: entryB, name: "b.pdf", error: "boom" }]);
    expect(chunkedUploadCaseMedia).toHaveBeenCalledTimes(2);
    expect(chunkedUploadCaseMedia.mock.invocationCallOrder[0]).toBeLessThan(
      chunkedUploadCaseMedia.mock.invocationCallOrder[1],
    );
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // This function only reports the outcome — callers decide what to remove
    // from the inbox (via removeSharedFiles), so a failed entry is never
    // silently discarded here.
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("reports savedCount equal to entries.length when everything succeeds", async () => {
    chunkedUploadCaseMedia.mockResolvedValue({ ok: true, url: "https://host/x", filename: "x", fileSize: 10 });
    resilientFetch.mockResolvedValue({ ok: true });

    const summary = await saveSharedFilesToUnassignedDocuments(entries, "lab-1");
    expect(summary).toEqual({ savedCount: 2, succeeded: entries, failures: [] });
  });

  it("keeps every entry pending (none succeeded) when the lab cannot be resolved upstream", async () => {
    // Mirrors the caller contract: if labOrganizationId is empty, every
    // per-file call fails fast and nothing should be treated as saved.
    const summary = await saveSharedFilesToUnassignedDocuments(entries, "");
    expect(summary.savedCount).toBe(0);
    expect(summary.succeeded).toEqual([]);
    expect(summary.failures).toHaveLength(2);
    expect(chunkedUploadCaseMedia).not.toHaveBeenCalled();
  });
});
