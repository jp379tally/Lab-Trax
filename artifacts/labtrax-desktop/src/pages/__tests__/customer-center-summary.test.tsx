/** @vitest-environment jsdom */
/**
 * Customer Center summary consumers must not fall back to the old unbounded
 * cases/invoices lists for the practice tables.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

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
import PracticesPage from "@/pages/practices";

const LAB_ID = "cc-lab";
const PRACTICE_ID = "cc-practice";
const ORG = {
  id: PRACTICE_ID,
  type: "provider",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
  parentLabOrganizationId: LAB_ID,
  deletedAt: null,
};
const ADMIN_ME = {
  id: "cc-user",
  memberships: [
    {
      status: "active",
      role: "admin",
      organizationId: LAB_ID,
      organization: { id: LAB_ID, type: "lab", name: "Acme Lab" },
    },
  ],
};
const ADMIN_USER = {
  id: "cc-user",
  username: "cc-admin",
  role: "admin",
} as unknown as SessionUser;
const SUMMARY = [
  {
    providerOrganizationId: PRACTICE_ID,
    caseCount: 7,
    openBalance: 150,
    totalBilled: 375,
    invoiceCount: 3,
    allPaid: false,
    allDeposited: false,
    anyOverdue: true,
  },
];

function installMock() {
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/organizations?")) return Promise.resolve([ORG]);
    if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
    if (url === "/cases/customer-center-summary") return Promise.resolve(SUMMARY);
    if (url === "/cases/legacy-doctor-directory") return Promise.resolve([]);
    if (url.startsWith("/organizations/") && url.endsWith("/members")) {
      return Promise.resolve([]);
    }
    if (url.startsWith("/organizations/") && url.endsWith("/unassigned-doctors")) {
      return Promise.resolve([]);
    }
    if (url.startsWith("/organizations/connections")) return Promise.resolve([]);
    if (url.startsWith("/pricing/")) return Promise.resolve({ tiers: [], overrides: [] });
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  installMock();
});

describe("Customer Center summary consumers", () => {
  it("renders Accounts totals from the summary without full case/invoice queries", async () => {
    render(<AccountsPage />, { wrapper: makeAuthWrapper("/", {
      user: ADMIN_USER,
      status: "authed",
    }) });

    expect(await screen.findByText("Bright Smiles")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("7").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$375.00").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$150.00").length).toBeGreaterThan(0);
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/cases/customer-center-summary");
    expect(apiFetchMock).not.toHaveBeenCalledWith("/cases");
    expect(apiFetchMock).not.toHaveBeenCalledWith("/invoices");
  });

  it("renders Practices totals and status styling from the summary", async () => {
    render(<PracticesPage />, { wrapper: makeAuthWrapper("/", {
      user: ADMIN_USER,
      status: "authed",
    }) });

    expect(await screen.findByText("Bright Smiles")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("7").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$375.00").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$150.00").length).toBeGreaterThan(0);
    });
    expect(
      screen
        .getAllByText("$375.00")
        .some((element) => element.className.includes("text-destructive")),
    ).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith("/cases/customer-center-summary");
    expect(apiFetchMock).not.toHaveBeenCalledWith("/cases");
    expect(apiFetchMock).not.toHaveBeenCalledWith("/invoices");
  });
});