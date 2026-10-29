/** @vitest-environment jsdom */
/**
 * Integration tests for FieldCombobox behavior in DashboardDropZone's rxConfirm panel.
 *
 * Invariants protected:
 *  - After AI fills Material = "Zirconia", opening the Material combobox shows ALL
 *    available material options (not just "Zirconia") — the core regression guard.
 *  - Selecting a different material from the list updates the displayed value.
 *  - The final /cases create call carries the user-selected value, not the AI value.
 *
 * These tests bring the component to "rxConfirm" state the same way the existing
 * DashboardDropZone.analyze tests do — by dropping a file and letting the AI
 * analyze path resolve — then interact with the combobox fields specifically.
 */

import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { DashboardDropZone } from "../DashboardDropZone";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(msg: string, status = 500) {
      super(msg);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/format", () => ({
  formatPhone: (p: string) => p,
}));

vi.mock("@/components/DoctorNamePicker", () => ({
  DoctorNamePicker: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Select doctor…"}
      data-testid="doctor-name-picker"
    />
  ),
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          getViewport: () => ({ width: 800, height: 600 }),
          render: () => ({ promise: Promise.resolve() }),
        }),
    }),
  }),
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({ default: "stub-worker" }));

// ─── FileReader mock ──────────────────────────────────────────────────────────

class MockFileReader {
  onload: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  result: string | null = null;

  readAsDataURL(_: Blob) {
    Promise.resolve().then(() => {
      this.result = "data:image/jpeg;base64,/9j/fakeJpegData==";
      this.onload?.({ target: this } as any);
    });
  }
}

let OrigFileReader: typeof FileReader;

beforeAll(() => {
  OrigFileReader = window.FileReader;
  Object.defineProperty(window, "FileReader", {
    value: MockFileReader,
    configurable: true,
    writable: true,
  });
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as any).__origGetContext = origGetContext;
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(),
    putImageData: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
  }) as any;
  HTMLCanvasElement.prototype.toDataURL = vi
    .fn()
    .mockReturnValue("data:image/jpeg;base64,fakecanvas==") as any;
});

afterAll(() => {
  Object.defineProperty(window, "FileReader", {
    value: OrigFileReader,
    configurable: true,
    writable: true,
  });
  HTMLCanvasElement.prototype.getContext = (
    HTMLCanvasElement.prototype as any
  ).__origGetContext;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MATERIAL_VOCAB = [
  { id: "m1", value: "Zirconia", isDefault: true },
  { id: "m2", value: "PFM", isDefault: false },
  { id: "m3", value: "Emax", isDefault: false },
  { id: "m4", value: "Full Cast Gold", isDefault: false },
];

const RESTORATION_TYPE_VOCAB = [
  { id: "r1", value: "Crown & Bridge", isDefault: true },
  { id: "r2", value: "Denture", isDefault: false },
  { id: "r3", value: "Implant", isDefault: false },
  { id: "r4", value: "Diagnostic Wax Up", isDefault: false },
];

const SHADE_VOCAB = [
  { id: "s1", value: "A2", isDefault: true },
  { id: "s2", value: "A3", isDefault: false },
];

const AI_RX_RESPONSE = {
  doctorName: "Dr. Jane Smith",
  patientName: "Bob Anderson",
  patientInitials: "B.A.",
  caseType: "Crown & Bridge",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
  toothAssignments: [{ toothNumber: "14", role: "prepared_crown", roleEvidence: "Prepared crown #14", material: "Zirconia", shade: "A2", requiresReview: false }],
  dueDate: "2026-08-01",
  isRush: false,
  notes: "",
  practiceName: "Smith Dental",
  practiceAddress: "",
  practicePhone: "",
};

const DROP_ZONE_USER = {
  id: "u1",
  username: "lab_staff",
  role: "admin",
} as unknown as SessionUser;

function makeJpegFile(name = "rx.jpg"): File {
  return new File(["fake-jpeg-bytes"], name, { type: "image/jpeg" });
}

/** Helper that stubs all background queries + the AI analyze response. */
function makeDefaultMock(opts: { createBody?: (body: any) => void } = {}) {
  return (path: string, reqOpts?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations"))
      return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary?kind=material"))
      return Promise.resolve(MATERIAL_VOCAB);
    if (path.startsWith("/vocabulary?kind=shade"))
      return Promise.resolve(SHADE_VOCAB);
    if (path.startsWith("/vocabulary?kind=restoration_type"))
      return Promise.resolve(RESTORATION_TYPE_VOCAB);
    if (path === "/analyze-prescription")
      return Promise.resolve(AI_RX_RESPONSE);
    if (path === "/cases") {
      opts.createBody?.(JSON.parse(reqOpts?.body ?? "{}"));
      return Promise.resolve({ id: "case1", caseNumber: "2026-001" });
    }
    if (path.startsWith("/rx-practice-aliases")) return Promise.resolve({});
    return Promise.reject(new Error(`Unexpected apiFetch: ${path}`));
  };
}

/**
 * A richer mock for submit-path tests. Returns a provider org "Smith Dental"
 * alongside the lab org so the AI-extracted practiceName auto-sets rxProviderOrgId,
 * and stubs the doctor-resolve, patient-similarity, and case-number endpoints
 * so createCaseFromRx can reach the POST /cases call.
 */
function makeSubmitMock(opts: {
  createBody?: (body: any) => void;
  previewBody?: (body: any) => void;
} = {}) {
  return (path: string, reqOpts?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations"))
      return Promise.resolve([
        { id: "lab1", type: "lab", name: "Test Lab" },
        { id: "prov1", type: "provider", name: "Smith Dental" },
      ]);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary?kind=material"))
      return Promise.resolve(MATERIAL_VOCAB);
    if (path.startsWith("/vocabulary?kind=shade"))
      return Promise.resolve(SHADE_VOCAB);
    if (path.startsWith("/vocabulary?kind=restoration_type"))
      return Promise.resolve(RESTORATION_TYPE_VOCAB);
    if (path === "/analyze-prescription")
      return Promise.resolve(AI_RX_RESPONSE);
    if (path.startsWith("/rx-practice-aliases")) return Promise.resolve({});
    if (path === "/invoices/preview-draft") {
      opts.previewBody?.(JSON.parse(reqOpts?.body ?? "{}"));
      return Promise.resolve({ lineItems: [], subtotal: "0.00", total: "0.00" });
    }
    if (path.startsWith("/doctors/resolve-name"))
      return Promise.resolve({
        exactMatch: "Dr. Jane Smith",
        similarMatches: [],
        canAddNew: true,
      });
    if (path.startsWith("/cases/patient-similarity"))
      return Promise.resolve([]);
    if (path.startsWith("/cases/next-case-number"))
      return Promise.resolve({ caseNumber: "2026-001" });
    if (path === "/cases") {
      opts.createBody?.(JSON.parse(reqOpts?.body ?? "{}"));
      return Promise.resolve({ id: "case1", caseNumber: "2026-001" });
    }
    // File attachment after create — allow gracefully.
    if (path.startsWith("/cases/case1/attachments"))
      return Promise.resolve({ id: "att1" });
    return Promise.reject(new Error(`Unexpected apiFetch: ${path}`));
  };
}

function renderDropZone() {
  const Wrapper = makeAuthWrapper("/", { user: DROP_ZONE_USER, status: "authed" });
  return render(
    <Wrapper>
      <DashboardDropZone />
    </Wrapper>,
  );
}

function triggerFileInput(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) return;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input, { target: { files } });
}

/** Bring the component to rxConfirm state by dropping a JPEG and waiting. */
async function reachRxConfirmState(container: HTMLElement) {
  await act(async () => {
    triggerFileInput(container, [makeJpegFile()]);
    await new Promise((r) => setTimeout(r, 300));
  });
  await waitFor(
    () => {
      expect(container.textContent).toMatch(/AI read this prescription/i);
    },
    { timeout: 4000 },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DashboardDropZone — AI-prefilled combobox behavior in rxConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation(makeDefaultMock());
  });

  it("shows prominent labels associated with the clinical comboboxes", async () => {
    const { container } = renderDropZone();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await reachRxConfirmState(container);

    for (const { labelText, inputId } of [
      { labelText: "Case Type", inputId: "rx-clinical-case-type" },
      { labelText: "Case Material", inputId: "rx-clinical-material" },
      { labelText: "Shade", inputId: "rx-clinical-shade" },
    ]) {
      const label = Array.from(container.querySelectorAll("label")).find(
        (candidate) => candidate.htmlFor === inputId,
      );
      const input = container.querySelector<HTMLInputElement>(`#${inputId}`);

      expect(label?.textContent?.trim()).toBe(labelText);
      expect(label?.contains(input ?? null)).toBe(true);
      expect(label?.querySelector("span")?.className).toContain("text-sm");
      expect(label?.querySelector("span")?.className).toContain("font-semibold");
    }
  });

  it("Material combobox shows all vocabulary options when opened after AI fill", async () => {
    const { container } = renderDropZone();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await reachRxConfirmState(container);

    // Find the material input (value should be AI-provided "Zirconia").
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder="Material"]'),
    );
    expect(inputs.length).toBeGreaterThan(0);
    const materialInput = inputs[0];
    expect(materialInput.value).toBe("Zirconia");

    // Focus the material combobox — should show full list, not just "Zirconia".
    fireEvent.focus(materialInput);

    // Options are portaled into document.body.
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const labels = options.map((el) => el.textContent?.trim() ?? "");

    // All vocab items must appear.
    expect(labels.some((l) => l === "Zirconia")).toBe(true);
    expect(labels.some((l) => l === "PFM")).toBe(true);
    expect(labels.some((l) => l === "Emax")).toBe(true);
    expect(labels.some((l) => l === "Full Cast Gold")).toBe(true);
  });

  it("Selecting a different material updates the input value", async () => {
    const { container } = renderDropZone();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await reachRxConfirmState(container);

    const materialInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Material"]',
    )!;
    expect(materialInput.value).toBe("Zirconia");

    fireEvent.focus(materialInput);

    const pfmOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.trim() === "PFM",
    );
    expect(pfmOption).toBeDefined();
    fireEvent.mouseDown(pfmOption!);

    expect(materialInput.value).toBe("PFM");
  });

  it("Restoration type combobox shows all options when opened after AI fill", async () => {
    const { container } = renderDropZone();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await reachRxConfirmState(container);

    const rtInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Restoration type"]',
    )!;
    expect(rtInput.value).toBe("Crown & Bridge");

    fireEvent.focus(rtInput);

    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const labels = options.map((el) => el.textContent?.trim() ?? "");
    expect(labels.some((l) => l === "Crown & Bridge")).toBe(true);
    expect(labels.some((l) => l === "Denture")).toBe(true);
    expect(labels.some((l) => l === "Implant")).toBe(true);
  });

  it("POST /cases payload uses user-edited material value, not the original AI value", async () => {
    let capturedCreateBody: any = null;

    mockApiFetch.mockImplementation(
      makeSubmitMock({ createBody: (b) => { capturedCreateBody = b; } }),
    );

    const { container } = renderDropZone();

    // Wait for background queries to hydrate.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await reachRxConfirmState(container);

    // AI filled Material = "Zirconia". Change it to "PFM".
    const materialInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Material"]',
    )!;
    expect(materialInput.value).toBe("Zirconia");

    fireEvent.focus(materialInput);
    const pfmOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.trim() === "PFM",
    );
    expect(pfmOption).toBeDefined();
    fireEvent.mouseDown(pfmOption!);
    expect(materialInput.value).toBe("PFM");

    // Click "Create case".
    const createBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      /create case/i.test(b.textContent ?? ""),
    );
    expect(createBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(createBtn!);
      // Give the async createCaseFromRx → proceedCreateCase chain time to complete.
      await new Promise((r) => setTimeout(r, 600));
    });

    // The /cases POST body must contain the user-selected "PFM", not "Zirconia".
    await waitFor(
      () => {
        expect(capturedCreateBody).not.toBeNull();
      },
      { timeout: 3000 },
    );

    // Material is carried via the restorations array.
    const restorations: any[] = capturedCreateBody?.restorations ?? [];
    expect(restorations.length).toBeGreaterThan(0);
    expect(restorations.every((r: any) => r.material === "PFM")).toBe(true);
  });

  it("selecting Diagnostic Wax Up replaces material and shade, then allows manual edits", async () => {
    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await reachRxConfirmState(container);

    const restorationTypeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Restoration type"]',
    )!;
    fireEvent.focus(restorationTypeInput);
    const diagnosticOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.trim() === "Diagnostic Wax Up",
    );
    expect(diagnosticOption).toBeDefined();
    fireEvent.mouseDown(diagnosticOption!);

    await waitFor(() => {
      expect(restorationTypeInput.value).toBe("Diagnostic Wax Up");
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Material"]')?.value)
        .toBe("Diagnostic Wax Up");
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Shade"]')?.value)
        .toBe("Diagnostic Wax Up");
      expect(container.querySelector<HTMLSelectElement>(
        'select[aria-label="Restoration subtype"]',
      )?.value).toBe("restorative/diagnostic_wax_up");
    });

    const materialInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Material"]',
    )!;
    const shadeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Shade"]',
    )!;
    fireEvent.change(materialInput, { target: { value: "PFM" } });
    fireEvent.change(shadeInput, { target: { value: "A3" } });
    expect(materialInput.value).toBe("PFM");
    expect(shadeInput.value).toBe("A3");
  });

  it("makes Diagnostic Wax Up directly selectable as the restoration subtype", async () => {
    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await reachRxConfirmState(container);

    const subtypeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Restoration subtype"]',
    )!;
    expect(Array.from(subtypeSelect.options).some((option) =>
      option.value === "restorative/diagnostic_wax_up" &&
      option.textContent === "Diagnostic Wax Up",
    )).toBe(true);
    fireEvent.change(subtypeSelect, {
      target: { value: "restorative/diagnostic_wax_up" },
    });

    await waitFor(() => {
      expect(subtypeSelect.value).toBe("restorative/diagnostic_wax_up");
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Material"]')?.value)
        .toBe("Diagnostic Wax Up");
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Shade"]')?.value)
        .toBe("Diagnostic Wax Up");
    });
  });

  it("carries Diagnostic Wax Up through invoice preview and saved case restorations", async () => {
    let capturedPreviewBody: any = null;
    let capturedCreateBody: any = null;
    mockApiFetch.mockImplementation(makeSubmitMock({
      previewBody: (body) => { capturedPreviewBody = body; },
      createBody: (body) => { capturedCreateBody = body; },
    }));

    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await reachRxConfirmState(container);

    const restorationTypeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Restoration type"]',
    )!;
    fireEvent.focus(restorationTypeInput);
    const diagnosticOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.trim() === "Diagnostic Wax Up",
    );
    expect(diagnosticOption).toBeDefined();
    fireEvent.mouseDown(diagnosticOption!);

    await waitFor(() => {
      expect(capturedPreviewBody?.restorations).toEqual([
        expect.objectContaining({
          restorationType: "Crown",
          restorationSubtype: "restorative/diagnostic_wax_up",
          material: "Diagnostic Wax Up",
          shade: "Diagnostic Wax Up",
        }),
      ]);
    }, { timeout: 5000 });

    const createBtn = Array.from(container.querySelectorAll("button")).find((button) =>
      /create case/i.test(button.textContent ?? ""),
    );
    expect(createBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(createBtn!);
      await new Promise((r) => setTimeout(r, 700));
    });
    await waitFor(() => {
      expect(capturedCreateBody?.restorations).toEqual([
        expect.objectContaining({
          restorationType: "Crown",
          restorationSubtype: "restorative/diagnostic_wax_up",
          material: "Diagnostic Wax Up",
          shade: "Diagnostic Wax Up",
        }),
      ]);
    }, { timeout: 5000 });
  });
});
