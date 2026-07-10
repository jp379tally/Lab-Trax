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
      doctorName: "Dr. Smith",
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
    },
  });
}

/**
 * Alias resolve binds providerOrgId to BOUND_ORG_ID; patient-similarity returns
 * no matches so the first submit proceeds straight to createCase.
 */
function installFetchHandler() {
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
      return new Response(JSON.stringify({ data: { matches: [] } }), {
        status: 200,
      });
    }
    // The scanned "Dr. Smith" strict-matches an on-file doctor, so the new
    // resolution gate passes straight through to createCase (which then
    // exercises the server 409 DOCTOR_CONFIRMATION_REQUIRED backstop below).
    if (url.includes("/api/doctors/resolve-name")) {
      return new Response(
        JSON.stringify({
          data: {
            exactMatch: "Dr. Smith",
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
  const screen = render(<AiReaderExtractedScreen />);
  // Let the alias-resolve effect bind providerOrgId.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "26-42");
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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-confirm-candidate")).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId("doctor-confirm-candidate"));

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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-confirm-candidate")).toBeTruthy();
    });

    // The FormSheet primary action ("Create as new doctor") is form-save.
    fireEvent.press(screen.getByTestId("form-save"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(2);
    });
    const resubmit = mockCreateCaseMutateAsync.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(resubmit.data.confirmNewDoctor).toBe(true);
    // Keeps the bound practice + extracted doctor name, not a candidate.
    expect(resubmit.data.doctorName).toBe("Dr. Smith");
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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-resolve-candidate")).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId("doctor-resolve-candidate"));

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
    fireEvent.press(screen.getByTestId("ai-reader-create-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("doctor-resolve-candidate")).toBeTruthy();
    });

    // FormSheet primary action = "Add … as new doctor". The resolve sheet uses
    // testIDPrefix="doctor-resolve" so its save button doesn't collide with the
    // confirm sheet's form-save (both mount under the test Modal stub).
    fireEvent.press(screen.getByTestId("doctor-resolve-save"));

    await waitFor(() => {
      expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    const submit = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submit.data.confirmNewDoctor).toBe(true);
    // Keeps the scanned name + bound practice.
    expect(submit.data.doctorName).toBe("Dr. Smith");
    expect(submit.data.providerOrganizationId).toBe(BOUND_ORG_ID);
  });
});
