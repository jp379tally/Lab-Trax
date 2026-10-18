/** @vitest-environment jsdom */
/**
 * Regression tests for the "hide tooth chart / tooth-number when a removable
 * restoration type is selected" behaviour on the desktop client.
 *
 * Two surfaces are covered, both driven by CatalogRestorationPicker's
 * Case Type → Subtype → Material FieldCombobox trio (mocked below to plain
 * controlled inputs). Neither test fixture loads real catalog data, so the
 * picker falls back to its first ("Case Type…") combobox to drive
 * restorationType directly, mirroring the single-select it replaced:
 *  1. NewCaseModal restoration rows — type change hides the Tooth # input.
 *  2. CaseDrawer "Add manually" drawer form — type change hides the
 *     Tooth # / Range input AND the mini ToothChart.
 *
 * Both use `isRemovableRestorationType` from @/lib/restoration-category to
 * drive conditional rendering. If a future refactor bypasses that guard, these
 * tests will fail before the regression ships.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { NewCaseModal, CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";

// ─── Shared module stubs ──────────────────────────────────────────────────────

// Heavy PDF dependencies not needed for restoration-visibility tests.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// The interactive SVG ToothChart is not needed for these tests.
// Replace all ToothChart exports with lightweight stubs. CaseDrawer also
// imports pure-function utilities (parseBridgeConnectors, formatToothSet, etc.)
// from the same module — those must be re-exported from the real module so the
// component initialises correctly.
vi.mock("@/components/ToothChart", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ToothChart")>();
  return {
    ...real,
    ToothChart: () => <div data-testid="stub-tooth-chart" />,
    ReadOnlyToothChart: () => null,
  };
});

// FieldCombobox is a portal-based combobox whose dropdown relies on real DOM
// layout. Replace it with a controlled <input> that directly fires onChange so
// the restoration-type state change is predictable in jsdom.
vi.mock("@/components/FieldCombobox", () => ({
  FieldCombobox: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    [k: string]: unknown;
  }) => (
    <input
      data-testid={`fcombo-${placeholder ?? "unknown"}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// Minimal case used across drawer tests.
const FAKE_CASE: LabCase = {
  id: "case-1",
  caseNumber: "26-1",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  doctorName: "Dr. Synthetic063",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: new Date("2026-01-15T10:00:00Z").toISOString(),
  updatedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
  totalPrice: "0",
} as unknown as LabCase;

// ─── 1. NewCaseModal — restoration row ───────────────────────────────────────

describe("NewCaseModal restoration row — removable type hides Tooth # input", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([])),
    );
  });

  function renderModal() {
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<NewCaseModal onClose={() => {}} />)}
      </Wrapper>,
    );
  }

  /**
   * Returns the restoration-type combobox (CatalogRestorationPicker's first,
   * "Case Type…", field) after "Add row" has been clicked. With no catalog
   * data loaded, this field drives restorationType directly.
   */
  function getTypeCombo() {
    return screen.getByTestId("fcombo-Case Type…") as HTMLInputElement;
  }

  it("shows the Tooth # input for a non-removable type (default empty)", () => {
    renderModal();
    fireEvent.click(screen.getByText("Add row"));

    // Default state: restorationType is "", not removable → tooth# is visible.
    expect(screen.getByPlaceholderText("e.g. 3, 14")).toBeInTheDocument();
  });

  it("hides the Tooth # input when type is changed to 'Full Denture'", () => {
    renderModal();
    fireEvent.click(screen.getByText("Add row"));

    fireEvent.change(getTypeCombo(), { target: { value: "Full Denture" } });

    // Tooth # input must no longer be rendered.
    expect(screen.queryByPlaceholderText("e.g. 3, 14")).not.toBeInTheDocument();
  });

  it("restores Tooth # input when type is switched back to a fixed type", () => {
    renderModal();
    fireEvent.click(screen.getByText("Add row"));

    const typeCombo = getTypeCombo();

    // Switch to removable (use "Partial Denture" which is in RESTORATION_TYPES).
    fireEvent.change(typeCombo, { target: { value: "Partial Denture" } });
    expect(screen.queryByPlaceholderText("e.g. 3, 14")).not.toBeInTheDocument();

    // Switch back to a fixed type.
    fireEvent.change(typeCombo, { target: { value: "Crown" } });
    expect(screen.getByPlaceholderText("e.g. 3, 14")).toBeInTheDocument();
  });
});

// ─── 2. CaseDrawer "Add manually" form ───────────────────────────────────────

describe('CaseDrawer "Add manually" form — removable type hides Tooth # / Range and mini ToothChart', () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;

        if (path.includes("/cases/case-1")) {
          return jsonResponse({
            ...FAKE_CASE,
            restorations: [],
            attachments: [],
            notes: [],
          });
        }
        if (path.endsWith("/invoices")) return jsonResponse([]);
        if (path.endsWith("/organizations")) return jsonResponse([]);
        if (path.includes("/vocabulary")) return jsonResponse([]);
        return jsonResponse({});
      }),
    );
  });

  async function renderDrawerAtRestorations() {
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={FAKE_CASE} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    // Navigate to the Restorations tab.
    const restoTab = await screen.findByRole("button", { name: /restorations/i });
    fireEvent.click(restoTab);

    // Open the "Add manually" drawer form.
    const addManually = await screen.findByRole("button", { name: /add manually/i });
    fireEvent.click(addManually);
  }

  it("shows the Tooth # / Range input before any type is selected", async () => {
    await renderDrawerAtRestorations();

    // The tooth/range input is visible when restorationType is blank (not removable).
    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 14 or 14-16")).toBeInTheDocument();
    });
  });

  it("shows the mini ToothChart before any type is selected (both main + mini)", async () => {
    await renderDrawerAtRestorations();

    // Two ToothChart instances: one main interactive chart, one mini inside the
    // "Add manually" Tooth # section.  Both render as stub-tooth-chart divs.
    await waitFor(() => {
      expect(screen.getAllByTestId("stub-tooth-chart").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("hides Tooth # / Range input when restoration type is set to 'Full Denture'", async () => {
    await renderDrawerAtRestorations();

    // Set the restoration type to a removable type via the mocked FieldCombobox.
    // The restoration type field is now CatalogRestorationPicker's first
    // ("Category") combobox — with no catalog data loaded (no labOrganizationId
    // on FAKE_CASE), it falls back to driving restorationType directly, just
    // like the single "Select type…" combobox it replaced.
    const typeCombo = await screen.findByTestId("fcombo-Case Type…");
    fireEvent.change(typeCombo, { target: { value: "Full Denture" } });

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("e.g. 14 or 14-16"),
      ).not.toBeInTheDocument();
    });
  });

  it("mini ToothChart is hidden when restoration type is set to 'Valplast' (only main chart remains)", async () => {
    await renderDrawerAtRestorations();

    // Before: both main + mini chart are present.
    await waitFor(() => {
      expect(screen.getAllByTestId("stub-tooth-chart").length).toBeGreaterThanOrEqual(2);
    });

    const typeCombo = await screen.findByTestId("fcombo-Case Type…");
    fireEvent.change(typeCombo, { target: { value: "Valplast" } });

    // After: only the main chart remains — the mini ToothChart inside the
    // Tooth # / Range section is gone.
    await waitFor(() => {
      expect(screen.getAllByTestId("stub-tooth-chart").length).toBe(1);
    });
  });

  it("restores both inputs when type is switched back to a fixed type", async () => {
    await renderDrawerAtRestorations();

    const typeCombo = await screen.findByTestId("fcombo-Case Type…");

    // Switch to removable — tooth# input and mini chart disappear.
    fireEvent.change(typeCombo, { target: { value: "Full Denture" } });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("e.g. 14 or 14-16"),
      ).not.toBeInTheDocument();
    });

    // Switch back to a non-removable type — both reappear.
    fireEvent.change(typeCombo, { target: { value: "Crown" } });
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("e.g. 14 or 14-16"),
      ).toBeInTheDocument();
      // Mini chart is back → at least 2 total stub-tooth-chart elements.
      expect(screen.getAllByTestId("stub-tooth-chart").length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ─── 3. CaseDrawer — catalog fetch error ─────────────────────────────────────

/**
 * When the case has a labOrganizationId the CatalogRestorationPicker fires a
 * real /catalog/tree fetch. If that request returns a non-200 status (network
 * hiccup, server error) useQuery leaves `catalog` undefined and the component
 * must fall back gracefully: the "Case Type…" combobox still drives
 * restorationType directly, the Tooth # input stays visible, and the user can
 * still change the type and submit the form.
 */

// A case that carries a labOrganizationId so useEffectiveCatalog fires.
const FAKE_CASE_WITH_LAB: LabCase = {
  ...FAKE_CASE,
  labOrganizationId: "lab-org-1",
} as unknown as LabCase;

describe("CaseDrawer — catalog fetch returns non-200 error", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;

        // Catalog endpoint returns a server error — this is the scenario under test.
        if (path.includes("/catalog/tree")) {
          return jsonResponse({ error: "Internal Server Error" }, 500);
        }

        if (path.includes("/cases/case-1")) {
          return jsonResponse({
            ...FAKE_CASE_WITH_LAB,
            restorations: [],
            attachments: [],
            notes: [],
          });
        }
        if (path.endsWith("/invoices")) return jsonResponse([]);
        if (path.endsWith("/organizations")) return jsonResponse([]);
        if (path.includes("/vocabulary")) return jsonResponse([]);
        // Finance billable-items query fires when labOrganizationId is set.
        if (path.includes("/finance/vendors")) return jsonResponse([]);
        return jsonResponse([]);
      }),
    );
  });

  async function renderDrawerAtRestorations() {
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={FAKE_CASE_WITH_LAB} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    const restoTab = await screen.findByRole("button", { name: /restorations/i });
    fireEvent.click(restoTab);

    const addManually = await screen.findByRole("button", { name: /add manually/i });
    fireEvent.click(addManually);
  }

  it("still renders the type picker (Case Type… combobox) after a catalog 500", async () => {
    await renderDrawerAtRestorations();

    // The Case Type… combobox must be present — the drawer is not hung or blank.
    await waitFor(() => {
      expect(screen.getByTestId("fcombo-Case Type…")).toBeInTheDocument();
    });
  });

  it("Tooth # / Range input is visible before any type is selected", async () => {
    await renderDrawerAtRestorations();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 14 or 14-16")).toBeInTheDocument();
    });
  });

  it("hides Tooth # / Range when a removable type is chosen after catalog error", async () => {
    await renderDrawerAtRestorations();

    const typeCombo = await screen.findByTestId("fcombo-Case Type…");
    fireEvent.change(typeCombo, { target: { value: "Full Denture" } });

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("e.g. 14 or 14-16"),
      ).not.toBeInTheDocument();
    });
  });

  it("restores Tooth # / Range when type is switched back to a fixed type after catalog error", async () => {
    await renderDrawerAtRestorations();

    const typeCombo = await screen.findByTestId("fcombo-Case Type…");

    fireEvent.change(typeCombo, { target: { value: "Full Denture" } });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("e.g. 14 or 14-16"),
      ).not.toBeInTheDocument();
    });

    fireEvent.change(typeCombo, { target: { value: "Crown" } });
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("e.g. 14 or 14-16"),
      ).toBeInTheDocument();
    });
  });
});
