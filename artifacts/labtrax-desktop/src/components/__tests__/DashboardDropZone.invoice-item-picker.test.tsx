/** @vitest-environment jsdom */
/**
 * The editable invoice preview inside the AI intake (drop-zone) review panel
 * must offer a billable-item typeahead instead of a bare description box.
 *
 * Invariants protected:
 *  - Typing part of a catalog material name surfaces the matching suggestion,
 *    sourced from GET /pricing/pre-create-items for the currently selected
 *    lab + practice + doctor.
 *  - Picking a suggestion fills the description AND the doctor's effective
 *    unit price, and the invoice total updates immediately.
 *  - A free-typed description that matches nothing still saves — it reaches
 *    POST /cases as an invoiceOverrideLine with no catalog identity, while a
 *    picked line carries its catalogItemKey through to the created invoice.
 */

import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

vi.mock("@/components/PracticePicker", () => ({
  PracticePicker: ({ value }: { value: string }) => (
    <div data-testid="practice-picker" data-value={value} />
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

// ─── FileReader + canvas stubs (analyze path) ─────────────────────────────────

class MockFileReader {
  onload: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  result: string | null = null;
  readAsDataURL(_: Blob) {
    const url = "data:image/jpeg;base64,/9j/fakeJpegData==";
    Promise.resolve().then(() => {
      this.result = url;
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

const RX_RESPONSE = {
  doctorName: "Dr. Jane Smith",
  patientName: "Bob Anderson",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
  toothAssignments: [{ toothNumber: "14", role: "prepared_crown", roleEvidence: "Prepared crown #14", material: "Zirconia", shade: "A2", requiresReview: false }],
  dueDate: "2026-08-01",
  isRush: false,
  notes: "",
  practiceName: "Maple Dental",
  practiceAddress: "",
  practicePhone: "",
};

const ORGS = [
  { id: "lab1", type: "lab", name: "Test Lab" },
  { id: "provB", type: "provider", name: "Maple Dental" },
];

// One auto-generated line at $150 so the running total is easy to assert.
const PREVIEW_DRAFT = {
  lineItems: [
    {
      description: "Zirconia Crown",
      toothLabel: "#14",
      quantity: 1,
      unitPrice: "150.00",
      lineTotal: "150.00",
      priceSource: "tier",
      priceKey: "zirconia_crown",
      priced: true,
      restorationIndices: [0],
    },
  ],
  subtotal: "150.00",
  total: "150.00",
};

// The catalog row is what makes an E.max/lithium-disilicate crown pickable at
// intake even though the lab has no billable-item record for it. $210 is this
// doctor's effective tier price.
const PRE_CREATE_ITEMS = {
  items: [
    { id: "v1", priceKey: null, name: "Custom Polish", unitPrice: 25, source: null },
  ],
  catalogItems: [
    {
      key: "emax_crown",
      label: "E.max Crown",
      unitPrice: 210,
      source: "tier",
      sourceId: "tier1",
      sourceName: "Gold",
    },
    {
      key: "zirconia_crown",
      label: "Zirconia Crown",
      unitPrice: 150,
      source: "tier",
      sourceId: "tier1",
      sourceName: "Gold",
    },
  ],
};

const DROP_ZONE_USER = {
  id: "u1",
  username: "lab_staff",
  role: "admin",
} as unknown as SessionUser;

function makeJpegFile(name = "rx.jpg"): File {
  return new File(["fake-jpeg-bytes"], name, { type: "image/jpeg" });
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
  if (!input) throw new Error("file input not found");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input, { target: { files } });
}

function findButtonByText(root: ParentNode, re: RegExp): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => re.test(b.textContent ?? ""),
  );
  if (!btn) throw new Error(`button matching ${re} not found`);
  return btn;
}

/** All description typeaheads in the editable preview, in row order. */
function descriptionInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[placeholder="Description"]'),
  );
}

/** The unit-price input belonging to the same preview row as `descInput`. */
function unitPriceInputFor(descInput: HTMLInputElement): HTMLInputElement {
  // Walk up from the typeahead (which nests its own wrapper divs) to the first
  // ancestor that also holds the row's price input.
  let node: HTMLElement | null = descInput.parentElement;
  while (node) {
    const price = node.querySelector<HTMLInputElement>('input[placeholder="0.00"]');
    if (price) return price;
    node = node.parentElement;
  }
  throw new Error("unit price input not found for row");
}

/** The editable preview's running total (last "$x.xx" in the Total row). */
function totalText(container: HTMLElement): string {
  const totalLabel = Array.from(container.querySelectorAll("span")).find(
    (s) => s.textContent?.trim() === "Total",
  );
  const amount = totalLabel?.parentElement?.querySelector("span:last-child");
  return amount?.textContent?.trim() ?? "";
}

let postedCases: any[] = [];

function installHandlers() {
  postedCases = [];
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary")) return Promise.resolve([]);
    if (path.startsWith("/rx-practice-aliases"))
      return Promise.resolve({ found: false, providerOrganizationId: null });
    if (path === "/analyze-prescription") return Promise.resolve(RX_RESPONSE);
    if (path === "/invoices/preview-draft") return Promise.resolve(PREVIEW_DRAFT);
    if (path.startsWith("/pricing/pre-create-items"))
      return Promise.resolve(PRE_CREATE_ITEMS);
    if (path.startsWith("/cases/patient-similarity"))
      return Promise.resolve({ matches: [] });
    if (path.startsWith("/cases/next-case-number"))
      return Promise.resolve({ caseNumber: "25-1000" });
    if (path.startsWith("/doctors/resolve-name"))
      return Promise.resolve({
        exactMatch: "Dr. Jane Smith",
        similarMatches: [],
        canAddNew: true,
      });
    if (path === "/media/upload") return Promise.resolve({ url: "media://uploaded" });
    if (path === "/cases" && init?.method === "POST") {
      try {
        postedCases.push(JSON.parse(init?.body ?? "{}"));
      } catch {
        postedCases.push(null);
      }
      return Promise.resolve({ id: "case-new-1", caseNumber: "25-1000" });
    }
    if (/^\/cases\/[^/]+\/attachments$/.test(path)) return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  });
}

/** Drops a file and waits for the editable invoice preview to be populated. */
async function reachPreview(): Promise<HTMLElement> {
  const { container } = renderDropZone();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await act(async () => {
    triggerFileInput(container, [makeJpegFile()]);
    await new Promise((r) => setTimeout(r, 300));
  });
  await waitFor(
    () => expect(container.querySelector('[data-testid="practice-picker"]')).not.toBeNull(),
    { timeout: 5000 },
  );
  // The preview request is debounced by 400ms.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });
  await waitFor(() => expect(descriptionInputs(container).length).toBe(1), {
    timeout: 5000,
  });
  return container;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — intake invoice item picker", () => {
  beforeEach(() => {
    installHandlers();
  });

  it("suggests a matching catalog item while typing and fills the doctor's price on pick", async () => {
    const container = await reachPreview();
    const selectedDescription = descriptionInputs(container)[0];
    expect(selectedDescription.value).toBe("#14 Zirconia Crown");
    expect(selectedDescription.className).toContain("h-9");
    expect(selectedDescription.className).toContain("text-sm");
    expect(selectedDescription.title).toBe("#14 Zirconia Crown");

    // Options are requested for the selected lab + practice + doctor.
    await waitFor(() =>
      expect(
        mockApiFetch.mock.calls.some(
          (c: any[]) =>
            typeof c[0] === "string" && c[0].startsWith("/pricing/pre-create-items"),
        ),
      ).toBe(true),
    );
    const optionsCall = mockApiFetch.mock.calls
      .map((c: any[]) => c[0])
      .find(
        (p: any) => typeof p === "string" && p.startsWith("/pricing/pre-create-items"),
      ) as string;
    expect(optionsCall).toContain("labOrganizationId=lab1");
    expect(optionsCall).toContain("providerOrganizationId=provB");
    expect(optionsCall).toContain("doctorName=");

    // Add a blank line and type part of the material name.
    await act(async () => {
      fireEvent.click(findButtonByText(container, /\+ Add line/i));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(2));
    const newRowDesc = descriptionInputs(container)[1];
    await act(async () => {
      fireEvent.change(newRowDesc, { target: { value: "max" } });
    });

    // The dropdown is portal-rendered to <body> so the preview table can't clip it.
    const option = await waitFor(
      () => {
        const match = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>("button"),
        ).find((b) => (b.textContent ?? "").includes("E.max Crown"));
        if (!match) throw new Error("E.max Crown suggestion not rendered");
        expect(container.contains(match)).toBe(false);
        return match;
      },
      { timeout: 3000 },
    );
    expect(option.textContent).toContain("$210.00");
    expect(option.className).toContain("min-h-9");
    expect(option.querySelector("span.flex-1")?.className).not.toContain("truncate");

    // Picking it fills the description and this doctor's effective price.
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    await waitFor(() => {
      expect(descriptionInputs(container)[1].value).toBe("E.max Crown");
      expect(unitPriceInputFor(descriptionInputs(container)[1]).value).toBe("210.00");
    });

    // …and the invoice total updates immediately (150 auto line + 210 picked).
    expect(totalText(container)).toBe("$360.00");
  }, 20000);

  it("still saves a free-typed line, and carries a picked line's catalog identity to POST /cases", async () => {
    const container = await reachPreview();

    // Line 2: picked from the catalog. Line 3: free-typed, matches nothing.
    await act(async () => {
      fireEvent.click(findButtonByText(container, /\+ Add line/i));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(2));
    await act(async () => {
      fireEvent.change(descriptionInputs(container)[1], { target: { value: "max" } });
    });
    const option = await waitFor(() => {
      const match = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => (b.textContent ?? "").includes("E.max Crown"));
      if (!match) throw new Error("E.max Crown suggestion not rendered");
      return match;
    });
    await act(async () => {
      fireEvent.mouseDown(option);
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /\+ Add line/i));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(3));
    const freeRow = descriptionInputs(container)[2];
    await act(async () => {
      fireEvent.change(freeRow, { target: { value: "Rush courier fee" } });
    });
    await act(async () => {
      fireEvent.change(unitPriceInputFor(descriptionInputs(container)[2]), {
        target: { value: "35" },
      });
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => expect(postedCases.length).toBe(1), { timeout: 5000 });
    const lines = postedCases[0]?.invoiceOverrideLines ?? [];
    // Free-typed line survives verbatim, with no catalog identity attached.
    expect(lines).toContainEqual({
      description: "Rush courier fee",
      quantity: 1,
      unitPrice: 35,
      subItems: [],
    });
    // Picked line carries its catalog key so the draft line is attributable.
    expect(lines).toContainEqual({
      description: "E.max Crown",
      quantity: 1,
      unitPrice: 210,
      catalogItemKey: "emax_crown",
      subItems: [],
    });
  }, 20000);

  it("shows the Case Pan Barcode field and preserves its text in the created case payload", async () => {
    const container = await reachPreview();
    expect(container.textContent).toContain("Case Pan Barcode");
    const barcode = container.querySelector<HTMLInputElement>(
      "#rx-case-pan-barcode",
    );
    expect(barcode?.type).toBe("text");
    expect(barcode?.inputMode).toBe("");

    await act(async () => {
      fireEvent.change(barcode!, { target: { value: "0000123" } });
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => expect(postedCases.length).toBe(1), { timeout: 5000 });
    expect(postedCases[0]?.casePanBarcode).toBe("0000123");
  }, 20000);

  it("sends an empty override set when every preview line is removed", async () => {
    const container = await reachPreview();

    // Remove the single auto-generated line, leaving an empty preview.
    await act(async () => {
      fireEvent.click(findButtonByText(container, /^×$/));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(0));

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => expect(postedCases.length).toBe(1), { timeout: 5000 });
    // An explicit empty array — not an omitted field, which would let the
    // server auto-price the removed line straight back onto the invoice.
    expect(postedCases[0]?.invoiceOverrideLines).toEqual([]);
    const previewInput = JSON.parse(mockApiFetch.mock.calls.find(([path]: any[]) => path === "/invoices/preview-draft")![1].body);
    expect(previewInput.restorations[0].restorationSubtype).toBeTruthy();
    expect(previewInput.restorations.map((row: any) => row.restorationSubtype))
      .toEqual(postedCases[0].restorations.map((row: any) => row.restorationSubtype));
  }, 20000);
});
