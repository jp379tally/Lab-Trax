/** @vitest-environment jsdom */
/**
 * Integration tests for the searchable Practice picker in the DashboardDropZone
 * prescription import flow.
 *
 * Invariants protected:
 *  - The practice list is fetched with `includeLabPractices=true` so EVERY
 *    Customer-Center practice (including lab-managed practices the user is not a
 *    direct member of) is selectable — not just the user's own memberships.
 *  - The picker is type-to-filter: typing narrows the visible options.
 *  - Choosing an option resolves it back to the provider-org id and reflects the
 *    selected practice name in the trigger.
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

// DoctorNamePicker is rendered as a plain input so it doesn't interfere with the
// practice-picker assertions (this suite is not about doctor auto-fill).
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

// AI extracted a practice name that does NOT match any provider org, so the
// picker is left empty for the user to resolve manually.
const RX_RESPONSE = {
  doctorName: "",
  patientName: "Bob Anderson",
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

// "Blissful Dental Spa" is a lab-managed practice that only appears when the
// query asks for includeLabPractices=true.
const ORGS = [
  { id: "lab1", type: "lab", name: "Test Lab" },
  { id: "provA", type: "provider", name: "Maple Dental" },
  { id: "provB", type: "provider", name: "Oak Dental" },
  { id: "provC", type: "provider", name: "Blissful Dental Spa" },
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardDropZone — searchable Practice picker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/legacy/cases") return Promise.resolve({ cases: [] });
      if (path.startsWith("/organizations")) return Promise.resolve(ORGS);
      if (path === "/cases/doctor-names") return Promise.resolve([]);
      if (path === "/cases/doctor-directory") return Promise.resolve([]);
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
    await waitFor(
      () => expect(screen.queryByTestId("practice-picker-trigger")).not.toBeNull(),
      { timeout: 4000 },
    );
    return container;
  }

  it("fetches practices with includeLabPractices=true so lab practices are selectable", async () => {
    await reachRxConfirm();

    // The drop-zone must request the lab-inclusive practice list.
    expect(
      mockApiFetch.mock.calls.some(
        ([p]) => p === "/organizations?includeLabPractices=true",
      ),
    ).toBe(true);

    // Opening the picker reveals the lab-managed practice.
    await act(async () => {
      fireEvent.click(practiceTrigger());
    });
    expect(screen.getByText("Blissful Dental Spa")).toBeTruthy();
    expect(screen.getByText("Maple Dental")).toBeTruthy();
    expect(screen.getByText("Oak Dental")).toBeTruthy();
  });

  it("filters the options as the user types", async () => {
    await reachRxConfirm();

    await act(async () => {
      fireEvent.click(practiceTrigger());
    });

    const search = screen.getByPlaceholderText("Search practices…");
    await act(async () => {
      fireEvent.change(search, { target: { value: "bliss" } });
    });

    expect(screen.getByText("Blissful Dental Spa")).toBeTruthy();
    expect(screen.queryByText("Maple Dental")).toBeNull();
    expect(screen.queryByText("Oak Dental")).toBeNull();
  });

  it("selecting a practice reflects it in the trigger", async () => {
    await reachRxConfirm();

    await act(async () => {
      fireEvent.click(practiceTrigger());
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Blissful Dental Spa"));
    });

    // The trigger now shows the chosen practice (placeholder is gone).
    expect(practiceTrigger().textContent).toMatch(/blissful dental spa/i);
    expect(practiceTrigger().textContent).not.toMatch(/select a practice/i);
  });
});
