/**
 * @vitest-environment jsdom
 *
 * Guards two things:
 *
 * 1. CasesTable (component-level): the "Type" column header (`<th>Type</th>`)
 *    appears when `showTypeIndicator={true}` and is absent when the prop is
 *    omitted or false.
 *
 * 2. DashboardPage (section-level wiring): the badge column is present in the
 *    "Due today" and "Past due" sections and absent in the "No due date"
 *    section, matching the `showTypeIndicator` assignments in the JSX. Any
 *    accidental addition or removal of `showTypeIndicator` on a section-level
 *    CasesTable invocation will break the assertions here.
 */

import React from "react";
import { format } from "date-fns";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { cleanup } from "@testing-library/react";

// ── Shared mock state (hoisted so vi.mock factories can read it) ───────────

const mockQueryResults = vi.hoisted(
  () =>
    new Map<
      string,
      { data: unknown; isLoading: boolean; isSuccess: boolean }
    >(),
);

// ── Module-level mocks (hoisted before imports) ────────────────────────────

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {},
  getAccessToken: vi.fn(),
  getApiOrigin: vi.fn().mockReturnValue("http://localhost"),
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: vi.fn().mockReturnValue({ user: null, status: "anonymous" }),
  AuthContext: {
    Provider: ({ children }: { children: React.ReactNode }) => children,
  },
}));

vi.mock("@/lib/ai-panel-context", () => ({
  useAiPanel: vi.fn().mockReturnValue({ open: false, setOpen: vi.fn() }),
}));

vi.mock("@/lib/platform-admin-gate", () => ({
  usePlatformAdminGate: vi.fn().mockReturnValue({ isAdmin: false }),
  PlatformAdminSetupNotice: () => null,
}));

vi.mock("@/lib/platform-admin-query", () => ({
  retryUnlessForbidden: vi.fn((fn: unknown) => fn),
  haltPollingIfForbidden: vi.fn((fn: unknown) => fn),
}));

vi.mock("@/lib/cleanup-schedule", () => ({
  formatNextCleanupTime: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/backup-schedule", () => ({
  formatNextBackupTime: vi.fn().mockReturnValue(""),
}));

vi.mock("@/components/TriggeredByBadge", () => ({
  TriggeredByBadge: () => null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi
    .fn()
    .mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = JSON.stringify(queryKey);
      const stored = mockQueryResults.get(key);
      if (stored) return stored;
      return { data: undefined, isLoading: false, isSuccess: false };
    }),
  useMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/useDayChange", () => ({
  useDayChange: vi.fn(),
}));

vi.mock("@/components/DashboardDropZone", () => ({
  DashboardDropZone: () => null,
}));

vi.mock("@/components/UnassignedDocumentsCard", () => ({
  UnassignedDocumentsCard: () => null,
}));

vi.mock("@/pages/cases", () => ({
  NewCaseModal: () => null,
  CaseDrawer: () => null,
}));

vi.mock("@/components/TrialBanner", () => ({
  DashboardSubscriptionBanner: () => null,
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) =>
    React.createElement("a", null, children),
  useLocation: vi.fn().mockReturnValue(["/", vi.fn()]),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, status),
}));

// ── Actual imports (after mocks are hoisted) ───────────────────────────────

import { CasesTable } from "@/pages/dashboard";
import type { LabCase } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function todayString(): string {
  return format(new Date(), "yyyy-MM-dd");
}

function yesterdayString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return format(d, "yyyy-MM-dd");
}

function makeCase(overrides: Partial<LabCase> = {}): LabCase {
  return {
    id: "case-001",
    caseNumber: "LAB-001",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    doctorName: "Dr. Synthetic063",
    status: "in_progress",
    priority: "normal",
    dueDate: null,
    createdAt: "2026-07-01T10:00:00Z",
    receivedAt: "2026-07-01T10:00:00Z",
    casePanBarcode: null,
    restorationTypes: "crown",
    restorationMaterials: "zirconia",
    organizationId: "org-1",
    ...overrides,
  } as unknown as LabCase;
}

const NO_OP = () => {};

// ---------------------------------------------------------------------------
// CasesTable — showTypeIndicator controls the "Type" <th>
// ---------------------------------------------------------------------------

describe("CasesTable — 'Type' column header presence", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the 'Type' <th> when showTypeIndicator is true (Due Today section)", () => {
    render(
      <CasesTable
        cases={[makeCase()]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    expect(screen.getByRole("columnheader", { name: /type/i })).toBeDefined();
  });

  it("does NOT render the 'Type' <th> when showTypeIndicator is omitted (Past Due section)", () => {
    render(
      <CasesTable
        cases={[makeCase()]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: /type/i })).toBeNull();
  });

  it("does NOT render the 'Type' <th> when showTypeIndicator is false (No Due Date section)", () => {
    render(
      <CasesTable
        cases={[makeCase()]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator={false}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: /type/i })).toBeNull();
  });

  it("always renders the fixed column headers regardless of showTypeIndicator", () => {
    const { rerender } = render(
      <CasesTable
        cases={[]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    for (const name of [
      "Case #",
      "Patient",
      "Doctor",
      "Status",
      "Location",
      "Due date",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeDefined();
    }

    rerender(
      <CasesTable
        cases={[]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
      />,
    );
    for (const name of [
      "Case #",
      "Patient",
      "Doctor",
      "Status",
      "Location",
      "Due date",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeDefined();
    }
  });

  it("renders 7 columns with showTypeIndicator and 6 columns without", () => {
    const { rerender, container } = render(
      <CasesTable
        cases={[]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    expect(container.querySelectorAll("th").length).toBe(7);

    rerender(
      <CasesTable
        cases={[]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
      />,
    );
    expect(container.querySelectorAll("th").length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// CasesTable — type badge values in rows
// ---------------------------------------------------------------------------

describe("CasesTable — type badge values in data rows", () => {
  afterEach(() => {
    cleanup();
  });

  it('shows "C" badge for a crown/zirconia case when showTypeIndicator is true', () => {
    render(
      <CasesTable
        cases={[
          makeCase({
            restorationTypes: "crown",
            restorationMaterials: "zirconia",
          }),
        ]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    expect(screen.getByText("C")).toBeDefined();
  });

  it('shows "D" badge for a denture case when showTypeIndicator is true', () => {
    render(
      <CasesTable
        cases={[
          makeCase({ restorationTypes: "denture", restorationMaterials: null }),
        ]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    expect(screen.getByText("D")).toBeDefined();
  });

  it("shows a dash (—) for an unclassifiable case when showTypeIndicator is true", () => {
    render(
      <CasesTable
        cases={[
          makeCase({ restorationTypes: null, restorationMaterials: null }),
        ]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders NO badge cell when showTypeIndicator is false, even for a crown case", () => {
    render(
      <CasesTable
        cases={[
          makeCase({
            restorationTypes: "crown",
            restorationMaterials: "zirconia",
          }),
        ]}
        loading={false}
        emptyText="No cases."
        onSelect={NO_OP}
        showTypeIndicator={false}
      />,
    );
    expect(screen.queryByText("C")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DashboardPage — section-level wiring
//
// These tests render the full DashboardPage and verify that the "Type" column
// header appears exactly in the Due Today section and nowhere else. If
// `showTypeIndicator` is accidentally added to or removed from any section's
// CasesTable invocation in dashboard.tsx, these assertions will fail.
// ---------------------------------------------------------------------------

describe("DashboardPage — Type badge column wiring per section", () => {
  afterEach(() => {
    cleanup();
    mockQueryResults.clear();
  });

  function seedCases(cases: LabCase[]) {
    mockQueryResults.set(JSON.stringify(["cases"]), {
      data: cases,
      isLoading: false,
      isSuccess: true,
    });
    // Provide an active lab membership so the component renders the main
    // dashboard (not the "join a lab" flow, which appears when
    // meQuery.isSuccess && !hasActiveLabMembership).
    mockQueryResults.set(JSON.stringify(["auth", "me"]), {
      data: {
        memberships: [
          {
            status: "active",
            organization: { type: "lab", id: "org-1", name: "Test Lab" },
          },
        ],
      },
      isLoading: false,
      isSuccess: true,
    });
  }

  async function renderDashboard() {
    const { default: DashboardPage } = await import("@/pages/dashboard");
    return render(<DashboardPage />);
  }

  it("'Type' <th> is present in the Due Today section", async () => {
    seedCases([
      makeCase({ id: "due-today", dueDate: todayString(), status: "received" }),
    ]);

    const { container } = await renderDashboard();

    const dueTodayHeading = screen.getByRole("heading", { name: /due today/i });
    const dueTodaySection = dueTodayHeading.closest("section");
    expect(dueTodaySection).not.toBeNull();

    const typeHeader = within(dueTodaySection!).queryByRole("columnheader", {
      name: /type/i,
    });
    expect(typeHeader).not.toBeNull();
    void container;
  });

  it("'Type' <th> is present in the Past Due section", async () => {
    seedCases([
      makeCase({
        id: "past-due",
        dueDate: yesterdayString(),
        status: "received",
      }),
    ]);

    const { container } = await renderDashboard();

    const pastDueHeading = screen.getByRole("heading", { name: /past due/i });
    const pastDueSection = pastDueHeading.closest("section");
    expect(pastDueSection).not.toBeNull();

    const typeHeader = within(pastDueSection!).queryByRole("columnheader", {
      name: /type/i,
    });
    expect(typeHeader).not.toBeNull();
    void container;
  });

  it("'Type' <th> is NOT present in the No Due Date section", async () => {
    seedCases([
      makeCase({ id: "no-due-date", dueDate: null, status: "received" }),
    ]);

    const { container } = await renderDashboard();

    const noDueDateHeading = screen.getByRole("heading", {
      name: /no due date/i,
    });
    const noDueDateSection = noDueDateHeading.closest("section");
    expect(noDueDateSection).not.toBeNull();

    const typeHeader = within(noDueDateSection!).queryByRole("columnheader", {
      name: /type/i,
    });
    expect(typeHeader).toBeNull();
    void container;
  });

  it("Due Today and Past Due have 'Type' <th>; No Due Date does not", async () => {
    seedCases([
      makeCase({
        id: "past-due",
        dueDate: yesterdayString(),
        status: "received",
      }),
      makeCase({ id: "due-today", dueDate: todayString(), status: "received" }),
      makeCase({ id: "no-due-date", dueDate: null, status: "received" }),
    ]);

    const { container } = await renderDashboard();

    const dueTodaySection = screen
      .getByRole("heading", { name: /due today/i })
      .closest("section");
    const pastDueSection = screen
      .getByRole("heading", { name: /past due/i })
      .closest("section");
    const noDueDateSection = screen
      .getByRole("heading", { name: /no due date/i })
      .closest("section");

    expect(
      within(dueTodaySection!).queryByRole("columnheader", { name: /type/i }),
    ).not.toBeNull();
    expect(
      within(pastDueSection!).queryByRole("columnheader", { name: /type/i }),
    ).not.toBeNull();
    expect(
      within(noDueDateSection!).queryByRole("columnheader", { name: /type/i }),
    ).toBeNull();
    void container;
  });
});
