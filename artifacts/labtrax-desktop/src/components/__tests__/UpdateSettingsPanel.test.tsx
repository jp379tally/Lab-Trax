/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdateSettingsPanel } from "../UpdateSettingsPanel";

afterEach(() => {
  cleanup();
  (window as any).electronAPI = {};
});

describe("UpdateSettingsPanel", () => {
  it("is hidden when the Electron update bridge is absent", () => {
    (window as any).electronAPI = undefined;
    const { container } = render(<UpdateSettingsPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows guided signed-installer transition steps for a portable Windows build", async () => {
    const api = {
      getAppVersion: vi.fn().mockResolvedValue("2.4.1"),
      getBuildMetadata: vi.fn().mockResolvedValue({ version: "2.4.1", buildNumber: 143, updateChannel: "portable" }),
      getUpdateState: vi.fn().mockResolvedValue({
        currentVersion: "2.4.1",
        status: "idle",
        autoUpdaterEnabled: false,
        updateChannel: "portable",
        manualInstallerUrl: "https://lab-trax.replit.app/downloads/LabTrax-Setup.exe",
        installerPlatform: "windows",
      }),
      onUpdateState: vi.fn(() => () => {}),
      checkForUpdates: vi.fn(),
      installUpdate: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(true),
    };
    (window as any).electronAPI = api;
    render(<UpdateSettingsPanel />);
    expect(await screen.findByText("v2.4.1")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-build-number")).toHaveTextContent("143");
    expect(screen.getByTestId("desktop-update-channel")).toHaveTextContent("portable");
    expect(screen.getByText(/portable copy cannot update itself/i)).toBeInTheDocument();
    expect(screen.getByText(/do not use the portable zip/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check for updates/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /download signed windows installer/i }));
    await waitFor(() =>
      expect(api.openExternal).toHaveBeenCalledWith(
        "https://lab-trax.replit.app/downloads/LabTrax-Setup.exe",
      ),
    );
    expect(api.checkForUpdates).not.toHaveBeenCalled();
  });

  it("keeps Microsoft Store guidance separate from direct installer downloads", async () => {
    (window as any).electronAPI = {
      getAppVersion: vi.fn().mockResolvedValue("2.4.1"),
      getBuildMetadata: vi.fn().mockResolvedValue({ version: "2.4.1", buildNumber: null, updateChannel: null }),
      getUpdateState: vi.fn().mockResolvedValue({
        currentVersion: "2.4.1",
        status: "idle",
        autoUpdaterEnabled: false,
        isWindowsStore: true,
        manualInstallerUrl: null,
      }),
      onUpdateState: vi.fn(() => () => {}),
      checkForUpdates: vi.fn(),
      installUpdate: vi.fn(),
      openExternal: vi.fn(),
    };
    render(<UpdateSettingsPanel />);
    expect(await screen.findByText(/delivered through the microsoft store/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download signed/i })).not.toBeInTheDocument();
  });

  it("offers a signed-installer recovery link when the update feed fails", async () => {
    const api = {
      getAppVersion: vi.fn().mockResolvedValue("2.4.1"),
      getBuildMetadata: vi.fn().mockResolvedValue({ version: "2.4.1", buildNumber: null, updateChannel: null }),
      getUpdateState: vi.fn().mockResolvedValue({
        currentVersion: "2.4.1",
        status: "error",
        autoUpdaterEnabled: true,
        manualInstallerUrl: "https://lab-trax.replit.app/downloads/LabTrax.dmg",
        installerPlatform: "macos",
        error: "Cannot load update feed",
      }),
      onUpdateState: vi.fn(() => () => {}),
      checkForUpdates: vi.fn(),
      installUpdate: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(true),
    };
    (window as any).electronAPI = api;
    render(<UpdateSettingsPanel />);
    expect(await screen.findByText(/update feed could not be reached/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /download signed macos installer/i }));
    await waitFor(() =>
      expect(api.openExternal).toHaveBeenCalledWith(
        "https://lab-trax.replit.app/downloads/LabTrax.dmg",
      ),
    );
  });

  it("checks manually and offers restart when a download is ready", async () => {
    let emitState: ((state: any) => void) | undefined;
    const api = {
      getAppVersion: vi.fn().mockResolvedValue("2.4.1"),
      getBuildMetadata: vi.fn().mockResolvedValue({ version: "2.4.1", buildNumber: null, updateChannel: null }),
      getUpdateState: vi.fn().mockResolvedValue({ currentVersion: "2.4.1", status: "idle", autoUpdaterEnabled: true }),
      onUpdateState: vi.fn((callback: (state: any) => void) => {
        emitState = callback;
        return () => {};
      }),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    };
    (window as any).electronAPI = api;
    render(<UpdateSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /check for updates/i }));
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledTimes(1));
    emitState?.({ currentVersion: "2.4.1", latestVersion: "2.5.0", status: "downloaded", autoUpdaterEnabled: true });
    const install = await screen.findByRole("button", { name: /restart & update/i });
    fireEvent.click(install);
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/v2.5.0 has been downloaded/i)).toBeInTheDocument();
  });

  it("clearly marks missing installed build metadata as unavailable", async () => {
    (window as any).electronAPI = {
      getAppVersion: vi.fn().mockResolvedValue("2.4.1"),
      getBuildMetadata: vi.fn().mockResolvedValue({
        version: null,
        buildNumber: null,
        updateChannel: null,
      }),
      getUpdateState: vi.fn().mockResolvedValue({ status: "idle", autoUpdaterEnabled: true }),
      onUpdateState: vi.fn(() => () => {}),
      checkForUpdates: vi.fn(),
      installUpdate: vi.fn(),
    };
    render(<UpdateSettingsPanel />);
    expect(await screen.findByTestId("desktop-installed-version")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("desktop-build-number")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("desktop-update-channel")).toHaveTextContent("Unavailable");
  });
});
