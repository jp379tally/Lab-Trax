/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { setSessionSecret, clearSessionSecret } from "@/lib/platform-admin-session";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";
import { resetManualBackupProgress } from "@/lib/manual-backup-progress";

const ADMIN_USER = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
  phone: null,
  phoneVerifiedAt: null,
  practiceOrganizationId: null,
  practiceLogoUrl: null,
};

const emptySchedule = {
  sourceEnvironment: "development",
  allowedScheduleIntervalsMinutes: [5, 15, 20, 30, 60, 360, 1440, 2880, 4320],
  interval: null,
  unit: null,
  destination: null,
  path: null,
  enabled: false,
  lastSuccessfulBackupAt: null,
  staleAlertThresholdDays: 7,
  staleAlertRateLimitDays: 3,
  staleAfterDays: 7,
};

let schedule: Record<string, unknown>;
let savedSchedule: Record<string, unknown> | null;
let manualProgressPhase = "case-media transfer into archive";
let manualProgressMetrics: Record<string, number> = { completedBytes: 2048, totalBytes: 4096 };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  setSessionSecret("synthetic-backup-settings-test-pin");
  window.localStorage.clear();
  schedule = { ...emptySchedule };
  savedSchedule = null;
  manualProgressPhase = "case-media transfer into archive";
  manualProgressMetrics = { completedBytes: 2048, totalBytes: 4096 };
  resetManualBackupProgress("", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/admin/backup/status/")) {
        return jsonResponse({
          runId: url.split("/").pop(),
          state: "running",
          phase: manualProgressPhase,
          overallProgress: manualProgressPhase === "case-media transfer into archive" ? 51
            : manualProgressPhase === "database dump" ? 5
              : manualProgressPhase === "local download" ? 83 : 2,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          elapsedMs: 1500,
          metrics: manualProgressMetrics,
        });
      }
      if (url.includes("/admin/backup/onedrive-status")) {
        return jsonResponse({ ok: true, connected: true, folder: "LabTrax Backups" });
      }
      if (url.includes("/admin/backup/google-drive-status")) {
        return jsonResponse({ ok: true, connected: true, folder: "LabTrax Backups", accountName: null, accountEmail: null, error: null, manageUrl: null });
      }
      if (url.includes("/admin/backup/run")) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({
            ok: true,
            size: 1024,
            completedAt: new Date().toISOString(),
            fileName: "complete-backup.zip.enc",
            archiveKind: "complete-non-production",
            partialFailure: false,
          })), 400);
        });
      }
      if (url.includes("/admin/backup/history-retention")) {
        return jsonResponse({
          ok: true,
          retentionDays: 30,
          dbRetentionDays: null,
          envRetentionDays: 30,
          maxRows: 200,
          dbMaxRows: null,
          envMaxRows: 200,
        });
      }
      if (url.includes("/admin/backup/history")) return jsonResponse({ ok: true, runs: [] });
      if (url.includes("/admin/backup/schedule")) {
        if (init?.method === "PUT") savedSchedule = JSON.parse(String(init.body));
        return jsonResponse(schedule);
      }
      return jsonResponse({ ok: true });
    }),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  clearSessionSecret();
  setScheduledLocalBackupProgress(null);
  resetManualBackupProgress("", "");
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function renderBackupTab(options: { adminSettingsPin?: string | null } = {}) {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  }, options);
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → schedule intervals", () => {
  it("keeps backup settings locked until the admin PIN session is present", async () => {
    clearSessionSecret();
    await renderBackupTab({ adminSettingsPin: null });
    expect(await screen.findByTestId("admin-settings-pin-gate")).toBeVisible();
    expect(screen.queryByTestId("backup-schedule-destination")).not.toBeInTheDocument();
  });
  it("shows the compact recovery layout while preserving schedule, manual backup, history, and restore", async () => {
    await renderBackupTab();

    const summary = await screen.findByTestId("backup-summary");
    const scheduleSection = screen.getByTestId("backup-schedule-section");
    const manualSection = screen.getByTestId("backup-manual-section");
    const historySection = screen.getByTestId("backup-history-section");
    const restoreSection = screen.getByTestId("backup-restore-section");

    expect(screen.getByRole("heading", { name: "Backup & Recovery" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Schedule Automatic Backups" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Manual Backup" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Backups" })).toBeInTheDocument();
    expect(screen.getByText("Manage encrypted backups and recovery destinations.")).toBeInTheDocument();
    expect(summary).toHaveAccessibleName("Backup status summary");
    expect(summary.compareDocumentPosition(scheduleSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scheduleSection.compareDocumentPosition(manualSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(manualSection.compareDocumentPosition(historySection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historySection.compareDocumentPosition(restoreSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("backup-summary-latest")).toBeVisible();
    expect(screen.getByTestId("backup-summary-upcoming")).toBeVisible();
    expect(screen.getByTestId("backup-summary-destination")).toBeVisible();
    expect(summary).toContainElement(await screen.findByTestId("backup-stale-headline"));
    expect(scheduleSection.parentElement).toBe(manualSection.parentElement);
    expect(scheduleSection.parentElement).toHaveClass("grid-cols-1", "xl:grid-cols-2", "min-w-0");
    expect(screen.getByText("Keep for (days)")).toBeInTheDocument();
    expect(screen.getByText("Max rows")).toBeInTheDocument();
  });

  it("shows the enabled backup cadence when the server has no next-run timestamp", async () => {
    schedule = {
      ...emptySchedule,
      interval: 15,
      unit: "minutes",
      enabled: true,
      effectiveIntervalMinutes: 15,
      lastSuccessfulBackupAt: new Date().toISOString(),
    };
    await renderBackupTab();

    const summaryHealth = await screen.findByTestId("backup-summary-health");
    await waitFor(() => expect(summaryHealth).toHaveTextContent("Automatic backups active"));
    expect(screen.getByTestId("backup-summary-upcoming")).toHaveTextContent("Runs automatically");
    expect(screen.getByTestId("backup-summary-upcoming")).toHaveTextContent("every 15 minutes");
    expect(screen.getByTestId("backup-summary-upcoming")).not.toHaveTextContent("Not scheduled");
  });

  it("shows whole-run manual progress, then removes the bar and confirms completion", async () => {
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "51"));
    expect(bar.firstElementChild).toHaveClass("backup-progress-stripes");
    expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("51%");

    expect(await screen.findByText(/Backup complete\./)).toBeInTheDocument();
    expect(screen.queryByTestId("manual-backup-progress-bar")).not.toBeInTheDocument();
  });

  it("shows the whole-run milestone when the current phase has no measurable total", async () => {
    manualProgressPhase = "database dump";
    manualProgressMetrics = { dumpBytes: 2048 };
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "5"));
    expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("5%");
    expect(await screen.findByText(/Backup complete\./)).toBeInTheDocument();
  });

  it("shows whole-run progress while the complete archive is downloading", async () => {
    manualProgressPhase = "local download";
    manualProgressMetrics = { transferredBytes: 1250, transferTotalBytes: 5000 };
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "83"));
    expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("83%");
    expect(await screen.findByText(/Backup complete\./)).toBeInTheDocument();
  });

  it("shows live progress for an active scheduled Desktop backup", async () => {
    setScheduledLocalBackupProgress({
      startedAt: Date.now() - 2_000,
      phase: "Recording the verified local backup",
      liveStatus: {
        runId: "0ad043e2-854a-4507-bec4-f99750738096",
        state: "running",
        phase: "case-media transfer into archive",
        elapsedMs: 1200,
        metrics: {
          completedBytes: 2048,
          totalBytes: 4096,
          completedFiles: 1,
          fileCount: 2,
        },
      },
    });
    await renderBackupTab();

    const progress = await screen.findByTestId("scheduled-backup-live-progress");
    expect(progress).toHaveTextContent("Scheduled Desktop backup");
    expect(progress).toHaveTextContent("Adding case media to archive");
    expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent("2.0 KB of 4.0 KB of case media added");
    expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent("1 of 2 media files");
  });

  it("offers development cadence choices and defaults to an unsaved 48-hour schedule", async () => {
    await renderBackupTab();

    const select = await screen.findByTestId("backup-schedule-interval") as HTMLSelectElement;
    expect(select).toHaveValue("48_hours");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Every 5 minutes", "Every 15 minutes", "Every 20 minutes", "Every 30 minutes", "Every hour", "Every 6 hours", "Every 24 hours",
      "Every 48 hours",
      "Every 72 hours",
    ]);
    expect(screen.getByTestId("backup-schedule-cadence-guidance")).toHaveTextContent(
      "This schedule protects the Development database only",
    );
  });

  it("keeps a saved legacy interval visible and warns before changing an active schedule", async () => {
    schedule = { ...emptySchedule, interval: 2, unit: "hours", enabled: true };
    await renderBackupTab();

    const select = await screen.findByTestId("backup-schedule-interval") as HTMLSelectElement;
    expect(select).toHaveValue("2_hours");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Current: every 2 hours (legacy)",
      "Every 5 minutes", "Every 15 minutes", "Every 20 minutes", "Every 30 minutes", "Every hour", "Every 6 hours", "Every 24 hours",
      "Every 48 hours",
      "Every 72 hours",
    ]);
    expect(screen.getByTestId("backup-schedule-legacy-cadence")).toHaveTextContent(
      "Select a cadence allowed for this database and save to update it",
    );
  });

  it("offers all requested production intervals and all four destinations", async () => {
    schedule = {
      ...emptySchedule,
      sourceEnvironment: "production",
      allowedScheduleIntervalsMinutes: [5, 15, 20, 30, 60, 360, 1440],
      interval: null,
      unit: null,
    };
    await renderBackupTab();

    const select = await screen.findByTestId("backup-schedule-interval") as HTMLSelectElement;
    expect(select).toHaveValue("15_minutes");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Every 5 minutes", "Every 15 minutes", "Every 20 minutes", "Every 30 minutes", "Every hour", "Every 6 hours", "Every 24 hours",
    ]);
    expect(screen.getByTestId("backup-schedule-cadence-guidance")).toHaveTextContent(
      "Choose the destination and interval for production backups",
    );
    const destination = screen.getByTestId("backup-schedule-destination") as HTMLSelectElement;
    expect(Array.from(destination.options).map(option => [option.value, option.disabled])).toEqual([
      ["local", false], ["network", false], ["onedrive", false], ["google-drive", false],
    ]);
  });
  it("saves the selected Google Drive production destination and twenty-minute cadence", async () => {
    schedule = { ...emptySchedule, sourceEnvironment: "production", allowedScheduleIntervalsMinutes: [5, 15, 20, 30, 60, 360, 1440] };
    await renderBackupTab();
    const destination = await screen.findByTestId("backup-schedule-destination");
    fireEvent.change(destination, { target: { value: "google-drive" } });
    fireEvent.change(screen.getByTestId("backup-schedule-interval"), { target: { value: "20_minutes" } });
    fireEvent.click(screen.getByLabelText("Enable automatic backups"));
    const save = screen.getByRole("button", { name: "Save schedule" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(savedSchedule).toMatchObject({ destination: "google-drive", interval: 20, unit: "minutes", enabled: true }));
  });
  it("reports verified readable media separately from missing-original complete recovery", async () => {
    schedule = {
      ...emptySchedule,
      sourceEnvironment: "production",
      offsite: {
        enabled: true, stale: false,
        databaseProtection: {
          state: "partial", stage: "Records and readable media verified", coverage: "partial",
          mediaFiles: 2, mediaBytes: 5000, missingFiles: 1,
          lastVerifiedAt: "2026-10-25T12:00:00.000Z",
          lastDestinationCheckAt: "2026-10-25T12:00:00.000Z",
          dumpBytes: 1000, newChunks: 2, newBytes: 500, reusedChunks: 4, error: null,
        },
      },
    };
    await renderBackupTab();
    expect(await screen.findByTestId("database-protection-status")).toHaveTextContent("partial");
    expect(screen.getByTestId("database-protection-status")).toHaveTextContent("not complete recovery");
    expect(screen.getByTestId("database-protection-status")).toHaveTextContent("missing originals: 1");
    expect(screen.queryByTestId("backup-full-archive-interval")).not.toBeInTheDocument();
  });
});
