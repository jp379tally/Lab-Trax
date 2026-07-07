/**
 * Regression tests for the doctor-confirmation flow on new-case.tsx.
 *
 * The server returns 409 DOCTOR_CONFIRMATION_REQUIRED when the typed doctor
 * name closely matches an existing doctor in the practice. The screen must open
 * a confirmation sheet (candidates + typed name) instead of the dead-end
 * "Couldn't create case" alert. These tests pin that contract so a future
 * refactor of submitCase / handleUseExistingDoctor / handleKeepNewDoctor can't
 * silently revert it.
 *
 * Invariants protected:
 *  - A 409 with details.code === "DOCTOR_CONFIRMATION_REQUIRED" opens the
 *    confirmation state (renders the candidate rows) and does NOT show the
 *    generic error alert.
 *  - Any other error still shows the generic "Couldn't create case" alert and
 *    never opens the confirmation state.
 *  - "Use existing doctor" re-submits with confirmNewDoctor:true and the
 *    candidate's doctorName / providerOrganizationId.
 *  - "Create as new doctor" re-submits with just confirmNewDoctor:true.
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
  mockCreateCaseMutateAsync,
} from "../../vitest.setup";

import NewCaseScreen from "@/app/new-case";

const ORG_ID = "org-1";

/**
 * Seed an editable lab plus one existing case so the "past doctor" dropdown has
 * a selectable row (which binds providerOrganizationId — required to submit).
 */
function seedEditableLabWithDoctor() {
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
    cases: [
      {
        id: "c1",
        doctorName: "Dr. Smith",
        providerOrganizationId: ORG_ID,
        patientFirstName: "Jane",
        patientLastName: "Doe",
      },
    ],
  });
}

/** Fill the required fields and bind a doctor via the past-doctor dropdown. */
async function fillFormAndSelectDoctor(screen: ReturnType<typeof render>) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  fireEvent.changeText(screen.getByTestId("new-case-number"), "26-42");
  fireEvent.changeText(screen.getByTestId("new-case-patient-first"), "John");
  fireEvent.changeText(screen.getByTestId("new-case-patient-last"), "Roe");

  // Focus (no typing) surfaces the past-doctor dropdown built from seeded cases.
  fireEvent(screen.getByTestId("new-case-doctor"), "focus");
  await waitFor(() => {
    expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
  });
  fireEvent.press(screen.getByTestId("past-doctor-result-0"));
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
  vi.clearAllMocks();
});

describe("NewCaseScreen — doctor confirmation", () => {
  it("opens the confirmation sheet (not the generic alert) on a 409 DOCTOR_CONFIRMATION_REQUIRED", async () => {
    seedEditableLabWithDoctor();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          providerOrganizationId: ORG_ID,
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = render(<NewCaseScreen />);
    await fillFormAndSelectDoctor(screen);

    fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => {
      expect(screen.getAllByTestId("doctor-confirm-candidate")).toHaveLength(1);
    });
    expect(screen.getByText(/looks similar to/i)).toBeTruthy();
    // The dead-end alert must NOT fire.
    expect(Alert.alert).not.toHaveBeenCalledWith(
      "Couldn't create case",
      expect.anything(),
    );
  });

  it("shows the generic alert and does NOT open the confirmation sheet on a non-409 error", async () => {
    seedEditableLabWithDoctor();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw { status: 500, data: { details: { code: "INTERNAL" } } };
    });

    const screen = render(<NewCaseScreen />);
    await fillFormAndSelectDoctor(screen);

    fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        "Couldn't create case",
        expect.anything(),
      );
    });
    expect(screen.queryByTestId("doctor-confirm-candidate")).toBeNull();
  });

  it("'use existing doctor' re-submits with confirmNewDoctor and the candidate's doctorName/providerOrganizationId", async () => {
    seedEditableLabWithDoctor();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          providerOrganizationId: ORG_ID,
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = render(<NewCaseScreen />);
    await fillFormAndSelectDoctor(screen);
    fireEvent.press(screen.getByTestId("new-case-save"));

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
    expect(resubmit.data.providerOrganizationId).toBe(ORG_ID);
  });

  it("'create as new doctor' re-submits with just confirmNewDoctor", async () => {
    seedEditableLabWithDoctor();
    mockCreateCaseMutateAsync.mockImplementationOnce(async () => {
      throw doctorConfirm409([
        {
          doctorName: "Dr. John Smith",
          providerOrganizationId: ORG_ID,
          similarity: 0.9,
          totalCases: 3,
        },
      ]);
    });

    const screen = render(<NewCaseScreen />);
    await fillFormAndSelectDoctor(screen);
    fireEvent.press(screen.getByTestId("new-case-save"));

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
    // Keeps the originally-typed/bound doctor, not a candidate.
    expect(resubmit.data.doctorName).toBe("Dr. Smith");
    expect(resubmit.data.providerOrganizationId).toBe(ORG_ID);
  });
});
