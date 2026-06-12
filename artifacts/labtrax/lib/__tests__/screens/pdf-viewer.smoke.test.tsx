import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { setMockSearchParams } from "../../../vitest.setup";
import { router } from "expo-router";

// The viewer downloads the auth-gated file and shares it via these helpers; mock
// them so the screen can be exercised without filesystem / network I/O.
const { downloadAttachmentToLocalFile, shareLocalFile } = vi.hoisted(() => ({
  downloadAttachmentToLocalFile: vi.fn(),
  shareLocalFile: vi.fn(),
}));

vi.mock("@/lib/open-attachment", () => ({
  downloadAttachmentToLocalFile,
  shareLocalFile,
}));

import PdfViewerScreen from "@/app/pdf-viewer";

const PARAMS = {
  url: "/api/cases/c1/attachments/a1/file",
  fileName: "iTero_Rx_309233315.pdf",
  fileType: "application/pdf",
};
const LOCAL_URI = "file:///cache/labtrax-share/iTero_Rx_309233315.pdf";

beforeEach(() => {
  setMockSearchParams(PARAMS);
  downloadAttachmentToLocalFile.mockResolvedValue(LOCAL_URI);
  shareLocalFile.mockResolvedValue("opened");
});

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  vi.clearAllMocks();
});

describe("PdfViewerScreen", () => {
  it("renders without throwing", () => {
    expect(() => render(<PdfViewerScreen />)).not.toThrow();
  });

  it("downloads the attachment to a local file on mount", async () => {
    render(<PdfViewerScreen />);
    await waitFor(() => {
      expect(downloadAttachmentToLocalFile).toHaveBeenCalledWith({
        url: PARAMS.url,
        fileName: PARAMS.fileName,
        fileType: PARAMS.fileType,
      });
    });
  });

  it("shares the downloaded file from the explicit Share button", async () => {
    const { getByTestId, queryByTestId } = render(<PdfViewerScreen />);
    // Wait for the download to resolve so the viewer is ready (share enabled).
    await waitFor(() => expect(queryByTestId("pdf-loading")).toBeNull());

    fireEvent.press(getByTestId("pdf-share"));
    expect(shareLocalFile).toHaveBeenCalledWith(LOCAL_URI, {
      fileName: PARAMS.fileName,
      fileType: PARAMS.fileType,
    });
  });

  it("navigates back from the Back button", () => {
    const { getByTestId } = render(<PdfViewerScreen />);
    fireEvent.press(getByTestId("pdf-back"));
    expect(vi.mocked(router.back)).toHaveBeenCalled();
  });

  it("shows an error state when the download fails", async () => {
    downloadAttachmentToLocalFile.mockResolvedValue(null);
    const { getByTestId } = render(<PdfViewerScreen />);
    await waitFor(() => {
      expect(getByTestId("pdf-error")).toBeTruthy();
    });
  });

  it("shows an error state when no url param is provided", async () => {
    setMockSearchParams({});
    const { getByTestId } = render(<PdfViewerScreen />);
    await waitFor(() => {
      expect(getByTestId("pdf-error")).toBeTruthy();
    });
    expect(downloadAttachmentToLocalFile).not.toHaveBeenCalled();
  });
});
