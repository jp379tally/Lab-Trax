/**
 * @vitest-environment jsdom
 *
 * Task #3271: confirm the Case Type filter's handling of cases with no
 * restoration type is intentional and consistent, not a silent regression.
 *
 * `deriveCaseHierarchy` returns `{ caseType: null, ... }` for a case with an
 * empty/null `restorationTypes`, and `hierarchyToCaseCategory` maps that to
 * `null`. The `filtered` useMemo in cases.tsx then falls back to the
 * `"other"` bucket (`hierarchyToCaseCategory(hierarchy) ?? "other"`), so an
 * uncategorized case:
 *   - is hidden when a specific real category (e.g. "Removable") is selected
 *   - still surfaces under the "Other" filter
 *   - is always shown under the "All types" default
 * These tests pin that behavior so a future change can't silently start
 * dropping uncategorized cases from every filter with no error shown.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CasesPage from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

// jspdf/react-pdf pull in heavy/non-jsdom-friendly modules at import time and
// aren't exercised by this filter-only test — stub them like the sibling
// smoke-test file does.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function makeCase(overrides: Partial<LabCase> = {}): LabCase {
  return {
    id: "case-1",
    caseNumber: "26-1",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    doctorName: "Dr. Synthetic063",
    status: "received",
    priority: "normal",
    dueDate: null,
    createdAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
    totalPrice: "0",
    restorationTypes: null,
    restorationMaterials: null,
    firstRestorationSubtype: null,
    ...overrides,
  } as unknown as LabCase;
}

// A crown case with no material — maps to the "Crown & Bridge" category.
const CROWN_CASE = makeCase({
  id: "case-crown",
  caseNumber: "26-CROWN",
  restorationTypes: "Crown",
  restorationMaterials: null,
});

// A denture case — maps to the "Removable" category.
const DENTURE_CASE = makeCase({
  id: "case-denture",
  caseNumber: "26-DENTURE",
  restorationTypes: "Denture",
  restorationMaterials: null,
});

// No restoration type/material/subtype at all — deriveCaseHierarchy returns
// caseType: null, which hierarchyToCaseCategory maps to null and the page
// buckets as "other".
const NO_TYPE_CASE = makeCase({
  id: "case-no-type",
  caseNumber: "26-NOTYPE",
  restorationTypes: null,
  restorationMaterials: null,
  firstRestorationSubtype: null,
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// The Case Type filter is a multi-select: open its trigger and toggle the
// option's checkbox. Checking a single option is the multi-select equivalent
// of the old single-value <select> choice.
function selectCaseTypeFilter(label: string) {
  fireEvent.click(screen.getByTestId("cases-type-filter"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: label }));
}

async function activateNormalPriority() {
  fireEvent.click(screen.getByTestId("cases-priority-filter"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Normal" }));
  await screen.findByText("26-CROWN");
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname.endsWith("/cases/worklist")) {
        const categories = parsed.searchParams.getAll("caseType");
        const categoryFor = (labCase: LabCase) =>
          labCase.id === CROWN_CASE.id ? "crown_bridge" :
          labCase.id === DENTURE_CASE.id ? "removable" : "other";
        const rows = categories.length
          ? [CROWN_CASE, DENTURE_CASE, NO_TYPE_CASE].filter((labCase) => categories.includes(categoryFor(labCase)))
          : [CROWN_CASE, DENTURE_CASE, NO_TYPE_CASE];
        return jsonResponse({ rows, total: rows.length, page: 1, pageSize: 50, hasMore: false });
      }
      if (url.includes("/organizations") || url.includes("/locations")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    }),
  );
});

describe("Cases list — Case Type filter and uncategorized (no-restoration-type) cases", () => {
  it('"All types" (default) shows every case, including one with no restoration type', async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await activateNormalPriority();
    expect(screen.getByText("26-CROWN")).toBeInTheDocument();
    expect(screen.getByText("26-DENTURE")).toBeInTheDocument();
    expect(screen.getByText("26-NOTYPE")).toBeInTheDocument();
  });

  it("filtering by a valid case type shows only cases in that category", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await activateNormalPriority();
    selectCaseTypeFilter("Removable");

    await waitFor(() => {
      expect(screen.getByText("26-DENTURE")).toBeInTheDocument();
      expect(screen.queryByText("26-CROWN")).not.toBeInTheDocument();
      expect(screen.queryByText("26-NOTYPE")).not.toBeInTheDocument();
    });
  });

  it("a case with no restoration type is hidden under an unrelated specific Case Type filter", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await activateNormalPriority();
    selectCaseTypeFilter("Crown & Bridge");

    await waitFor(() => {
      expect(screen.getByText("26-CROWN")).toBeInTheDocument();
      expect(screen.queryByText("26-NOTYPE")).not.toBeInTheDocument();
      expect(screen.queryByText("26-DENTURE")).not.toBeInTheDocument();
    });
  });

  it('a case with no restoration type still surfaces under the "Other" filter (not silently lost)', async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    await activateNormalPriority();
    selectCaseTypeFilter("Other");

    await waitFor(() => {
      expect(screen.getByText("26-NOTYPE")).toBeInTheDocument();
      expect(screen.queryByText("26-CROWN")).not.toBeInTheDocument();
      expect(screen.queryByText("26-DENTURE")).not.toBeInTheDocument();
    });
  });
});
