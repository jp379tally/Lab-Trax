/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { getManualBackupProgress, resetManualBackupProgress } from "@/lib/manual-backup-progress";

const MANAGE_URL = "https://replit.com/@test-owner/test-slug";
const ORIGINAL_INNER_WIDTH = window.innerWidth;
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

let googleStatus: Record<string, unknown>;
let schedule: Record<string, unknown>;
let savedSchedule: Record<string, unknown> | null;
let manualRunBody: Record<string, unknown> | null;
let manualRunCount: number;
let asyncManualRun: boolean;
let manualLiveStatus: Record<string, unknown>;
let historyRuns: Array<Record<string, unknown>>;
let scheduledTestCalled = false;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSchedule(enabled = false) {
  return {
    interval: 24,
    unit: "hours",
    destination: null,
    path: null,
    enabled,
    lastSuccessfulBackupAt: new Date().toISOString(),
    staleAlertThresholdDays: 7,
    staleAlertRateLimitDays: 3,
    staleAfterDays: 7,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  googleStatus = {
    ok: true,
    connected: false,
    accountName: null,
    accountEmail: null,
    folder: "LabTrax Backups/non-production",
    error: "Google Drive is not connected.",
    manageUrl: MANAGE_URL,
  };
  schedule = makeSchedule();
  savedSchedule = null;
  manualRunBody = null;
  manualRunCount = 0;
  asyncManualRun = false;
  historyRuns = [];
  manualLiveStatus = {
    runId: "",
    state: "completed",
    phase: "backup complete",
    overallProgress: 100,
    elapsedMs: 1,
    metrics: {},
    result: {
      runId: "",
      size: 2_500_000,
      completedAt: new Date().toISOString(),
      fileName: "labtrax-test.zip.enc",
      archiveKind: "complete-non-production",
    },
  };
  resetManualBackupProgress("", "");
  scheduledTestCalled = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/admin/backup/google-drive-status")) return jsonResponse(googleStatus);
    if (url.includes("/admin/backup/schedule/run-now")) {
      scheduledTestCalled = true;
      return jsonResponse({
        ok: true,
        destination: "google-drive",
        size: 2_500_000,
        fileName: "labtrax-test.zip.enc",
        completedAt: new Date().toISOString(),
      });
    }
    if (url.includes("/admin/backup/schedule")) {
      if (init?.method === "PUT") {
        savedSchedule = JSON.parse(String(init.body)) as Record<string, unknown>;
        schedule = { ...schedule, ...savedSchedule };
        return jsonResponse(schedule);
      }
      return jsonResponse(schedule);
    }
    if (url.includes("/admin/backup/run")) {
      manualRunCount += 1;
      manualRunBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (asyncManualRun) {
        manualLiveStatus = { ...manualLiveStatus, runId: manualRunBody.runId, state: "running" };
        return jsonResponse({ ok: true, runId: manualRunBody.runId, state: "running" });
      }
      return jsonResponse({
        ok: true,
        archiveKind: manualRunBody.archiveKind ?? "complete-non-production",
        size: 2_500_000,
        completedAt: new Date().toISOString(),
        fileName: "labtrax-test.zip.enc",
      });
    }
    if (url.includes("/admin/backup/status/")) {
      return jsonResponse(manualLiveStatus);
    }
    if (url.includes("/admin/backup/history") && !url.includes("history-retention")) {
      return jsonResponse({ ok: true, runs: historyRuns });
    }
    return jsonResponse({ ok: true, items: [], data: [], runs: [] });
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: ORIGINAL_INNER_WIDTH });
  window.history.replaceState(null, "", "/");
});

async function renderBackupSettings() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → Google Drive", () => {
  it("requires an explicit database-only choice and labels the result as excluding media", async () => {
    googleStatus = { ...googleStatus, connected: true, error: null };
    schedule.sourceEnvironment = "production";
    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));
    const contents = await screen.findByRole("combobox", { name: "Backup contents" });
    expect(contents).toHaveValue("full");
    fireEvent.change(contents, { target: { value: "database-only" } });
    const button = screen.getByRole("button", { name: "Back up now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(manualRunBody).toMatchObject({ destination: "google-drive", archiveKind: "database-only" }));
    await screen.findByText(/Database-only backup delivered\. Media is excluded/);
    expect(screen.queryByText(/^Backup complete\./)).not.toBeInTheDocument();
  });
  it.each(["development", "production"] as const)("labels the connected %s database source", async (source) => {
    schedule.sourceEnvironment = source;
    await renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-source-label").textContent).toContain(
      source === "production" ? "Production" : "Development",
    ));
  });

  it("shows actionable disconnected guidance and offers workspace linking", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));

    const notice = await screen.findByTestId("google-drive-status-disconnected");
    expect(notice).toHaveTextContent(/hosting workspace/i);
    expect(notice).toHaveTextContent(/desktop browser may not complete account linking/i);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();

    fireEvent.click(screen.getByTestId("google-drive-connect-button"));
    expect(openSpy).toHaveBeenCalledWith(MANAGE_URL, "_blank", "noopener,noreferrer");
  });

  it("keeps destinations, long paths, and path controls usable at a narrow width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 440 });
    const longFolderPath = `LabTrax Backups/non-production/${"deeply-nested-folder/".repeat(8)}2026`;
    googleStatus = {
      ...googleStatus,
      connected: true,
      accountName: "Backup Account",
      folder: longFolderPath,
      error: null,
    };
    historyRuns = [{
      id: 99,
      triggeredBy: "manual",
      destination: "local",
      path: longFolderPath,
      fileName: "backup.zip.enc",
      sizeBytes: 2500,
      status: "success",
      error: null,
      completedAt: new Date().toISOString(),
      mediaFileCount: 1,
      attachmentRowCount: 1,
      partialFailure: false,
      warnings: null,
      archiveKind: "complete-non-production",
    }];

    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));

    const destinations = screen.getByTestId("backup-destination-choices");
    const googleNotice = await screen.findByTestId("google-drive-status-connected");
    const localChoice = screen.getByRole("radio", { name: "Local folder / USB" });
    expect(screen.getByTestId("settings-layout")).toHaveClass("flex-col", "md:flex-row");
    expect(screen.getByTestId("settings-layout").querySelector("nav")).toHaveClass("w-full", "md:w-48");
    expect(destinations).toHaveClass("min-w-0");
    expect(googleNotice).toHaveClass("break-words");
    expect(googleNotice).toHaveTextContent(longFolderPath);
    expect(screen.getByTitle(longFolderPath)).toHaveClass("break-words");
    expect(screen.getByTitle(longFolderPath)).not.toHaveClass("truncate");
    expect(localChoice.closest("label")).toHaveClass("min-w-0");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();

    fireEvent.click(screen.getByRole("radio", { name: "Network server" }));
    expect(screen.getByPlaceholderText(/server/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
  });

  it("sends manual backups to Google Drive without asking for a local path", async () => {
    googleStatus = {
      ...googleStatus,
      connected: true,
      accountName: "Backup Account",
      error: null,
    };
    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));
    await screen.findByTestId("google-drive-status-connected");

    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(manualRunBody).not.toBeNull());
    expect(manualRunBody).toMatchObject({ destination: "google-drive" });
    expect(manualRunBody).not.toHaveProperty("path");
  });

  it("reconnects to the same active run after Settings unmounts without starting a duplicate", async () => {
    googleStatus = { ...googleStatus, connected: true, error: null };
    asyncManualRun = true;
    manualLiveStatus = {
      runId: "",
      state: "running",
      phase: "Google Drive transfer",
      overallProgress: 43,
      elapsedMs: 1000,
      metrics: { uploadedBytes: 43, uploadTotalBytes: 100 },
    };
    const first = await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("43%"));
    expect(manualRunCount).toBe(1);
    const runId = String(manualRunBody?.runId);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/i);

    first.unmount();
    manualLiveStatus = {
      ...manualLiveStatus,
      overallProgress: 65,
      elapsedMs: 2500,
      metrics: { uploadedBytes: 65, uploadTotalBytes: 100 },
    };
    await renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("65%"));
    expect(screen.getByRole("button", { name: "Backing up…" })).toBeDisabled();
    expect(manualRunCount).toBe(1);

    manualLiveStatus = {
      runId,
      state: "completed",
      phase: "backup complete",
      overallProgress: 100,
      elapsedMs: 3000,
      metrics: {},
      result: {
        runId,
        size: 2_500_000,
        completedAt: new Date().toISOString(),
        fileName: "labtrax-test.zip.enc",
        archiveKind: "complete-non-production",
      },
    };
    await waitFor(() => expect(getManualBackupProgress().state).toBe("completed"), { timeout: 7000 });
    expect(getManualBackupProgress().result).toMatchObject({
      size: 2_500_000, fileName: "labtrax-test.zip.enc",
    });
    await waitFor(
      () => expect(screen.getByText(/Backup complete\./)).toBeInTheDocument(),
      { timeout: 7000 },
    );
    expect(manualRunCount).toBe(1);
  });

  it("keeps the Desktop-owned local transfer running and reconnectable after Settings unmounts", async () => {
    const runId = "2cd9aedf-87cf-40f6-8d10-920db0a0aef7";
    manualLiveStatus = {
      runId,
      state: "running",
      phase: "local download",
      overallProgress: 42,
      elapsedMs: 1000,
      metrics: { transferredBytes: 42, transferTotalBytes: 100 },
      delivery: {
        fileName: "labtrax-test.zip.enc",
        size: 2_500_000,
        archiveKind: "complete-non-production",
        sourceEnvironment: "non-production",
      },
    };
    let finishDownload!: (result: Record<string, unknown>) => void;
    const downloadBackupToFolder = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      finishDownload = resolve;
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      downloadBackupToFolder,
      onBackupRunId: (listener: (id: string) => void) => {
        listener(runId);
        return () => {};
      },
    };

    const first = await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Local folder / USB" }));
    const folder = await screen.findByPlaceholderText(/Backups/);
    fireEvent.change(folder, { target: { value: "/synthetic-usb" } });
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(downloadBackupToFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("42%"));

    first.unmount();
    manualLiveStatus = {
      ...manualLiveStatus,
      overallProgress: 65,
      elapsedMs: 2500,
      metrics: { transferredBytes: 65, transferTotalBytes: 100 },
    };
    await renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("65%"));
    expect(downloadBackupToFolder).toHaveBeenCalledOnce();

    finishDownload({
      ok: true,
      fileName: "labtrax-test.zip.enc",
      path: "/synthetic-usb/labtrax-test.zip.enc",
      sizeBytes: 2_500_000,
      downloadRunId: runId,
      archiveKind: "complete-non-production",
      partialFailure: false,
    });
    await waitFor(() => expect(screen.getByText(/Backup complete\./)).toBeInTheDocument());
    expect(getManualBackupProgress().result).toMatchObject({
      savedTo: "/synthetic-usb/labtrax-test.zip.enc",
      fileName: "labtrax-test.zip.enc",
    });
    expect(downloadBackupToFolder).toHaveBeenCalledOnce();
    expect(manualRunCount).toBe(1);
    expect(manualRunBody).toMatchObject({ destination: "browser" });
    expect(manualRunBody?.runId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("saves a Google Drive schedule without a path and offers Run now", async () => {
    googleStatus = { ...googleStatus, connected: true, error: null };
    await renderBackupSettings();
    const destination = await waitFor(() => {
      const match = screen.getAllByRole("combobox").find((element) =>
        Array.from((element as HTMLSelectElement).options)
          .some((option) => option.value === "google-drive"));
      expect(match).toBeDefined();
      return match;
    });
    expect(destination).toBeDefined();
    fireEvent.change(destination!, { target: { value: "google-drive" } });
    await screen.findByTestId("google-drive-status-connected");
    fireEvent.click(screen.getByLabelText("Enable automatic backups"));
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(savedSchedule).not.toBeNull());
    expect(savedSchedule).toMatchObject({
      destination: "google-drive",
      enabled: true,
      path: null,
    });
    expect(await screen.findByRole("button", { name: "Run now" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(scheduledTestCalled).toBe(true));
  });
});

