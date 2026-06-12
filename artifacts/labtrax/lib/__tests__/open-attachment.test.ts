// Tests for `lib/open-attachment.ts` — opening auth-gated case attachments in
// the OS viewer / in-app viewer. We mock the auth media cache, expo-sharing, and
// the legacy expo-file-system surface so no real network/filesystem I/O happens.
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getAuthedMediaUri,
  shareAsync,
  isAvailableAsync,
  copyAsync,
  getInfoAsync,
  makeDirectoryAsync,
  deleteAsync,
} = vi.hoisted(() => ({
  getAuthedMediaUri: vi.fn(),
  shareAsync: vi.fn(),
  isAvailableAsync: vi.fn(),
  copyAsync: vi.fn(),
  getInfoAsync: vi.fn(),
  makeDirectoryAsync: vi.fn(),
  deleteAsync: vi.fn(),
}));

vi.mock("@/lib/authed-media-cache", () => ({
  getAuthedMediaUri,
  refreshAuthedMediaUri: vi.fn(),
}));

vi.mock("expo-sharing", () => ({
  shareAsync,
  isAvailableAsync,
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync,
  makeDirectoryAsync,
  copyAsync,
  deleteAsync,
}));

import {
  openAttachment,
  downloadAttachmentToLocalFile,
  shareLocalFile,
} from "@/lib/open-attachment";

const URL = "/api/cases/c1/attachments/a1/file";
// The cached media file name is derived from the API path, so it has no extension.
const CACHED_NO_EXT = "file:///cache/labtrax-media/_api_cases_c1_attachments_a1_file";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthedMediaUri.mockResolvedValue(CACHED_NO_EXT);
  isAvailableAsync.mockResolvedValue(true);
  getInfoAsync.mockResolvedValue({ exists: false });
  makeDirectoryAsync.mockResolvedValue(undefined);
  deleteAsync.mockResolvedValue(undefined);
  copyAsync.mockResolvedValue(undefined);
  shareAsync.mockResolvedValue(undefined);
});

describe("openAttachment", () => {
  it("returns 'error' and never shares when the download fails", async () => {
    getAuthedMediaUri.mockResolvedValue(null);
    const result = await openAttachment({
      url: URL,
      fileName: "x.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("error");
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it("returns 'unavailable' when sharing is not supported on the device", async () => {
    isAvailableAsync.mockResolvedValue(false);
    const result = await openAttachment({
      url: URL,
      fileName: "x.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("unavailable");
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it("copies the cached file to a name with the real extension and shares it as a PDF", async () => {
    const result = await openAttachment({
      url: URL,
      fileName: "iTero_Rx_309233315.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("opened");
    expect(copyAsync).toHaveBeenCalledTimes(1);
    const copyArg = copyAsync.mock.calls[0][0] as { from: string; to: string };
    expect(copyArg.from).toBe(CACHED_NO_EXT);
    expect(copyArg.to.toLowerCase().endsWith(".pdf")).toBe(true);

    const [sharedUri, opts] = shareAsync.mock.calls[0] as [string, Record<string, unknown>];
    expect(sharedUri).toBe(copyArg.to);
    expect(opts).toMatchObject({ mimeType: "application/pdf", UTI: "com.adobe.pdf" });
  });

  it("deletes any stale copy before copying (iOS copyAsync rejects on an existing dest)", async () => {
    await openAttachment({
      url: URL,
      fileName: "report.pdf",
      fileType: "application/pdf",
    });
    expect(deleteAsync).toHaveBeenCalledTimes(1);
    const [deletedDest, deleteOpts] = deleteAsync.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const copyArg = copyAsync.mock.calls[0][0] as { to: string };
    expect(deletedDest).toBe(copyArg.to);
    expect(deleteOpts).toMatchObject({ idempotent: true });
    // Delete must run *before* the copy.
    expect(deleteAsync.mock.invocationCallOrder[0]).toBeLessThan(
      copyAsync.mock.invocationCallOrder[0],
    );
  });

  it("does not copy when the cached file already carries the extension", async () => {
    getAuthedMediaUri.mockResolvedValue("file:///cache/labtrax-media/report.pdf");
    const result = await openAttachment({
      url: URL,
      fileName: "report.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("opened");
    expect(copyAsync).not.toHaveBeenCalled();
    const [sharedUri] = shareAsync.mock.calls[0] as [string];
    expect(sharedUri).toBe("file:///cache/labtrax-media/report.pdf");
  });

  it("passes the mime type and omits UTI for a non-pdf attachment", async () => {
    const result = await openAttachment({
      url: URL,
      fileName: "scan.stl",
      fileType: "model/stl",
    });
    expect(result).toBe("opened");
    const [, opts] = shareAsync.mock.calls[0] as [string, { mimeType?: string; UTI?: string }];
    expect(opts.mimeType).toBe("model/stl");
    expect(opts.UTI).toBeUndefined();
  });

  it("falls back to the cached file when the copy step throws", async () => {
    copyAsync.mockRejectedValue(new Error("copy failed"));
    const result = await openAttachment({
      url: URL,
      fileName: "x.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("opened");
    const [sharedUri] = shareAsync.mock.calls[0] as [string];
    expect(sharedUri).toBe(CACHED_NO_EXT);
  });
});

describe("downloadAttachmentToLocalFile (in-app viewer)", () => {
  it("returns a local file URI carrying the real extension", async () => {
    const uri = await downloadAttachmentToLocalFile({
      url: URL,
      fileName: "iTero_Rx_309233315.pdf",
      fileType: "application/pdf",
    });
    expect(uri).not.toBeNull();
    expect(uri!.toLowerCase().endsWith(".pdf")).toBe(true);
    // Delete-before-copy applies here too.
    expect(deleteAsync.mock.invocationCallOrder[0]).toBeLessThan(
      copyAsync.mock.invocationCallOrder[0],
    );
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it("returns null when the download fails", async () => {
    getAuthedMediaUri.mockResolvedValue(null);
    const uri = await downloadAttachmentToLocalFile({
      url: URL,
      fileName: "x.pdf",
      fileType: "application/pdf",
    });
    expect(uri).toBeNull();
  });

  it("returns null (never an extensionless uri) when the copy fails", async () => {
    copyAsync.mockRejectedValue(new Error("copy failed"));
    const uri = await downloadAttachmentToLocalFile({
      url: URL,
      fileName: "x.pdf",
      fileType: "application/pdf",
    });
    expect(uri).toBeNull();
  });
});

describe("shareLocalFile (explicit Share action)", () => {
  it("shares the provided local URI with the pdf UTI", async () => {
    const result = await shareLocalFile("file:///cache/labtrax-share/report.pdf", {
      fileName: "report.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("opened");
    const [sharedUri, opts] = shareAsync.mock.calls[0] as [
      string,
      { mimeType?: string; UTI?: string },
    ];
    expect(sharedUri).toBe("file:///cache/labtrax-share/report.pdf");
    expect(opts.mimeType).toBe("application/pdf");
    expect(opts.UTI).toBe("com.adobe.pdf");
  });

  it("returns 'unavailable' and never shares when sharing is unsupported", async () => {
    isAvailableAsync.mockResolvedValue(false);
    const result = await shareLocalFile("file:///cache/labtrax-share/report.pdf", {
      fileName: "report.pdf",
      fileType: "application/pdf",
    });
    expect(result).toBe("unavailable");
    expect(shareAsync).not.toHaveBeenCalled();
  });
});
