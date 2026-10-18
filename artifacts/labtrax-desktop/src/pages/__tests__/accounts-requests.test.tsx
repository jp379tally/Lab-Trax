/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";
import AccountsPage from "@/pages/accounts";
import { useCustomerRequests, customerRequestsKey } from "@/lib/customer-requests";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), apiFetch: api.fetch,
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...await original<typeof import("@workspace/api-client-react")>(),
  useGetDoctorDuplicateClusters: () => ({ data: { data: { clusters: [], totalGroups: 0 } } }),
  useListUnassignedDoctors: () => ({ data: { data: [] } }),
  searchDoctors: async () => ({ data: { entries: [], total: 0 } }),
}));

const requestRow = {
  id: "request-1", organizationId: "lab-1", labName: "First Lab",
  requestedByUserId: "provider-1", requestedRole: "user", organizationType: "lab",
  requesterName: "Dr. Casey", requesterUsername: "casey", requesterEmail: "casey@example.com",
  requesterDoctorName: "Dr. Casey", requesterPracticeName: "Casey Dental",
  requesterPracticeAddress: "123 Main St", requesterUserType: "provider",
  message: "Please partner with our practice.", createdAt: "2026-10-01T12:00:00Z",
};
let pending = [requestRow];
let role = "admin";
let fail = false;
let fetchGate: Promise<unknown> | null = null;

function wrapper(path = "/accounts") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const location = memoryLocation({ path });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <AuthContext.Provider value={{ ...MOCK_AUTH_DEFAULTS, status: "authed", user: { id: "admin-1", username: "admin", role, practiceOrganizationId: "lab-1" } }}>
          {children}
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>
  );
  return { Wrapper, client, location };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  pending = [requestRow];
  role = "admin";
  fail = false;
  fetchGate = null;
  sessionStorage.clear();
  api.fetch.mockReset();
  api.fetch.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return {
      user: { id: "admin-1" },
      memberships: ["lab-1", "lab-2"].map((id) => ({
        organizationId: id, role, status: "active", organization: { id, type: "lab", name: id === "lab-1" ? "First Lab" : "Second Lab" },
      })),
    };
    if (path.startsWith("/auth/lab-team?")) {
      if (fail) throw new Error("Server unavailable");
      if (fetchGate) return fetchGate;
      const id = new URLSearchParams(path.split("?")[1]).get("orgId");
      return { pendingJoinRequests: pending.filter((r) => r.organizationId === id) };
    }
    if (path.startsWith("/organizations") || path.startsWith("/cases") || path === "/invoices") return [];
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("Customer Center incoming requests", () => {
  it("shows existing pending details with no billed customers and despite a customer search, without clearing them", async () => {
    sessionStorage.setItem("accounts_search_v1", "does not match");
    const { Wrapper } = wrapper("/accounts?view=requests");
    render(<AccountsPage />, { wrapper: Wrapper });
    expect(await screen.findByText("Casey Dental")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Requests awaiting review/ })).toBeInTheDocument();
    expect(screen.getByText(requestRow.message)).toBeInTheDocument();
    expect(screen.getByText("casey@example.com")).toBeInTheDocument();
    expect(screen.getByText("123 Main St")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review request from Dr. Casey" })).toHaveAttribute("href", "/settings?tab=profile&joinRequestId=request-1");
    expect(api.fetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it("switches scoped cache identity immediately and does not reuse another lab's rows", async () => {
    const { Wrapper } = wrapper();
    render(<AccountsPage />, { wrapper: Wrapper });
    await screen.findByText("Casey Dental");
    let resolve!: (value: unknown) => void;
    fetchGate = new Promise((r) => { resolve = r; });
    fireEvent.change(screen.getByRole("combobox", { name: "Requests for lab" }), { target: { value: "lab-2" } });
    expect(screen.queryByText("Casey Dental")).not.toBeInTheDocument();
    expect(screen.getByText("Loading requests...")).toBeInTheDocument();
    await act(async () => { resolve({ pendingJoinRequests: [] }); });
    expect(await screen.findByText("No requests awaiting review")).toBeInTheDocument();
    expect(api.fetch).toHaveBeenCalledWith("/auth/lab-team?orgId=lab-2");
  });

  it("does not fetch or expose requests for billing/non-admin memberships", async () => {
    role = "billing";
    const { Wrapper } = wrapper();
    render(<AccountsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(api.fetch).toHaveBeenCalledWith("/auth/me"));
    expect(screen.queryByText("Casey Dental")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Requests awaiting review/ })).not.toBeInTheDocument();
    expect(api.fetch.mock.calls.some(([path]) => path.startsWith("/auth/lab-team"))).toBe(false);
  });

  it("follows badge deep links again after selecting another lab without remounting Customer Center", async () => {
    const { Wrapper, location } = wrapper("/accounts?view=requests&requestLabId=lab-1");
    render(<AccountsPage />, { wrapper: Wrapper });
    await screen.findByText("Casey Dental");
    fireEvent.change(screen.getByRole("combobox", { name: "Requests for lab" }), { target: { value: "lab-2" } });
    await screen.findByText("No requests awaiting review");
    await act(async () => { location.navigate("/accounts?view=requests&requestLabId=lab-1"); });
    expect(await screen.findByText("Casey Dental")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Requests for lab" })).toHaveValue("lab-1");
  });

  it("shows failure rather than an empty request list and retries successfully", async () => {
    fail = true;
    const { Wrapper } = wrapper();
    render(<AccountsPage />, { wrapper: Wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load requests.");
    expect(screen.queryByText("No requests awaiting review")).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Casey Dental");
  });

  it("review invalidation removes only server-resolved rows, and refresh failure retains unresolved rows", async () => {
    const { Wrapper, client } = wrapper();
    render(<AccountsPage />, { wrapper: Wrapper });
    await screen.findByText("Casey Dental");
    fail = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["lab-team"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to refresh requests.");
    expect(screen.getByText("Casey Dental")).toBeInTheDocument();
    fail = false;
    pending = [];
    await act(async () => { await client.invalidateQueries({ queryKey: ["lab-team"] }); });
    expect(await screen.findByText("No requests awaiting review")).toBeInTheDocument();
    expect(screen.queryByText("Casey Dental")).not.toBeInTheDocument();
  });
});

function Probe({ labId = "lab-1", userId = "admin-1" }: { labId?: string; userId?: string }) {
  const query = useCustomerRequests(userId, labId);
  return <div>{query.data?.map((r) => r.id).join(",") || "none"}</div>;
}

describe("request freshness and cache scoping", () => {
  it("polls every 30 seconds while active and refreshes on returning focus and visibility", async () => {
    vi.useFakeTimers();
    const { Wrapper } = wrapper();
    render(<Probe />, { wrapper: Wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("request-1")).toBeInTheDocument();
    const calls = api.fetch.mock.calls.length;
    pending = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.fetch.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByText("none")).toBeInTheDocument();
    pending = [requestRow];
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("request-1")).toBeInTheDocument();
    pending = [];
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("separates identities by user and lab", () => {
    expect(customerRequestsKey("u1", "lab-1")).not.toEqual(customerRequestsKey("u1", "lab-2"));
    expect(customerRequestsKey("u1", "lab-1")).not.toEqual(customerRequestsKey("u2", "lab-1"));
  });
});
