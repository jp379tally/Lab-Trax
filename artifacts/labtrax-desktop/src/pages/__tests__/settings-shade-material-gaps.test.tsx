/** @vitest-environment jsdom */
/**
 * Settings page — Lab Catalog → Advanced → "Fill in missing shade & material
 * info" panel.
 *
 * Verifies that the Advanced panel:
 *  1. Renders a pre-run list of the invoices missing shade/material returned
 *     by GET /invoices/admin/shade-material-gaps, including rows for each
 *     fixability status (fully/partially/not fixable).
 *  2. After clicking "Fill in now", renders the "Still needs review" list
 *     from the POST /invoices/admin/shade-material-backfill response.
 *
 * This guards the wiring between the gaps/backfill API responses and the
 * panel's row list — the underlying derivation matrix itself is covered by
 * the api-server integration tests.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import { clearSessionSecret, setSessionSecret } from "@/lib/platform-admin-session";
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
    organizationId: LAB_ORG_ID,
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

const GAP_ROWS = [
  {
    invoiceId: "inv-full",
    invoiceNumber: "INV-1001",
    caseId: "case-full",
    caseNumber: "CASE-1001",
    practiceName: "Bright Smiles",
    patientName: "Alice Fully",
    currentShade: "",
    currentMaterial: "",
    shadeMissing: true,
    materialMissing: true,
    derivedShade: "A2",
    derivedMaterial: "Zirconia",
    status: "fully_fixable" as const,
  },
  {
    invoiceId: "inv-partial",
    invoiceNumber: "INV-1002",
    caseId: "case-partial",
    caseNumber: "CASE-1002",
    practiceName: "Bright Smiles",
    patientName: "Bob Partial",
    currentShade: "",
    currentMaterial: "",
    shadeMissing: true,
    materialMissing: true,
    derivedShade: "B1",
    derivedMaterial: null,
    status: "partially_fixable" as const,
  },
  {
    invoiceId: "inv-none",
    invoiceNumber: "INV-1003",
    caseId: "case-none",
    caseNumber: "CASE-1003",
    practiceName: "Bright Smiles",
    patientName: "Cara None",
    currentShade: "",
    currentMaterial: "",
    shadeMissing: true,
    materialMissing: true,
    derivedShade: null,
    derivedMaterial: null,
    status: "not_fixable" as const,
  },
];

// After a run: the partial row got its shade filled in but is still missing
// material, so it now reads as "not fixable" (nothing further to derive);
// the "nothing derivable" row is unchanged. The fully-fixed invoice drops
// off the list entirely.
const REMAINING_ROWS = [
  {
    ...GAP_ROWS[1],
    currentShade: "B1",
    shadeMissing: false,
    derivedShade: null,
    status: "not_fixable" as const,
  },
  GAP_ROWS[2],
];

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

function makeApiFetchImpl() {
  return async (endpoint: string, init?: RequestInit) => {
    if (endpoint === "/auth/me" || endpoint.startsWith("/auth/me?")) {
      return { user: LAB_ADMIN_USER, memberships: MEMBERSHIPS };
    }
    if (endpoint.startsWith("/admin/backup-schedule")) {
      return { schedule: null };
    }
    if (endpoint.startsWith("/auth/lab-team")) {
      return { team: [], members: [], callerRole: "admin", pendingInvites: [], pendingJoinRequests: [] };
    }
    if (endpoint.startsWith(`/organizations/${LAB_ORG_ID}`)) {
      return { id: LAB_ORG_ID, name: "Test Lab", type: "lab" };
    }
    if (endpoint.startsWith("/catalog/tree")) {
      return {
        labOrganizationId: LAB_ORG_ID,
        caseTypes: [
          { key: "restorative", label: "Restorative", subtypes: [] },
          { key: "removable", label: "Removable", subtypes: [] },
          { key: "ortho", label: "Ortho", subtypes: [] },
        ],
      };
    }
    if (endpoint.startsWith("/catalog/legacy-vocabulary-review")) {
      return [];
    }
    // Vocabulary lists are consumed as `(data ?? []).filter(...)` — they
    // must resolve to an array, not fall through to the generic {} below.
    if (endpoint.startsWith("/vocabulary")) {
      return [];
    }
    if (endpoint.startsWith("/invoices/admin/shade-material-gaps")) {
      return {
        labOrganizationId: LAB_ORG_ID,
        totalCaseLinked: 5,
        gapCount: GAP_ROWS.length,
        rows: GAP_ROWS,
        rowsTruncated: false,
      };
    }
    if (endpoint.startsWith("/invoices/admin/shade-material-backfill") && init?.method === "POST") {
      return {
        labOrganizationId: LAB_ORG_ID,
        gapInvoicesFound: GAP_ROWS.length,
        updated: 1,
        skippedNoDerivable: 1,
        remainingGapCount: REMAINING_ROWS.length,
        remainingRows: REMAINING_ROWS,
        remainingRowsTruncated: false,
      };
    }
    return {};
  };
}

function makeStableWrapper(path = "/settings?tab=vocabulary") {
  // SettingsPage reads its initial tab from the real browser URL
  // (window.location.search) via readInitialTab(), not from wouter's
  // in-memory router — so the tab query param must be pushed onto real
  // history for the "vocabulary" tab (and its VocabularyPanel) to mount.
  window.history.pushState({}, "", path);
  setSessionSecret("1234");
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
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
  clearSessionSecret();
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

describe("Settings — Lab Catalog Advanced shade/material gap panel", () => {
  it("renders the pre-run list of invoices missing shade or material", async () => {
    const Wrapper = makeStableWrapper();
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    const list = await waitFor(() => screen.getByTestId("shade-material-gaps-list"), {
      timeout: 5000,
    });

    for (const row of GAP_ROWS) {
      const rowEl = within(list).getByTestId(`shade-material-gap-row-${row.invoiceId}`);
      expect(rowEl.textContent).toContain(row.invoiceNumber);
      expect(rowEl.textContent).toContain(row.patientName);
    }

    // Status badges distinguish fully/partially/not fixable.
    const fullRow = within(list).getByTestId("shade-material-gap-row-inv-full");
    expect(fullRow.textContent).toMatch(/fully fixable/i);
    const partialRow = within(list).getByTestId("shade-material-gap-row-inv-partial");
    expect(partialRow.textContent).toMatch(/partial/i);
    const noneRow = within(list).getByTestId("shade-material-gap-row-inv-none");
    expect(noneRow.textContent).toMatch(/manual/i);
  });

  it("shows the 'Still needs review' list from the run's response after clicking Fill in now", async () => {
    const Wrapper = makeStableWrapper();
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("shade-material-gaps-list"), { timeout: 5000 });

    fireEvent.click(screen.getByTestId("shade-material-backfill-run-btn"));

    const remainingList = await waitFor(
      () => screen.getByTestId("shade-material-remaining-list"),
      { timeout: 5000 },
    );

    // The fully-fixed invoice is gone from the remaining list...
    expect(within(remainingList).queryByTestId("shade-material-gap-row-inv-full")).toBeNull();
    // ...but the partially-fixed and untouched invoices still need review.
    expect(within(remainingList).getByTestId("shade-material-gap-row-inv-partial")).toBeTruthy();
    expect(within(remainingList).getByTestId("shade-material-gap-row-inv-none")).toBeTruthy();

    const backfillCall = apiFetchMock.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].startsWith("/invoices/admin/shade-material-backfill") &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(backfillCall).toBeTruthy();
  });
});
