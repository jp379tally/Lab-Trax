/** @vitest-environment jsdom */
/**
 * Focused regression guard: the shade and material FieldCombobox fields inside
 * the case-edit form (CaseDrawer edit mode) must show the **full** vocabulary
 * list when opened, even when the fields are pre-filled from the existing case
 * restorations.
 *
 * Invariants protected:
 *  - Editing a case whose restorations carry material="Zirconia" pre-fills the
 *    Material combobox with "Zirconia". Opening that combobox must show ALL
 *    material vocabulary options, not just "Zirconia".
 *  - The same holds for the Shade combobox pre-filled with "A2".
 *
 * These fields all use FieldCombobox (confirmed by audit — no separate inline
 * combobox implementations exist in the case edit or create forms for
 * shade/material/restoration type). The fix lives in FieldCombobox.onFocus:
 * it resets filterText to "" so the full suggestions list is shown on every
 * open regardless of the current input value.
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { CaseDrawer } from "@/pages/cases";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import type { LabCase } from "@/lib/types";
import type { SessionUser } from "@/lib/api";

// ─── Module mocks (same pattern as cases.test.tsx) ────────────────────────────

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LAB_ORG_ID = "lab-1";
const CASE_ID = "case-edit-shade-1";

const MATERIAL_VOCAB = [
  { id: "m1", value: "Zirconia", isDefault: true },
  { id: "m2", value: "PFM", isDefault: false },
  { id: "m3", value: "Emax", isDefault: false },
  { id: "m4", value: "Full Cast Gold", isDefault: false },
];

const SHADE_VOCAB = [
  { id: "s1", value: "A2", isDefault: true },
  { id: "s2", value: "A3", isDefault: false },
  { id: "s3", value: "B1", isDefault: false },
];

const RESTORATION_TYPE_VOCAB = [
  { id: "r1", value: "Crown & Bridge", isDefault: true },
];

/** Case returned for the initial prop (list-level shape). */
const fakeCase = {
  id: CASE_ID,
  caseNumber: "26-100",
  patientFirstName: "Alice",
  patientLastName: "Brown",
  doctorName: "Dr. Nguyen",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-01-10T09:00:00.000Z",
  updatedAt: "2026-01-10T09:00:00.000Z",
  totalPrice: "0",
  labOrganizationId: LAB_ORG_ID,
} as unknown as LabCase;

/** Detailed case returned by GET /cases/:id — includes restorations with
 *  a pre-set material and shade so CaseDrawer edit mode is pre-filled. */
const caseDetail = {
  ...fakeCase,
  notes: [],
  restorations: [
    {
      id: "rest-1",
      caseId: CASE_ID,
      toothNumber: "14",
      restorationType: "Crown & Bridge",
      material: "Zirconia",
      shade: "A2",
      quantity: 1,
    },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    const search = new URL(url, "http://localhost").search;

    if (path.endsWith(`/cases/${CASE_ID}`)) return json(caseDetail);
    if (path.endsWith("/cases")) return json([]);

    if (path.includes("/vocabulary") && search.includes("kind=material"))
      return json(MATERIAL_VOCAB);
    if (path.includes("/vocabulary") && search.includes("kind=shade"))
      return json(SHADE_VOCAB);
    if (path.includes("/vocabulary") && search.includes("kind=restoration_type"))
      return json(RESTORATION_TYPE_VOCAB);

    if (path.endsWith("/organizations")) return json([]);
    if (path.includes("/invoices")) return json([]);
    if (path.includes("/finance/vendors")) return json([]);
    if (path.includes("/cases/doctor-names")) return json([]);
    if (path.includes("/cases/doctor-directory")) return json([]);
    if (path.includes("/doctors/") || path.includes("/doctor")) return json([]);

    return json({});
  });
}

function renderDrawer() {
  const Wrapper = makeAuthWrapper("/cases", {
    user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
    status: "authed",
  });
  return render(
    <Wrapper>
      <AiPanelContext.Provider value={{ openPanel: () => {} }}>
        <CaseDrawer labCase={fakeCase} onClose={() => {}} />
      </AiPanelContext.Provider>
    </Wrapper>,
  );
}

/** Click the "Edit" button to enter edit mode. */
async function openEditMode() {
  const editBtn = (await screen.findAllByRole("button")).find(
    (b) => b.textContent?.trim() === "Edit",
  );
  expect(editBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(editBtn!);
    await new Promise((r) => setTimeout(r, 100));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CaseDrawer edit-mode — shade & material FieldCombobox full-list-on-open", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Material combobox shows all vocabulary options when opened after pre-fill from restorations", async () => {
    renderDrawer();

    // Wait for vocabulary and case detail to load.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await openEditMode();

    // Locate the Material field by its saved value in Clinical Details. Its
    // placeholder can vary between the legacy and catalog-backed picker.
    const materialInput = await screen.findByDisplayValue("Zirconia");
    expect(materialInput).toBeTruthy();

    // The field should be pre-filled with the restoration's material.
    await waitFor(() => {
      expect((materialInput as HTMLInputElement).value).toBe("Zirconia");
    });

    // Focus the combobox — the full-list-on-open fix resets filterText to ""
    // so all suggestions are shown regardless of the pre-filled value.
    fireEvent.focus(materialInput);

    // Options are rendered into a portal on document.body.
    await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const labels = options.map((el) => el.textContent?.trim() ?? "");
      // All vocabulary items must be visible, not just the pre-filled value.
      expect(labels).toContain("Zirconia");
      expect(labels).toContain("PFM");
      expect(labels).toContain("Emax");
      expect(labels).toContain("Full Cast Gold");
    });
  });

  it("Shade combobox shows all vocabulary options when opened after pre-fill from restorations", async () => {
    renderDrawer();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await openEditMode();

    // Locate the Shade field by its saved value in Clinical Details.
    const shadeInput = await screen.findByDisplayValue("A2");
    expect(shadeInput).toBeTruthy();

    await waitFor(() => {
      expect((shadeInput as HTMLInputElement).value).toBe("A2");
    });

    fireEvent.focus(shadeInput);

    await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const labels = options.map((el) => el.textContent?.trim() ?? "");
      // All shade vocabulary options must appear, not just the pre-filled "A2".
      expect(labels).toContain("A2");
      expect(labels).toContain("A3");
      expect(labels).toContain("B1");
    });
  });

  it("Selecting a different material from the dropdown updates the input value", async () => {
    renderDrawer();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await openEditMode();

    const materialInput = await screen.findByDisplayValue("Zirconia");
    await waitFor(() => {
      expect((materialInput as HTMLInputElement).value).toBe("Zirconia");
    });

    fireEvent.focus(materialInput);

    // Pick "Emax" from the dropdown.
    const emaxOption = await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const opt = options.find((el) => el.textContent?.trim() === "Emax");
      expect(opt).toBeTruthy();
      return opt!;
    });

    fireEvent.mouseDown(emaxOption);

    expect((materialInput as HTMLInputElement).value).toBe("Emax");
  });

  it("Selecting a different shade from the dropdown updates the input value", async () => {
    renderDrawer();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await openEditMode();

    const shadeInput = await screen.findByDisplayValue("A2");
    await waitFor(() => {
      expect((shadeInput as HTMLInputElement).value).toBe("A2");
    });

    fireEvent.focus(shadeInput);

    const b1Option = await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const opt = options.find((el) => el.textContent?.trim() === "B1");
      expect(opt).toBeTruthy();
      return opt!;
    });

    fireEvent.mouseDown(b1Option);

    expect((shadeInput as HTMLInputElement).value).toBe("B1");
  });
});
