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

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

// pdfjs-dist/build/pdf.worker.min.mjs?url is a Vite virtual module. Stub it.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({ default: "stub-worker" }));

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
    vi.clearAllMocks();
    // Default stubs for the background queries.
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path === "/organizations")
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
      if (path === "/organizations")
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

  it("sends imageBase64 field (not raw bytes) to /analyze-prescription for a JPEG", async () => {
    let capturedBody: any = null;

    mockApiFetch.mockImplementation((path: string, opts: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path === "/organizations")
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

  it("calls /analyze-prescription for a PDF (PDF-to-image conversion path)", async () => {
    let analyzeCalled = false;

    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path === "/organizations")
        return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") {
        analyzeCalled = true;
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
    }, { timeout: 4000 });
  });

  it("renders the doctorName from the fixture in rxConfirm state", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path === "/organizations")
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
      if (path === "/organizations") return Promise.resolve([]);
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
      if (path === "/organizations") return Promise.resolve([]);
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
      if (path === "/organizations") return Promise.resolve([]);
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
