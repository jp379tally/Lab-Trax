/** @vitest-environment jsdom */
/**
 * Regression tests for the per-doctor practice memory in the AI intake
 * (DashboardDropZone prescription import flow).
 *
 * The Rx-practice-name alias is keyed on the practice TEXT the AI read off the
 * prescription, which is exactly the thing that keeps changing between scans.
 * The doctor-keyed memory is the higher-priority key, so:
 *
 *  - A second prescription for a doctor whose practice was confirmed once
 *    auto-selects that practice and shows NO "save this mapping" prompt.
 *  - A prescription with no readable practice name at all still auto-selects
 *    the practice from the doctor memory.
 *  - A near-duplicate doctor name asks "which doctor is this?" FIRST — naming
 *    the candidate's real practice and address — and confirming it selects the
 *    practice without ever asking the practice question.
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { DashboardDropZone } from "../DashboardDropZone";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
  ApiError: class extends Error {},
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

// PracticePicker is mocked to a div exposing the selected org id plus one
// button per option, so the tests can read the auto-filled value directly and
// drive a manual selection (the real searchable dropdown is exercised by the
// practice-picker and add-practice suites).
vi.mock("@/components/PracticePicker", () => ({
  PracticePicker: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange?: (id: string) => void;
    options?: Array<{ id: string; label: string }>;
  }) => (
    <div data-testid="practice-picker" data-value={value}>
      {(options ?? []).map((o) => (
        <button
          key={o.id}
          type="button"
          data-testid={`pick-practice-${o.id}`}
          onClick={() => onChange?.(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

// ─── FileReader class-based mock (image → data URL) ───────────────────────────

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
});

afterAll(() => {
  Object.defineProperty(window, "FileReader", {
    value: OrigFileReader,
    configurable: true,
    writable: true,
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORGS = [
  { id: "lab1", type: "lab", name: "Test Lab" },
  { id: "provA", type: "provider", name: "Sample Dental Associates" },
  { id: "provB", type: "provider", name: "Oak Dental" },
];

/** Scan #2 for a doctor already confirmed once, with unhelpful practice text. */
const RX_REMEMBERED_DOCTOR = {
  doctorName: "Dr. Synthetic029 Provider029",
  patientName: "Pat Test",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
    toothIndices: "14",
    toothAssignments: [{ toothNumber: "14", role: "prepared_crown", roleEvidence: "Prepared crown #14", material: "Zirconia", shade: "A2", requiresReview: false }],
  dueDate: "2026-08-01",
  isRush: false,
  notes: "",
  // Deliberately NOT a match for any provider org, and not the alias key
  // either — the doctor memory has to carry this on its own.
  practiceName: "Totally Unrecognized Practice",
  practiceAddress: "",
  practicePhone: "",
};

/** The AI could read no practice name at all off this prescription. */
const RX_NO_PRACTICE_NAME = {
  ...RX_REMEMBERED_DOCTOR,
  practiceName: "",
};

/** A slightly misread doctor name that closely resembles one on file. */
const RX_NEAR_DUPLICATE_DOCTOR = {
  ...RX_REMEMBERED_DOCTOR,
  doctorName: "Synthetic029 Proveder029",
  practiceName: "",
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
  const Wrapper = makeAuthWrapper("/", {
    user: DROP_ZONE_USER,
    status: "authed",
  });
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

function practiceValue(container: HTMLElement): string {
  const el = container.querySelector('[data-testid="practice-picker"]');
  if (!el) throw new Error("practice picker not found");
  return el.getAttribute("data-value") ?? "";
}

function findButtonByText(container: HTMLElement, re: RegExp): HTMLButtonElement {
  const btn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => re.test(b.textContent ?? ""));
  if (!btn) throw new Error(`button matching ${re} not found`);
  return btn;
}

/**
 * Installs the API mock. `rx` is what /analyze-prescription returns,
 * `doctorMemory` what GET /rx-doctor-practice-memory returns, and
 * `resolveResponse` what GET /doctors/resolve-name returns.
 */
function installHandlers(opts: {
  rx: Record<string, unknown>;
  doctorMemory?: { found: boolean; providerOrganizationId?: string | null };
  resolveResponse?: {
    exactMatch: string | null;
    similarMatches: Array<Record<string, unknown>>;
    canAddNew: boolean;
  };
  onMemoryPost?: (body: any) => void;
}) {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: any) => {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path.startsWith("/vocabulary")) return Promise.resolve([]);
    if (path === "/analyze-prescription") return Promise.resolve(opts.rx);
    if (path.startsWith("/rx-doctor-practice-memory")) {
      if (init?.method === "POST") {
        let body: any = null;
        try {
          body = JSON.parse(init?.body ?? "{}");
        } catch {
          body = null;
        }
        opts.onMemoryPost?.(body);
        return Promise.resolve({ found: true });
      }
      // NOTE: the shape here is what apiFetch RETURNS, not what the server
      // sends. The server sends `{ ok, data: { found, providerOrganizationId } }`
      // and apiFetch strips the envelope, so a caller sees the inner object.
      // Mocking the enveloped shape here would let a `.data`-reading bug pass.
      // `apiFetch envelope contract` below pins that down against the real
      // apiFetch.
      return Promise.resolve(
        opts.doctorMemory ?? { found: false, providerOrganizationId: null },
      );
    }
    // No Rx-name alias saved — the doctor memory is the only thing that can
    // resolve the practice in these tests.
    if (path.startsWith("/rx-practice-aliases"))
      return Promise.resolve({ found: false, providerOrganizationId: null });
    if (path.startsWith("/doctors/resolve-name"))
      return Promise.resolve(
        opts.resolveResponse ?? {
          exactMatch: null,
          similarMatches: [],
          canAddNew: true,
        },
      );
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
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — per-doctor practice memory", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("auto-selects the remembered practice and shows no save prompt on a later Rx for the same doctor", async () => {
    installHandlers({
      rx: RX_REMEMBERED_DOCTOR,
      doctorMemory: { found: true, providerOrganizationId: "provA" },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await waitFor(() => expect(practiceValue(container)).toBe("provA"));

    // The whole point: no practice question, even though the Rx practice text
    // matches nothing and no alias exists for it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();

    // …and the user can see WHERE the practice came from.
    expect(screen.getByTestId("practice-remembered-badge").textContent).toMatch(
      /Remembered for Dr\. Synthetic029 Provider029/i,
    );
  });

  it("still auto-selects from doctor memory when the Rx has no readable practice name", async () => {
    installHandlers({
      rx: RX_NO_PRACTICE_NAME,
      doctorMemory: { found: true, providerOrganizationId: "provA" },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await waitFor(() => expect(practiceValue(container)).toBe("provA"));
    expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();
  });

  it("leaves the practice unresolved when nothing is remembered for the doctor", async () => {
    installHandlers({
      rx: RX_NO_PRACTICE_NAME,
      doctorMemory: { found: false, providerOrganizationId: null },
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(practiceValue(container)).toBe("");
    expect(screen.queryByTestId("practice-remembered-badge")).toBeNull();
  });

  it("remembers the practice the user picks by hand when the Rx has no practice name", async () => {
    // The path with no Rx-name alias to prompt about: there is no practice
    // text to key an alias on, so if picking the practice does not teach the
    // doctor mapping, this doctor is asked again on every single scan.
    const memoryPosts: any[] = [];
    installHandlers({
      rx: RX_NO_PRACTICE_NAME,
      doctorMemory: { found: false, providerOrganizationId: null },
      onMemoryPost: (b) => memoryPosts.push(b),
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);
    await waitFor(() => expect(practiceValue(container)).toBe(""));
    expect(memoryPosts).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId("pick-practice-provA"));
      await new Promise((r) => setTimeout(r, 100));
    });

    await waitFor(() => expect(memoryPosts).toHaveLength(1));
    expect(memoryPosts[0]).toMatchObject({
      labOrganizationId: "lab1",
      doctorName: "Dr. Synthetic029 Provider029",
      providerOrganizationId: "provA",
    });
    // And the user can see it stuck.
    await waitFor(() =>
      expect(screen.getByTestId("practice-remembered-badge")).toBeTruthy(),
    );
  });

  it("surfaces an inline error when remembering a hand-picked practice fails", async () => {
    installHandlers({
      rx: RX_NO_PRACTICE_NAME,
      doctorMemory: { found: false, providerOrganizationId: null },
    });
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: any) => {
      if (path.startsWith("/rx-doctor-practice-memory") && init?.method === "POST") {
        return Promise.reject(new Error("Server error"));
      }
      return base(path, init);
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    await act(async () => {
      fireEvent.click(screen.getByTestId("pick-practice-provA"));
      await new Promise((r) => setTimeout(r, 100));
    });

    await waitFor(() => {
      expect(screen.getByTestId("doctor-memory-error").textContent).toMatch(
        /Couldn't remember/i,
      );
    });
    expect(screen.queryByTestId("practice-remembered-badge")).toBeNull();
  });

  it("remembers a fuzzy-matched practice the user simply accepts, when the case is created", async () => {
    // Nothing is prompted on this path — the practice text fuzzy-matches a
    // practice on file, so the picker is never touched. Submitting the case is
    // the user's confirmation, and must teach the mapping; otherwise the next
    // Rx for this doctor with blank or differently-worded practice text starts
    // asking all over again.
    const memoryPosts: any[] = [];
    installHandlers({
      rx: { ...RX_REMEMBERED_DOCTOR, practiceName: "Sample Dental" },
      doctorMemory: { found: false, providerOrganizationId: null },
      resolveResponse: {
        // The doctor IS on file under this exact spelling, so no identify step.
        exactMatch: "Dr. Synthetic029 Provider029",
        similarMatches: [],
        canAddNew: false,
      },
      onMemoryPost: (b) => memoryPosts.push(b),
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    // Fuzzy-matched, with no prompt and nothing remembered yet.
    await waitFor(() => expect(practiceValue(container)).toBe("provA"));
    expect(screen.queryByTestId("practice-remembered-badge")).toBeNull();
    expect(memoryPosts).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-case-btn"));
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => expect(memoryPosts.length).toBeGreaterThan(0));
    expect(memoryPosts[0]).toMatchObject({
      labOrganizationId: "lab1",
      doctorName: "Dr. Synthetic029 Provider029",
      providerOrganizationId: "provA",
    });
  });

  it("asks which doctor this is BEFORE the practice question, then skips the practice prompt once confirmed", async () => {
    const memoryPosts: any[] = [];
    installHandlers({
      rx: RX_NEAR_DUPLICATE_DOCTOR,
      doctorMemory: { found: false, providerOrganizationId: null },
      resolveResponse: {
        exactMatch: null,
        similarMatches: [
          {
            doctorName: "Dr. Synthetic029 Provider029",
            providerOrganizationId: "provA",
            practiceName: "Sample Dental Associates",
            practiceAddressLine1: "100 Example Road",
            practiceCity: "Sampletown",
            practiceState: "FL",
            similarity: 0.82,
            totalCases: 7,
          },
        ],
        canAddNew: true,
      },
      onMemoryPost: (b) => memoryPosts.push(b),
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);

    // The identify-the-doctor step is up, naming the candidate's real practice
    // AND address — and the practice is still unresolved at this point.
    const step = await waitFor(() => screen.getByTestId("doctor-identify-step"));
    expect(step.textContent).toMatch(
      /Is this Dr\. Synthetic029 Provider029 at Sample Dental Associates — 100 Example Road, Sampletown, FL\?/,
    );
    expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Is this Dr\. Synthetic029 Provider029/));
      await new Promise((r) => setTimeout(r, 100));
    });

    // Confirming adopts the stored spelling and its practice…
    await waitFor(() => expect(practiceValue(container)).toBe("provA"));
    expect(screen.queryByTestId("doctor-identify-step")).toBeNull();
    // …and never asks the practice question.
    expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();

    // Both the stored spelling and the scanned misreading are remembered, so
    // the next scan of either resolves with no prompt at all.
    const remembered = memoryPosts.map((p) => p.doctorName);
    expect(remembered).toContain("Dr. Synthetic029 Provider029");
    expect(remembered).toContain("Synthetic029 Proveder029");
    for (const p of memoryPosts) {
      expect(p.providerOrganizationId).toBe("provA");
      expect(p.labOrganizationId).toBe("lab1");
    }
  });

  it("keeps the identify step open with an inline error when remembering fails", async () => {
    installHandlers({
      rx: RX_NEAR_DUPLICATE_DOCTOR,
      doctorMemory: { found: false, providerOrganizationId: null },
      resolveResponse: {
        exactMatch: null,
        similarMatches: [
          {
            doctorName: "Dr. Synthetic029 Provider029",
            providerOrganizationId: "provA",
            practiceName: "Sample Dental Associates",
            practiceAddressLine1: null,
            practiceCity: null,
            practiceState: null,
            similarity: 0.82,
            totalCases: 7,
          },
        ],
        canAddNew: true,
      },
    });
    // Make only the memory POST fail.
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: any) => {
      if (path.startsWith("/rx-doctor-practice-memory") && init?.method === "POST") {
        return Promise.reject(new Error("Server error"));
      }
      return base(path, init);
    });

    const { container } = renderDropZone();
    await dropAndReachConfirm(container);
    await waitFor(() => screen.getByTestId("doctor-identify-step"));

    await act(async () => {
      fireEvent.click(findButtonByText(container, /Is this Dr\. Synthetic029 Provider029/));
      await new Promise((r) => setTimeout(r, 100));
    });

    // Never a silent "sure, remembered".
    await waitFor(() => {
      expect(screen.getByTestId("doctor-memory-error").textContent).toMatch(
        /Couldn't remember/i,
      );
    });
    expect(screen.getByTestId("doctor-identify-step")).toBeTruthy();
  });
});
