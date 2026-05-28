/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AppVersionCard } from "@/pages/settings";

/**
 * Renderer smoke test for the Settings → Desktop app card.
 *
 * The Check-for-updates card used to be nested inside the
 * `{info && …}` wrapper in DesktopInstallerPanel, so admins saw an
 * empty gap whenever the installer-distribution query was loading,
 * errored, or hadn't returned `info` yet. The fix hoisted
 * AppVersionCard out of that wrapper so it renders unconditionally.
 *
 * This suite asserts the unconditional contract directly on
 * AppVersionCard:
 *   - With a full Electron bridge present, the Check-for-updates
 *     button is in the DOM regardless of any sibling query state.
 *   - With no bridge (browser/PWA), the Browser-preview placeholder
 *     renders instead — never a blank gap.
 */

type ElectronAPILike = {
  getAppVersion: () => Promise<string>;
  getUpdateState: () => Promise<unknown>;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  installUpdate: () => Promise<void>;
  onUpdateState: (cb: (s: unknown) => void) => () => void;
};

function installElectronApi(): ElectronAPILike {
  const api: ElectronAPILike = {
    getAppVersion: vi.fn(async () => "1.2.3"),
    getUpdateState: vi.fn(async () => ({
      status: "idle",
      lastCheckedAt: null,
      currentVersion: "1.2.3",
      latestVersion: null,
      downloadProgress: null,
      releaseNotes: null,
      error: null,
      feedUrl: null,
    })),
    checkForUpdates: vi.fn(async () => ({ status: "checking" })),
    downloadUpdate: vi.fn(async () => ({ status: "downloading" })),
    installUpdate: vi.fn(async () => {}),
    onUpdateState: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: ElectronAPILike }).electronAPI = api;
  return api;
}

function clearElectronApi() {
  // setup.ts defines window.electronAPI as a writable property with
  // value {} so feature-detection (`typeof api.getUpdateState !== "function"`)
  // returns false. Reset back to that shape so getDesktopUpdaterApi() sees
  // "no real bridge".
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
}

beforeEach(() => {
  clearElectronApi();
});

afterEach(() => {
  clearElectronApi();
});

describe("AppVersionCard — admin-panel update card", () => {
  it("renders the Check-for-updates button when the Electron bridge is present", async () => {
    installElectronApi();
    render(<AppVersionCard />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Check for updates/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows the installed version once getAppVersion resolves", async () => {
    installElectronApi();
    render(<AppVersionCard />);
    await waitFor(() => {
      expect(screen.getByText(/Installed v1\.2\.3/i)).toBeInTheDocument();
    });
  });

  it("falls back to the Browser-preview placeholder when no bridge is present", () => {
    // No installElectronApi() — electronAPI stays {} from setup.ts, so
    // getDesktopUpdaterApi() returns null.
    render(<AppVersionCard />);
    expect(screen.getByText(/Browser preview/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Check for updates/i }),
    ).not.toBeInTheDocument();
  });
});
