/** @vitest-environment jsdom */
/**
 * Barcode conflict detection — desktop cases list & case drawer
 *
 * Guards:
 * - Conflict badges appear only for active (non-complete) cases that share a
 *   pan barcode with at least one other active case in the same lab.
 * - Completed cases are excluded from conflict calculation even when their
 *   barcode matches active cases.
 * - Deleted cases never appear in API responses (server-side filtering); the
 *   client-side conflict logic therefore never needs to check deleted_at. Tests
 *   that validate the deleted exclusion are in the api-server test suite.
 * - The conflict count badge reflects the number of conflicting rows visible.
 * - The "Conflicts only" toggle narrows the list to conflicting rows and removes
 *   non-conflicting rows from the table.
 * - Typing in the barcode filter input triggers a server-side query with the
 *   `?barcode=` parameter (rather than client-side substring search).
 * - When the barcode filter is active, conflict detection switches to
 *   barcodeSearch.data — not the main list — so the conflicts shown match the
 *   server's returned set for that barcode, not the local paginated cache.
 * - Inline barcode edit in the case drawer shows an amber warning in real time
 *   when the typed barcode is already used by another active case.
 * - The warning includes the conflicting case number and a "Save anyway" button.
 * - The warning clears automatically when the barcode becomes unique again.
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CasesPage, { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const LAB = "lab-1";

/**
 * Two active cases that share BC-DUPE — both should receive a Conflict badge.
 * One completed case that also carries BC-DUPE — must NOT receive a badge.
 * One active case with a unique barcode — must NOT receive a badge.
 */
const ACTIVE_A = {
  id: "c-a", caseNumber: "1001",
  patientFirstName: "Alice", patientLastName: "Alpha",
  doctorName: "Dr. A", status: "received", priority: "normal",
  casePanBarcode: "BC-DUPE", labOrganizationId: LAB,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  totalPrice: "0", dueDate: null,
};

const ACTIVE_B = {
  ...ACTIVE_A, id: "c-b", caseNumber: "1002",
  patientFirstName: "Bob", patientLastName: "Beta",
};

// Same barcode, but completed — must be excluded from conflict detection.
const COMPLETED_C = {
  ...ACTIVE_A, id: "c-c", caseNumber: "1003",
  patientFirstName: "Carol", patientLastName: "Gamma",
  status: "complete",
};

// Unique barcode — no conflict.
const ACTIVE_D = {
  ...ACTIVE_A, id: "c-d", caseNumber: "1004",
  patientFirstName: "Dave", patientLastName: "Delta",
  casePanBarcode: "BC-UNIQUE",
};

const ALL_CASES = [ACTIVE_A, ACTIVE_B, COMPLETED_C, ACTIVE_D];

// ── Fetch stub factory ───────────────────────────────────────────────────────

/**
 * Returns a vi.fn() that serves controlled JSON responses:
 * - `/api/cases?barcode=…`  → barcode search results (barcodeResults param, or
 *   all cases if omitted)
 * - `/api/cases`            → the main case list (mainCases param)
 * - `/api/organizations`    → empty array
 * - everything else         → empty object `{}`
 */
function makeFetchStub(
  mainCases: unknown[] = ALL_CASES,
  barcodeResults?: unknown[],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("?barcode=")) {
      const payload = barcodeResults ?? mainCases;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/cases") || url.includes("/api/cases?")) {
      return new Response(JSON.stringify(mainCases), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/organizations")) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Barcode conflict detection — desktop cases list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchStub());
  });

  it("shows a Conflict badge for each active case sharing a pan barcode with another active case", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await waitFor(() => {
      expect(screen.getAllByLabelText("Barcode conflict").length).toBe(2);
    });
  });

  it("does NOT show a Conflict badge for the completed case even though it carries the duplicate barcode", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await waitFor(() => {
      // Exactly 2 badges — the completed row is excluded
      expect(screen.getAllByLabelText("Barcode conflict").length).toBe(2);
    });

    // Completed case's patient name is still visible (row exists in the list)
    expect(screen.getAllByText(/Carol/).length).toBeGreaterThan(0);
  });

  it("does NOT show a Conflict badge for a case with a unique barcode", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await waitFor(() => {
      // Dave has BC-UNIQUE — no conflict
      expect(screen.getAllByLabelText("Barcode conflict").length).toBe(2);
    });

    expect(screen.getAllByText(/Dave/).length).toBeGreaterThan(0);
  });

  it("conflict count badge reflects the number of conflicting rows in the current list", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // The conflict count badge should show "2" (ACTIVE_A and ACTIVE_B)
    await waitFor(() => {
      expect(
        screen.getAllByText("2").some(
          (el) => el.closest("button") !== null || el.closest("[class*='amber']") !== null,
        ),
      ).toBe(true);
    });
  });

  it("'Conflicts only' toggle hides rows that are not involved in a barcode conflict", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await waitFor(() => {
      expect(screen.getAllByLabelText("Barcode conflict").length).toBe(2);
    });

    // Activate "Conflicts only"
    const conflictsBtn = screen.getByTitle(
      /Show only cases that share a pan barcode/i,
    );
    fireEvent.click(conflictsBtn);

    await waitFor(() => {
      // Dave (unique barcode) must disappear
      expect(screen.queryByText(/Dave/)).toBeNull();
      // Carol (completed — not conflicting) must disappear
      expect(screen.queryByText(/Carol/)).toBeNull();
      // Alice and Bob (conflicting) must remain
      expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0);
    });
  });

  it("'Conflicts only' toggle is disabled when there are no conflicts in the list", async () => {
    // Only one case — no duplicate, no conflicts
    vi.stubGlobal("fetch", makeFetchStub([ACTIVE_D]));

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await waitFor(() => {
      expect(screen.queryAllByLabelText("Barcode conflict").length).toBe(0);
    });

    const conflictsBtn = screen.getByTitle(/No barcode conflicts detected/i);
    expect(conflictsBtn).toBeDisabled();
  });

  it("barcode filter input triggers a server-side query with the ?barcode= parameter", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    const barcodeInput = screen.getByPlaceholderText(/Filter by exact barcode/i);
    fireEvent.change(barcodeInput, { target: { value: "BC-DUPE" } });

    await waitFor(() => {
      const urls: string[] = (fetchStub as ReturnType<typeof vi.fn>).mock.calls.map(
        ([input]: [RequestInfo | URL]) =>
          typeof input === "string" ? input : input.toString(),
      );
      expect(urls.some((u) => u.includes("?barcode="))).toBe(true);
    });
  });

  it("barcode server query uses the trimmed filter value as the ?barcode= param", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    fireEvent.change(screen.getByPlaceholderText(/Filter by exact barcode/i), {
      target: { value: "  BC-DUPE  " },
    });

    await waitFor(() => {
      const urls: string[] = (fetchStub as ReturnType<typeof vi.fn>).mock.calls.map(
        ([input]: [RequestInfo | URL]) =>
          typeof input === "string" ? input : input.toString(),
      );
      expect(
        urls.some(
          (u) =>
            u.includes("?barcode=") &&
            decodeURIComponent(u).includes("BC-DUPE") &&
            !decodeURIComponent(u).includes("  "),
        ),
      ).toBe(true);
    });
  });

  it("conflict detection switches to barcodeSearch.data when barcode filter is active (discriminating fixture)", async () => {
    // Discriminating setup:
    //   main list  → only ACTIVE_A (1 BC-DUPE case) — NOT enough for a conflict
    //   barcode search → [ACTIVE_A, ACTIVE_B] (2 BC-DUPE cases) — IS a conflict
    //
    // If the component accidentally reads from the main list while the barcode
    // filter is active, conflictCount would be 0 and no badges would appear.
    // The test passes ONLY when the component correctly sources conflicts from
    // the barcodeSearch payload.
    const fetchStub = makeFetchStub([ACTIVE_A], [ACTIVE_A, ACTIVE_B]);
    vi.stubGlobal("fetch", fetchStub);

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // Verify baseline: with just one BC-DUPE case in the main list, no conflicts
    await waitFor(() => {
      expect(screen.queryAllByLabelText("Barcode conflict").length).toBe(0);
    });

    // Activate barcode filter → component now sources conflicts from barcodeSearch
    fireEvent.change(screen.getByPlaceholderText(/Filter by exact barcode/i), {
      target: { value: "BC-DUPE" },
    });

    // Barcode search returns two matching active cases → conflict is now detected
    await waitFor(() => {
      expect(screen.getAllByLabelText("Barcode conflict").length).toBe(2);
    });
  });
});

// ── Inline barcode edit conflict warning — CaseDrawer ───────────────────────

const DRAWER_LAB_ID = "lab-drawer";

const BASE_CASE: LabCase = {
  id: "case-edit",
  caseNumber: "100",
  patientFirstName: "Edit",
  patientLastName: "Case",
  doctorName: "Dr. Edit",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  totalPrice: "0",
  labOrganizationId: DRAWER_LAB_ID,
  casePanBarcode: "CURRENT-BC",
} as unknown as LabCase;

const CONFLICT_CASE_FIXTURE = {
  id: "case-other",
  caseNumber: "200",
  casePanBarcode: "CONFLICT-BC",
  labOrganizationId: DRAWER_LAB_ID,
  status: "received",
};

function makeDrawerFetch(
  conflictResults: unknown[] = [],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("?barcode=")) {
      return new Response(JSON.stringify(conflictResults), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Default: return empty array — safe for .map() calls on any endpoint
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("Inline barcode edit conflict warning — CaseDrawer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeDrawerFetch([]));
  });

  it("shows an amber warning when the typed barcode is already in use by another active case", async () => {
    vi.stubGlobal("fetch", makeDrawerFetch([CONFLICT_CASE_FIXTURE]));

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    // Enter inline barcode edit mode
    const barcodeBtn = screen.getByTitle(/Click to edit barcode/i);
    fireEvent.click(barcodeBtn);

    // Type a conflicting barcode
    const input = screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i);
    fireEvent.change(input, { target: { value: "CONFLICT-BC" } });

    await waitFor(() => {
      expect(
        screen.getByText(/already used by an active case/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Case #200/)).toBeInTheDocument();
  });

  it("includes the conflicting case number in the warning message", async () => {
    vi.stubGlobal("fetch", makeDrawerFetch([CONFLICT_CASE_FIXTURE]));

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    fireEvent.change(
      screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      { target: { value: "CONFLICT-BC" } },
    );

    await waitFor(() => {
      expect(screen.getByText(/Case #200/)).toBeInTheDocument();
    });
  });

  it("shows a 'Save anyway' button when a conflict is detected", async () => {
    vi.stubGlobal("fetch", makeDrawerFetch([CONFLICT_CASE_FIXTURE]));

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    fireEvent.change(
      screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      { target: { value: "CONFLICT-BC" } },
    );

    await waitFor(() => {
      expect(screen.getByText(/Save anyway/i)).toBeInTheDocument();
    });
  });

  it("clears the warning when the typed barcode becomes unique", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("barcode=CONFLICT-BC")) {
        return new Response(JSON.stringify([CONFLICT_CASE_FIXTURE]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("?barcode=")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Default: return empty array — safe for .map() calls on any endpoint
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    const input = screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i);

    // Type conflicting barcode — warning should appear
    fireEvent.change(input, { target: { value: "CONFLICT-BC" } });
    await waitFor(() => {
      expect(screen.getByText(/already used by an active case/i)).toBeInTheDocument();
    });

    // Change to a unique barcode — warning should clear
    fireEvent.change(input, { target: { value: "UNIQUE-BC" } });
    await waitFor(() => {
      expect(screen.queryByText(/already used by an active case/i)).toBeNull();
    });
  });

  it("'Save anyway' button sends allowDuplicate and exits edit mode", async () => {
    vi.stubGlobal("fetch", makeDrawerFetch([CONFLICT_CASE_FIXTURE]));

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    fireEvent.change(
      screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      { target: { value: "CONFLICT-BC" } },
    );

    await waitFor(() => {
      expect(screen.getByText(/Save anyway/i)).toBeInTheDocument();
    });

    // Click "Save anyway" — edit mode should exit (input disappears)
    fireEvent.click(screen.getByText(/Save anyway/i));

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      ).toBeNull();
    });

    // The PATCH call must have been made with allowDuplicateBarcode: true
    const patchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([input, init]: [RequestInfo | URL, RequestInit | undefined]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.includes(`/cases/${BASE_CASE.id}`) && init?.method === "PATCH";
      },
    );
    expect(patchCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(patchCalls[0][1].body as string) as Record<string, unknown>;
    expect(body.allowDuplicateBarcode).toBe(true);
  });

  it("does NOT warn when the only conflicting case has status 'complete'", async () => {
    const completedConflict = { ...CONFLICT_CASE_FIXTURE, status: "complete" };
    vi.stubGlobal("fetch", makeDrawerFetch([completedConflict]));

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    fireEvent.change(
      screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      { target: { value: "CONFLICT-BC" } },
    );

    // Give the debounce time to fire and resolve
    await new Promise((r) => setTimeout(r, 600));

    // No warning — completed case must not count as a conflict
    expect(screen.queryByText(/already used by an active case/i)).toBeNull();
    expect(screen.queryByText(/Save anyway/i)).toBeNull();
  });

  it("conflict check sends 'organizationId' (not 'labOrganizationId') to scope the search to the current lab", async () => {
    const fetchStub = makeDrawerFetch([CONFLICT_CASE_FIXTURE]);
    vi.stubGlobal("fetch", fetchStub);

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTitle(/Click to edit barcode/i));
    fireEvent.change(
      screen.getByPlaceholderText(/Scan or type barcode.*blank to clear/i),
      { target: { value: "CONFLICT-BC" } },
    );

    await waitFor(() => {
      const urls: string[] = (fetchStub as ReturnType<typeof vi.fn>).mock.calls.map(
        ([input]: [RequestInfo | URL]) =>
          typeof input === "string" ? input : input.toString(),
      );
      const conflictUrl = urls.find((u) => u.includes("?barcode="));
      expect(conflictUrl).toBeDefined();
      const parsed = new URL(conflictUrl!, "http://localhost");
      expect(parsed.searchParams.get("organizationId")).toBe(DRAWER_LAB_ID);
      expect(parsed.searchParams.has("labOrganizationId")).toBe(false);
    });
  });
});
