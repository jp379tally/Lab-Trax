import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupWebScreen from "./BackupWebScreen";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  schedule: {
    sourceEnvironment: undefined as "development" | "production" | undefined,
    enabled: false,
    interval: 15,
    unit: "minutes" as const,
    destination: "local" as "local" | "network" | "onedrive" | "google-drive",
    path: "C:\\Backups\\LabTrax" as string | null,
    lastSuccessfulBackupAt: "2026-10-12T16:00:00.000Z",
    staleAlertThresholdDays: 7,
    staleAlertRateLimitDays: 3,
    staleAfterDays: 7,
    offsite: {
      enabled: true,
      running: true,
      intervalMinutes: 15,
      lastVerifiedAt: "2026-10-12T16:00:00.000Z",
      stale: false,
      ageMinutes: 1,
      source: "onedrive" as const,
    },
    fullArchiveIntervalMinutes: 60,
    newestArchive: {
      name: "labtrax-backup-test-full.zip.enc",
      createdAt: "2026-10-12T16:00:00.000Z",
      sizeBytes: 1024,
      ageMinutes: 1,
    },
    archiveCount: 1,
  },
  scheduleError: false,
  oneDrive: {
    connected: true,
    accountName: "Backup account",
    accountEmail: "backup@example.test",
    folder: "Apps/LabTrax Backups",
    error: null,
    manageUrl: null,
  },
  googleDrive: {
    connected: true,
    accountName: "Backup account",
    accountEmail: "backup@example.test",
    folder: "LabTrax Backups/non-production",
    error: null,
    manageUrl: null,
  },
  history: [] as Array<Record<string, unknown>>,
  saveBackupSchedule: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  runBackupNow: vi.fn(async (..._args: unknown[]) => ({
    fileName: "manual-full.zip.enc",
    size: 1024,
    completedAt: "2026-10-12T16:00:00Z",
    partialFailure: false,
    warnings: null as string | null,
  })),
  oneDriveRefetch: vi.fn(),
  googleDriveRefetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn(async () => undefined) },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    const data = queryKey[1] === "backup-schedule-web"
      ? mocks.scheduleError ? undefined : mocks.schedule
      : queryKey[1] === "backup-onedrive-status-web"
        ? mocks.oneDrive
        : queryKey[1] === "backup-google-drive-status-web"
          ? mocks.googleDrive
        : queryKey[1] === "backup-history-web"
          ? { runs: mocks.history }
          : { retentionDays: 90, maxRows: 500 };
    const isError = queryKey[1] === "backup-schedule-web" && mocks.scheduleError;
    return { data, isLoading: false, isError, error: isError ? new Error("Not authorized") : null, refetch: mocks.oneDriveRefetch };
  },
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("@workspace/api-client-react", async () => ({
  followManualBackup: (await import("../../../../lib/api-client-react/src/manual-backup-job")).followManualBackup,
  getBackupRunStatus: vi.fn(),
  disableBackupSchedule: vi.fn(),
  getBackupSchedule: vi.fn(),
  getGoogleDriveBackupStatus: vi.fn(),
  getOneDriveBackupStatus: vi.fn(),
  getRestoreStatus: vi.fn(),
  runBackupNow: mocks.runBackupNow,
  saveBackupSchedule: mocks.saveBackupSchedule,
}));

vi.mock("@/lib/platform-admin-session", () => ({
  getPlatformAdminSessionHeaders: async () => ({ "X-Platform-Admin-Session": "test-only-session" }),
}));

vi.mock("@/lib/query-client", () => ({
  resilientFetch: mocks.download,
  getApiUrl: () => "https://backup.example.test/",
  refreshAndGetAccessToken: async () => null,
  getCsrfToken: () => null,
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.download }));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      background: "#fff",
      border: "#ddd",
      error: "#c00",
      surface: "#fff",
      surfaceAlt: "#f5f5f5",
      text: "#111",
      textSecondary: "#555",
      textTertiary: "#777",
      tint: "#0674e7",
      warning: "#b66b00",
    },
  }),
}));

vi.mock("@/components/settings/SettingsRow", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

describe("BackupWebScreen schedule intervals", () => {
  beforeEach(() => {
    mocks.schedule.sourceEnvironment = undefined;
    vi.clearAllMocks();
    mocks.schedule.interval = 15;
    mocks.schedule.unit = "minutes";
    mocks.scheduleError = false;
    mocks.oneDrive.connected = true;
    mocks.googleDrive.connected = true;
    mocks.history = [];
    mocks.download.mockReset();
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["development", "production"] as const)("labels the connected %s database without changing bindings", async (source) => {
    mocks.schedule.sourceEnvironment = source;
    const view = await render(<BackupWebScreen />);
    expect(view.getByText(`Database source: ${source === "production" ? "Production" : "Development"}`)).toBeTruthy();
  });

  it.each([
    { kind: "complete-non-production", truncated: false, succeeds: true },
    { kind: "db-only", truncated: false, succeeds: false },
    { kind: "complete-non-production", truncated: true, succeeds: false },
  ])("offers a local file only for confirmed complete bytes: $kind, truncated=$truncated", async ({ kind, truncated, succeeds }) => {
    const bytes = new Uint8Array(44);
    bytes.set([76, 84, 82, 50]);
    bytes.set([76, 84, 70, 49], 32);
    new DataView(bytes.buffer).setBigUint64(36, 32n, false);
    mocks.download.mockResolvedValueOnce(new Response(truncated ? bytes.slice(0, 35) : bytes, {
      headers: {
        "x-backup-archive-kind": kind,
        "x-backup-coverage-version": "1",
        "x-backup-media-file-count": "0",
        "x-backup-attachment-row-count": "0",
        "content-length": "44",
      },
    }));
    const screen = await render(<BackupWebScreen />);
    const click = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({ click, remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    });
    const createObjectURL = vi.fn(() => "blob:synthetic-backup");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    await fireEvent.press(screen.getByTestId("manual-backup-run"));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(
      "https://backup.example.test/api/admin/backup/generate",
      expect.objectContaining({ method: "POST", headers: { "X-Platform-Admin-Session": "test-only-session" } }),
    ));
    if (succeeds) {
      await waitFor(() => expect(screen.getByTestId("manual-backup-result")).toBeTruthy());
      expect(click).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } else {
      await waitFor(() => expect(screen.queryByTestId("manual-backup-error")).toBeTruthy());
      expect(screen.queryByTestId("manual-backup-result")).toBeNull();
      expect(click).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("streams to the selected file, truncated=%s, without a browser-memory blob", async (truncated) => {
    mocks.schedule.sourceEnvironment = "production";
    const bytes = new Uint8Array(44);
    bytes.set([76, 84, 82, 50]);
    bytes.set([76, 84, 70, 49], 32);
    new DataView(bytes.buffer).setBigUint64(36, 32n, false);
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({
      name: "synthetic-complete.zip.enc", createWritable: async () => writable,
    })));
    mocks.download.mockResolvedValueOnce(new Response(truncated ? bytes.slice(0, 35) : bytes, {
      headers: {
        "x-backup-archive-kind": "complete-production", "x-backup-coverage-version": "1",
        "x-backup-media-file-count": "0", "x-backup-attachment-row-count": "0",
      },
    }));
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-run"));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(
      "https://backup.example.test/api/admin/backup/generate",
      expect.objectContaining({ headers: {
        "X-Platform-Admin-Session": "test-only-session", "X-LabTrax-Backup-Source": "production",
      } }),
    ));
    if (truncated) {
      await waitFor(() => expect(screen.getByTestId("manual-backup-error")).toBeTruthy());
      expect(writable.abort).toHaveBeenCalledOnce();
      expect(writable.close).not.toHaveBeenCalled();
      expect(screen.queryByTestId("manual-backup-result")).toBeNull();
    } else {
      await waitFor(() => expect(screen.getByTestId("manual-backup-result")).toBeTruthy());
      expect(writable.close).toHaveBeenCalledOnce();
      expect(writable.abort).not.toHaveBeenCalled();
    }
  });

  it("shows the approved 5-minute, 10-minute, 15-minute, and 1-hour choices", async () => {
    const screen = await render(<BackupWebScreen />);

    expect(screen.getByTestId("schedule-frequency-5-minutes")).toBeTruthy();
    expect(screen.getByTestId("schedule-frequency-10-minutes")).toBeTruthy();
    expect(screen.getByTestId("schedule-frequency-15-minutes")).toBeTruthy();
    expect(screen.getByTestId("schedule-frequency-1-hours")).toBeTruthy();
  });

  it("preserves an existing legacy interval until the administrator changes it", async () => {
    mocks.schedule.interval = 30;
    const screen = await render(<BackupWebScreen />);

    expect(screen.getByTestId("schedule-frequency-30-minutes")).toBeTruthy();
    expect(screen.getByTestId("schedule-legacy-frequency")).toBeTruthy();
  });

  it("saves the explicitly selected five-minute routine without changing off-site settings", async () => {
    const screen = await render(<BackupWebScreen />);
    expect(mocks.saveBackupSchedule).not.toHaveBeenCalled();
    expect(screen.getByTestId("schedule-enabled-switch").props.value).toBe(false);
    await fireEvent.press(screen.getByTestId("schedule-frequency-5-minutes"));
    await fireEvent.press(screen.getByTestId("schedule-destination-onedrive"));
    await fireEvent.press(screen.getByTestId("schedule-save"));

    await waitFor(() => expect(mocks.saveBackupSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ interval: 5, unit: "minutes", destination: "onedrive", enabled: false }),
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(mocks.saveBackupSchedule.mock.calls[0][0]).not.toHaveProperty("offsite");
  });

  it("shows a disconnected OneDrive state, refreshes it, and blocks manual uploads", async () => {
    mocks.oneDrive.connected = false;
    const screen = await render(<BackupWebScreen />);
    expect(screen.getByTestId("onedrive-status-disconnected")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("onedrive-check-again-button"));
    expect(mocks.oneDriveRefetch).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("manual-backup-destination-onedrive"));
    expect(screen.getByTestId("manual-backup-run")).toBeDisabled();
  });

  it("uses the OneDrive manual route and reports a partial archive as a warning", async () => {
    mocks.runBackupNow.mockResolvedValueOnce({
      fileName: "manual-full.zip.enc",
      size: 1024,
      completedAt: "2026-10-12T16:00:00Z",
      partialFailure: true,
      warnings: "Profile photos were not included.",
    });
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-destination-onedrive"));
    await fireEvent.press(screen.getByTestId("manual-backup-run"));

    await waitFor(() => expect(mocks.runBackupNow).toHaveBeenCalledWith(
      { destination: "onedrive", path: "", runId: expect.any(String), respondAsync: true },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(screen.getByText("Backup completed with warnings")).toBeTruthy();
  });

  it("allows a connected Google Drive manual backup and reports its server-side result", async () => {
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-destination-google-drive"));
    await fireEvent.press(screen.getByTestId("manual-backup-run"));

    await waitFor(() => expect(mocks.runBackupNow).toHaveBeenCalledWith(
      { destination: "google-drive", path: "", runId: expect.any(String), respondAsync: true },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(screen.getByTestId("manual-google-drive-status")).toBeTruthy();
    expect(screen.getByTestId("manual-backup-result")).toBeTruthy();
  });

  it("recovers the exact cloud job after a gateway 502 without submitting twice", async () => {
    const api = await import("@workspace/api-client-react");
    mocks.runBackupNow.mockRejectedValueOnce(Object.assign(new Error("Request failed (502)"), { status: 502 }));
    vi.mocked(api.getBackupRunStatus).mockImplementationOnce(async runId => ({
      runId, state: "completed", phase: "backup complete",
      result: { runId, size: 1234, completedAt: "2026-10-21T12:00:00Z", fileName: "synthetic.enc",
        partialFailure: true, warnings: "One synthetic original is missing." },
    }));
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-destination-onedrive"));
    await fireEvent.press(screen.getByTestId("manual-backup-run"));
    await waitFor(() => expect(screen.getByText("Backup completed with warnings")).toBeTruthy());
    expect(mocks.runBackupNow).toHaveBeenCalledTimes(1);
    const runId = mocks.runBackupNow.mock.calls[0]![0] as { runId: string };
    expect(api.getBackupRunStatus).toHaveBeenCalledWith(runId.runId, expect.any(Object));
  });

  it("shows an actionable terminal cloud error, never backup success", async () => {
    const api = await import("@workspace/api-client-react");
    mocks.runBackupNow.mockResolvedValueOnce({ state: "running" } as never);
    vi.mocked(api.getBackupRunStatus).mockImplementationOnce(async runId => ({
      runId, state: "failed", phase: "OneDrive upload",
      error: "Reconnect OneDrive (HTTP 401); no verified backup was created.",
    }));
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-destination-onedrive"));
    await fireEvent.press(screen.getByTestId("manual-backup-run"));
    await waitFor(() => expect(screen.getByText(/Reconnect OneDrive/)).toBeTruthy());
    expect(screen.queryByTestId("manual-backup-result")).toBeNull();
  });

  it("saves Google Drive schedules without a local path and allows server-side Run now", async () => {
    mocks.schedule.enabled = true;
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("schedule-destination-google-drive"));
    await fireEvent.press(screen.getByTestId("schedule-save"));

    await waitFor(() => expect(mocks.saveBackupSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ destination: "google-drive", path: null, enabled: true }),
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    // The Run now control follows server-confirmed schedule state. Reflect
    // the successful save as the next query response before asserting it is
    // enabled; the unsaved local schedule still points at Local / USB.
    mocks.schedule = { ...mocks.schedule, destination: "google-drive", path: null };
    await screen.rerender(<BackupWebScreen />);
    expect(screen.getByTestId("schedule-run-now")).not.toBeDisabled();
  });

  it("blocks Google Drive manual uploads until the status endpoint confirms a connection", async () => {
    mocks.googleDrive.connected = false;
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("manual-backup-destination-google-drive"));
    expect(screen.getByTestId("google-drive-status-disconnected")).toBeTruthy();
    expect(screen.getByTestId("manual-backup-run")).toBeDisabled();
  });

  it("does not allow unknown schedule values to overwrite a failed status read", async () => {
    mocks.scheduleError = true;
    const screen = await render(<BackupWebScreen />);
    expect(screen.getByTestId("backup-status-error")).toBeTruthy();
    expect(screen.getByText(/Backup status could not be loaded\. Check your connection/)).toBeTruthy();
    expect(screen.queryByText("Not authorized")).toBeNull();
    expect(screen.getByTestId("schedule-save")).toBeDisabled();
  });

  it("shows a plain backup failure summary while keeping the cause available on request", async () => {
    mocks.history = [{
      id: 91,
      status: "error",
      destination: "onedrive",
      path: null,
      fileName: null,
      sizeBytes: null,
      completedAt: "2026-10-12T16:00:00Z",
      triggeredBy: "scheduler",
      error: "Backup failed during OneDrive transfer after 60s: Graph returned 503 Service Unavailable.",
      userMessage: "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details before deciding what to do next.",
    }];
    const screen = await render(<BackupWebScreen />);

    expect(screen.getByText(/no new complete recovery point was created/i)).toBeTruthy();
    expect(screen.queryByText(/Graph returned 503/)).toBeNull();
    await fireEvent.press(screen.getByText("Show failure details"));
    expect(screen.getByText(/Graph returned 503/)).toBeTruthy();
  });

  it("allows downloading a database-only archive but refuses it as a full restore source", async () => {
    mocks.history = [{
      id: 1,
      status: "success",
      destination: "onedrive",
      fileName: "test-db-only.zip.enc",
      completedAt: "2026-10-12T16:00:00Z",
      sizeBytes: 1024,
      archiveKind: "database-only",
      mediaFileCount: 0,
      attachmentRowCount: 1,
      triggeredBy: "scheduler:offsite",
    }];
    const screen = await render(<BackupWebScreen />);
    await fireEvent.press(screen.getByTestId("backup-history-select-1"));

    expect(screen.getByTestId("history-restore-selected")).toBeDisabled();
    expect(screen.getByTestId("history-download")).not.toBeDisabled();
    expect(screen.getByTestId("history-database-only-refusal")).toBeTruthy();
  });
});
