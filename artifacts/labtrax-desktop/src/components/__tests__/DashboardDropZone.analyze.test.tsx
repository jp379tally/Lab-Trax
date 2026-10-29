/** @vitest-environment jsdom */
/**
 * Integration tests for DashboardDropZone AI analyze path (regression guard).
 *
 * Invariants protected:
 *  - Dropping a JPEG file triggers POST /api/analyze-prescription with a
 *    base64 imageBase64 body (not a raw binary upload).
 *  - Dropping a PDF triggers the PDF-to-image conversion path before the POST
 *    (pdfjs-dist is mocked so jsdom can run without a real canvas).
 *  - On a successful API response the component enters the "rxConfirm" state
 *    and renders the returned doctorName / patientName / shade.
 *  - On a 503 ("AI not configured") the component shows a recognisable error
 *    message and does not crash.
 *  - On a 500 the component shows the generic error state.
 *
 * No component code is rewritten; state transitions are tested through the
 * rendered output only.
 */

import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
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
  DoctorNamePicker: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Select doctor…"}
      data-testid="doctor-name-picker"
    />
  ),
}));

// PDF conversion depends on pdfjs-dist + canvas — mock both.
const pdfFixture = vi.hoisted(() => ({ pages: 1, getPage: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      get numPages() { return pdfFixture.pages; },
      getPage: pdfFixture.getPage.mockImplementation(() =>
        Promise.resolve({
          getViewport: () => ({ width: 800, height: 600 }),
          render: () => ({ promise: Promise.resolve() }),
        })),
    }),
  }),
  GlobalWorkerOptions: { workerSrc: "" },
}));

// pdfjs-dist/build/pdf.worker.min.mjs?url is a Vite virtual module. Stub it.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({ default: "stub-worker" }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?worker&url", () => ({ default: "stub-worker" }));

// ─── FileReader class-based mock ─────────────────────────────────────────────
// vi.fn() Proxies are not usable as constructors (new FileReader() throws).
// We replace the global FileReader with a plain class before each test and
// restore afterwards. The dataUrl is set via a module-level variable so each
// test can configure it.

let _mockDataUrl = "data:image/jpeg;base64,/9j/fakeJpegData==";

class MockFileReader {
  onload: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  result: string | null = null;

  readAsDataURL(_: Blob) {
    const url = _mockDataUrl;
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

  // Canvas stub for PDF path — pdfjs calls canvas.getContext and toDataURL.
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

const VALID_RX_RESPONSE = {
  doctorName: "Dr. Jane Smith",
  patientName: "Bob Anderson",
  patientInitials: "B.A.",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
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

function makePdfFile(name = "rx.pdf"): File {
  return new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
}

// ─── Provider wrapper ─────────────────────────────────────────────────────────

function renderDropZone() {
  const Wrapper = makeAuthWrapper("/", { user: DROP_ZONE_USER, status: "authed" });
  return render(
    <Wrapper>
      <DashboardDropZone />
    </Wrapper>,
  );
}

async function enterRxReview(
  response: typeof VALID_RX_RESPONSE,
  defaultCaseDueDays?: number | null,
) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations"))
      return Promise.resolve([{
        id: "lab1",
        type: "lab",
        name: "Test Lab",
        ...(defaultCaseDueDays === undefined ? {} : { defaultCaseDueDays }),
      }]);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path === "/analyze-prescription") return Promise.resolve(response);
    return Promise.reject(new Error(`Unexpected apiFetch: ${path}`));
  });
  const view = renderDropZone();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  await act(async () => {
    triggerFileInput(view.container, [makeJpegFile()]);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="rx-review-container"]')).toBeTruthy(),
  );
  return view;
}

// ─── Trigger helper: simulate file selection via the hidden <input type=file> ─

function triggerFileInput(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    // Fallback: simulate a drop event.
    const zone = container.firstElementChild as HTMLElement;
    if (zone) {
      fireEvent.dragEnter(zone, {
        dataTransfer: { files, types: ["Files"] },
      });
      fireEvent.drop(zone, {
        dataTransfer: { files, types: ["Files"] },
      });
    }
    return;
  }
  Object.defineProperty(input, "files", {
    value: files,
    configurable: true,
  });
  fireEvent.change(input, { target: { files } });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DashboardDropZone — AI analyze path", () => {
  beforeEach(() => {
  pdfFixture.pages = 1;
    vi.clearAllMocks();
    // Default stubs for the background queries.
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected apiFetch: ${path}`));
    });
    _mockDataUrl = "data:image/jpeg;base64,/9j/fakeJpegData==";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Smoke test ──────────────────────────────────────────────────────────────

  it("renders the idle drop zone without crashing", async () => {
    const { container } = renderDropZone();
    // Wait for background queries to settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(container.firstElementChild).toBeTruthy();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("reaches rxConfirm state ('AI read this prescription') after successful JPEG analyze", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.resolve(VALID_RX_RESPONSE);
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();

    // Let the queries load first.
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(
      () => {
        const text = container.textContent ?? "";
        expect(text).toMatch(/AI read this prescription/i);
      },
      { timeout: 4000 },
    );
  });

  it("prefills the lab schedule from receipt and preserves a staff-edited date", async () => {
    const { container } = await enterRxReview(
      { ...VALID_RX_RESPONSE, dueDate: "2026-08-08" },
      7,
    );
    const received = screen.getByLabelText("Date received") as HTMLInputElement;
    const labDue = screen.getByLabelText(/Lab due date/) as HTMLInputElement;

    fireEvent.change(received, { target: { value: "2026-08-01" } });
    await waitFor(() => expect(labDue.value).toBe("2026-08-08"));
    expect(screen.getByLabelText("Rx due date (from prescription)")).toHaveValue("2026-08-08");
    expect(container.textContent).toContain("7-day turnaround");

    fireEvent.change(received, { target: { value: "2026-08-02" } });
    await waitFor(() => expect(labDue.value).toBe("2026-08-09"));
    expect(screen.getByLabelText("Rx due date (from prescription)")).toHaveValue("2026-08-08");

    fireEvent.change(received, { target: { value: "" } });
    await waitFor(() => expect(labDue.value).toBe(""));
    fireEvent.change(received, { target: { value: "2026-08-02" } });
    await waitFor(() => expect(labDue.value).toBe("2026-08-09"));

    fireEvent.change(labDue, { target: { value: "2026-08-15" } });
    fireEvent.change(received, { target: { value: "2026-08-03" } });
    await waitFor(() => expect(received.value).toBe("2026-08-03"));
    expect(labDue.value).toBe("2026-08-15");
  });

  it.each(["2026-07-31", "2026-08-09"])(
    "omits an extracted prescription date outside the turnaround window (%s)",
    async (dueDate) => {
      const { container } = await enterRxReview(
        { ...VALID_RX_RESPONSE, dueDate },
        7,
      );
      fireEvent.change(screen.getByLabelText("Date received"), {
        target: { value: "2026-08-01" },
      });
      await waitFor(() =>
        expect(screen.getByLabelText(/Lab due date/)).toHaveValue("2026-08-08"),
      );
      expect(container.querySelector("#rx-due-date")).toBeNull();
      expect(container.textContent).not.toContain("The prescription requests");
    },
  );

  it("keeps Rx date entry unchanged when the lab has no turnaround preference", async () => {
    const { container } = await enterRxReview(
      { ...VALID_RX_RESPONSE, dueDate: "2026-08-20" },
      null,
    );
    fireEvent.change(screen.getByLabelText("Date received"), {
      target: { value: "2026-08-01" },
    });
    expect(screen.getByLabelText("Rx due date (from prescription)")).toHaveValue("2026-08-20");
    expect(screen.getByLabelText(/Lab due date/)).toHaveValue("");
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it("shows an empty Rx date field without a warning when no date was extracted", async () => {
    const { container } = await enterRxReview(
      { ...VALID_RX_RESPONSE, dueDate: "" },
      7,
    );
    await waitFor(() => expect(container.querySelector("#rx-due-date")).toBeTruthy());
    expect(container.querySelector<HTMLInputElement>("#rx-due-date")?.value).toBe("");
    expect(container.textContent).not.toContain("The prescription requests");
  });

  it("keeps the optional chart and assignment summary in separate responsive review regions", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.resolve(VALID_RX_RESPONSE);
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    const review = await waitFor(() => {
      const panel = container.querySelector<HTMLElement>('[data-testid="rx-review-container"]');
      expect(panel).toBeTruthy();
      return panel!;
    });
    const grid = review.querySelector<HTMLElement>(".rx-review-assignment-grid");
    const chartRegion = grid?.querySelector(".rx-review-chart-region");
    const summary = screen.getByRole("complementary", {
      name: "AI tooth assignment summary",
    });

    expect(grid).toBeTruthy();
    expect(chartRegion).toContainElement(
      screen.getByRole("group", {
        name: "Dental tooth chart, Universal tooth numbering",
      }),
    );
    expect(grid).toContainElement(summary);
    expect(summary.parentElement).toBe(grid);
    expect(review.textContent).toContain("Optional: use the chart to correct extracted tooth roles");
    expect(summary.textContent).toContain(
      "Extracted prescription details remain the baseline.",
    );
  });

  it("projects explicit bridge roles and removable arch/tooth evidence without adding teeth", async () => {
    const explicitBridge = {
      ...VALID_RX_RESPONSE,
      caseType: "Crown & Bridge",
      toothIndices: "2,3,4",
      toothAssignments: [
        { toothNumber: "2", role: "prepared_crown", roleEvidence: "crown on tooth #2", material: "Zirconia", shade: "A2", requiresReview: false },
        { toothNumber: "3", role: "pontic", roleEvidence: "pontic on tooth #3", material: "Zirconia", shade: "A2", requiresReview: false },
        { toothNumber: "4", role: "prepared_crown", roleEvidence: "crown on tooth #4", material: "Zirconia", shade: "A2", requiresReview: false },
      ],
      bridgeConnectors: "2-3,3-4",
    };
    const scenarios = [
      {
        response: explicitBridge,
        verify: (container: HTMLElement) => {
          expect(container.querySelector('[data-tooth-id="2"]')?.getAttribute("data-tooth-role")).toBe("crown");
          expect(container.querySelector('[data-tooth-id="3"]')?.getAttribute("data-tooth-role")).toBe("pontic");
          expect(container.querySelector('[data-tooth-id="4"]')?.getAttribute("data-tooth-role")).toBe("crown");
          expect(container.querySelector('[data-connector="2-3"]')?.getAttribute("aria-pressed")).toBe("true");
          expect(container.querySelector('[data-connector="3-4"]')?.getAttribute("aria-pressed")).toBe("true");
        },
      },
      {
        response: {
          ...VALID_RX_RESPONSE,
          caseType: "Denture",
          material: "Acrylic",
          arch: "upper",
          removableSubtype: "denture",
          toothIndices: "",
        },
        verify: (container: HTMLElement) => {
          const review = container.querySelector('[data-testid="rx-review-container"]')!;
          expect(review.textContent).toContain("Upper arch");
          expect(review.textContent).toContain("Denture");
          expect(container.querySelectorAll('[data-tooth-selected="true"]')).toHaveLength(0);
        },
      },
      {
        response: {
          ...VALID_RX_RESPONSE,
          caseType: "Removable",
          material: "Acrylic",
          arch: "upper",
          removableSubtype: "partial",
          toothIndices: "2,4",
        },
        verify: (container: HTMLElement) => {
          expect(container.querySelector('[data-tooth-id="2"]')?.getAttribute("data-tooth-selected")).toBe("true");
          expect(container.querySelector('[data-tooth-id="4"]')?.getAttribute("data-tooth-selected")).toBe("true");
          expect(container.querySelector('[data-tooth-id="3"]')?.getAttribute("data-tooth-selected")).not.toBe("true");
          expect(container.querySelectorAll('[data-tooth-selected="true"]')).toHaveLength(2);
          const chartHud = container.querySelector("svg [data-chart-hud]");
          expect(chartHud?.textContent).toContain("Type: Removable");
          expect(chartHud?.textContent).toContain("Material: Acrylic");
        },
      },
    ];

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      // The component intentionally keeps manual review overrides for the same
      // source image; give each case distinct bytes so these exercise fresh Rx
      // analyses rather than that same-source correction path.
      _mockDataUrl = `data:image/jpeg;base64,scenario-${scenarioIndex}`;
      mockApiFetch.mockImplementation((path: string) => {
        if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
        if (path.startsWith("/organizations"))
          return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
        if (path === "/cases/doctor-names") return Promise.resolve([]);
        if (path === "/cases/doctor-directory") return Promise.resolve([]);
        if (path === "/analyze-prescription") return Promise.resolve(scenario.response);
        return Promise.reject(new Error(`Unexpected: ${path}`));
      });

      const { container, unmount } = renderDropZone();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      await act(async () => {
        triggerFileInput(container, [makeJpegFile()]);
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      await waitFor(() => expect(container.querySelector('[data-testid="rx-review-container"]')).toBeTruthy());
      scenario.verify(container);
      unmount();
    }
  }, 20000);

  it("sends imageBase64 field (not raw bytes) to /analyze-prescription for a JPEG", async () => {
    let capturedBody: any = null;

    mockApiFetch.mockImplementation((path: string, opts: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") {
        try { capturedBody = JSON.parse(opts?.body ?? "{}"); } catch {}
        return Promise.resolve(VALID_RX_RESPONSE);
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
      expect(capturedBody).toHaveProperty("imageBase64");
      expect(typeof capturedBody.imageBase64).toBe("string");
    }, { timeout: 4000 });

    // The imageBase64 field should be a data URL, not raw bytes.
    expect(capturedBody.imageBase64).toMatch(/^data:/);
  });

  it("rejects an oversized PDF before rendering any page or submitting analysis", async () => {
    pdfFixture.pages = 11;
    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    await act(async () => {
      triggerFileInput(container, [makePdfFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });
    await waitFor(() => expect(screen.getByText(/at most 10 prescription pages/)).toBeTruthy());
    expect(pdfFixture.getPage).not.toHaveBeenCalled();
    expect(mockApiFetch.mock.calls.flat()).not.toContain("/analyze-prescription");
  });

  it("calls /analyze-prescription for a PDF (PDF-to-image conversion path)", async () => {
    let analyzeCalled = false;
    let capturedBody: Record<string, unknown> | null = null;
    pdfFixture.pages = 2;

    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") {
        analyzeCalled = true;
        capturedBody = JSON.parse(opts?.body ?? "{}");
        return Promise.resolve(VALID_RX_RESPONSE);
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makePdfFile()]);
      await new Promise((r) => setTimeout(r, 500));
    });

    await waitFor(() => {
      expect(analyzeCalled).toBe(true);
      expect(capturedBody).not.toBeNull();
    }, { timeout: 4000 });
    expect(pdfFixture.getPage).toHaveBeenCalledTimes(2);
    expect(capturedBody).toMatchObject({
      imageBase64: expect.stringMatching(/^data:image\/jpeg;base64,/),
      additionalImages: [expect.stringMatching(/^data:image\/jpeg;base64,/)],
      desktopReader: true,
    });
  });

  it("shows accurate-reader progress while the analysis request is pending", async () => {
    let resolveAnalyze!: (value: typeof VALID_RX_RESPONSE) => void;
    let capturedBody: Record<string, unknown> | null = null;
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") {
        capturedBody = JSON.parse(opts?.body ?? "{}");
        return new Promise((resolve) => {
          resolveAnalyze = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
      triggerFileInput(container, [makeJpegFile()]);
    });

    await waitFor(() =>
      expect(capturedBody).not.toBeNull(),
    );
    expect(container.textContent).toMatch(/accurate AI reader/i);
    expect(capturedBody).not.toHaveProperty("fast");
    expect(capturedBody).toMatchObject({ desktopReader: true });

    await act(async () => resolveAnalyze(VALID_RX_RESPONSE));
    await waitFor(() =>
      expect(container.textContent).toMatch(/AI read this prescription/i),
    );
  });

  it("renders the doctorName from the fixture in rxConfirm state", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations"))
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.resolve(VALID_RX_RESPONSE);
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      // The rxConfirm panel renders rxDraft.doctorName as an editable input.
      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[type=text], input:not([type]), textarea"),
      );
      const values = inputs.map((el) => el.value);
      expect(values.some((v) => v.includes("Dr. Jane Smith"))).toBe(true);
    }, { timeout: 4000 });
  });

  // ── Error states ───────────────────────────────────────────────────────────

  it("shows an error state when the server returns success:false (AI not configured)", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve([]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.resolve({
          success: false,
          error: "AI is not configured on this server.",
        });
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const text = container.textContent ?? "";
      // Phase transitions to "error" — the error message must appear.
      expect(text).toMatch(/AI is not configured|not configured|analysis failed/i);
    }, { timeout: 4000 });

    // Must NOT have reached the confirm panel.
    expect(container.textContent).not.toMatch(/AI read this prescription/i);
  });

  it("shows a generic error state when the API throws a 500", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve([]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.reject(new Error("Internal Server Error"));
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toMatch(/Internal Server Error|AI analysis failed|error/i);
    }, { timeout: 4000 });

    expect(container.textContent).not.toMatch(/AI read this prescription/i);
  });

  it("does NOT reach rxConfirm when API returns success:false without an error field", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve([]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription")
        return Promise.resolve({ success: false });
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });

    // Give enough time for the phase transition.
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

    expect(container.textContent).not.toMatch(/AI read this prescription/i);
  });
});
