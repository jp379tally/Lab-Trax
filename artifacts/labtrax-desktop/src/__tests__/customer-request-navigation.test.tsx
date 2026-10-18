/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/components/AppLayout";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
import { setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";

const state = vi.hoisted(() => ({ fetch: vi.fn(), duplicates: 2 }));
vi.mock("@/lib/api", () => ({
  apiFetch: state.fetch, apiFetchArrayBuffer: vi.fn(),
  serverAssetUrl: (path: string) => path,
}));
vi.mock("@/lib/uploads-context", () => ({
  useUploads: () => ({ entries: [], activeCount: 0, removeEntry: vi.fn(), cancelEntry: vi.fn() }),
}));
vi.mock("@/components/AiChatPanel", () => ({ AiChatPanel: () => null }));
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("@/components/ReportIssueDialog", () => ({
  canReportIssueRole: () => false, ReportIssueAction: () => null,
  FeedbackAction: () => null,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetDoctorDuplicateClusters: () => ({ data: { data: { totalGroups: state.duplicates } } }),
  getGetDoctorDuplicateClustersQueryKey: () => ["clusters"],
}));
vi.mock("@/lib/local-backup-scheduler", () => ({ startLocalBackupScheduler: vi.fn() }));
vi.mock("@/components/BackupStalenessBanner", () => ({
  useBackupFreshness: () => ({ stale: false }), BackupStalenessBanner: () => null,
}));

let role = "admin";
let pending = true;
const user = { id: "admin-1", username: "admin", practiceOrganizationId: "lab-1" };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const location = memoryLocation({ path: "/accounts", record: true });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <AuthContext.Provider value={{ ...MOCK_AUTH_DEFAULTS, user: { ...user, role }, status: "authed" }}>
          <AppLayout><div>Customer content</div></AppLayout>
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
  return { client, location };
}
beforeEach(() => {
  role = "admin";
  pending = true;
  state.duplicates = 2;
  state.fetch.mockReset();
  state.fetch.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return {
      user,
      memberships: ["lab-1", "lab-2"].map((id) => ({
        organizationId: id, status: "active", role,
        organization: { id, type: "lab", name: id },
      })),
    };
    if (path.startsWith("/auth/lab-team?")) return {
      pendingJoinRequests: pending && path.endsWith("lab-2") ? [{ id: "r2", organizationId: "lab-2" }] : [],
    };
    if (path === "/notifications") return [];
    return {};
  });
});

describe("Customer Center alert navigation", () => {
  it("shows scheduled backup progress in the app header and clears it when the run ends", async () => {
    setScheduledLocalBackupProgress({
      startedAt: Date.now(),
      phase: "Generating, downloading and writing the full archive",
      liveStatus: {
        runId: "0ad043e2-854a-4507-bec4-f99750738096",
        state: "running",
        phase: "case-media transfer into archive",
        elapsedMs: 1200,
        metrics: { completedBytes: 2048, totalBytes: 4096 },
      },
    });
    mount();

    const indicator = await screen.findByTestId("scheduled-backup-indicator");
    expect(indicator).toHaveTextContent("Backup");
    expect(indicator).toHaveTextContent("Adding case media to archive");
    expect(indicator).toHaveTextContent("2.0 KB of 4.0 KB of case media added");

    await act(async () => {
      setScheduledLocalBackupProgress({
        startedAt: Date.now(),
        phase: "Verifying the saved backup",
        liveStatus: {
          runId: "0ad043e2-854a-4507-bec4-f99750738096",
          state: "awaiting_verification",
          phase: "local file verification",
          elapsedMs: 2400,
          metrics: { uploadedBytes: 8192, uploadTotalBytes: 8192 },
        },
      });
    });
    expect(indicator).toHaveTextContent("Verifying saved file");
    expect(indicator).toHaveTextContent("8.0 KB of 8.0 KB uploaded");

    await act(async () => setScheduledLocalBackupProgress(null));
    expect(screen.queryByTestId("scheduled-backup-indicator")).not.toBeInTheDocument();
  });

  it("routes request and duplicate badges independently, including requests to the non-primary lab", async () => {
    const { client, location } = mount();
    const requestLink = await screen.findByRole("link", { name: "1 requests awaiting review" });
    expect(requestLink).toHaveTextContent("Requests 1");
    expect(requestLink).toHaveAttribute("href", "/accounts?view=requests&requestLabId=lab-2");
    const duplicateLink = screen.getByRole("link", { name: /Customer Center.*2 possible duplicate doctor groups/ });
    expect(duplicateLink).toHaveAttribute("href", "/accounts?view=duplicates");
    fireEvent.click(requestLink);
    expect(location.history?.at(-1)).toBe("/accounts?view=requests&requestLabId=lab-2");
    expect(screen.getByRole("link", { name: "1 requests awaiting review" })).toBeInTheDocument();
    fireEvent.click(duplicateLink);
    expect(location.history?.at(-1)).toBe("/accounts?view=duplicates");
    expect(state.fetch.mock.calls.some(([, init]) => init?.method)).toBe(false);
    pending = false;
    await act(async () => { await client.invalidateQueries({ queryKey: ["lab-team"] }); });
    await waitFor(() => expect(screen.queryByRole("link", { name: /requests awaiting review/ })).not.toBeInTheDocument());
    expect(screen.getByLabelText("2 possible duplicate doctor groups")).toBeInTheDocument();
  });

  it("hides incoming counts and makes no request-list calls for non-admins", async () => {
    role = "billing";
    mount();
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith("/auth/me"));
    expect(state.fetch.mock.calls.some(([path]) => path.startsWith("/auth/lab-team"))).toBe(false);
    expect(screen.queryByText(/Requests \d/)).not.toBeInTheDocument();
  });
});
