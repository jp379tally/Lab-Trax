/**
 * @vitest-environment jsdom
 *
 * Guards the CaseHierarchySelect inline dropdown component (cases.tsx):
 *
 * 1. Happy path: an admin sees the Case Type dropdown, selects a new case type,
 *    apiFetch is called with the correct URL + restorationType / restorationSubtype /
 *    material body, and the query cache is invalidated for both ["case", caseId]
 *    and ["cases"].
 *
 * 2. Error path: when the PATCH fails, toast.error is called with the error
 *    message and the inline error span is rendered.
 */

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockInvalidateQueries = vi.hoisted(() => vi.fn());
const mockUseEffectiveCatalog = vi.hoisted(() => vi.fn());

// ── Module-level mocks (must be declared before any `import` of the module) ─

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  ApiError: class extends Error {},
  getAccessToken: vi.fn(),
  getApiOrigin: vi.fn().mockReturnValue("http://localhost"),
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: mockToastError, success: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, isSuccess: false }),
  useMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: mockInvalidateQueries }),
}));

// Stub heavy deps that cases.tsx imports at module level but CaseTypeSelect doesn't use.
vi.mock("@/lib/ai-panel-context", () => ({
  useAiPanel: vi.fn().mockReturnValue({ open: false, setOpen: vi.fn() }),
}));

vi.mock("@/hooks/useTableColumns", () => ({
  useTableColumns: vi.fn().mockReturnValue({ columns: [], toggleColumn: vi.fn() }),
}));

vi.mock("@/components/ColumnSettingsPopover", () => ({
  ColumnSettingsPopover: () => null,
}));

vi.mock("wouter", () => ({
  useLocation: vi.fn().mockReturnValue(["/", vi.fn()]),
  useSearch: vi.fn().mockReturnValue(""),
  Link: ({ children }: { children: React.ReactNode }) => React.createElement("a", null, children),
}));

vi.mock("@/lib/upload-media-file", () => ({
  uploadMediaFile: vi.fn(),
}));

vi.mock("@/lib/note-dictation", () => ({
  composeNoteDictation: vi.fn(),
}));

vi.mock("@/lib/shift-click-range", () => ({
  computeShiftClickRange: vi.fn(),
  shiftKeyFromChangeEvent: vi.fn(),
  suppressShiftClickTextSelection: vi.fn(),
}));

vi.mock("@/components/DoctorNamePicker", () => ({
  DoctorNamePicker: () => null,
}));

vi.mock("@/components/FieldCombobox", () => ({
  FieldCombobox: () => null,
}));

vi.mock("./doctors", () => ({
  MergeDialog: () => null,
}));

vi.mock("@workspace/api-client-react", () => ({
  undoDoctorMerge: vi.fn(),
}));

vi.mock("@/lib/nav-guard", () => ({
  setNavBlocker: vi.fn(),
}));

vi.mock("@/lib/restoration-category", () => ({
  isRemovableRestorationType: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/case-date-filter", () => ({
  computeCaseDateRange: vi.fn(),
  caseWithinDateRange: vi.fn().mockReturnValue(true),
}));

vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: () => null,
  AuthedVideo: () => null,
  MediaLightbox: () => null,
  isSameApiOrigin: vi.fn().mockReturnValue(true),
}));

// CatalogRestorationPicker: mock useEffectiveCatalog so sub-type and material
// tests can inject a catalog without a real network call.  encodeCatalogSelection
// is implemented inline for built-in (non-custom) key combinations.
vi.mock("@/components/CatalogRestorationPicker", () => {
  mockUseEffectiveCatalog.mockReturnValue({ data: undefined });
  return {
    useEffectiveCatalog: mockUseEffectiveCatalog,
    encodeCatalogSelection: (ct?: string, st?: string, mat?: string) => {
      if (!ct || !st) return null;
      return mat ? `${ct}/${st}/${mat}` : `${ct}/${st}`;
    },
  };
});

vi.mock("@/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue(""),
  formatDateTime: vi.fn().mockReturnValue(""),
  formatDueDate: vi.fn().mockReturnValue(""),
  formatShortDueDate: vi.fn().mockReturnValue(""),
  formatMoney: vi.fn().mockReturnValue("$0.00"),
  formatPhone: vi.fn().mockReturnValue(""),
  formatShortDate: vi.fn().mockReturnValue(""),
  relativeTime: vi.fn().mockReturnValue(""),
  statusLabel: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/print", () => ({
  printCaseCard: vi.fn(),
  printCaseCardAdvanced: vi.fn(),
  printCaseHistory: vi.fn(),
  printCaseLabel: vi.fn(),
  printCaseOverview: vi.fn(),
  printInvoice: vi.fn(),
  printTabContent: vi.fn(),
}));

vi.mock("@/lib/export", () => ({
  printInvoicePdf: vi.fn(),
}));

vi.mock("@/components/ToothChart", () => ({
  ToothChart: () => null,
  parseToothField: vi.fn().mockReturnValue([]),
  parseBridgeConnectors: vi.fn().mockReturnValue([]),
  formatBridgeConnectors: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/rx-summary", () => ({
  buildHighlightedToothValue: vi.fn().mockReturnValue(""),
  deriveRxSummary: vi.fn().mockReturnValue(null),
  formatRxTeethLabel: vi.fn().mockReturnValue(""),
  formatRxTeethWithShades: vi.fn().mockReturnValue(""),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, status),
}));

vi.mock("./invoices", () => ({
  InvoiceEditor: () => null,
}));

vi.mock("@/components/ToothActionDialog", () => ({
  ToothActionDialog: () => null,
}));

vi.mock("@/components/ScanViewerModal", () => ({
  default: () => null,
}));

vi.mock("@/components/ScanThumbnail", () => ({
  default: () => null,
}));

vi.mock("@/components/PrintLayoutEditor", () => ({
  PrintLayoutEditor: () => null,
}));

vi.mock("@/components/CasePrintLayoutEditor", () => ({
  CasePrintLayoutEditor: () => null,
}));

vi.mock("@/components/PrescriptionPreview", () => ({
  PrescriptionPreview: () => null,
}));

vi.mock("@/lib/print-layout", () => ({
  isDefaultLayout: vi.fn().mockReturnValue(true),
  loadPrintLayoutConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/case-print-template", () => ({
  coerceCasePrintTemplate: vi.fn().mockReturnValue({}),
}));

vi.mock("@/components/TrialBanner", () => ({
  TrialBanner: () => null,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: vi.fn().mockReturnValue({ user: null, status: "anonymous" }),
  AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}));

vi.mock("react-qr-code", () => ({
  default: () => null,
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn() },
}));

// ── Actual imports (after vi.mock calls are hoisted) ───────────────────────

import { CaseHierarchySelect } from "@/pages/cases";

// ── Tests ──────────────────────────────────────────────────────────────────

const CASE_ID = "case-abc";
const RESTORATION_ID = "rest-xyz";

/** Minimal CaseHierarchy for each case type (no custom sub/material). */
const hierarchyFor = (caseType: "restorative" | "removable" | "ortho" | null) => ({
  caseType,
  subtype: null as null,
  materialSubtype: null as null,
});

describe("CaseHierarchySelect — happy path", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockInvalidateQueries.mockReset();
    mockToastError.mockReset();
    // Resolve successfully (apiFetch returns the updated hierarchy summary)
    mockApiFetch.mockResolvedValue({ id: RESTORATION_ID, restorationType: "Full Denture" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the first <select> with all three case-type options", () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    // The first combobox is the Case Type selector
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const caseTypeSelect = selects[0];
    expect(caseTypeSelect).toBeDefined();

    const options = Array.from(caseTypeSelect.options).map((o) => o.value);
    expect(options).toContain("restorative");
    expect(options).toContain("removable");
    expect(options).toContain("ortho");
  });

  it("renders a placeholder '—' option when hierarchy.caseType is null", () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor(null)}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const caseTypeSelect = selects[0];
    const placeholderOption = Array.from(caseTypeSelect.options).find((o) => o.value === "");
    expect(placeholderOption).toBeDefined();
    expect(placeholderOption!.text).toBe("—");
  });

  it("PATCHes the correct URL with restorationType=Crown (+ null subtype/material) when switching to restorative", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("removable")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "restorative" } });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/cases/${CASE_ID}/restorations/hierarchy`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ restorationType: "Crown", restorationSubtype: null, material: null }),
        }),
      );
    });
  });

  it("sends one case-level PATCH regardless of the number of restorations", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("removable")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "restorative" },
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/cases/${CASE_ID}/restorations/hierarchy`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          restorationType: "Crown",
          restorationSubtype: null,
          material: null,
        }),
      }),
    );
  });

  it.each([
    ["removable", "upper", "Full Denture", "upper"],
    ["removable", "lower", "Full Denture", "lower"],
    ["removable", "both", "Full Denture", "upper_lower"],
    ["ortho", "upper", "Night Guard", "upper"],
    ["ortho", "lower", "Night Guard", "lower"],
    ["ortho", "both", "Night Guard", "upper_lower"],
  ] as const)(
    "stages restorative-to-%s until %s arch is selected, then saves type and arch together",
    async (caseType, arch, restorationType, apiArch) => {
      render(
        <CaseHierarchySelect
          hierarchy={hierarchyFor("restorative")}
          caseId={CASE_ID}
          firstRestorationId={RESTORATION_ID}
          labOrganizationId={null}
        />,
      );

      const caseTypeSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      fireEvent.change(caseTypeSelect, { target: { value: caseType } });

      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(caseTypeSelect.value).toBe("restorative");
      expect(screen.getByRole("combobox", { name: "Arch" })).toBeDefined();

      fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
        target: { value: arch },
      });

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledTimes(1);
        expect(mockApiFetch).toHaveBeenCalledWith(
          `/cases/${CASE_ID}/restorations/hierarchy`,
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
              restorationType,
              restorationSubtype: null,
              material: null,
              arch: apiArch,
            }),
          }),
        );
      });
    },
  );

  it("keeps saved-arch edits as arch-only PATCHes", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("removable")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
        archValues={["upper"]}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "lower" },
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/cases/${CASE_ID}/restorations/${RESTORATION_ID}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ arch: "lower" }),
        }),
      );
    });
  });

  it("invalidates all affected case and finance caches after a successful PATCH", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledTimes(5);
      const calls = mockInvalidateQueries.mock.calls.map((c) => c[0]);
      expect(calls).toContainEqual({ queryKey: ["case", CASE_ID] });
      expect(calls).toContainEqual({ queryKey: ["cases"] });
      expect(calls).toContainEqual({ queryKey: ["invoices"] });
      expect(calls).toContainEqual({ queryKey: ["invoice-for-case", CASE_ID] });
      expect(calls).toContainEqual({ queryKey: ["invoice-detail", CASE_ID] });
    });
  });

  it("does not call toast.error on success", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    // Give any async side effects a chance to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("does not show an inline error span on success", async () => {
    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(/could not update/i)).toBeNull();
  });
});

// ── Minimal catalog fixture for sub type / material tests ─────────────────────
//
// The catalog mirrors the shape returned by useEffectiveCatalog (EffectiveCatalogTree).
// Only the keys/labels used by the tests are populated; the other case types
// carry empty subtypes so the existing case-type-change tests still pass.
const MOCK_CATALOG = {
  caseTypes: [
    {
      key: "restorative",
      label: "Restorative",
      id: null,
      subtypes: [
        {
          key: "crown_and_bridge",
          label: "Crown & Bridge",
          id: null,
          materials: [
            { key: "zirconia", label: "Zirconia", id: null },
            { key: "emax", label: "E.max / Lithium Disilicate", id: null },
          ],
        },
        {
          key: "crown",
          label: "Crown",
          id: null,
          materials: [{ key: "zirconia", label: "Zirconia", id: null }],
        },
      ],
    },
    { key: "removable", label: "Removable", id: null, subtypes: [] },
    { key: "ortho", label: "Ortho / Appliances", id: null, subtypes: [] },
  ],
};

describe("CaseHierarchySelect — sub type and material cascade", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockInvalidateQueries.mockReset();
    mockToastError.mockReset();
    mockApiFetch.mockResolvedValue({});
    // Provide a real catalog so sub type / material selects are rendered.
    mockUseEffectiveCatalog.mockReturnValue({ data: MOCK_CATALOG });
  });

  afterEach(() => {
    cleanup();
    // Restore the "no catalog" default for other describe blocks.
    mockUseEffectiveCatalog.mockReturnValue({ data: undefined });
  });

  it("saves the empty-case cascade without any restoration-specific URL", async () => {
    const props = { caseId: CASE_ID, labOrganizationId: "lab-1" };
    const { rerender } = render(<CaseHierarchySelect {...props}
      hierarchy={{ caseType: null, subtype: null, materialSubtype: null }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Case Type" }), { target: { value: "restorative" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Case Type" })).not.toBeDisabled());
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({
      restorationType: "Crown", restorationSubtype: null, material: null, toothNumbers: [],
    });
    // Refetched server data now includes the row created by the hierarchy write.
    rerender(<CaseHierarchySelect {...props} firstRestorationId={RESTORATION_ID}
      hierarchy={{ caseType: "restorative", subtype: null, materialSubtype: null }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Case Subtype" }), { target: { value: "crown_and_bridge" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Case Subtype" })).not.toBeDisabled());
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({
      restorationType: "Crown & Bridge", restorationSubtype: "restorative/crown_and_bridge", material: null,
    });
    rerender(<CaseHierarchySelect {...props} firstRestorationId={RESTORATION_ID}
      hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: null }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Case Material" }), { target: { value: "zirconia" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Case Material" })).not.toBeDisabled());
    expect(JSON.parse(mockApiFetch.mock.calls[2][1].body)).toEqual({
      restorationType: "Crown & Bridge", restorationSubtype: "restorative/crown_and_bridge/zirconia", material: "Zirconia",
    });
    expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(`/cases/${CASE_ID}/restorations/hierarchy`));
  });

  it("restores all confirmed controls after a rejected subtype change and allows retry", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("Invoice is locked"));
    render(<CaseHierarchySelect hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: "zirconia" }}
      caseId={CASE_ID} firstRestorationId={RESTORATION_ID} labOrganizationId="lab-1" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Case Subtype" }), { target: { value: "crown" } });
    await screen.findByText("Invoice is locked");
    expect((screen.getByRole("combobox", { name: "Case Type" }) as HTMLSelectElement).value).toBe("restorative");
    expect((screen.getByRole("combobox", { name: "Case Subtype" }) as HTMLSelectElement).value).toBe("crown_and_bridge");
    expect((screen.getByRole("combobox", { name: "Case Material" }) as HTMLSelectElement).value).toBe("zirconia");
    expect(screen.getByRole("combobox", { name: "Case Subtype" })).not.toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Case Subtype" }), { target: { value: "crown" } });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });

  it("does not render a Sub Type <select> when hierarchy.caseType is null (nothing selected)", () => {
    render(
      <CaseHierarchySelect
        hierarchy={{ caseType: null, subtype: null, materialSubtype: null }}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId="lab-1"
      />,
    );

    // selectedCtKey is "" (falsy) → the sub-type select is conditionally hidden.
    // Only the case-type combobox should be present.
    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(1);
  });

  it("PATCHes the case hierarchy with an encoded subtype and clears material when a subtype is selected", async () => {
    // Case type already chosen, but no subtype yet.
    render(
      <CaseHierarchySelect
        hierarchy={{ caseType: "restorative", subtype: null, materialSubtype: null }}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId="lab-1"
      />,
    );

    // With a catalog loaded, two selects exist: [case type, sub type].
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(2);

    fireEvent.change(selects[1], { target: { value: "crown_and_bridge" } });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/cases/${CASE_ID}/restorations/hierarchy`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            restorationType: "Crown & Bridge",
            restorationSubtype: "restorative/crown_and_bridge",
            material: null,
          }),
        }),
      );
    });
  });

  it("PATCHes the case hierarchy with the encoded material subtype when selected", async () => {
    // Both case type and sub type already chosen; user is picking a material.
    render(
      <CaseHierarchySelect
        hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: null }}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId="lab-1"
      />,
    );

    // Three selects: [case type, sub type, material].
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(3);

    fireEvent.change(selects[2], { target: { value: "zirconia" } });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/cases/${CASE_ID}/restorations/hierarchy`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            restorationType: "Crown & Bridge",
            restorationSubtype: "restorative/crown_and_bridge/zirconia",
            material: "Zirconia",
          }),
        }),
      );
    });
  });
});

describe("CaseHierarchySelect — error path", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockInvalidateQueries.mockReset();
    mockToastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("calls toast.error with the error message when PATCH rejects", async () => {
    const errMsg = "Restoration not found";
    mockApiFetch.mockRejectedValue(new Error(errMsg));

    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(errMsg);
    });
  });

  it("renders an inline error span with the error message when PATCH rejects", async () => {
    const errMsg = "Endpoint misconfigured";
    mockApiFetch.mockRejectedValue(new Error(errMsg));

    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => {
      expect(screen.getByText(errMsg)).toBeDefined();
      expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("restorative");
    });
  });

  it("restores the confirmed hierarchy after a failed conversion and allows another selection", async () => {
    const errMsg = "Arch is required for Removable and Ortho restorations.";
    mockApiFetch
      .mockRejectedValueOnce(new Error(errMsg))
      .mockResolvedValueOnce({ id: RESTORATION_ID, restorationType: "Full Denture" });

    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => {
      expect(screen.getByText(errMsg)).toBeDefined();
      expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("restorative");
      expect(screen.queryByRole("combobox", { name: "Arch" })).toBeNull();
      expect(screen.getAllByRole("combobox")[0]).not.toBeDisabled();
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "lower" },
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
      expect(mockApiFetch).toHaveBeenLastCalledWith(
        `/cases/${CASE_ID}/restorations/hierarchy`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            restorationType: "Full Denture",
            restorationSubtype: null,
            material: null,
            arch: "lower",
          }),
        }),
      );
      expect(screen.queryByText(errMsg)).toBeNull();
    });
  });

  it("falls back to 'Could not update case.' for non-Error rejections", async () => {
    mockApiFetch.mockRejectedValue("string error");

    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Could not update case.");
    });
    expect(screen.getByText("Could not update case.")).toBeDefined();
  });

  it("refreshes case and invoice caches when the hierarchy PATCH rejects", async () => {
    mockApiFetch.mockRejectedValue(new Error("500 Internal Server Error"));

    render(
      <CaseHierarchySelect
        hierarchy={hierarchyFor("restorative")}
        caseId={CASE_ID}
        firstRestorationId={RESTORATION_ID}
        labOrganizationId={null}
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "removable" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Arch" }), {
      target: { value: "upper" },
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());

    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledTimes(5));
    const calls = mockInvalidateQueries.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({ queryKey: ["case", CASE_ID] });
    expect(calls).toContainEqual({ queryKey: ["cases"] });
    expect(calls).toContainEqual({ queryKey: ["invoices"] });
    expect(calls).toContainEqual({ queryKey: ["invoice-for-case", CASE_ID] });
    expect(calls).toContainEqual({ queryKey: ["invoice-detail", CASE_ID] });
  });
});
