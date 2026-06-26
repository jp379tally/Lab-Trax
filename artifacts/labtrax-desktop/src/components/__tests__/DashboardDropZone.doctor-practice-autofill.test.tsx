/** @vitest-environment jsdom */
/**
 * Integration test for doctor -> practice auto-fill in the DashboardDropZone
 * prescription import flow.
 *
 * Invariant protected:
 *  - When the AI extraction leaves the Practice (provider) dropdown empty
 *    (the AI's practice name did not match any provider org), picking an
 *    on-record doctor from the doctor dropdown auto-populates the Practice
 *    dropdown with that doctor's primary practice (the provider org the doctor
 *    has the most cases under, per GET /cases/doctor-directory).
 *  - Picking an unknown / custom doctor name leaves the Practice unchanged.
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
  ApiError: class extends Error {},
}));

vi.mock("@/lib/format", () => ({
  formatPhone: (p: string) => p,
}));

// DoctorNamePicker is rendered as a plain text input so the test can drive its
// onChange directly (it carries the auto-fill side effect under test).
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

// AI extracted a doctor and a practice name that does NOT match any provider
// org, so the practice dropdown is left empty for the user to resolve.
const RX_RESPONSE = {
  // AI left the doctor blank, so selecting an on-record doctor is a genuine
  // value change (a same-value fireEvent.change is suppressed by React's
  // controlled-input value tracker and would never fire onChange).
  doctorName: "",
  patientName: "Bob Anderson",
  caseType: "crown",
  shade: "A2",
  material: "Zirconia",
  toothIndices: "14",
  dueDate: "2026-08-01",
  isRush: false,
  notes: "",
  practiceName: "Unrecognized Practice LLC",
  practiceAddress: "",
  practicePhone: "",
};

const DOCTOR_DIRECTORY = [
  // Dr. Cory Couch is mostly at Maple Dental (provB) → that's his primary.
  { doctorName: "Dr. Cory Couch", providerOrganizationId: "provB", caseCount: 5 },
  { doctorName: "Dr. Cory Couch", providerOrganizationId: "provA", caseCount: 1 },
];

const ORGS = [
  { id: "lab1", type: "lab", name: "Test Lab" },
  { id: "provA", type: "provider", name: "Oak Dental" },
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
  if (!input) return;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input, { target: { files } });
}

// The lab <select> is hidden for a single-lab user, so the only native <select>
// in the rxConfirm panel is the Practice dropdown.
function practiceSelect(container: HTMLElement): HTMLSelectElement {
  const sel = container.querySelector<HTMLSelectElement>("select");
  if (!sel) throw new Error("practice <select> not found");
  return sel;
}

function doctorInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    '[data-testid="doctor-name-picker"]',
  );
  if (!el) throw new Error("doctor picker not found");
  return el;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — doctor → practice auto-fill", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path === "/organizations") return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names")
        return Promise.resolve(["Dr. Cory Couch"]);
      if (path === "/cases/doctor-directory")
        return Promise.resolve(DOCTOR_DIRECTORY);
      if (path === "/analyze-prescription") return Promise.resolve(RX_RESPONSE);
      if (path.startsWith("/rx-practice-aliases"))
        return Promise.resolve({ data: { found: false } });
      return Promise.resolve([]);
    });
  });

  async function reachRxConfirm() {
    const { container } = renderDropZone();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await act(async () => {
      triggerFileInput(container, [makeJpegFile()]);
      await new Promise((r) => setTimeout(r, 300));
    });
    // Wait until the rxConfirm panel (with the practice <select>) is mounted.
    await waitFor(() => expect(container.querySelector("select")).not.toBeNull(), {
      timeout: 4000,
    });
    return container;
  }

  it("auto-fills the practice with the doctor's primary practice when an on-record doctor is picked", async () => {
    const container = await reachRxConfirm();

    // Practice starts empty (AI practice name did not match a provider org).
    expect(practiceSelect(container).value).toBe("");

    // User picks the on-record doctor.
    await act(async () => {
      fireEvent.change(doctorInput(container), {
        target: { value: "Dr. Cory Couch" },
      });
    });

    // Practice auto-fills to the doctor's primary practice (most cases → provB).
    await waitFor(() => expect(practiceSelect(container).value).toBe("provB"), {
      timeout: 4000,
    });
  });

  it("leaves the practice unchanged for an unknown / custom doctor name", async () => {
    const container = await reachRxConfirm();

    expect(practiceSelect(container).value).toBe("");

    await act(async () => {
      fireEvent.change(doctorInput(container), {
        target: { value: "Dr. Nobody On Record" },
      });
    });

    // No mapping for this name → practice stays empty.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(practiceSelect(container).value).toBe("");
  });
});
