/** @vitest-environment jsdom */
/**
 * Settings page — revenue targets PATCH contract.
 *
 * Verifies that clicking Save on the Monthly revenue targets panel sends a
 * PATCH to /organizations/:id with the correct field names and value types.
 * The key regression this guards against: renaming revenueTargetLow/High in
 * the mutation payload, sending strings instead of numbers, or accidentally
 * dropping one of the fields.
 *
 * Test 1 — save preserves loaded values:
 *   org has revenueTargetLow=70000, revenueTargetHigh=80000 → form loads those
 *   values → Save sends { revenueTargetLow: 70000, revenueTargetHigh: 80000 }.
 *
 * Test 2 — save clears to null when org has no custom targets:
 *   org has null/null → form initialises to empty strings → Save sends
 *   { revenueTargetLow: null, revenueTargetHigh: null }.
 *
 * Uses staleTime: Infinity so React Query does NOT re-fetch on re-renders,
 * and refetchOnMount: false to prevent concurrent fetches from racing the
 * form's useEffect.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import SettingsPage from "@/pages/settings";

const LAB_ORG_ID = "lab-org-1";

const LAB_ADMIN_USER = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  email: "labadmin@test.com",
  role: "admin",
  practiceOrganizationId: LAB_ORG_ID,
};

const MEMBERSHIPS = [
  {
    id: "mem-1",
    status: "active",
    role: "admin",
    organization: {
      id: LAB_ORG_ID,
      name: "Test Lab",
      displayName: "Test Lab",
      type: "lab",
    },
  },
];

const AUTH_VALUE: AuthContextValue = {
  user: LAB_ADMIN_USER as AuthContextValue["user"],
  status: "authed",
  restoreStatus: "ok",
  restoreNoticeDismissed: true,
  acknowledgeRestoreNotice: () => {},
  login: async () => {},
  register: async () => ({ user: null as never, token: "" }),
  logout: async () => {},
  refresh: async () => {},
};

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getApiOrigin: () => "https://api.labtrax.test",
    waitForTokenHydration: async () => undefined,
    authedMediaFetch: vi.fn(async () => new Response(null, { status: 204 })),
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

function makeApiFetchImpl(orgOverride: Record<string, unknown> = {}) {
  return async (endpoint: string) => {
    if (endpoint === "/auth/me" || endpoint.startsWith("/auth/me?")) {
      return { user: LAB_ADMIN_USER, memberships: MEMBERSHIPS };
    }
    if (
      endpoint === `/organizations/${LAB_ORG_ID}` ||
      endpoint.startsWith(`/organizations/${LAB_ORG_ID}?`)
    ) {
      return {
        id: LAB_ORG_ID,
        name: "Test Lab",
        type: "lab",
        revenueTargetLow: null,
        revenueTargetHigh: null,
        defaultCaseDueDays: null,
        invoiceDueDayOfMonth: null,
        ...orgOverride,
      };
    }
    if (endpoint === "/auth/lab-team" || endpoint.startsWith("/auth/lab-team?")) {
      return { team: [], members: [], callerRole: "admin", pendingInvites: [], pendingJoinRequests: [] };
    }
    if (endpoint === "/admin/backup-schedule") {
      return { schedule: null };
    }
    return {};
  };
}

/**
 * Stable wrapper: staleTime Infinity + refetchOnMount false prevent React
 * Query from re-fetching during re-renders and racing the form useEffect.
 */
function makeStableWrapper(path = "/settings") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: 0,
      },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <AuthContext.Provider value={AUTH_VALUE}>{children}</AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  apiFetchMock.mockClear();
  apiFetchMock.mockImplementation(makeApiFetchImpl());

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          team: [],
          members: [],
          callerRole: "admin",
          pendingInvites: [],
          pendingJoinRequests: [],
          items: [],
          sessions: [],
          permissions: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );

  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("Settings — revenue targets form saves correct PATCH payload", () => {
  /**
   * When the org has custom targets set, clicking Save re-sends those values.
   * This pins the PATCH field names (revenueTargetLow / revenueTargetHigh)
   * and that numbers are serialised as numbers, not strings.
   */
  it("sends org-loaded values in the PATCH when Save is clicked (field names + numeric types)", async () => {
    apiFetchMock.mockImplementation(
      makeApiFetchImpl({ revenueTargetLow: 70_000, revenueTargetHigh: 80_000 }),
    );

    const Wrapper = makeStableWrapper();
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    // Wait until the form inputs reflect the org-loaded values so the
    // useEffect has already run and the form state is stable.
    await waitFor(
      () => {
        const hi = screen.getByTestId("revenue-target-high-input") as HTMLInputElement;
        if (hi.value !== "80000") throw new Error("org data not yet applied to form");
        return hi;
      },
      { timeout: 5000 },
    );

    // Verify the low input also has the correct value before saving.
    const lo = screen.getByTestId("revenue-target-low-input") as HTMLInputElement;
    expect(lo.value).toBe("70000");

    fireEvent.click(screen.getByTestId("revenue-target-save-btn"));

    await waitFor(() => {
      const patchCall = apiFetchMock.mock.calls.find(
        (call) =>
          call[0] === `/organizations/${LAB_ORG_ID}` &&
          (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string) as unknown;
      // Field names must be revenueTargetLow / revenueTargetHigh (not revLow/revHigh etc.)
      // Values must be numbers, not strings.
      expect(body).toEqual({ revenueTargetLow: 70_000, revenueTargetHigh: 80_000 });
    });
  });

  /**
   * When the org has no custom targets (null), the form shows empty inputs.
   * Clicking Save sends null/null — clearing the overrides.
   * This pins that the mutation sends null (not 0, not "", not undefined).
   */
  it("sends null for both fields when org has no custom revenue targets and Save is clicked", async () => {
    const Wrapper = makeStableWrapper();
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    // Wait for the revenue section to be fully visible (requires meQuery + isLabAdmin).
    const saveBtn = await waitFor(
      () => screen.getByTestId("revenue-target-save-btn"),
      { timeout: 5000 },
    );

    // Also wait for the org query to have been fetched so the form state is settled.
    await waitFor(
      () => {
        const orgFetched = apiFetchMock.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            (c[0] === `/organizations/${LAB_ORG_ID}` ||
              c[0].startsWith(`/organizations/${LAB_ORG_ID}?`)),
        );
        if (!orgFetched) throw new Error("org query not yet fetched");
      },
      { timeout: 5000 },
    );

    // Both inputs should be empty (org has null values).
    const lo = screen.getByTestId("revenue-target-low-input") as HTMLInputElement;
    const hi = screen.getByTestId("revenue-target-high-input") as HTMLInputElement;
    expect(lo.value).toBe("");
    expect(hi.value).toBe("");

    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patchCall = apiFetchMock.mock.calls.find(
        (call) =>
          call[0] === `/organizations/${LAB_ORG_ID}` &&
          (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string) as unknown;
      // Must send null (not 0, not "", not undefined) when inputs are empty.
      expect(body).toEqual({ revenueTargetLow: null, revenueTargetHigh: null });
    });
  });
});
