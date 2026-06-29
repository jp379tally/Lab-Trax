/** @vitest-environment jsdom */
/**
 * Regression guard for the ZIP-import → remake path in DashboardDropZone.
 *
 * Background: the generic/Shining ZIP branch in `proceedCreateCase` was
 * missing the `...(remake ?? {})` spread, so a remake submitted via a dropped
 * ZIP (the duplicate-prompt "Link as remake" flow) silently created a plain
 * non-remake case with a wrong case number — the remake metadata was dropped
 * and the original case appeared to "vanish" (no cross-link, no suffix).
 *
 * This test walks the full client path with a real JSZip archive:
 *   drop ZIP → AI analyze (PDF) → rxConfirm → "Create case" → duplicate
 *   prompt → "Link as remake" → POST /cases.
 *
 * Invariants protected:
 *  - The POST /cases body forwards remakeOfCaseId, remakeReason, and
 *    remakeCharged from the duplicate-prompt remake selection.
 *  - The next-case-number fetch is skipped for a remake (the server assigns
 *    the suffixed number), i.e. GET /cases/next-case-number is NOT called.
 *
 * No component code is rewritten; the path is driven entirely through the
 * rendered UI.
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

// PracticePicker mocked to a div exposing the resolved provider org id so the
// test can confirm the practice auto-resolved (the real searchable picker is
// covered by other suites).
vi.mock("@/components/PracticePicker", () => ({
  PracticePicker: ({ value }: { value: string }) => (
    <div data-testid="practice-picker" data-value={value} />
  ),
}));

// PDF → image conversion depends on pdfjs-dist + canvas — mock both.
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

// ─── FileReader + canvas stubs (PDF analyze path) ─────────────────────────────

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

// AI extraction. practiceName matches a provider org so the practice auto-
// resolves and the create button is allowed to proceed to the duplicate check.
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

// The prior case the new ZIP-imported case is a remake of.
const SIMILARITY_MATCH = {
  id: "case-original-1",
  caseNumber: "25-1000",
  matchKind: "name",
  source: "canonical" as const,
  patientFirstName: "Bob",
  patientLastName: "Anderson",
  doctorName: "Dr. Jane Smith",
  status: "complete",
  createdAt: "2026-05-01T00:00:00.000Z",
};

const DROP_ZONE_USER = {
  id: "u1",
  username: "lab_staff",
  role: "admin",
} as unknown as SessionUser;

// Build a real (non-iTero) ZIP: a generic prescription PDF + one 3D scan.
async function makeRemakeZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file("prescription.pdf", "%PDF-1.4 fake-rx-bytes");
  zip.file("model.ply", "ply ascii fake-scan-bytes");
  const ab = await zip.generateAsync({ type: "arraybuffer" });
  return new File([ab], "shining-export.zip", { type: "application/zip" });
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — ZIP-import remake path", () => {
  let postCasesBody: any;
  let nextCaseNumberCalled: boolean;

  beforeEach(() => {
    postCasesBody = null;
    nextCaseNumberCalled = false;
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      // Background queries.
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path.startsWith("/vocabulary")) return Promise.resolve([]);
      if (path.startsWith("/rx-practice-aliases"))
        return Promise.resolve({ data: { found: false } });

      // AI analyze.
      if (path === "/analyze-prescription")
        return Promise.resolve(RX_RESPONSE);

      // Duplicate / remake candidate lookup.
      if (path.startsWith("/cases/patient-similarity"))
        return Promise.resolve({ matches: [SIMILARITY_MATCH] });

      // Media uploads (rx PDF + scan), small files → single-shot.
      if (path === "/media/upload")
        return Promise.resolve({ url: "media://uploaded" });

      // Must NOT be hit for a remake.
      if (path.startsWith("/cases/next-case-number")) {
        nextCaseNumberCalled = true;
        return Promise.resolve({ caseNumber: "25-9999" });
      }

      // Case create.
      if (path === "/cases" && opts?.method === "POST") {
        try {
          postCasesBody = JSON.parse(opts?.body ?? "{}");
        } catch {
          postCasesBody = null;
        }
        return Promise.resolve({ id: "case-new-1", caseNumber: "25-1000-R" });
      }

      // Attachment creation.
      if (/^\/cases\/[^/]+\/attachments$/.test(path))
        return Promise.resolve({ ok: true });

      return Promise.resolve([]);
    });
  });

  it("forwards remake metadata and skips next-case-number on the ZIP-import remake path", async () => {
    const zipFile = await makeRemakeZipFile();
    const { container } = renderDropZone();

    // Let background queries settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 1. Drop the ZIP → analyze (PDF) → rxConfirm.
    await act(async () => {
      triggerFileInput(container, [zipFile]);
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(
      () =>
        expect(
          container.querySelector('[data-testid="practice-picker"]'),
        ).not.toBeNull(),
      { timeout: 5000 },
    );

    // Practice auto-resolved from the matching org name → create can proceed.
    const picker = container.querySelector('[data-testid="practice-picker"]');
    expect(picker?.getAttribute("data-value")).toBe("provB");

    // 2. Click "Create case" → duplicate check fires → duplicate prompt.
    await act(async () => {
      fireEvent.click(findButtonByText(container, /Create case/i));
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(
      () => {
        expect(container.textContent ?? "").toMatch(
          /Possible duplicate \/ remake/i,
        );
      },
      { timeout: 5000 },
    );

    // 3. Fill the remake reason + charge, then "Link as remake".
    const reason = container.querySelector("textarea");
    if (!reason) throw new Error("remake reason textarea not found");
    await act(async () => {
      fireEvent.change(reason, {
        target: { value: "Shade came back too dark; remaking as A2" },
      });
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /invoice as usual/i));
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /^Link as remake$/i));
      await new Promise((r) => setTimeout(r, 400));
    });

    // 4. The POST /cases body must carry the remake metadata.
    await waitFor(
      () => {
        expect(postCasesBody).not.toBeNull();
      },
      { timeout: 5000 },
    );

    expect(postCasesBody).toMatchObject({
      remakeOfCaseId: "case-original-1",
      remakeReason: "Shade came back too dark; remaking as A2",
      remakeCharged: true,
    });

    // And the next-case-number fetch must have been skipped for the remake.
    expect(nextCaseNumberCalled).toBe(false);
  });
});
