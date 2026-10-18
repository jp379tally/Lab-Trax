/**
 * @vitest-environment jsdom
 *
 * Exercises the ordinary image/PDF intake, not the ZIP importer. The create
 * request is captured after the user reviews the AI fields and selects an arch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "./test-utils";
import type { SessionUser } from "@/lib/api";
import { DashboardDropZone } from "@/components/DashboardDropZone";

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  ApiError: class extends Error {},
}));
vi.mock("@/lib/upload-media-file", () => ({
  uploadMediaFile: vi.fn().mockResolvedValue({ url: "/uploads/rx.jpg" }),
}));
vi.mock("@/lib/format", () => ({ formatPhone: (value: string) => value }));
vi.mock("@/components/DoctorNamePicker", () => ({ DoctorNamePicker: () => null }));

const user = { id: "u1", username: "staff", role: "staff" } as SessionUser;

async function uploadRx(caseType: string) {
  const Wrapper = makeAuthWrapper("/", { user, status: "authed" });
  const { container } = render(
    <Wrapper><DashboardDropZone /></Wrapper>,
  );
  const input = container.querySelector('input[type="file"]')!;
  const file = new File(["fake-jpeg"], "rx.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByTestId("create-case-btn");
  if (caseType !== "Crown") expect(screen.getByLabelText("Arch")).toBeTruthy();
  // Choose the practice in the review panel, as a user can do when the
  // extraction raced the organization lookup.
  fireEvent.click(screen.getByTestId("practice-picker-trigger"));
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
}

function createPayload() {
  const call = mockApiFetch.mock.calls.find(([url]) => url === "/cases");
  expect(call, "standard intake must POST /cases").toBeDefined();
  return JSON.parse(call![1].body as string);
}

describe("desktop ordinary Rx upload arch", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/legacy/cases") return { cases: [] };
      if (url.startsWith("/organizations")) return [
        { id: "lab", type: "lab", name: "Lab" },
        { id: "practice", type: "provider", name: "Practice" },
      ];
      if (url === "/cases/doctor-names" || url === "/cases/doctor-directory") return [];
      if (url.startsWith("/vocabulary?")) return [];
      if (url === "/analyze-prescription") return {
        doctorName: "Dr. Example",
        patientName: "Example Patient",
        practiceName: "Practice",
        caseType: mockCaseType,
        ...(mockCaseType === "Crown" ? { toothIndices: "14", material: "Zirconia", shade: "A2",
          toothAssignments: [{ toothNumber: "14", role: "prepared_crown", roleEvidence: "Prepared crown #14",
            material: "Zirconia", shade: "A2", requiresReview: false }] } : {}),
      };
      if (url.startsWith("/rx-doctor-practice-memory")) return { found: true, providerOrganizationId: "practice" };
      if (url.startsWith("/doctors/resolve-name")) return { exactMatch: "Dr. Example", similarMatches: [] };
      if (url.startsWith("/cases/patient-similarity")) return { matches: [] };
      if (url.startsWith("/cases/next-case-number")) return { caseNumber: "26-1" };
      if (url === "/invoices/preview-draft") return { lineItems: [], total: "0.00" };
      if (url === "/cases") return { id: "case1", caseNumber: "26-1" };
      return {};
    });
  });

  let mockCaseType = "Full Denture";

  for (const caseType of ["Full Denture", "Night Guard"]) {
    for (const [choice, arches] of [
      ["upper", ["upper"]],
      ["lower", ["lower"]],
      ["both", ["upper", "lower"]],
    ] as const) {
      it(`${caseType}: ${choice} creates separately marked quantity-1 sources matching preview`, async () => {
        mockCaseType = caseType;
        await uploadRx(caseType);
        fireEvent.change(screen.getByLabelText("Arch"), { target: { value: choice } });
        await waitFor(() => {
          const preview = mockApiFetch.mock.calls.filter(([url]) => url === "/invoices/preview-draft").at(-1);
          expect(preview && JSON.parse(preview[1].body).restorations.map((r: { arch: string }) => r.arch))
            .toEqual([...arches]);
        });
        fireEvent.click(screen.getByTestId("create-case-btn"));
        await waitFor(() => expect(mockApiFetch.mock.calls.some(([url]) => url === "/cases")).toBe(true));
        const rows = createPayload().restorations;
        expect(rows.map((r: { arch: string }) => r.arch)).toEqual([...arches]);
        expect(rows.map((r: { quantity: number }) => r.quantity)).toEqual(arches.map(() => 1));
        expect(rows.every((r: { restorationType: string }) => r.restorationType === caseType)).toBe(true);
      });
    }
  }

  it("requires an arch for a removable prescription before submitting", async () => {
    mockCaseType = "Full Denture";
    await uploadRx(mockCaseType);
    fireEvent.click(screen.getByTestId("create-case-btn"));
    expect(await screen.findByText(/Select Upper, Lower, or Upper \+ Lower/)).toBeTruthy();
    expect(mockApiFetch.mock.calls.some(([url]) => url === "/cases")).toBe(false);
  });

  it("does not require an arch for a crown", async () => {
    mockCaseType = "Crown";
    await uploadRx(mockCaseType);
    expect(screen.queryByLabelText("Arch")).toBeNull();
    fireEvent.click(screen.getByTestId("create-case-btn"));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([url]) => url === "/cases")).toBe(true));
    expect(createPayload().restorations).toEqual([expect.objectContaining({
      restorationType: "Crown", toothNumber: "14", quantity: 1,
    })]);
    expect(createPayload().restorations[0]).not.toHaveProperty("arch");
  });
});