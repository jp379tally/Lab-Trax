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
import { clearSessionSecret, setSessionSecret } from "@/lib/platform-admin-session";
import { getScheduledLocalBackupProgress, setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";
import {
  LOCAL_BACKUP_LAST_RUN_KEY,
  LOCAL_BACKUP_RETRY_AFTER_KEY,
} from "@/lib/local-backup-scheduler";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiFetchArrayBuffer: vi.fn(),
  reports: [] as Array<Record<string, unknown>>,
  reportSessions: [] as string[],
  activeAccount: "desktop-admin",
  reportUnavailable: false,
  rejectVerification: false,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: testState.apiFetch,
    apiFetchArrayBuffer: testState.apiFetchArrayBuffer,
    createLocalBackupApiSession: () => {
      const session = testState.activeAccount;
      const sessionHeaders = { "x-test-backup-session": session };
      const withSessionHeaders = (options: RequestInit = {}) => ({
        ...options,
        headers: {
          ...(options.headers as Record<string, string> | undefined),
          ...sessionHeaders,
        },
      });
      return {
        apiFetch: (endpoint: string, options?: RequestInit) =>
          testState.apiFetch(endpoint, withSessionHeaders(options)),
        apiFetchArrayBuffer: (endpoint: string, options?: RequestInit) =>
          testState.apiFetchArrayBuffer(endpoint, withSessionHeaders(options)),
        downloadBackupToFolder: (folderPath: string, source: "manual" | "scheduler" = "scheduler") =>
          actual.apiDownloadBackupToFolder(folderPath, source, sessionHeaders),
      };
    },
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
const SECOND_ADMIN_USER = {
  ...ADMIN_USER,
  id: "desktop-admin-second",
  username: "desktop-admin-second",
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

const queryClients: QueryClient[] = [];
const settlePending: Array<() => void> = [];

function renderDesktopBackupSettings(initialUser: typeof ADMIN_USER | null = ADMIN_USER) {
  if (initialUser) setSessionSecret("1234");
  else clearSessionSecret();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  queryClients.push(queryClient);
  const location = memoryLocation({ path: "/settings?tab=backup" });
  const tree = (user: typeof ADMIN_USER | null) => (
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <AuthContext.Provider
          value={{
            ...MOCK_AUTH_DEFAULTS,
            user: user as any,
            status: user ? "authed" : "anonymous",
            restoreStatus: "ok",
            restoreNoticeDismissed: true,
          }}
        >
          {user ? <AppLayout><SettingsPage /></AppLayout> : <div>Signed out</div>}
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>
  );
  const view = render(tree(initialUser));
  return {
    ...view,
    setUser: (user: typeof ADMIN_USER | null) => view.rerender(tree(user)),
  };
}

beforeEach(() => {
  localStorage.clear();
  setScheduledLocalBackupProgress(null);
  window.history.replaceState(null, "", "/settings?tab=backup");
  testState.reports = [];
  testState.reportSessions = [];
  testState.activeAccount = ADMIN_USER.id;
  testState.reportUnavailable = false;
  testState.rejectVerification = false;
  testState.apiFetch.mockReset();
  testState.apiFetchArrayBuffer.mockReset();
  testState.apiFetch.mockImplementation(async (endpoint: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const session = init?.headers?.["x-test-backup-session"];
    if (endpoint === "/admin/backup/schedule") {
      return session === SECOND_ADMIN_USER.id ? { ...schedule, enabled: false } : schedule;
    }
    if (endpoint === `/admin/backup/status/${RUN_ID}`) return liveStatus;
    if (endpoint === "/admin/backup/desktop-run-report") {
      const report = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      testState.reports.push(report);
      testState.reportSessions.push(session ?? "unbound");
      if (testState.reportUnavailable) throw new Error("Backup history is unavailable.");
      if (testState.rejectVerification) return { rejected: true, warning: "The saved archive could not be verified." };
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

afterEach(async () => {
  // An assertion failure must not leave an unfinished run publishing into the
  // next test's shared progress store, or a QueryClient keeping timers alive.
  await act(async () => {
    for (const settle of settlePending.splice(0)) settle();
  });
  for (const client of queryClients.splice(0)) client.clear();
  setScheduledLocalBackupProgress(null);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  (window as Window & { electronAPI?: unknown }).electronAPI = {};
});

describe("scheduled backup progress in the Desktop shell", () => {
  it.each([
    { outcome: "completion", downloadFails: false },
    { outcome: "reported failure", downloadFails: true },
    { outcome: "bridge rejection", downloadFails: true, bridgeRejects: true },
    { outcome: "server verification rejection", downloadFails: false, rejectVerification: true },
    { outcome: "unconfirmed success report", downloadFails: false, reportUnavailable: true },
    { outcome: "unconfirmed failure report", downloadFails: true, reportUnavailable: true },
  ])("shows live server progress and clears it after $outcome", async ({
    downloadFails, bridgeRejects = false, rejectVerification = false, reportUnavailable = false,
  }) => {
    testState.reportUnavailable = reportUnavailable;
    testState.rejectVerification = rejectVerification;
    const result = downloadFails
      ? { ok: false, status: 500, error: "The local folder could not be written.", downloadRunId: RUN_ID }
      : { ok: true, fileName: "scheduled.zip", path: "C:\\LabTraxBackups\\scheduled.zip", sizeBytes: 4096, downloadRunId: RUN_ID };
    let onRunId: ((runId: string) => void) | undefined;
    let finishDownload!: () => void;
    // Create the deferred before rendering, so even failed startup assertions
    // can release it during teardown. Never await a bridge-start promise inside
    // act: if startup fails, that hides the cause behind the test timeout.
    const download = new Promise<typeof result>((resolve, reject) => {
      finishDownload = () => bridgeRejects
        ? reject(Object.assign(new Error("Desktop bridge disconnected."), { downloadRunId: RUN_ID }))
        : resolve(result);
      settlePending.push(() => resolve(result));
    });
    const unsubscribe = vi.fn(() => { onRunId = undefined; });
    const downloadToFolder = vi.fn(async (request: { url: string; folderPath: string; headers: Record<string, string> }) => {
      expect(request.url).toContain("/api/admin/backup/generate?deferRecord=1");
      expect(request.folderPath).toBe(schedule.path);
      expect(request.headers["x-test-backup-session"]).toBe(ADMIN_USER.id);
      onRunId?.(RUN_ID);
      return download;
    });
    const electronAPI = {
      downloadBackupToFolder: downloadToFolder,
      isBackupFolderAvailable: vi.fn(async (folder: string) => folder === schedule.path),
      onBackupRunId: (listener: (runId: string) => void) => {
        onRunId = listener;
        return unsubscribe;
      },
      platformAdmin: {
        getStatus: async () => ({ available: true, configured: true, savedAt: 1 }),
        getSecret: async () => null,
      },
    };
    (window as Window & { electronAPI?: unknown }).electronAPI = electronAPI;

    renderDesktopBackupSettings();
    await waitFor(() => expect(downloadToFolder).toHaveBeenCalledTimes(1));

    const progress = await screen.findByTestId("scheduled-backup-live-progress");
    await waitFor(() => {
      expect(testState.apiFetch).toHaveBeenCalledWith(
        `/admin/backup/status/${RUN_ID}`,
        expect.objectContaining({
          headers: expect.objectContaining({ "x-test-backup-session": ADMIN_USER.id }),
        }),
      );
      expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent(
        "2.0 KB of 4.0 KB of case media added",
      );
    });
    expect(progress).toHaveTextContent("Scheduled Desktop backup");
    expect(progress).toHaveTextContent("Adding case media to archive");
    expect(screen.getByTestId("scheduled-backup-live-metrics")).toHaveTextContent("1 of 2 media files");
    expect(getScheduledLocalBackupProgress()?.liveStatus).toEqual(liveStatus);
    expect(screen.getByTestId("scheduled-backup-indicator")).toHaveTextContent("Adding case media to archive");

    // Leave a status poll in flight when the run finishes. Its late response
    // must not republish progress after either a successful or failed run.
    let resolveLateStatus!: (status: typeof liveStatus) => void;
    const lateStatus = new Promise<typeof liveStatus>((resolve) => { resolveLateStatus = resolve; });
    settlePending.push(() => resolveLateStatus(liveStatus));
    const apiImplementation = testState.apiFetch.getMockImplementation()!;
    testState.apiFetch.mockImplementation((endpoint: string, init?: { body?: string; headers?: Record<string, string> }) =>
      endpoint === `/admin/backup/status/${RUN_ID}` ? lateStatus : apiImplementation(endpoint, init),
    );
    await act(async () => { onRunId?.(RUN_ID); });
    expect(testState.apiFetch).toHaveBeenLastCalledWith(
      `/admin/backup/status/${RUN_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-test-backup-session": ADMIN_USER.id }),
      }),
    );

    await act(async () => {
      finishDownload();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("scheduled-backup-live-progress")).not.toBeInTheDocument();
      expect(screen.queryByTestId("scheduled-backup-indicator")).not.toBeInTheDocument();
      expect(getScheduledLocalBackupProgress()).toBeNull();
    });
    const reportStatuses = downloadFails ? ["error"] : ["success"];
    expect(testState.reports.map((report) => report.status)).toEqual(reportStatuses);
    for (const report of testState.reports) {
      expect(report).toMatchObject({ downloadRunId: RUN_ID });
    }
    const succeeded = !downloadFails && !rejectVerification && !reportUnavailable;
    if (succeeded) {
      expect(Number(localStorage.getItem(`${LOCAL_BACKUP_LAST_RUN_KEY}:${ADMIN_USER.id}`))).toBeGreaterThan(0);
      expect(localStorage.getItem(`${LOCAL_BACKUP_RETRY_AFTER_KEY}:${ADMIN_USER.id}`)).toBe("0");
    } else {
      expect(localStorage.getItem(`${LOCAL_BACKUP_LAST_RUN_KEY}:${ADMIN_USER.id}`)).toBeNull();
      expect(Number(localStorage.getItem(`${LOCAL_BACKUP_RETRY_AFTER_KEY}:${ADMIN_USER.id}`))).toBeGreaterThan(Date.now());
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => { resolveLateStatus(liveStatus); });
    expect(getScheduledLocalBackupProgress()).toBeNull();
    expect(screen.queryByTestId("scheduled-backup-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-backup-live-progress")).not.toBeInTheDocument();
    expect(downloadToFolder).toHaveBeenCalledTimes(1);
    expect(electronAPI.isBackupFolderAvailable).toHaveBeenCalledWith(schedule.path);
  });

  it("finishes an old session's held disk write without showing or reporting it as the new account", async () => {
    let onRunId: ((runId: string) => void) | undefined;
    let finishDownload!: () => void;
    let resolveLateStatus!: (status: typeof liveStatus) => void;
    const lateStatus = new Promise<typeof liveStatus>((resolve) => { resolveLateStatus = resolve; });
    settlePending.push(() => resolveLateStatus(liveStatus));
    const result = {
      ok: true,
      fileName: "scheduled.zip",
      path: "C:\\LabTraxBackups\\scheduled.zip",
      sizeBytes: 4096,
      downloadRunId: RUN_ID,
    };
    const download = new Promise<typeof result>((resolve) => {
      finishDownload = () => resolve(result);
      settlePending.push(() => resolve(result));
    });
    const downloadToFolder = vi.fn(async (request: { url: string; folderPath: string; headers: Record<string, string> }) => {
      expect(request.url).toContain("/api/admin/backup/generate?deferRecord=1");
      expect(request.folderPath).toBe(schedule.path);
      expect(request.headers["x-test-backup-session"]).toBe(ADMIN_USER.id);
      onRunId?.(RUN_ID);
      return download;
    });
    (window as Window & { electronAPI?: unknown }).electronAPI = {
      downloadBackupToFolder: downloadToFolder,
      isBackupFolderAvailable: vi.fn(async (folder: string) => folder === schedule.path),
      onBackupRunId: (listener: (runId: string) => void) => {
        onRunId = listener;
        return () => { onRunId = undefined; };
      },
      platformAdmin: {
        getStatus: async () => ({ available: true, configured: true, savedAt: 1 }),
        getSecret: async () => null,
      },
    };

    const view = renderDesktopBackupSettings();
    await waitFor(() => expect(downloadToFolder).toHaveBeenCalledTimes(1));
    await screen.findByTestId("scheduled-backup-live-progress");
    await waitFor(() => expect(testState.apiFetch).toHaveBeenCalledWith(
      `/admin/backup/status/${RUN_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-test-backup-session": ADMIN_USER.id }),
      }),
    ));

    // Leave an old-session status request unresolved through sign-out and the
    // next admin's sign-in.
    const originalApiFetch = testState.apiFetch.getMockImplementation()!;
    testState.apiFetch.mockImplementation((endpoint: string, init?: { body?: string; headers?: Record<string, string> }) =>
      endpoint === `/admin/backup/status/${RUN_ID}`
        ? lateStatus
        : originalApiFetch(endpoint, init),
    );
    await act(async () => { onRunId?.(RUN_ID); });
    expect(testState.apiFetch).toHaveBeenLastCalledWith(
      `/admin/backup/status/${RUN_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-test-backup-session": ADMIN_USER.id }),
      }),
    );

    await act(async () => { view.setUser(null); });
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    testState.activeAccount = SECOND_ADMIN_USER.id;
    await act(async () => { view.setUser(SECOND_ADMIN_USER); });
    await waitFor(() => expect(testState.apiFetch).toHaveBeenCalledWith(
      "/admin/backup/schedule",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-test-backup-session": SECOND_ADMIN_USER.id }),
      }),
    ));
    expect(screen.queryByTestId("scheduled-backup-live-progress")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-backup-indicator")).not.toBeInTheDocument();
    expect(getScheduledLocalBackupProgress()).toBeNull();

    // The already-started bridge write is not cancelled. Its success report
    // and watermark remain bound to the account that initiated the run.
    await act(async () => { finishDownload(); });
    await waitFor(() => expect(testState.reports).toHaveLength(1));
    expect(testState.reports[0]).toMatchObject({ status: "success", downloadRunId: RUN_ID });
    expect(testState.reportSessions).toEqual([ADMIN_USER.id]);
    expect(Number(localStorage.getItem(`${LOCAL_BACKUP_LAST_RUN_KEY}:${ADMIN_USER.id}`))).toBeGreaterThan(0);
    expect(localStorage.getItem(`${LOCAL_BACKUP_LAST_RUN_KEY}:${SECOND_ADMIN_USER.id}`)).toBeNull();
    expect(downloadToFolder).toHaveBeenCalledTimes(1);

    await act(async () => { resolveLateStatus(liveStatus); });
    expect(getScheduledLocalBackupProgress()).toBeNull();
    expect(screen.queryByTestId("scheduled-backup-live-progress")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-backup-indicator")).not.toBeInTheDocument();
    view.unmount();
  });
});
