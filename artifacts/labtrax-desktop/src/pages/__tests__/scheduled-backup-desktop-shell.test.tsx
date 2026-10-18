/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/components/AppLayout";
import SettingsPage from "@/pages/settings";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";
import { getScheduledLocalBackupProgress, setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiFetchArrayBuffer: vi.fn(),
  reports: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: testState.apiFetch,
    apiFetchArrayBuffer: testState.apiFetchArrayBuffer,
  };
});
vi.mock("@/lib/uploads-context", () => ({
  useUploads: () => ({ entries: [], activeCount: 0, removeEntry: vi.fn(), cancelEntry: vi.fn() }),
}));
vi.mock("@/lib/customer-requests", () => ({
  customerRequestLabs: () => [],
  useCustomerRequestCounts: () => [],
}));
vi.mock("@/components/AiChatPanel", () => ({ AiChatPanel: () => null }));
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("@/components/ReportIssueDialog", () => ({
  canReportIssueRole: () => false,
  ReportIssueAction: () => null,
  FeedbackAction: () => null,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetDoctorDuplicateClusters: () => ({ data: { data: { totalGroups: 0 } } }),
  getGetDoctorDuplicateClustersQueryKey: () => ["clusters"],
}));
vi.mock("@/components/BackupStalenessBanner", () => ({
  useBackupFreshness: () => ({ stale: false }),
  BackupStalenessBanner: () => null,
}));

const ADMIN_USER = {
  id: "desktop-admin",
  username: "desktop-admin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
  phone: null,
  phoneVerifiedAt: null,
  practiceOrganizationId: null,
  practiceLogoUrl: null,
};
const RUN_ID = "0ad043e2-854a-4507-bec4-f99750738096";
const liveStatus = {
  runId: RUN_ID,
  state: "running" as const,
  phase: "case-media transfer into archive",
  elapsedMs: 1200,
  metrics: {
    completedBytes: 2048,
    totalBytes: 4096,
    completedFiles: 1,
    fileCount: 2,
  },
};
const schedule = {
  interval: 1,
  unit: "minutes",
  destination: "local",
  path: "C:\\LabTraxBackups",
  enabled: true,
  lastSuccessfulBackupAt: null,
  staleAlertThresholdDays: 7,
  staleAlertRateLimitDays: 3,
  staleAfterDays: 7,
};

function renderDesktopBackupSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const location = memoryLocation({ path: "/settings?tab=backup" });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <AuthContext.Provider
          value={{
            ...MOCK_AUTH_DEFAULTS,
            user: ADMIN_USER as any,
            status: "authed",
            restoreStatus: "ok",
            restoreNoticeDismissed: true,
          }}
        >
          <AppLayout>
            <SettingsPage />
          </AppLayout>
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setScheduledLocalBackupProgress(null);
  window.history.replaceState(null, "", "/settings?tab=backup");
  testState.reports = [];
  testState.apiFetch.mockReset();
  testState.apiFetchArrayBuffer.mockReset();
  testState.apiFetch.mockImplementation(async (endpoint: string, init?: { body?: string }) => {
    if (endpoint === "/admin/backup/schedule") return schedule;
    if (endpoint === `/admin/backup/status/${RUN_ID}`) return liveStatus;
    if (endpoint === "/admin/backup/desktop-run-report") {
      const report = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      testState.reports.push(report);
      return { completedAt: "2026-10-14T12:00:00.000Z" };
    }
    if (endpoint === "/admin/backup/history") return { ok: true, runs: [] };
    if (endpoint === "/admin/backup/history-retention") {
      return {
        ok: true,
        retentionDays: 30,
        dbRetentionDays: null,
        envRetentionDays: 30,
        maxRows: 200,
        dbMaxRows: null,
        envMaxRows: 200,
      };
    }
    if (endpoint === "/admin/backup/overdue-status") return { lastSuccessfulBackupAt: null, staleAfterDays: 7 };
    if (endpoint === "/auth/me") return { user: ADMIN_USER, memberships: [] };
    if (endpoint === "/notifications") return [];
    return {};
  });
});

afterEach(() => {
  setScheduledLocalBackupProgress(null);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  (window as Window & { electronAPI?: unknown }).electronAPI = {};
});

describe("scheduled backup progress in the Desktop shell", () => {
  it.each([
    { outcome: "completion", result: { ok: true, fileName: "scheduled.zip", path: "C:\\LabTraxBackups\\scheduled.zip", sizeBytes: 4096, downloadRunId: RUN_ID }, reportStatus: "success" },
    { outcome: "reported failure", result: { ok: false, status: 500, error: "The local folder could not be written.", downloadRunId: RUN_ID }, reportStatus: "error" },
  ])("shows live server progress and clears it after $outcome", async ({ result, reportStatus }) => {
    let onRunId: ((runId: string) => void) | undefined;
    let finishDownload!: (value: typeof result) => void;
    let markBridgeStarted!: () => void;
    const bridgeStarted = new Promise<void>((resolve) => { markBridgeStarted = resolve; });
    const downloadToFolder = vi.fn(async (request: { url: string; folderPath: string }) => {
      expect(request.url).toContain("/api/admin/backup/generate?deferRecord=1");
      expect(request.folderPath).toBe(schedule.path);
      onRunId?.(RUN_ID);
      markBridgeStarted();
      return new Promise<typeof result>((resolve) => { finishDownload = resolve; });
    });
    const electronAPI = {
      downloadBackupToFolder: downloadToFolder,
      onBackupRunId: (listener: (runId: string) => void) => {
        onRunId = listener;
        return () => { onRunId = undefined; };
      },
      platformAdmin: {
        getStatus: async () => ({ available: true, configured: true, savedAt: 1 }),
        getSecret: async () => null,
      },
    };
    (window as Window & { electronAPI?: unknown }).electronAPI = electronAPI;

    await act(async () => {
      renderDesktopBackupSettings();
    });
    await act(async () => { await bridgeStarted; });

    const progress = screen.getByTestId("scheduled-backup-live-progress");
    await waitFor(() => {
      expect(testState.apiFetch).toHaveBeenCalledWith(`/admin/backup/status/${RUN_ID}`);
      expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent(
        "2.0 KB of 4.0 KB of case media added",
      );
    });
    expect(progress).toHaveTextContent("Scheduled Desktop backup");
    expect(progress).toHaveTextContent("Adding case media to archive");
    expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent("1 of 2 media files");
    expect(getScheduledLocalBackupProgress()?.liveStatus).toEqual(liveStatus);

    await act(async () => {
      finishDownload(result);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("scheduled-backup-live-progress")).not.toBeInTheDocument();
      expect(getScheduledLocalBackupProgress()).toBeNull();
    });
    await waitFor(() => expect(testState.reports).toHaveLength(1));
    expect(testState.reports[0]).toMatchObject({ status: reportStatus, downloadRunId: RUN_ID });
    expect(downloadToFolder).toHaveBeenCalledTimes(1);
  });
});
