/** @vitest-environment jsdom */
/**
 * Regression guard for the required "doctor not on file" resolution step in
 * DashboardDropZone (desktop AI drop-zone intake).
 *
 * When the AI-extracted doctor name does NOT strictly match an existing doctor
 * for the selected lab+practice, clicking "Create case" must open the
 * resolution modal and BLOCK case creation until the user resolves it. On a
 * strict (exact) match the case is created directly, adopting the stored
 * spelling. The POST /cases 409 DOCTOR_CONFIRMATION_REQUIRED gate remains the
 * authoritative server-side backstop and is out of scope here.
 *
 * Invariants protected:
 *  - Non-exact resolve → the "Doctor not on file" modal appears and POST /cases
 *    is NOT called.
 *  - Exact resolve → POST /cases is called directly with the stored spelling.
 *  - "Use this doctor" → POST /cases with the candidate's spelling +
 *    confirmNewDoctor:true.
 *  - "Add … as new doctor" → POST /cases with the scanned name +
 *    confirmNewDoctor:true.
 *
 * No component code is rewritten; the path is driven through the rendered UI.
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

// PDF → image conversion depends on pdfjs-dist + canvas — mock both (unused for
// a JPEG drop, but the component imports them eagerly).
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

// practiceName matches a provider org so the practice auto-resolves and the
// create button can proceed to the resolution/duplicate checks.
const RX_RESPONSE = {
  doctorName: "Dr. Jane Smith",
  patientName: "Bob Anderson",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
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

function findButtonByText(container: HTMLElement, re: RegExp): HTMLButtonElement {
  const btn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => re.test(b.textContent ?? ""));
  if (!btn) throw new Error(`button matching ${re} not found`);
  return btn;
}

/**
 * Drives the drop-zone from idle to the rxConfirm panel with the practice
 * auto-resolved. `resolveResponse` is what GET /doctors/resolve-name returns.
 */
function installHandlers(opts: {
  resolveResponse: {
    exactMatch: string | null;
    similarMatches: Array<Record<string, unknown>>;
    canAddNew: boolean;
  };
  onPostCases: (body: any) => void;
}) {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary")) return Promise.resolve([]);
    if (path.startsWith("/rx-practice-aliases"))
      return Promise.resolve({ data: { found: false } });
    if (path === "/analyze-prescription") return Promise.resolve(RX_RESPONSE);
    if (path.startsWith("/cases/patient-similarity"))
      return Promise.resolve({ matches: [] });
    if (path.startsWith("/cases/next-case-number"))
      return Promise.resolve({ caseNumber: "25-1000" });
    if (path.startsWith("/doctors/resolve-name"))
      return Promise.resolve(opts.resolveResponse);
    if (path === "/media/upload")
      return Promise.resolve({ url: "media://uploaded" });
    if (path === "/cases" && init?.method === "POST") {
      let body: any = null;
      try {
        body = JSON.parse(init?.body ?? "{}");
      } catch {
        body = null;
      }
      opts.onPostCases(body);
      return Promise.resolve({ id: "case-new-1", caseNumber: "25-1000" });
    }
    if (/^\/cases\/[^/]+\/attachments$/.test(path))
      return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  });
}

async function dropAndReachConfirm(container: HTMLElement) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await act(async () => {
    triggerFileInput(container, [makeJpegFile()]);
    await new Promise((r) => setTimeout(r, 300));
  });
  await waitFor(
    () =>
      expect(
        container.querySelector('[data-testid="practice-picker"]'),
      ).not.toBeNull(),
    { timeout: 5000 },
  );
  // Practice auto-resolved from the matching org name.
  const picker = container.querySelector('[data-testid="practice-picker"]');
  expect(picker?.getAttribute("data-value")).toBe("provB");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — doctor resolution (not on file)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("blocks POST /cases and opens the resolution modal when the scanned name is not on file", async () => {
    let posted: any = null;
    installHandlers({
      resolveResponse: {
        exactMatch: null,
        similarMatches: [
          {
            doctorName: "Dr. Janet Smyth",
            providerOrganizationId: "provB",
            similarity: 0.6,
            totalCases: 3,
          },
        ],
        canAddNew: true,
      },
      onPostCases: (b) => {
        posted = b;
      },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(
      () => {
        expect(container.textContent ?? "").toMatch(/Doctor not on file/i);
      },
      { timeout: 5000 },
    );
    // The case must NOT have been created — the gate blocks it.
    expect(posted).toBeNull();
    // The suggested existing doctor is offered.
    expect(container.textContent ?? "").toMatch(/Dr\. Janet Smyth/);
  });

  it("creates the case directly (adopting the stored spelling) on a strict/exact match", async () => {
    let posted: any = null;
    installHandlers({
      resolveResponse: {
        exactMatch: "Dr. Jane Smith",
        similarMatches: [],
        canAddNew: true,
      },
      onPostCases: (b) => {
        posted = b;
      },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(
      () => {
        expect(posted).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(posted.doctorName).toBe("Dr. Jane Smith");
    // No "not on file" modal on an exact match.
    expect(container.textContent ?? "").not.toMatch(/Doctor not on file/i);
  });

  it("'use this doctor' creates the case with the candidate's spelling + confirmNewDoctor", async () => {
    let posted: any = null;
    installHandlers({
      resolveResponse: {
        exactMatch: null,
        similarMatches: [
          {
            doctorName: "Dr. Janet Smyth",
            providerOrganizationId: "provB",
            similarity: 0.6,
            totalCases: 3,
          },
        ],
        canAddNew: true,
      },
      onPostCases: (b) => {
        posted = b;
      },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(
      () => expect(container.textContent ?? "").toMatch(/Doctor not on file/i),
      { timeout: 5000 },
    );

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Use this doctor/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    expect(posted.doctorName).toBe("Dr. Janet Smyth");
    expect(posted.confirmNewDoctor).toBe(true);
  });

  it("'add as new doctor' creates the case with the scanned name + confirmNewDoctor", async () => {
    let posted: any = null;
    installHandlers({
      resolveResponse: {
        exactMatch: null,
        similarMatches: [
          {
            doctorName: "Dr. Janet Smyth",
            providerOrganizationId: "provB",
            similarity: 0.6,
            totalCases: 3,
          },
        ],
        canAddNew: true,
      },
      onPostCases: (b) => {
        posted = b;
      },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(
      () => expect(container.textContent ?? "").toMatch(/Doctor not on file/i),
      { timeout: 5000 },
    );

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Add .* as new doctor/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    expect(posted.doctorName).toBe("Dr. Jane Smith");
    expect(posted.confirmNewDoctor).toBe(true);
  });
});
