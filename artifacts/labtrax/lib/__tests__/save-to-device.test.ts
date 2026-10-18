// Tests for `lib/save-to-device.ts` — saving auth-gated case/provider
// attachments to the device (photo library for images, OS share/save flow
// for documents). We mock expo-media-library, the authed media cache, and
// the existing openAttachment share pipeline so no real I/O happens.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { requestPermissionsAsync, saveToLibraryAsync, acquireAuthedMediaUri, release, openAttachment, downloadAttachmentToLocalFile } = vi.hoisted(
  () => ({
    requestPermissionsAsync: vi.fn(),
    saveToLibraryAsync: vi.fn(),
    acquireAuthedMediaUri: vi.fn(),
    release: vi.fn(),
    openAttachment: vi.fn(),
    downloadAttachmentToLocalFile: vi.fn(),
  }),
);

vi.mock("expo-media-library", () => ({
  requestPermissionsAsync,
  saveToLibraryAsync,
}));

vi.mock("@/lib/authed-media-cache", () => ({
  acquireAuthedMediaUri,
}));

vi.mock("@/lib/open-attachment", () => ({
  openAttachment,
  downloadAttachmentToLocalFile,
}));

import { saveImageToDevice, saveDocumentToDevice } from "@/lib/save-to-device";

const URL = "/api/cases/c1/attachments/a1/file";
const LOCAL_URI = "file:///cache/labtrax-media/_api_cases_c1_attachments_a1_file";

beforeEach(() => {
  vi.clearAllMocks();
  requestPermissionsAsync.mockResolvedValue({ granted: true, status: "granted" });
  saveToLibraryAsync.mockResolvedValue(undefined);
  acquireAuthedMediaUri.mockResolvedValue({ uri: LOCAL_URI, release });
  openAttachment.mockResolvedValue("opened");
  downloadAttachmentToLocalFile.mockResolvedValue({ uri: `${LOCAL_URI}.jpg`, release });
});

describe("saveImageToDevice", () => {
  it("requests the add-only (write-only) photo library permission", async () => {
    await saveImageToDevice(URL);
    expect(requestPermissionsAsync).toHaveBeenCalledWith(true);
  });

  it("downloads the attachment and saves it to the library on success", async () => {
    const result = await saveImageToDevice(URL);
    expect(result).toBe("saved");
    expect(acquireAuthedMediaUri).toHaveBeenCalledWith(URL);
    expect(saveToLibraryAsync).toHaveBeenCalledWith(LOCAL_URI);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns 'permission-denied' and never downloads when permission is refused", async () => {
    requestPermissionsAsync.mockResolvedValue({ granted: false, status: "denied" });
    const result = await saveImageToDevice(URL);
    expect(result).toBe("permission-denied");
    expect(acquireAuthedMediaUri).not.toHaveBeenCalled();
    expect(saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("returns 'error' when the permission request throws", async () => {
    requestPermissionsAsync.mockRejectedValue(new Error("native crash"));
    const result = await saveImageToDevice(URL);
    expect(result).toBe("error");
    expect(saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("returns 'error' when the download fails", async () => {
    acquireAuthedMediaUri.mockResolvedValue(null);
    const result = await saveImageToDevice(URL);
    expect(result).toBe("error");
    expect(saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("returns 'error' when saveToLibraryAsync throws", async () => {
    saveToLibraryAsync.mockRejectedValue(new Error("disk full"));
    const result = await saveImageToDevice(URL);
    expect(result).toBe("error");
  });

  it("uses the authenticated attachment helper to preserve a note photo's extension", async () => {
    const file = { fileName: "margin.jpg", fileType: "image/jpeg" };
    expect(await saveImageToDevice(URL, file)).toBe("saved");
    expect(downloadAttachmentToLocalFile).toHaveBeenCalledWith({ url: URL, ...file });
    expect(saveToLibraryAsync).toHaveBeenCalledWith(`${LOCAL_URI}.jpg`);
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquireAuthedMediaUri).not.toHaveBeenCalled();
  });

  it("reports a failed attachment download without attempting to save", async () => {
    downloadAttachmentToLocalFile.mockResolvedValue(null);
    expect(await saveImageToDevice(URL, { fileName: "margin.jpg" })).toBe("error");
    expect(saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("reports an unexpected attachment download exception", async () => {
    downloadAttachmentToLocalFile.mockRejectedValue(new Error("connection lost"));
    expect(await saveImageToDevice(URL, { fileName: "margin.jpg" })).toBe("error");
  });

  it("releases the extension-bearing photo when saving fails", async () => {
    saveToLibraryAsync.mockRejectedValue(new Error("disk full"));
    expect(await saveImageToDevice(URL, { fileName: "margin.jpg" })).toBe("error");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("saveDocumentToDevice", () => {
  it("delegates to the existing download-and-share pipeline", async () => {
    const opts = { url: URL, fileName: "report.pdf", fileType: "application/pdf" };
    const result = await saveDocumentToDevice(opts);
    expect(result).toBe("opened");
    expect(openAttachment).toHaveBeenCalledWith(opts);
  });

  it("propagates 'unavailable' and 'error' outcomes from openAttachment", async () => {
    openAttachment.mockResolvedValue("unavailable");
    const result = await saveDocumentToDevice({ url: URL });
    expect(result).toBe("unavailable");
  });
});
