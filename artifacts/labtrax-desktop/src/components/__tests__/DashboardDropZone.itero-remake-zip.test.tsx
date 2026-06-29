/** @vitest-environment jsdom */
/**
 * Regression guard for the iTero ZIP-import → remake path in DashboardDropZone.
 *
 * Background: the generic/Shining ZIP branch was fixed to forward remake
 * metadata, but the iTero ZIP branch posts to a *different* endpoint
 * (`/cases/import-from-itero-rx`, multipart FormData) and still dropped the
 * remake fields. Dropping an iTero ZIP and choosing "Link as remake" silently
 * created a plain non-remake case — no suffixed number, no cross-link events,
 * and the charge flag was ignored.
 *
 * This test walks the full client path with a real JSZip iTero archive
 * (`iTero_Rx_<orderId>.pdf` + one scan):
 *   drop ZIP → AI analyze (PDF) → rxConfirm → "Create case" → duplicate
 *   prompt → "Link as remake" → POST /cases/import-from-itero-rx.
 *
 * Invariants protected:
 *  - The /cases/import-from-itero-rx FormData carries remakeOfCaseId,
 *    remakeReason, and remakeCharged from the duplicate-prompt remake
 *    selection.
 *  - iTero ZIP imports never call GET /cases/next-case-number (the server
 *    assigns the number — suffixed for a remake).
 *
 * Mirrors DashboardDropZone.remake-zip.test.tsx (the generic-ZIP variant).
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

// The prior case the new iTero ZIP-imported case is a remake of.
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

// Build a real iTero ZIP: an iTero_Rx_<orderId>.pdf + one 3D scan. The
// `iTero_Rx_*.pdf` name is what flips the import into the iTero branch.
const ITERO_ORDER_ID = "987654";
async function makeIteroRemakeZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file(`iTero_Rx_${ITERO_ORDER_ID}.pdf`, "%PDF-1.4 fake-itero-rx-bytes");
  zip.file("scan.stl", "solid fake-scan-bytes");
  const ab = await zip.generateAsync({ type: "arraybuffer" });
  return new File([ab], `iTero_export_${ITERO_ORDER_ID}.zip`, {
    type: "application/zip",
  });
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

describe("DashboardDropZone — iTero ZIP-import remake path", () => {
  let iteroFormData: FormData | null;
  let nextCaseNumberCalled: boolean;

  beforeEach(() => {
    iteroFormData = null;
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
      if (path === "/analyze-prescription") return Promise.resolve(RX_RESPONSE);

      // Duplicate / remake candidate lookup.
      if (path.startsWith("/cases/patient-similarity"))
        return Promise.resolve({ matches: [SIMILARITY_MATCH] });

      // Media uploads (scan files), small files → single-shot.
      if (path === "/media/upload")
        return Promise.resolve({ url: "media://uploaded" });

      // Must NOT be hit for an iTero import.
      if (path.startsWith("/cases/next-case-number")) {
        nextCaseNumberCalled = true;
        return Promise.resolve({ caseNumber: "25-9999" });
      }

      // iTero case create — capture the multipart FormData body.
      if (path === "/cases/import-from-itero-rx" && opts?.method === "POST") {
        iteroFormData = opts?.body instanceof FormData ? opts.body : null;
        return Promise.resolve({
          deduped: false,
          caseId: "case-new-1",
          caseNumber: "25-1000B",
        });
      }

      // Scan attachment creation.
      if (/^\/cases\/[^/]+\/attachments$/.test(path))
        return Promise.resolve({ ok: true });

      return Promise.resolve([]);
    });
  });

  it("forwards remake metadata in the iTero FormData and skips next-case-number", async () => {
    const zipFile = await makeIteroRemakeZipFile();
    const { container } = renderDropZone();

    // Let background queries settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 1. Drop the iTero ZIP → analyze (PDF) → rxConfirm.
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
        target: { value: "Margin open; remaking under warranty" },
      });
    });

    // Choose "No — no-charge remake" so we also exercise remakeCharged "false".
    await act(async () => {
      fireEvent.click(findButtonByText(container, /no-charge remake/i));
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, /^Link as remake$/i));
      await new Promise((r) => setTimeout(r, 500));
    });

    // 4. The iTero import FormData must carry the remake metadata.
    await waitFor(
      () => {
        expect(iteroFormData).not.toBeNull();
      },
      { timeout: 5000 },
    );

    const fd = iteroFormData!;
    expect(fd.get("remakeOfCaseId")).toBe("case-original-1");
    expect(fd.get("remakeReason")).toBe("Margin open; remaking under warranty");
    expect(fd.get("remakeCharged")).toBe("false");
    // It must still post to the dedicated iTero endpoint with the order id.
    expect(fd.get("iteroOrderId")).toBe(ITERO_ORDER_ID);

    // And the next-case-number fetch must have been skipped.
    expect(nextCaseNumberCalled).toBe(false);
  });
});
