/** @vitest-environment jsdom */
/**
 * The editable invoice preview inside the AI intake (drop-zone) review panel is
 * rebuilt from the server preview every time the practice or doctor changes.
 * That rebuild must not throw away the admin's own work.
 *
 * Invariants protected:
 *  - Lines the admin added by hand survive a doctor/practice change; only the
 *    auto-generated lines are rebuilt (and re-priced) from the server preview.
 *  - Explicit edits to an auto-generated line survive a doctor/practice change
 *    when its restoration mapping is unchanged.
 *  - A surviving line picked from the item typeahead is re-priced for the newly
 *    selected doctor…
 *  - …unless the admin typed a price by hand, which always wins.
 *  - Starting a new intake (cancel, then drop another file) still clears every
 *    line, hand-added ones included.
 */

import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import JSZip from "jszip";
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
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?worker&url", () => ({ default: "stub-worker" }));

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

const SECOND_DOCTOR = "Dr. Bravo Example";

/** The auto line is priced per doctor, exactly as the server would. */
function previewDraftFor(doctorName: string) {
  const unitPrice = doctorName === SECOND_DOCTOR ? "175.00" : "150.00";
  return {
    lineItems: [
      {
        description: "Zirconia Crown",
        toothLabel: "#14",
        quantity: 1,
        unitPrice,
        lineTotal: unitPrice,
        priceSource: "tier",
        priceKey: "zirconia_crown",
        priced: true,
        restorationIndices: [0],
      },
    ],
    subtotal: unitPrice,
    total: unitPrice,
  };
}

/** Typeahead options are re-resolved for whichever doctor is selected. */
function preCreateItemsFor(doctorName: string) {
  const emax = doctorName === SECOND_DOCTOR ? 260 : 210;
  return {
    items: [
      { id: "v1", priceKey: null, name: "Custom Polish", unitPrice: 25, source: null },
    ],
    catalogItems: [
      {
        key: "emax_crown",
        label: "E.max Crown",
        unitPrice: emax,
        source: "tier",
        sourceId: "tier1",
        sourceName: "Gold",
      },
    ],
  };
}

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
  let node: HTMLElement | null = descInput.parentElement;
  while (node) {
    const price = node.querySelector<HTMLInputElement>('input[placeholder="0.00"]');
    if (price) return price;
    node = node.parentElement;
  }
  throw new Error("unit price input not found for row");
}

function installHandlers(
  rx: typeof RX_RESPONSE & { arch?: "upper" | "lower" | "both" } = RX_RESPONSE,
  emptyPreview = false,
) {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary")) return Promise.resolve([]);
    if (path.startsWith("/rx-practice-aliases"))
      return Promise.resolve({ found: false, providerOrganizationId: null });
    if (path === "/analyze-prescription") return Promise.resolve(rx);
    if (path === "/invoices/preview-draft") {
      if (emptyPreview) {
        return Promise.resolve({ lineItems: [], subtotal: "0.00", total: "0.00" });
      }
      let doctorName = "";
      try {
        doctorName = JSON.parse(init?.body ?? "{}")?.doctorName ?? "";
      } catch {
        doctorName = "";
      }
      if (rx.arch) {
        const { restorations } = JSON.parse(init.body);
        return Promise.resolve({
          lineItems: restorations.map((row: { arch: string }, index: number) => ({
            description: `${row.arch} Night Guard`,
            quantity: 1,
            unitPrice: "150.00",
            lineTotal: "150.00",
            priced: true,
            priceSource: "tier",
            restorationIndices: [index],
          })),
          subtotal: String(restorations.length * 150),
          total: String(restorations.length * 150),
        });
      }
      return Promise.resolve(previewDraftFor(doctorName));
    }
    if (path.startsWith("/pricing/pre-create-items")) {
      const doctorName = new URLSearchParams(path.split("?")[1] ?? "").get(
        "doctorName",
      );
      return Promise.resolve(preCreateItemsFor(doctorName ?? ""));
    }
    if (path.startsWith("/cases/patient-similarity"))
      return Promise.resolve({ matches: [] });
    if (path.startsWith("/cases/next-case-number"))
      return Promise.resolve({ caseNumber: "25-1000" });
    if (path.startsWith("/doctors/resolve-name"))
      return Promise.resolve({
        exactMatch: RX_RESPONSE.doctorName,
        similarMatches: [],
        canAddNew: true,
      });
    if (path === "/media/upload") return Promise.resolve({ url: "media://uploaded" });
    if (path === "/cases" && init?.method === "POST")
      return Promise.resolve({ id: "case-new-1", caseNumber: "25-1000" });
    if (/^\/cases\/[^/]+\/attachments$/.test(path)) return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  });
}

/** Drops a file and waits for the editable invoice preview to be populated. */
async function dropFileAndReachPreview(container: HTMLElement, file = makeJpegFile(), lineCount = 1) {
  await act(async () => {
    triggerFileInput(container, [file]);
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
  await waitFor(() => expect(descriptionInputs(container).length).toBe(lineCount), {
    timeout: 5000,
  });
}

async function reachPreview(): Promise<HTMLElement> {
  const { container } = renderDropZone();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await dropFileAndReachPreview(container);
  return container;
}

/** Adds a row and fills it from the "E.max Crown" typeahead suggestion. */
async function addPickedLine(container: HTMLElement, rowIndex: number) {
  await act(async () => {
    fireEvent.click(findButtonByText(container, /\+ Add line/i));
  });
  await waitFor(() => expect(descriptionInputs(container).length).toBe(rowIndex + 1));
  await act(async () => {
    fireEvent.change(descriptionInputs(container)[rowIndex], {
      target: { value: "max" },
    });
  });
  const option = await waitFor(
    () => {
      const match = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => (b.textContent ?? "").includes("E.max Crown"));
      if (!match) throw new Error("E.max Crown suggestion not rendered");
      return match;
    },
    { timeout: 3000 },
  );
  await act(async () => {
    fireEvent.mouseDown(option);
  });
  await waitFor(() =>
    expect(descriptionInputs(container)[rowIndex].value).toBe("E.max Crown"),
  );
}

/** Switches the doctor and lets the preview + option queries settle. */
async function changeDoctor(container: HTMLElement, name: string) {
  const doctorInput = container.querySelector<HTMLInputElement>(
    '[data-testid="doctor-name-picker"]',
  );
  if (!doctorInput) throw new Error("doctor picker not found");
  await act(async () => {
    fireEvent.change(doctorInput, { target: { value: name } });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 800));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — hand-added invoice lines across a doctor change", () => {
  beforeEach(() => {
    installHandlers();
  });

  it("previews and creates from extracted values when the AI tooth chart has no assignments", async () => {
    installHandlers({ ...RX_RESPONSE, toothAssignments: [] });
    const container = await reachPreview();

    const previewCall = mockApiFetch.mock.calls
      .filter(([url]) => url === "/invoices/preview-draft")
      .at(-1);
    const previewRows = JSON.parse(previewCall![1].body).restorations;
    expect(previewRows).toEqual([
      expect.objectContaining({
        toothNumber: "14",
        restorationType: "crown",
        material: "Zirconia",
        shade: "A2",
      }),
    ]);
    expect(container.textContent).toContain("Invoice preview");

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
    });
    await waitFor(() => {
      const post = mockApiFetch.mock.calls.find(([url, init]) => url === "/cases" && init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body).restorations).toEqual([
        expect.objectContaining({
          toothNumber: "14",
          restorationType: "crown",
          material: "Zirconia",
          shade: "A2",
        }),
      ]);
    });
  }, 15000);

  it("applies an explicit tooth-role correction to preview and created case without requiring connectors", async () => {
    installHandlers();
    const container = await reachPreview();

    await act(async () => {
      fireEvent.change(container.querySelector<HTMLSelectElement>(
        'select[aria-label="Clinical role for tooth 14"]',
      )!, { target: { value: "Pontic" } });
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await waitFor(() => {
      const previewCall = mockApiFetch.mock.calls
        .filter(([url]) => url === "/invoices/preview-draft")
        .at(-1);
      expect(JSON.parse(previewCall![1].body).restorations[0].restorationType).toBe("Pontic");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
    });
    await waitFor(() => {
      const post = mockApiFetch.mock.calls.find(([url, init]) => url === "/cases" && init?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse(post![1].body);
      expect(body.restorations[0]).toEqual(expect.objectContaining({
        toothNumber: "14",
        restorationType: "Pontic",
        material: "Zirconia",
      }));
      expect(body).not.toHaveProperty("bridgeConnectors");
    });
  }, 15000);

  it("keeps an empty invoice preview visible when no billable rows are inferred", async () => {
    installHandlers({ ...RX_RESPONSE, toothIndices: "", caseType: "", material: "", shade: "", toothAssignments: [] }, true);
    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await waitFor(() => expect(container.querySelector('[data-testid="practice-picker"]')).not.toBeNull());
    await waitFor(() => expect(container.textContent).toContain("No billable line items were found in the prescription."));
    expect(mockApiFetch.mock.calls.some(([url, init]) =>
      url === "/invoices/preview-draft" && JSON.parse(init?.body ?? "{}").restorations.length === 0,
    )).toBe(true);
  }, 15000);

  it.each(["image", "PDF", "generic ZIP"])(
    "keeps both appliance sources and reviewed prices aligned when saving a %s",
    async (source) => {
      installHandlers({
        ...RX_RESPONSE,
        caseType: "Night Guard",
        material: "Acrylic",
        shade: "Clear",
        toothIndices: "",
        arch: "both",
      });
      let file = makeJpegFile();
      if (source === "PDF") {
        file = new File(["%PDF-1.4 fake-rx"], "prescription.pdf", { type: "application/pdf" });
      } else if (source === "generic ZIP") {
        const zip = new JSZip();
        zip.file("prescription.pdf", "%PDF-1.4 fake-rx");
        zip.file("model.ply", "ply ascii fake-scan");
        file = new File([await zip.generateAsync({ type: "arraybuffer" })], "shining-export.zip", {
          type: "application/zip",
        });
      }
      const { container } = renderDropZone();
      // Let organization queries settle before analysis captures the practice
      // directory, just as reachPreview does for the existing intake tests.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await dropFileAndReachPreview(container, file, 2);
      await waitFor(() =>
        expect(container.querySelector('[data-testid="practice-picker"]')?.getAttribute("data-value")).toBe("provB"),
      );
      const previewCall = mockApiFetch.mock.calls.find(([url]) => url === "/invoices/preview-draft");
      const previewRows = JSON.parse(previewCall![1].body).restorations;
      expect(previewRows).toEqual([
        expect.objectContaining({ toothNumber: "", arch: "upper", quantity: 1 }),
        expect.objectContaining({ toothNumber: "", arch: "lower", quantity: 1 }),
      ]);
      expect(previewRows.every((row: object) => !("unitPrice" in row))).toBe(true);
      expect(previewRows.every((row: any) => typeof row.restorationSubtype === "string")).toBe(true);
      expect(container.textContent).toContain("$300.00");

      // Distinct edits must stay attached to the respective appliance.
      await act(async () => {
        fireEvent.change(unitPriceInputFor(descriptionInputs(container)[0]), { target: { value: "87" } });
        fireEvent.change(unitPriceInputFor(descriptionInputs(container)[1]), { target: { value: "0" } });
      });
      await changeDoctor(container, SECOND_DOCTOR);
      expect(unitPriceInputFor(descriptionInputs(container)[0]).value).toBe("87");
      expect(unitPriceInputFor(descriptionInputs(container)[1]).value).toBe("0");
      await act(async () => {
        fireEvent.click(findButtonByText(container, /Create case/i));
      });
      await waitFor(() => {
        const post = mockApiFetch.mock.calls.find(([url, init]) => url === "/cases" && init?.method === "POST");
        expect(post).toBeDefined();
        const body = JSON.parse(post![1].body);
        expect(body.restorations.map(({ unitPrice: _price, priceOverridden: _override, ...row }: {
          unitPrice: number; priceOverridden?: boolean; restorationSubtype?: string;
        }) => row)).toEqual(previewRows);
        expect(body.restorations.map((row: { unitPrice: number }) => row.unitPrice)).toEqual([0, 0]);
        expect(body.invoiceOverrideLines).toEqual([
          expect.objectContaining({ description: "upper Night Guard", quantity: 1, unitPrice: 87 }),
          expect.objectContaining({ description: "lower Night Guard", quantity: 1, unitPrice: 0 }),
        ]);
      });
      expect(mockApiFetch.mock.calls.filter(([url, init]) => url === "/cases" && init?.method === "POST")).toHaveLength(1);
    },
    30000,
  );

  it("keeps user-added lines, re-prices picked ones, and respects a hand-typed price", async () => {
    const container = await reachPreview();

    // Row 2: picked from the typeahead, left at the suggested price.
    await addPickedLine(container, 1);
    await waitFor(() =>
      expect(unitPriceInputFor(descriptionInputs(container)[1]).value).toBe("210.00"),
    );

    // Row 3: picked from the typeahead, then hand-priced.
    await addPickedLine(container, 2);
    await act(async () => {
      fireEvent.change(unitPriceInputFor(descriptionInputs(container)[2]), {
        target: { value: "99" },
      });
    });

    // Row 4: free-typed, hand-priced, matches no suggestion.
    await act(async () => {
      fireEvent.click(findButtonByText(container, /\+ Add line/i));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(4));
    await act(async () => {
      fireEvent.change(descriptionInputs(container)[3], {
        target: { value: "Rush courier fee" },
      });
    });
    await act(async () => {
      fireEvent.change(unitPriceInputFor(descriptionInputs(container)[3]), {
        target: { value: "35" },
      });
    });

    await changeDoctor(container, SECOND_DOCTOR);

    // All three hand-added rows are still there (plus the auto row).
    await waitFor(() => expect(descriptionInputs(container).length).toBe(4));
    const rows = descriptionInputs(container);
    expect(rows[1].value).toBe("E.max Crown");
    expect(rows[2].value).toBe("E.max Crown");
    expect(rows[3].value).toBe("Rush courier fee");

    // The auto row is re-priced for the new doctor…
    await waitFor(() =>
      expect(unitPriceInputFor(descriptionInputs(container)[0]).value).toBe("175.00"),
    );
    // …so is the picked row the user never touched the price on…
    await waitFor(() =>
      expect(unitPriceInputFor(descriptionInputs(container)[1]).value).toBe("260.00"),
    );
    // …while hand-typed prices are left exactly as entered.
    expect(unitPriceInputFor(descriptionInputs(container)[2]).value).toBe("99");
    expect(unitPriceInputFor(descriptionInputs(container)[3]).value).toBe("35");
  }, 30000);

  it("keeps an edited auto-generated line across a doctor change", async () => {
    const container = await reachPreview();
    const autoDescription = descriptionInputs(container)[0];

    await act(async () => {
      fireEvent.change(autoDescription, {
        target: { value: "Rush zirconia crown" },
      });
    });
    await waitFor(() =>
      expect(descriptionInputs(container)[0].value).toBe("Rush zirconia crown"),
    );
    await act(async () => {
      fireEvent.change(unitPriceInputFor(autoDescription), {
        target: { value: "88" },
      });
    });
    await waitFor(() =>
      expect(unitPriceInputFor(descriptionInputs(container)[0]).value).toBe("88"),
    );

    await changeDoctor(container, SECOND_DOCTOR);

    await waitFor(() =>
      expect(descriptionInputs(container)[0].value).toBe("Rush zirconia crown"),
    );
    expect(unitPriceInputFor(descriptionInputs(container)[0]).value).toBe("88");
  }, 30000);

  it("submits corrected preview prices, a rush fee, and a layered child together", async () => {
    const container = await reachPreview();
    await act(async () => {
      fireEvent.change(unitPriceInputFor(descriptionInputs(container)[0]), {
        target: { value: "10" },
      });
      fireEvent.click(findButtonByText(container, /\+ Add child charge/i));
    });
    await act(async () => {
      fireEvent.change(container.querySelector<HTMLInputElement>('[aria-label="Child charge description 1"]')!, {
        target: { value: "Layered Porcelain" },
      });
      fireEvent.change(container.querySelector<HTMLInputElement>('[aria-label="Child charge price 1"]')!, {
        target: { value: "37" },
      });
      fireEvent.click(findButtonByText(container, /\+ Add line/i));
    });
    await act(async () => {
      fireEvent.change(descriptionInputs(container)[1], { target: { value: "Rush fee" } });
      fireEvent.change(unitPriceInputFor(descriptionInputs(container)[1]), { target: { value: "15" } });
    });
    expect(container.textContent).toContain("$62.00");
    await changeDoctor(container, SECOND_DOCTOR);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Child charge price 1"]')?.value).toBe("37");
    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 400));
    });
    await waitFor(() => {
      const post = mockApiFetch.mock.calls.find(([url, init]) => url === "/cases" && init?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse(post![1].body);
      expect(body.invoiceOverrideLines).toEqual([
        expect.objectContaining({
          unitPrice: 10,
          subItems: [{ description: "Layered Porcelain", quantity: 1, unitPrice: 37 }],
        }),
        { description: "Rush fee", quantity: 1, unitPrice: 15, subItems: [] },
      ]);
    }, { timeout: 5000 });
  }, 30000);

  it("clears hand-added lines when the intake is cancelled and a new file is dropped", async () => {
    const container = await reachPreview();

    await addPickedLine(container, 1);
    await waitFor(() => expect(descriptionInputs(container).length).toBe(2));

    await act(async () => {
      fireEvent.click(findButtonByText(container, /^Cancel$/));
    });
    await waitFor(() => expect(descriptionInputs(container).length).toBe(0));

    // A fresh intake starts from the auto-generated lines only.
    await dropFileAndReachPreview(container);
    expect(descriptionInputs(container).length).toBe(1);
    expect(descriptionInputs(container)[0].value).toContain("Zirconia Crown");
  }, 30000);
});
