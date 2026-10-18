/** @vitest-environment jsdom */
/**
 * Regression tests for the AI Rx practice alias save/load flow in the
 * DashboardDropZone prescription import flow.
 *
 * Invariants protected:
 *  - When GET /rx-practice-aliases returns found:false, selecting a non-matching
 *    practice shows the save prompt.
 *  - Clicking "Yes, remember this" calls POST; on success the prompt dismisses
 *    and no error is shown.
 *  - When POST returns a 500, the error message is shown and the prompt stays
 *    visible so the user can retry.
 *  - When GET returns found:true with a providerOrganizationId, the practice is
 *    auto-selected and the save prompt does not appear.
 */

import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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

// ─── FileReader class-based mock ──────────────────────────────────────────────

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

// The AI extracted a practice name that does NOT match any provider org, so
// the picker is left empty for the user to resolve manually.
const RX_NO_MATCH = {
  doctorName: "",
  patientName: "Pat Test",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
  dueDate: "2026-08-01",
  isRush: false,
  notes: "",
  practiceName: "Totally Unrecognized Practice",
  practiceAddress: "",
  practicePhone: "",
};

const ORGS = [
  { id: "lab1", type: "lab", name: "Test Lab" },
  { id: "provA", type: "provider", name: "Maple Dental" },
  { id: "provB", type: "provider", name: "Oak Dental" },
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
  if (!input) return;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input, { target: { files } });
}

function practiceTrigger(): HTMLButtonElement {
  return screen.getByTestId("practice-picker-trigger");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function reachRxConfirm(container: HTMLElement) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await act(async () => {
    triggerFileInput(container, [makeJpegFile()]);
    await new Promise((r) => setTimeout(r, 300));
  });
  await waitFor(
    () => expect(screen.queryByTestId("practice-picker-trigger")).not.toBeNull(),
    { timeout: 4000 },
  );
}

async function selectPractice(name: string) {
  await act(async () => {
    fireEvent.click(practiceTrigger());
  });
  await act(async () => {
    fireEvent.click(screen.getByText(name));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — alias save prompt", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") return Promise.resolve(RX_NO_MATCH);
      if (path.startsWith("/rx-practice-aliases") && !path.includes("POST"))
        return Promise.resolve({ found: false, providerOrganizationId: null });
      return Promise.resolve([]);
    });
  });

  it("shows the save prompt when the user picks a non-matching practice and no alias exists", async () => {
    const { container } = renderDropZone();
    await reachRxConfirm(container);

    await selectPractice("Maple Dental");

    await waitFor(() => {
      expect(screen.getByText(/Save this mapping for next time/i)).toBeTruthy();
    });
  });

  it("dismisses the prompt and shows no error on a successful POST", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") return Promise.resolve(RX_NO_MATCH);
      if (path.startsWith("/rx-practice-aliases")) {
        if (opts?.method === "POST") return Promise.resolve({ ok: true, data: { found: true } });
        return Promise.resolve({ found: false, providerOrganizationId: null });
      }
      return Promise.resolve([]);
    });

    const { container } = renderDropZone();
    await reachRxConfirm(container);
    await selectPractice("Maple Dental");
    await waitFor(() => {
      expect(screen.getByText(/Save this mapping for next time/i)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Yes, remember this"));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();
      expect(screen.queryByTestId("alias-save-error")).toBeNull();
    });
  });

  it("shows the error message and keeps the prompt visible when POST returns 500", async () => {
    const ApiError = class extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.status = status;
      }
    };

    mockApiFetch.mockImplementation((path: string, opts?: any) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") return Promise.resolve(RX_NO_MATCH);
      if (path.startsWith("/rx-practice-aliases")) {
        if (opts?.method === "POST")
          return Promise.reject(new ApiError("Server error", 500));
        return Promise.resolve({ found: false, providerOrganizationId: null });
      }
      return Promise.resolve([]);
    });

    const { container } = renderDropZone();
    await reachRxConfirm(container);
    await selectPractice("Maple Dental");
    await waitFor(() => {
      expect(screen.getByText(/Save this mapping for next time/i)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Yes, remember this"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("alias-save-error")).toBeTruthy();
      expect(screen.getByTestId("alias-save-error").textContent).toMatch(
        /Couldn't save/i,
      );
      // Prompt must still be visible.
      expect(screen.getByText(/Save this mapping for next time/i)).toBeTruthy();
    });
  });
});

describe("DashboardDropZone — alias auto-select", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("auto-selects the practice and hides the save prompt when GET returns found:true", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
      if (path === "/analyze-prescription") return Promise.resolve(RX_NO_MATCH);
      if (path.startsWith("/rx-practice-aliases"))
        return Promise.resolve({ found: true, providerOrganizationId: "provA" });
      return Promise.resolve([]);
    });

    const { container } = renderDropZone();
    await reachRxConfirm(container);

    // The save prompt must NOT appear since alias resolved automatically.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(screen.queryByText(/Save this mapping for next time/i)).toBeNull();
  });
});
