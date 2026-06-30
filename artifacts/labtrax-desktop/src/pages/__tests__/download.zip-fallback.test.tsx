/** @vitest-environment jsdom */
/**
 * Tests for the desktop download page trusting the server's resolved installer.
 *
 * The API server is authoritative about which installer to serve: for locally
 * served /downloads/ paths it resolves the configured kind to the best
 * *available* App Storage slot (active kind → portable ZIP → macOS DMG), or
 * returns downloadUrl:null + fileFound:false when nothing is uploaded. The page
 * no longer carries its own EXE→ZIP fallback — it renders directly from the
 * server's resolved downloadUrl/fileName.
 *
 * Invariants protected:
 *  - When the server resolves the active installer to the portable ZIP, the page
 *    offers that ZIP download (correct label + URL).
 *  - When the server reports no installer is available (fileFound:false), the
 *    page shows the "Installer temporarily unavailable" / use-the-web-app block.
 *  - When the server resolves to the EXE, the EXE download is offered unchanged.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import DownloadPage from "../download";
import { makeWrapper } from "../../__tests__/test-utils";

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  getApiOrigin: () => "https://api.example.test",
}));

function installerResponse(opts: {
  downloadUrl: string | null;
  fileName: string | null;
  fileFound: boolean;
}) {
  return {
    version: "1.2.3",
    downloadUrl: opts.downloadUrl,
    fileName: opts.fileName,
    releaseNotes: null,
    available: opts.fileFound,
    fileFound: opts.fileFound,
    installerObject: null,
    installerSlots: null,
  };
}

function wireApiFetch(installer: ReturnType<typeof installerResponse>) {
  mockApiFetch.mockImplementation((endpoint: string) => {
    if (endpoint === "/desktop-installer") return Promise.resolve(installer);
    if (endpoint === "/desktop/version") return Promise.resolve({ version: "1.2.3" });
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  });
}

describe("DownloadPage — server-resolved installer", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("offers the portable ZIP when the server resolves the active installer to the ZIP", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: "/downloads/LabTrax-Windows-Portable.zip",
        fileName: "LabTrax-Windows-Portable.zip",
        fileFound: true,
      }),
    );

    render(<DownloadPage />, { wrapper: makeWrapper("/download") });

    const link = await screen.findByRole("link", {
      name: /Download LabTrax-Windows-Portable\.zip/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://api.example.test/downloads/LabTrax-Windows-Portable.zip",
    );
    expect(link).toHaveAttribute("download", "LabTrax-Windows-Portable.zip");

    // The "Portable ZIP — no installer required" copy is shown.
    expect(
      screen.getByText(/Portable ZIP — no installer required/i),
    ).toBeInTheDocument();
    // The "temporarily unavailable" block is NOT shown.
    expect(
      screen.queryByText(/Installer temporarily unavailable/i),
    ).not.toBeInTheDocument();
  });

  it("shows the temporarily-unavailable block when the server reports no installer is available", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: null,
        fileName: null,
        fileFound: false,
      }),
    );

    render(<DownloadPage />, { wrapper: makeWrapper("/download") });

    await waitFor(() => {
      expect(
        screen.getByText(/Installer temporarily unavailable/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("link", { name: /Download LabTrax-Windows-Portable\.zip/i }),
    ).not.toBeInTheDocument();
  });

  it("offers the EXE download unchanged when the server resolves to the EXE", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: "/downloads/LabTrax-Setup.exe",
        fileName: "LabTrax-Setup.exe",
        fileFound: true,
      }),
    );

    render(<DownloadPage />, { wrapper: makeWrapper("/download") });

    const link = await screen.findByRole("link", {
      name: /Download LabTrax-Setup\.exe/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://api.example.test/downloads/LabTrax-Setup.exe",
    );
    expect(
      screen.queryByText(/Installer temporarily unavailable/i),
    ).not.toBeInTheDocument();
  });
});
