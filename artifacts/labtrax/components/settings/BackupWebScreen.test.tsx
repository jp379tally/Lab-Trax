import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupWebScreen from "./BackupWebScreen";

const mocks = vi.hoisted(() => ({
  schedule: {
    enabled: false,
    interval: 15,
    unit: "minutes" as const,
    destination: "local" as const,
    path: "C:\\Backups\\LabTrax",
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
  queryClient: { invalidateQueries: vi.fn(async () => undefined) },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    const data = queryKey[1] === "backup-schedule-web"
      ? mocks.scheduleError ? undefined : mocks.schedule
      : queryKey[1] === "backup-onedrive-status-web"
        ? mocks.oneDrive
        : queryKey[1] === "backup-history-web"
          ? { runs: mocks.history }
          : { retentionDays: 90, maxRows: 500 };
    const isError = queryKey[1] === "backup-schedule-web" && mocks.scheduleError;
    return { data, isLoading: false, isError, error: isError ? new Error("Not authorized") : null, refetch: mocks.oneDriveRefetch };
  },
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("@workspace/api-client-react", () => ({
  disableBackupSchedule: vi.fn(),
  getBackupSchedule: vi.fn(),
  getOneDriveBackupStatus: vi.fn(),
  getRestoreStatus: vi.fn(),
  runBackupNow: mocks.runBackupNow,
  saveBackupSchedule: mocks.saveBackupSchedule,
}));

vi.mock("@/lib/platform-admin-session", () => ({
  getPlatformAdminSessionHeaders: async () => ({ "X-Platform-Admin-Session": "test-only-session" }),
}));

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
    vi.clearAllMocks();
    mocks.schedule.interval = 15;
    mocks.schedule.unit = "minutes";
    mocks.scheduleError = false;
    mocks.oneDrive.connected = true;
    mocks.history = [];
  });

  afterEach(async () => { await cleanup(); });

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
      { destination: "onedrive", path: "" },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(screen.getByText("Backup completed with warnings")).toBeTruthy();
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
