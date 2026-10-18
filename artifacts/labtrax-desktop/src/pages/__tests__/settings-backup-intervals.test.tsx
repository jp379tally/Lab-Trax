/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";

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
let manualProgressPhase = "case-media transfer into archive";
let manualProgressMetrics: Record<string, number> = { completedBytes: 2048, totalBytes: 4096 };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  schedule = { ...emptySchedule };
  manualProgressPhase = "case-media transfer into archive";
  manualProgressMetrics = { completedBytes: 2048, totalBytes: 4096 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/admin/backup/status/")) {
        return jsonResponse({
          runId: url.split("/").pop(),
          state: "running",
          phase: manualProgressPhase,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          elapsedMs: 1500,
          metrics: manualProgressMetrics,
        });
      }
      if (url.includes("/admin/backup/onedrive-status")) {
        return jsonResponse({ ok: true, connected: true, folder: "LabTrax Backups" });
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
      if (url.includes("/admin/backup/schedule")) return jsonResponse(schedule);
      return jsonResponse({ ok: true });
    }),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  setScheduledLocalBackupProgress(null);
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function renderBackupTab() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → schedule intervals", () => {
  it("keeps the summary, schedule, manual backup, history, and restore in DOM order", async () => {
    await renderBackupTab();

    const summary = await screen.findByTestId("backup-summary");
    const scheduleSection = screen.getByTestId("backup-schedule-section");
    const manualSection = screen.getByTestId("backup-manual-section");
    const historySection = screen.getByTestId("backup-history-section");
    const restoreSection = screen.getByTestId("backup-restore-section");

    expect(summary).toHaveAccessibleName("Backup status summary");
    expect(summary.compareDocumentPosition(scheduleSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scheduleSection.compareDocumentPosition(manualSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(manualSection.compareDocumentPosition(historySection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historySection.compareDocumentPosition(restoreSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("backup-summary-latest")).toBeVisible();
    expect(screen.getByTestId("backup-summary-upcoming")).toBeVisible();
    expect(screen.getByTestId("backup-summary-destination")).toBeVisible();
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

  it("shows measured manual progress, then removes the bar and confirms completion", async () => {
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    expect(bar.firstElementChild).toHaveClass("backup-progress-stripes");
    expect(screen.getByText("50%")).toBeInTheDocument();

    expect(await screen.findByText(/Backup complete\./)).toBeInTheDocument();
    expect(screen.queryByTestId("manual-backup-progress-bar")).not.toBeInTheDocument();
  });

  it("keeps the manual progress bar indeterminate when a phase has no completed/total pair", async () => {
    manualProgressPhase = "database dump";
    manualProgressMetrics = { dumpBytes: 2048 };
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(await screen.findByText(/Backup complete\./)).toBeInTheDocument();
  });

  it("shows a measured percentage while the complete archive is downloading", async () => {
    manualProgressPhase = "local download";
    manualProgressMetrics = { transferredBytes: 1250, transferTotalBytes: 5000 };
    await renderBackupTab();
    fireEvent.click(screen.getAllByLabelText("OneDrive")[0]!);
    const manualButton = await screen.findByRole("button", { name: "Back up now" });
    await waitFor(() => expect(manualButton).toBeEnabled());
    fireEvent.click(manualButton);

    const bar = await screen.findByTestId("manual-backup-progress-bar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"));
    expect(screen.getByText("25%")).toBeInTheDocument();
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

  it("offers the requested four choices and defaults to an unsaved 15-minute schedule", async () => {
    await renderBackupTab();

    const select = await screen.findByTestId("backup-schedule-interval") as HTMLSelectElement;
    expect(select).toHaveValue("15_minutes");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Every 5 minutes",
      "Every 10 minutes",
      "Every 15 minutes",
      "Every hour",
    ]);
  });

  it("keeps a saved legacy interval visible without replacing it", async () => {
    schedule = { ...emptySchedule, interval: 30, unit: "minutes", enabled: true };
    await renderBackupTab();

    const select = await screen.findByTestId("backup-schedule-interval") as HTMLSelectElement;
    expect(select).toHaveValue("30_minutes");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Current: every 30 minutes (legacy)",
      "Every 5 minutes",
      "Every 10 minutes",
      "Every 15 minutes",
      "Every hour",
    ]);
  });
});
