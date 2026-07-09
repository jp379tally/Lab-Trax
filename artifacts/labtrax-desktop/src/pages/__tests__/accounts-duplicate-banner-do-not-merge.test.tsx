/** @vitest-environment jsdom */
/**
 * Regression suite: Customer Center duplicate banner → "Do not merge".
 *
 * The Doctors page's duplicate-cluster "Review" path passes `onDoNotMerge`
 * to the MergeDialog so the footer shows a "Do not merge" (permanent
 * dismiss) button. The Customer Center (accounts page) has its own
 * "Possible duplicate doctors" banner whose "Review & merge" button opened
 * the same dialog WITHOUT the cluster key or the dismiss wiring — so the
 * "Do not merge" button silently never appeared there.
 *
 * This suite pins the Customer Center path:
 * 1. The banner's "Review & merge" opens the Merge doctors dialog with the
 *    "Do not merge" button visible.
 * 2. Clicking it fires the dismiss mutation with the cluster's
 *    labOrganizationId + clusterKey + doctors, and closes the dialog.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";

const LAB_ID = "lab1";
const PROVIDER_ID = "org-985";
const CLUSTER_KEY = `${LAB_ID}::dr. kanesha cole|${PROVIDER_ID}||kanesha cole|${PROVIDER_ID}`;

const CLUSTER = {
  labOrganizationId: LAB_ID,
  labName: "Acme Dental Lab",
  topScore: 0.95,
  clusterKey: CLUSTER_KEY,
  doctors: [
    {
      doctorName: "Dr. Kanesha Cole",
      providerOrganizationId: PROVIDER_ID,
      practiceName: "Mahan Village Dental Care",
      totalCases: 3,
    },
    {
      doctorName: "Kanesha Cole",
      providerOrganizationId: PROVIDER_ID,
      practiceName: "Mahan Village Dental Care",
      totalCases: 2,
    },
  ],
};

const dismissMutate = vi.fn();
const previewMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetDoctorDuplicateClusters: () => ({
      data: { data: { clusters: [CLUSTER], dismissedClusters: [] } },
      isLoading: false,
    }),
    useDismissDoctorDuplicateCluster: () => ({
      mutate: dismissMutate,
      isPending: false,
    }),
    useRestoreDoctorDuplicateCluster: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useMergeDoctors: () => ({ mutate: vi.fn(), isPending: false }),
    usePreviewDoctorMerge: () => ({ mutate: previewMutate, data: undefined }),
    useUndoDoctorMerge: () => ({ mutate: vi.fn(), isPending: false }),
    useListUnassignedDoctors: () => ({ data: { ok: true, data: [] } }),
    searchDoctors: async () => ({ data: { entries: [], total: 0 } }),
    getGetDoctorDuplicateClustersQueryKey: () => [
      "doctor-duplicate-clusters",
    ],
  };
});

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import AccountsPage from "@/pages/accounts";

const LAB = {
  id: LAB_ID,
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
      organizationId: LAB_ID,
      organization: { id: LAB_ID, type: "lab" },
    },
  ],
};

function makeApiFetch() {
  return (url: string) => {
    if (typeof url === "string" && url.startsWith("/organizations"))
      return Promise.resolve([LAB]);
    if (url === "/cases") return Promise.resolve([]);
    if (url === "/invoices") return Promise.resolve([]);
    if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
    return Promise.resolve([]);
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
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
  dismissMutate.mockReset();
  previewMutate.mockReset();
  try {
    sessionStorage.clear();
  } catch {}
});

describe("Customer Center duplicate banner — Do not merge", () => {
  it("shows the Do not merge button when opened from the banner", async () => {
    apiFetchMock.mockImplementation(makeApiFetch());
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Possible duplicate doctors")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Review & merge"));

    await waitFor(() =>
      expect(screen.getByText("Do not merge")).toBeTruthy(),
    );
  });

  it("dismisses the cluster with its key and closes the dialog", async () => {
    apiFetchMock.mockImplementation(makeApiFetch());
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Possible duplicate doctors")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Review & merge"));
    const doNotMerge = await screen.findByText("Do not merge");

    fireEvent.click(doNotMerge);

    await waitFor(() => expect(dismissMutate).toHaveBeenCalledTimes(1));
    expect(dismissMutate).toHaveBeenCalledWith({
      data: {
        labOrganizationId: LAB_ID,
        clusterKey: CLUSTER_KEY,
        doctors: [
          {
            doctorName: "Dr. Kanesha Cole",
            providerOrganizationId: PROVIDER_ID,
            practiceName: "Mahan Village Dental Care",
          },
          {
            doctorName: "Kanesha Cole",
            providerOrganizationId: PROVIDER_ID,
            practiceName: "Mahan Village Dental Care",
          },
        ],
      },
    });

    await waitFor(() =>
      expect(screen.queryByText("Do not merge")).toBeNull(),
    );
  });
});
