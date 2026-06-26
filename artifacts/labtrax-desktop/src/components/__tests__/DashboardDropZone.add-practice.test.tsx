/** @vitest-environment jsdom */
/**
 * Integration tests for the inline "Add practice" entry point in the
 * DashboardDropZone prescription picker (Task #2417).
 *
 * Invariants protected:
 *  - Choosing "+ Add new practice" from the practice <select> opens the inline
 *    form pre-filled from the AI-extracted Rx fields.
 *  - Required-field validation mirrors the standalone Add Practice dialog: a
 *    name-only practice is creatable, but an empty name is rejected client-side
 *    with a visible "Practice name is required." message (no POST is sent).
 *  - A successful create selects the new practice in the picker and closes the
 *    inline form.
 *  - Server rejections are surfaced: a 409 names the conflicting practice and
 *    offers a one-click "Use existing practice" action; a 403 shows its
 *    message instead of a generic failure.
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { DashboardDropZone } from "../DashboardDropZone";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/api";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", () => {
  // ApiError mock carries a `body` so the 409 conflict path can be exercised.
  // Defined inside the factory because vi.mock is hoisted above module scope.
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(msg: string, status = 500, body: unknown = null) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  }
  return {
    apiFetch: (...args: any[]) => mockApiFetch(...args),
    createUploadSession: vi.fn(),
    sendUploadChunk: vi.fn(),
    ApiError: MockApiError,
  };
});

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

// ─── FileReader class-based mock ─────────────────────────────────────────────

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
});

afterAll(() => {
  Object.defineProperty(window, "FileReader", {
    value: OrigFileReader,
    configurable: true,
    writable: true,
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// AI saw a practice name but there is no matching provider org yet, so the
// picker nudges the user toward "+ Add new practice".
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
  practiceName: "Smith Dental",
  practiceAddress: "123 Main St, Springfield, IL 62701",
  practicePhone: "555-111-2222",
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
  if (!input) return;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input, { target: { files } });
}

// Drop a file and wait for the rxConfirm panel, then open the inline
// "Add practice" form via the practice <select>.
async function reachInlineAddPracticeForm(container: HTMLElement) {
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  await act(async () => {
    triggerFileInput(container, [makeJpegFile()]);
    await new Promise((r) => setTimeout(r, 200));
  });
  await waitFor(
    () => expect(container.textContent ?? "").toMatch(/AI read this prescription/i),
    { timeout: 4000 },
  );

  // Open the searchable practice picker, then choose its "Add new practice"
  // action row to reveal the inline create form.
  await act(async () => {
    fireEvent.click(screen.getByTestId("practice-picker-trigger"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("practice-picker-add-new"));
  });
  await waitFor(() =>
    expect(container.textContent ?? "").toMatch(/New practice — confirm details/i),
  );
}

function nameField(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="Practice name *"]',
  );
  if (!input) throw new Error("practice name input not found");
  return input;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Save practice & use it/i });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DashboardDropZone — inline Add practice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockDataUrl = "data:image/jpeg;base64,/9j/fakeJpegData==";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Background-query stubs. Only handles GET /organizations — the POST that
  // creates a practice must fall through to each test's own handler, so we
  // explicitly exclude POST here (otherwise the POST is swallowed as a false
  // "success" returning the lab list and the form closes without an error).
  function baseStubs(path: string, opts?: any): Promise<unknown> | null {
    if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
    if (path.startsWith("/organizations") && opts?.method !== "POST")
      return Promise.resolve([{ id: "lab1", type: "lab", name: "Test Lab" }]);
    if (path === "/cases/doctor-names") return Promise.resolve([]);
    if (path === "/cases/doctor-directory") return Promise.resolve([]);
    if (path === "/analyze-prescription") return Promise.resolve(RX_RESPONSE);
    return null;
  }

  it("opens the inline form pre-filled from the Rx and creates a name-only practice", async () => {
    let postBody: any = null;
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        postBody = JSON.parse(opts.body as string);
        return Promise.resolve({ id: "prov-new", name: postBody.name });
      }
      return Promise.reject(new Error(`Unexpected: ${path} ${opts?.method ?? ""}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    // Pre-filled from the AI-extracted practiceName.
    expect(nameField(container).value).toBe("Smith Dental");

    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody.name).toBe("Smith Dental");
    expect(postBody.type).toBe("provider");
    expect(postBody.parentLabOrganizationId).toBe("lab1");

    // Inline form closes after a successful create.
    await waitFor(() =>
      expect(container.textContent ?? "").not.toMatch(/New practice — confirm details/i),
    );
  });

  it("disables save for an empty name and sends no POST (required-name guard)", async () => {
    let postCount = 0;
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        postCount += 1;
        return Promise.resolve({ id: "x", name: "x" });
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    // Prefilled → save enabled. Clearing the name disables save, mirroring the
    // standalone Add Practice dialog (name is the only required field).
    expect(saveButton()).not.toBeDisabled();

    await act(async () => {
      fireEvent.change(nameField(container), { target: { value: "" } });
    });

    await waitFor(() => expect(saveButton()).toBeDisabled());

    // Clicking the disabled button must not fire a create request.
    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(postCount).toBe(0);

    // Re-entering a name re-enables save.
    await act(async () => {
      fireEvent.change(nameField(container), { target: { value: "New Practice" } });
    });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
  });

  it("surfaces a 409 conflict and offers 'Use existing practice'", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        return Promise.reject(
          new (ApiError as any)("Conflict", 409, {
            details: {
              conflictingOrg: {
                id: "prov-existing",
                name: "Smith Dental",
                displayName: "Smith Dental Studio",
                accountNumber: "1234AB",
              },
            },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() =>
      expect(container.textContent ?? "").toMatch(/already exists in this lab/i),
    );
    expect(container.textContent ?? "").toMatch(/Smith Dental Studio/);
    expect(container.textContent ?? "").toMatch(/1234AB/);

    const useExisting = screen.getByRole("button", { name: /Use existing practice/i });
    await act(async () => {
      fireEvent.click(useExisting);
    });

    // Picking the existing practice closes the inline form.
    await waitFor(() =>
      expect(container.textContent ?? "").not.toMatch(/New practice — confirm details/i),
    );
  });

  it("maps a 400 field error back to the offending input (inline highlight + message)", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        return Promise.reject(
          new (ApiError as any)("Invalid request.", 400, {
            ok: false,
            message: "Invalid request.",
            errors: [
              {
                code: "invalid_string",
                path: ["phone"],
                message: "Enter a valid phone number.",
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });

    // The field-specific server message is shown…
    await waitFor(() =>
      expect(container.textContent ?? "").toMatch(/Enter a valid phone number/i),
    );
    // …and a summary nudge points at the highlighted field.
    expect(container.textContent ?? "").toMatch(/fix the highlighted field/i);

    // The offending phone input is marked invalid; unrelated inputs are not.
    const phoneInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="000-000-0000"]',
    );
    expect(phoneInput).not.toBeNull();
    expect(phoneInput!.getAttribute("aria-invalid")).toBe("true");
    expect(nameField(container).getAttribute("aria-invalid")).toBe("false");

    // The inline form stays open so the user can fix the field in place.
    expect(container.textContent ?? "").toMatch(/New practice — confirm details/i);
  });

  it("falls back to the generic message for a 400 with no mappable field", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        return Promise.reject(
          new (ApiError as any)("Invalid request.", 400, {
            ok: false,
            message: "Invalid request.",
            errors: [
              {
                code: "custom",
                path: ["somethingUnknown"],
                message: "Unknown field problem.",
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });

    // No mappable field → generic 400 message (the server message), and no
    // input is flagged invalid by the field-mapping path.
    await waitFor(() =>
      expect(container.textContent ?? "").toMatch(/Invalid request/i),
    );
    expect(container.textContent ?? "").not.toMatch(/fix the highlighted field/i);
    expect(nameField(container).getAttribute("aria-invalid")).toBe("false");
  });

  it("surfaces a 403 rejection message instead of a generic failure", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      const stub = baseStubs(path, opts);
      if (stub) return stub;
      if (path === "/organizations" && opts?.method === "POST") {
        return Promise.reject(
          new (ApiError as any)("You don't have permission to add a practice here.", 403),
        );
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });

    const { container } = renderDropZone();
    await reachInlineAddPracticeForm(container);

    await act(async () => {
      fireEvent.click(saveButton());
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() =>
      expect(container.textContent ?? "").toMatch(/don't have permission/i),
    );
  });
});
