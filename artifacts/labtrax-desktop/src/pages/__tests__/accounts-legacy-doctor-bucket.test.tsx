/** @vitest-environment jsdom */
/**
 * Regression suite: Customer Center "Unassigned / legacy doctor names" bucket
 * (Task #2694).
 *
 * Legacy / providerless doctor names (e.g. the typo `Dr. Lauren Petral`) live
 * only in legacy `lab_cases` blobs or in canonical cases with a NULL provider,
 * so they show up in the Dashboard drop-zone picker but never in Customer
 * Center — which builds its rows from provider-attached canonical cases. This
 * suite pins:
 *
 * 1. The bucket surfaces legacy/providerless names (with their case counts)
 *    fetched from GET /cases/legacy-doctor-directory, but only for a lab admin.
 * 2. Selecting a legacy name reveals the "Merge doctors" action so it can be
 *    folded into a real doctor.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

// The duplicate-cluster badge hook is an Orval-generated React Query hook; stub
// it so the page renders without a live network layer.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetDoctorDuplicateClusters: () => ({ data: { data: { clusters: [] } } }),
    getGetDoctorDuplicateClustersQueryKey: () => ["doctor-duplicate-clusters"],
  };
});

import AccountsPage from "@/pages/accounts";

const LAB = {
  id: "lab1",
  type: "lab",
  name: "Acme Dental Lab",
  displayName: "Acme Dental Lab",
};

const ADMIN_ME = {
  id: "u1",
  memberships: [
    {
      status: "active",
      role: "admin",
      organizationId: "lab1",
      organization: { id: "lab1", type: "lab" },
    },
  ],
};

const NON_ADMIN_ME = {
  id: "u2",
  memberships: [
    {
      status: "active",
      role: "technician",
      organizationId: "lab1",
      organization: { id: "lab1", type: "lab" },
    },
  ],
};

const LEGACY_DIRECTORY = [
  { doctorName: "Dr. Lauren Petral", labOrganizationId: "lab1", totalCases: 3 },
];

function makeApiFetch(me: unknown) {
  return (url: string) => {
    if (url.startsWith("/organizations")) return Promise.resolve([LAB]);
    if (url === "/cases") return Promise.resolve([]);
    if (url === "/invoices") return Promise.resolve([]);
    if (url === "/auth/me") return Promise.resolve(me);
    if (url === "/cases/legacy-doctor-directory")
      return Promise.resolve(LEGACY_DIRECTORY);
    return Promise.resolve([]);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const queryClient = makeQueryClient();
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={MOCK_AUTH_DEFAULTS}>
          <AccountsPage />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  try {
    sessionStorage.clear();
  } catch {}
});

describe("Customer Center — legacy/providerless doctor bucket", () => {
  it("surfaces legacy/providerless names with case counts for a lab admin", async () => {
    apiFetchMock.mockImplementation(makeApiFetch(ADMIN_ME));
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("Unassigned / legacy doctor names"),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Dr. Lauren Petral")).toBeTruthy();
    // The per-name case count is rendered alongside the name.
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("does not fetch or render the bucket for a non-admin", async () => {
    apiFetchMock.mockImplementation(makeApiFetch(NON_ADMIN_ME));
    renderPage();

    // Let auth/me resolve so isAdmin settles to false.
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some((c) => c[0] === "/auth/me"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some((c) => c[0] === "/cases"),
      ).toBe(true),
    );

    expect(
      apiFetchMock.mock.calls.some(
        (c) => c[0] === "/cases/legacy-doctor-directory",
      ),
    ).toBe(false);
    expect(screen.queryByText("Unassigned / legacy doctor names")).toBeNull();
  });

  it("reveals the Merge doctors action when a legacy name is selected", async () => {
    apiFetchMock.mockImplementation(makeApiFetch(ADMIN_ME));
    renderPage();

    const nameEl = await screen.findByText("Dr. Lauren Petral");
    expect(screen.queryByText("Merge doctors")).toBeNull();

    fireEvent.click(nameEl);

    await waitFor(() =>
      expect(screen.getByText("Merge doctors")).toBeTruthy(),
    );
  });
});
