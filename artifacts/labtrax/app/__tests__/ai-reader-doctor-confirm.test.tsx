/**
 * Regression tests for the doctor-confirmation flow on ai-reader/extracted.tsx.
 *
 * Mirrors new-case-doctor-confirm.test.tsx for the AI-reader intake screen.
 * The server returns 409 DOCTOR_CONFIRMATION_REQUIRED when the extracted doctor
 * name closely matches an existing doctor. handleSubmit must open the
 * confirmation sheet instead of the dead-end "Couldn't create case" alert.
 *
 * Invariants protected:
 *  - A 409 with details.code === "DOCTOR_CONFIRMATION_REQUIRED" opens the
 *    confirmation state (renders the candidate rows) and does NOT show the
 *    generic error alert.
 *  - Any other error still shows the generic "Couldn't create case" alert and
 *    never opens the confirmation state.
 *  - "Use existing doctor" re-submits with confirmNewDoctor:true and the
 *    candidate's doctorName / providerOrganizationId (via override, so it can
 *    differ from the currently-bound practice).
 *  - "Create as new doctor" re-submits with just confirmNewDoctor:true, keeping
 *    the bound practice + extracted doctor name.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react-native";
import { Alert } from "react-native";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  mockCreateCaseMutateAsync,
} from "../../vitest.setup";
import {
  setAiReaderSession,
  clearAiReaderSession,
} from "@/lib/ai-reader-store";

import AiReaderExtractedScreen from "@/app/ai-reader/extracted";

const BOUND_ORG_ID = "org-1";

function seedEditableLab() {
  setMockAppState({
    meMemberships: [
      {
        id: "m1",
        role: "owner",
        status: "active",
        organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
      },
    ],
    labProviders: [
      { id: BOUND_ORG_ID, name: "Bright Smile Dental" },
    ],
  });
}

/** Seed the extracted Rx so the screen renders (else it redirects to capture). */
function seedExtracted() {
  setAiReaderSession({
    pages: [],
    extracted: {
      doctorName: "Dr. Synthetic063",
      patientName: "Jane Doe",
      patientInitials: null,
      caseType: null,
      toothIndices: null,
      shade: null,
      material: null,
      dueDate: null,
      isRush: null,
      notes: null,
      practiceName: "Bright Smile Dental",
      practiceAddress: null,
      practicePhone: null,
      confidence: null,
      step: null,
      gingivialShade: null,
    },
  });
}

/**
 * Alias resolve binds providerOrgId to BOUND_ORG_ID; patient-similarity returns
 * no matches so the first submit proceeds straight to createCase.
 */
function installFetchHandler(
  similarityResponse: (url: string) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ data: { matches: [] } }), {
      status: 200,
    }),
) {
  setMockFetchHandler((url: string, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/rx-practice-aliases") && method === "GET") {
      return new Response(
        JSON.stringify({
          data: { found: true, providerOrganizationId: BOUND_ORG_ID },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/cases/patient-similarity")) {
      return similarityResponse(url);
    }
    // The scanned "Dr. Synthetic063" strict-matches an on-file doctor, so the new
    // resolution gate passes straight through to createCase (which then
    // exercises the server 409 DOCTOR_CONFIRMATION_REQUIRED backstop below).
    if (url.includes("/api/doctors/resolve-name")) {
      return new Response(
        JSON.stringify({
          data: {
            exactMatch: "Dr. Synthetic063",
            similarMatches: [],
            canAddNew: true,
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
}

async function renderAndPrepare() {
  const screen = await render(<AiReaderExtractedScreen />);
  // Let the alias-resolve effect bind providerOrgId.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "26-42");
  return screen;
}

function doctorConfirm409(candidates: unknown[]) {
  return {
    status: 409,
    data: { details: { code: "DOCTOR_CONFIRMATION_REQUIRED", candidates } },
  };
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  clearAiReaderSession();
  vi.clearAllMocks();
});

describe("AiReaderExtractedScreen — doctor confirmation", () => {
  it("opens the confirmation sheet (not the generic alert) on a 409 DOCTOR_CONFIRMATION_REQUIRED", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          providerOrganizationId: BOUND_ORG_ID,
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getAllByTestId("doctor-confirm-candidate")).toHaveLength(1);
    });
    expect(Alert.alert).not.toHaveBeenCalledWith(
      "Couldn't create case",
      expect.anything(),
    );
  });

  it("shows the generic alert and does NOT open the confirmation sheet on a non-409 error", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw { status: 500, data: { details: { code: "INTERNAL" } } };
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        "Couldn't create case",
        expect.anything(),
      );
    });
    expect(screen.queryByTestId("doctor-confirm-candidate")).toBeNull();
  });

  it("'use existing doctor' re-submits with confirmNewDoctor and the candidate's doctorName/providerOrganizationId", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          // A different practice than the bound one — proves the override path.
          providerOrganizationId: "org-2",
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-confirm-candidate")).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId("doctor-confirm-candidate"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(2);
    });
    const resubmit = mockCreateCaseMutateAsync.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(resubmit.data.confirmNewDoctor).toBe(true);
    expect(resubmit.data.doctorName).toBe("Dr. John Smith");
    expect(resubmit.data.providerOrganizationId).toBe("org-2");
  });

  it("'create as new doctor' re-submits with just confirmNewDoctor", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          providerOrganizationId: "org-2",
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-confirm-candidate")).toBeTruthy();
    });

    // The FormSheet primary action ("Create as new doctor") is form-save.
    await fireEvent.press(screen.getByTestId("form-save"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(2);
    });
    const resubmit = mockCreateCaseMutateAsync.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(resubmit.data.confirmNewDoctor).toBe(true);
    // Keeps the bound practice + extracted doctor name, not a candidate.
    expect(resubmit.data.doctorName).toBe("Dr. Synthetic063");
    expect(resubmit.data.providerOrganizationId).toBe(BOUND_ORG_ID);
  });
});

/**
 * Tests for the required "doctor not on file" resolution step that runs BEFORE
 * createCase. When the scanned doctor name does NOT strictly match an on-file
 * doctor for the selected lab+practice, handleSubmit must open the resolution
 * sheet and block case creation until the user resolves it. This is the new
 * client-side gate; the server 409 remains the authoritative backstop.
 */
describe("AiReaderExtractedScreen — doctor resolution (not on file)", () => {
  /**
   * The resolve gate reads `doctorResolveQuery` (a `useQuery` keyed on
   * "doctor-resolve"), which is stubbed in vitest.setup. Seed its result via
   * `setMockAppState({ doctorResolve })` — no exact match + one fuzzy
   * suggestion means the scanned name is not on file.
   */
  const NON_EXACT_RESOLVE = {
    exactMatch: null,
    similarMatches: [
      {
        doctorName: "Dr. John Smith",
        providerOrganizationId: BOUND_ORG_ID,
        similarity: 0.6,
        totalCases: 4,
      },
    ],
    canAddNew: true,
  };

  it("blocks createCase and opens the resolution sheet when the scanned name is not on file", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    setMockAppState({ doctorResolve: NON_EXACT_RESOLVE });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-resolve-candidate")).toBeTruthy();
    });
    // The case must NOT have been created — the gate blocks it.
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalledWith(
      "Couldn't create case",
      expect.anything(),
    );
  });

  it("'use existing doctor' adopts the candidate's spelling and re-submits with confirmNewDoctor", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    setMockAppState({ doctorResolve: NON_EXACT_RESOLVE });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-resolve-candidate")).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId("doctor-resolve-candidate"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    const submit = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submit.data.confirmNewDoctor).toBe(true);
    expect(submit.data.doctorName).toBe("Dr. John Smith");
    expect(submit.data.providerOrganizationId).toBe(BOUND_ORG_ID);
  });

  it("'add as new doctor' re-submits with the scanned name + confirmNewDoctor", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    setMockAppState({ doctorResolve: NON_EXACT_RESOLVE });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-resolve-candidate")).toBeTruthy();
    });

    // FormSheet primary action = "Add … as new doctor". The resolve sheet uses
    // testIDPrefix="doctor-resolve" so its save button doesn't collide with the
    // confirm sheet's form-save (both mount under the test Modal stub).
    await fireEvent.press(screen.getByTestId("doctor-resolve-save"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    const submit = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submit.data.confirmNewDoctor).toBe(true);
    // Keeps the scanned name + bound practice.
    expect(submit.data.doctorName).toBe("Dr. Synthetic063");
    expect(submit.data.providerOrganizationId).toBe(BOUND_ORG_ID);
  });
});

/**
 * Parity tests for the alias save/load flow on the AI-reader extracted screen.
 *
 * Invariants protected:
 *  - When GET /rx-practice-aliases returns found:true, providerOrgId is
 *    pre-populated from the saved alias (the existing installFetchHandler above
 *    already demonstrates this; these tests exercise it more directly via
 *    providerOrganizationId appearing in the createCase call).
 *  - When POST /rx-practice-aliases fails, Alert.alert is called and the
 *    case-creation flow is not disrupted (case was already created).
 */
describe("AiReaderExtractedScreen — alias parity", () => {
  it("uses the alias-resolved providerOrgId when submitting the case", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler();
    mockCreateCaseMutateAsync.mockResolvedValueOnce({
      ok: true,
      data: { id: "case-1" },
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    const submit = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // The alias resolved BOUND_ORG_ID; it must be threaded into the case.
    expect(submit.data.providerOrganizationId).toBe(BOUND_ORG_ID);
  });

  it("calls Alert.alert and does not crash when POST /rx-practice-aliases fails", async () => {
    seedEditableLab();
    seedExtracted();
    // Override the fetch handler so alias POST returns a non-ok response.
    setMockFetchHandler((url: string, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/rx-practice-aliases") && method === "POST") {
        return new Response(JSON.stringify({ error: "DB error" }), {
          status: 500,
        });
      }
      if (url.includes("/api/rx-practice-aliases") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: { found: true, providerOrganizationId: BOUND_ORG_ID },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cases/patient-similarity")) {
        return new Response(JSON.stringify({ data: { matches: [] } }), {
          status: 200,
        });
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: { exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    mockCreateCaseMutateAsync.mockResolvedValueOnce({
      ok: true,
      data: { id: "case-alias-fail" },
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    // Case must still be created.
    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    // Alias save failure must surface via Alert, not a silent swallow.
    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        "Couldn't save mapping",
        expect.any(String),
      );
    });
  });
});

describe("AiReaderExtractedScreen — doctor practice memory", () => {
  it("uses doctor memory before the Rx-name alias and shows the remembered affordance", async () => {
    seedEditableLab();
    setMockAppState({
      labProviders: [
        { id: BOUND_ORG_ID, name: "Bright Smile Dental" },
        { id: "org-remembered", name: "Remembered Practice" },
      ],
    });
    seedExtracted();
    const lookupCalls: string[] = [];
    setMockFetchHandler((url: string, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") lookupCalls.push(url);
      if (url.includes("/api/rx-doctor-practice-memory") && method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { found: true, providerOrganizationId: "org-remembered" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rx-practice-aliases") && method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { found: true, providerOrganizationId: BOUND_ORG_ID },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: { exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cases/patient-similarity")) {
        return new Response(JSON.stringify({ data: { matches: [] } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    mockCreateCaseMutateAsync.mockResolvedValueOnce({
      ok: true,
      data: { id: "case-memory" },
    });

    const screen = await renderAndPrepare();

    await waitFor(() => {
      expect(screen.getAllByText("Remembered Practice").length).toBeGreaterThan(0);
      expect(screen.getByTestId("practice-remembered-badge")).toBeTruthy();
    });
    expect(
      lookupCalls.some((url) => url.includes("/api/rx-practice-aliases")),
    ).toBe(false);

    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    const submit = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submit.data.providerOrganizationId).toBe("org-remembered");
  });

  it("falls back from memory to alias, then to fuzzy practice-name matching", async () => {
    seedEditableLab();
    seedExtracted();
    const calls: string[] = [];
    setMockFetchHandler((url: string) => {
      calls.push(url);
      if (url.includes("/api/rx-doctor-practice-memory")) {
        return new Response(
          JSON.stringify({ ok: true, data: { found: false, providerOrganizationId: null } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rx-practice-aliases")) {
        return new Response(
          JSON.stringify({ ok: true, data: { found: false, providerOrganizationId: null } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: { exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Change practice")).toBeTruthy(),
    );
    expect(screen.getAllByText("Bright Smile Dental").length).toBeGreaterThan(0);

    const memoryIndex = calls.findIndex((url) =>
      url.includes("/api/rx-doctor-practice-memory"),
    );
    const aliasIndex = calls.findIndex((url) =>
      url.includes("/api/rx-practice-aliases"),
    );
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(aliasIndex).toBeGreaterThan(memoryIndex);
  });

  it("teaches a changed practice for the current doctor", async () => {
    seedEditableLab();
    setMockAppState({
      labProviders: [
        { id: BOUND_ORG_ID, name: "Bright Smile Dental" },
        { id: "org-2", name: "Second Practice" },
      ],
    });
    seedExtracted();
    const postedBodies: Array<Record<string, unknown>> = [];
    setMockFetchHandler((url: string, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/rx-doctor-practice-memory") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: { found: true, providerOrganizationId: BOUND_ORG_ID },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rx-doctor-practice-memory") && method === "POST") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, data: { found: true } }), {
          status: 200,
        });
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: { exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Change practice")).toBeTruthy(),
    );
    expect(screen.getAllByText("Bright Smile Dental").length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByLabelText("Change practice"));
    await fireEvent.press(screen.getByText("Second Practice"));

    await waitFor(() => {
      expect(postedBodies).toContainEqual({
        labOrganizationId: "lab-1",
        doctorName: "Dr. Synthetic063",
        providerOrganizationId: "org-2",
      });
    });
  });

  it("identifies a near-duplicate doctor before practice selection and remembers both spellings", async () => {
    seedEditableLab();
    setMockAppState({
      labProviders: [
        { id: BOUND_ORG_ID, name: "Bright Smile Dental" },
        { id: "org-2", name: "Northside Dental" },
      ],
    });
    seedExtracted();
    const postedDoctorNames: string[] = [];
    setMockFetchHandler((url: string, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/rx-doctor-practice-memory") && method === "GET") {
        return new Response(
          JSON.stringify({ data: { found: false, providerOrganizationId: null } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rx-doctor-practice-memory") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { doctorName: string };
        postedDoctorNames.push(body.doctorName);
        return new Response(JSON.stringify({ ok: true, data: { found: true } }), {
          status: 200,
        });
      }
      if (url.includes("/api/rx-practice-aliases")) {
        return new Response(
          JSON.stringify({ data: { found: false, providerOrganizationId: null } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: {
              exactMatch: null,
              similarMatches: [
                {
                  doctorName: "Dr. John Smith",
                  providerOrganizationId: "org-2",
                  practiceName: "Northside Dental",
                  practiceAddressLine1: "10 Main St",
                  practiceCity: "Austin",
                  practiceState: "TX",
                  similarity: 0.9,
                  totalCases: 4,
                },
              ],
              canAddNew: true,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => {
      expect(screen.getByTestId("doctor-identify-pending")).toBeTruthy();
      expect(screen.getByTestId("doctor-identify-candidate")).toBeTruthy();
    });
    expect(screen.queryByText("Select a practice…")).toBeNull();

    await fireEvent.press(screen.getByTestId("doctor-identify-candidate"));
    await waitFor(() => {
      expect(postedDoctorNames).toEqual([
        "Dr. John Smith",
        "Dr. Synthetic063",
      ]);
      expect(screen.getByText("Northside Dental")).toBeTruthy();
    });
  });

  it("does not show a practice prompt while doctor-first resolution is still pending", async () => {
    seedEditableLab();
    seedExtracted();
    let releaseMemoryLookup!: () => void;
    const pendingMemoryLookup = new Promise<Response>((resolve) => {
      releaseMemoryLookup = () =>
        resolve(
          new Response(
            JSON.stringify({
              data: { found: false, providerOrganizationId: null },
            }),
            { status: 200 },
          ),
        );
    });
    setMockFetchHandler((url: string) => {
      if (url.includes("/api/rx-doctor-practice-memory")) {
        return pendingMemoryLookup;
      }
      if (url.includes("/api/rx-practice-aliases")) {
        return new Response(
          JSON.stringify({ data: { found: false, providerOrganizationId: null } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: {
              exactMatch: null,
              similarMatches: [
                {
                  doctorName: "Dr. John Smith",
                  providerOrganizationId: BOUND_ORG_ID,
                  practiceName: "Bright Smile Dental",
                  similarity: 0.9,
                  totalCases: 2,
                },
              ],
              canAddNew: true,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => {
      expect(screen.getByTestId("practice-resolution-pending")).toBeTruthy();
    });
    expect(screen.queryByText("Select a practice…")).toBeNull();

    await act(async () => {
      releaseMemoryLookup();
      await pendingMemoryLookup;
    });
    await waitFor(() => {
      expect(screen.getByTestId("doctor-identify-candidate")).toBeTruthy();
      expect(screen.getByTestId("doctor-identify-pending")).toBeTruthy();
    });
    expect(screen.queryByText("Select a practice…")).toBeNull();
  });

  it("serializes rapid practice changes so the last selection is saved last", async () => {
    seedEditableLab();
    setMockAppState({
      labProviders: [
        { id: BOUND_ORG_ID, name: "Bright Smile Dental" },
        { id: "org-2", name: "Second Practice" },
      ],
    });
    seedExtracted();
    const postedPracticeIds: string[] = [];
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<Response>((resolve) => {
      releaseFirstWrite = () =>
        resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    setMockFetchHandler((url: string, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/rx-doctor-practice-memory") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: { found: true, providerOrganizationId: BOUND_ORG_ID },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rx-doctor-practice-memory") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          providerOrganizationId: string;
        };
        postedPracticeIds.push(body.providerOrganizationId);
        if (body.providerOrganizationId === "org-2") return firstWrite;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/doctors/resolve-name")) {
        return new Response(
          JSON.stringify({
            data: { exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => {
      expect(screen.getByTestId("practice-remembered-badge")).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId("practice-option-org-2"));
    await fireEvent.press(screen.getByTestId(`practice-option-${BOUND_ORG_ID}`));
    await waitFor(() => {
      expect(postedPracticeIds).toEqual(["org-2"]);
    });

    await act(async () => {
      releaseFirstWrite();
      await firstWrite;
    });
    await waitFor(() => {
      expect(postedPracticeIds).toEqual(["org-2", BOUND_ORG_ID]);
    });
  });
});

describe("AiReaderExtractedScreen — review-time duplicate warning", () => {
  const duplicateHit = {
    id: "existing-case-1",
    source: "canonical",
    caseNumber: "25-14",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    doctorName: "Dr. Synthetic063",
    status: "in_progress",
    matchKind: "exact",
    createdAt: "2025-04-16T12:00:00.000Z",
    toothNumbers: null,
    restorationTypes: null,
  };

  it("shows a dated warning and still runs the final duplicate/remake check on submit", async () => {
    seedEditableLab();
    seedExtracted();
    let similarityRequests = 0;
    installFetchHandler(() => {
      similarityRequests++;
      return new Response(
        JSON.stringify({
          data: {
            matches: [
              { ...duplicateHit, createdAt: "2024-02-10T12:00:00.000Z" },
              duplicateHit,
            ],
          },
        }),
        { status: 200 },
      );
    });

    const screen = await renderAndPrepare();
    await waitFor(() => {
      expect(screen.getByTestId("early-duplicate-warning")).toBeTruthy();
      expect(screen.getByText("Possible duplicate case from 4/16/2025.")).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => {
      expect(screen.getByText("Similar patient found")).toBeTruthy();
      expect(
        screen.getAllByText("#25-14 · Dr. Synthetic063 · in_progress").length,
      ).toBeGreaterThan(0);
    });
    // The warning lookup is not reused as confirmation: submit makes its own
    // request and opens the existing three-way duplicate decision.
    expect(similarityRequests).toBeGreaterThanOrEqual(2);
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
  });

  it("clears the warning when edited patient details no longer match", async () => {
    seedEditableLab();
    seedExtracted();
    const requestedLastNames: string[] = [];
    installFetchHandler((url) => {
      const lastName = new URL(url, "http://localhost").searchParams.get(
        "patientLastName",
      );
      if (lastName) requestedLastNames.push(lastName);
      const matches = lastName === "Doe" ? [duplicateHit] : [];
      return new Response(JSON.stringify({ data: { matches } }), {
        status: 200,
      });
    });

    const screen = await renderAndPrepare();
    await waitFor(() =>
      expect(screen.getByTestId("early-duplicate-warning")).toBeTruthy(),
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("Last"),
      "Jones",
    );
    expect(screen.queryByTestId("early-duplicate-warning")).toBeNull();
    await waitFor(() => {
      expect(requestedLastNames).toContain("Jones");
      expect(screen.queryByTestId("early-duplicate-warning")).toBeNull();
    });
  });

  it("ignores a slow lookup response after the patient inputs change", async () => {
    seedEditableLab();
    seedExtracted();
    let releaseOldLookup!: (response: Response) => void;
    let markOldLookupStarted!: () => void;
    const oldLookupStarted = new Promise<void>((resolve) => {
      markOldLookupStarted = resolve;
    });
    const oldLookupResponse = new Promise<Response>((resolve) => {
      releaseOldLookup = resolve;
    });
    const requestedLastNames: string[] = [];
    installFetchHandler((url) => {
      const lastName = new URL(url, "http://localhost").searchParams.get(
        "patientLastName",
      );
      if (lastName) requestedLastNames.push(lastName);
      if (lastName === "Doe") {
        markOldLookupStarted();
        return oldLookupResponse;
      }
      return new Response(JSON.stringify({ data: { matches: [] } }), {
        status: 200,
      });
    });

    const screen = await renderAndPrepare();
    await act(async () => {
      await oldLookupStarted;
    });

    await fireEvent.changeText(
      screen.getByPlaceholderText("Last"),
      "Jones",
    );
    await waitFor(() => expect(requestedLastNames).toContain("Jones"));

    await act(async () => {
      releaseOldLookup(
        new Response(JSON.stringify({ data: { matches: [duplicateHit] } }), {
          status: 200,
        }),
      );
      await oldLookupResponse;
    });
    expect(screen.queryByTestId("early-duplicate-warning")).toBeNull();
  });

  it("shows a matching-case warning even when the case has no usable date", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler(
      () =>
        new Response(
          JSON.stringify({
            data: { matches: [{ ...duplicateHit, createdAt: null }] },
          }),
          { status: 200 },
        ),
    );

    const screen = await renderAndPrepare();
    await waitFor(() => {
      expect(screen.getByTestId("early-duplicate-warning")).toBeTruthy();
      expect(screen.getByText("Possible duplicate case found.")).toBeTruthy();
    });
  });

  it("allows case creation when the early lookup fails", async () => {
    seedEditableLab();
    seedExtracted();
    installFetchHandler(() => {
      throw new Error("temporary network failure");
    });

    const screen = await renderAndPrepare();
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("early-duplicate-warning")).toBeNull();
  });
});
