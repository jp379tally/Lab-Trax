/** @vitest-environment jsdom */
/**
 * Regression guard: desktop update-state IPC contract.
 *
 * Protected workflow: "Desktop update panel status display"
 *
 * The AppVersionCard in Settings → Desktop app is the persistent update-status
 * panel every user can visit. These tests lock in the IPC shape it expects from
 * electron/main.cjs and the visual state it shows for each status value so that:
 *   - A refactor that changes the state field names doesn't silently blank the
 *     version number or the status badge.
 *   - Every status transition (idle → checking → available → downloading →
 *     downloaded → not-available → error) renders the right label and buttons.
 *   - autoUpdaterEnabled:false (dev/skip build) shows the "dev build" note.
 *
 * Keep this test permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AppVersionCard } from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

type UpdateState = {
  status: string;
  lastCheckedAt: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  downloadProgress: number | null;
  releaseNotes: string | null;
  error: string | null;
  feedUrl: string | null;
  autoUpdaterEnabled: boolean;
};

function makeState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    status: "idle",
    lastCheckedAt: null,
    currentVersion: "2.3.4",
    latestVersion: null,
    downloadProgress: null,
    releaseNotes: null,
    error: null,
    feedUrl: null,
    autoUpdaterEnabled: true,
    ...overrides,
  };
}

type ElectronAPILike = {
  getAppVersion: () => Promise<string>;
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  downloadUpdate: () => Promise<UpdateState>;
  installUpdate: () => Promise<void>;
  onUpdateState: (cb: (s: UpdateState) => void) => () => void;
};

function installElectronApi(state: UpdateState): ElectronAPILike {
  const api: ElectronAPILike = {
    getAppVersion: vi.fn(async () => state.currentVersion ?? "0.0.0"),
    getUpdateState: vi.fn(async () => state),
    checkForUpdates: vi.fn(async () => state),
    downloadUpdate: vi.fn(async () => state),
    installUpdate: vi.fn(async () => {}),
    onUpdateState: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: ElectronAPILike }).electronAPI = api;
  return api;
}

function clearElectronApi() {
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
}

beforeEach(() => clearElectronApi());
afterEach(() => clearElectronApi());

const Wrapper = makeAuthWrapper("/settings");

describe("AppVersionCard — update IPC state transitions", () => {
  it("shows Installed version once getAppVersion resolves", async () => {
    installElectronApi(makeState({ currentVersion: "2.3.4" }));
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/Installed v2\.3\.4/i)).toBeInTheDocument(),
    );
  });

  it("shows Idle status badge by default", async () => {
    installElectronApi(makeState({ status: "idle" }));
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText("Idle")).toBeInTheDocument(),
    );
  });

  it("shows Up to date badge for not-available status", async () => {
    installElectronApi(makeState({ status: "not-available", latestVersion: "2.3.4" }));
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText("Up to date")).toBeInTheDocument(),
    );
  });

  it("shows Update available badge and Download button for available status", async () => {
    installElectronApi(
      makeState({ status: "available", latestVersion: "2.4.0" }),
    );
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByText(/Update available.*v2\.4\.0/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Download now/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows downloading progress badge for downloading status", async () => {
    installElectronApi(
      makeState({ status: "downloading", downloadProgress: 42 }),
    );
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/Downloading.*42%/i)).toBeInTheDocument(),
    );
  });

  it("shows Ready to install badge and Restart & install button for downloaded status", async () => {
    installElectronApi(
      makeState({ status: "downloaded", latestVersion: "2.4.0" }),
    );
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByText(/Ready to install v2\.4\.0/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Restart.*install/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows Check failed badge for error status", async () => {
    installElectronApi(
      makeState({ status: "error", error: "Network timeout" }),
    );
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText("Check failed")).toBeInTheDocument(),
    );
  });

  it("shows always-present Check for updates button", async () => {
    installElectronApi(makeState());
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Check for updates/i }),
      ).toBeInTheDocument(),
    );
  });

  it("shows dev-build note when autoUpdaterEnabled is false", async () => {
    installElectronApi(makeState({ autoUpdaterEnabled: false }));
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        screen.getByTestId("updater-disabled-note"),
      ).toBeInTheDocument(),
    );
  });

  it("does NOT show dev-build note when autoUpdaterEnabled is true", async () => {
    installElectronApi(makeState({ autoUpdaterEnabled: true }));
    render(<AppVersionCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/Installed v/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("updater-disabled-note")).toBeNull();
  });

  it("falls back to Browser-preview placeholder with no bridge", () => {
    clearElectronApi();
    render(<AppVersionCard />, { wrapper: Wrapper });
    expect(screen.getByText(/Browser preview/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Check for updates/i }),
    ).toBeNull();
  });
});
