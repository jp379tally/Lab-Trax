/** @vitest-environment jsdom */
/**
 * Tests for the Windows ZIP fallback on the desktop download page.
 *
 * Invariants protected:
 *  - When the active EXE is missing from storage but the portable ZIP slot is
 *    available, the page offers the ZIP download (correct label + URL) instead
 *    of the "Installer temporarily unavailable" message.
 *  - When neither the EXE nor the ZIP is available, the page still shows the
 *    "Installer temporarily unavailable" / use-the-web-app block.
 *  - When the active EXE is present, the EXE download is offered unchanged.
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

interface SlotMap {
  zip: { available: boolean };
  exe: { available: boolean };
  dmg: { available: boolean };
}

function installerResponse(opts: {
  downloadUrl: string;
  fileName: string;
  fileFound: boolean;
  slots: SlotMap;
}) {
  return {
    version: "1.2.3",
    downloadUrl: opts.downloadUrl,
    fileName: opts.fileName,
    releaseNotes: null,
    available: opts.fileFound,
    fileFound: opts.fileFound,
    installerObject: null,
    installerSlots: opts.slots,
  };
}

function wireApiFetch(installer: ReturnType<typeof installerResponse>) {
  mockApiFetch.mockImplementation((endpoint: string) => {
    if (endpoint === "/desktop-installer") return Promise.resolve(installer);
    if (endpoint === "/desktop/version") return Promise.resolve({ version: "1.2.3" });
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  });
}

describe("DownloadPage — Windows ZIP fallback", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("offers the portable ZIP when the active EXE is missing but the ZIP slot is available", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: "/downloads/LabTrax-Setup.exe",
        fileName: "LabTrax-Setup.exe",
        fileFound: false,
        slots: {
          zip: { available: true },
          exe: { available: false },
          dmg: { available: false },
        },
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

  it("shows the temporarily-unavailable block when neither the EXE nor the ZIP exists", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: "/downloads/LabTrax-Setup.exe",
        fileName: "LabTrax-Setup.exe",
        fileFound: false,
        slots: {
          zip: { available: false },
          exe: { available: false },
          dmg: { available: false },
        },
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

  it("offers the EXE download unchanged when the active EXE is present", async () => {
    wireApiFetch(
      installerResponse({
        downloadUrl: "/downloads/LabTrax-Setup.exe",
        fileName: "LabTrax-Setup.exe",
        fileFound: true,
        slots: {
          zip: { available: true },
          exe: { available: true },
          dmg: { available: false },
        },
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
