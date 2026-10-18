/**
 * Smoke test: doctor name SuggestionInput shows all past doctors on focus,
 * and switches to the live-search dropdown once ≥2 characters are typed.
 *
 * Invariants protected:
 *  - Focusing the doctor field always shows ALL past-doctor suggestions
 *    regardless of what text is already in the field (e.g. pre-filled by AI).
 *  - Typing AFTER focus narrows the list to matching names only.
 *  - Re-focusing after typing resets the filter and shows all suggestions again.
 *  - Typing ≥2 characters hides the past-doctor list and shows the live-search
 *    panel (loading indicator or "No matching doctors" message).
 *  - Blurring the doctor field without picking a suggestion preserves the
 *    AI-pre-filled value and does NOT accidentally bind a providerOrgId.
 *
 * This pins the filterText-reset-on-focus contract in SuggestionInput so a
 * future refactor of the doctor field to a different component can't silently
 * revert the "full list on focus" behaviour.
 */

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

import NewCaseScreen from "@/app/new-case";

afterEach(() => {
  cleanup();
  resetMockAppState();
});

/**
 * Seed an editable lab with several past doctors so we can assert that ALL
 * of them appear when the doctor field is focused.
 */
function seedLabWithMultipleDoctors() {
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
        doctorName: "Dr. Alpha Example",
        providerOrganizationId: "org-alice",
        patientFirstName: "Pat",
        patientLastName: "One",
      },
      {
        id: "c2",
        doctorName: "Dr. Bravo Example",
        providerOrganizationId: "org-bob",
        patientFirstName: "Pat",
        patientLastName: "Two",
      },
      {
        id: "c3",
        doctorName: "Dr. Carol Chen",
        providerOrganizationId: "org-carol",
        patientFirstName: "Pat",
        patientLastName: "Three",
      },
    ],
  });
}

describe("NewCaseScreen — doctor field focus shows all past doctors", () => {
  it("shows all past-doctor suggestions when the field is focused with an empty value", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");

    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-1")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-2")).toBeTruthy();
    });
  });

  it("shows all past-doctor suggestions when focused even if AI has pre-filled the field", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Simulate AI pre-filling the doctor name (a name that matches only one
    // of the three seeded doctors).
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "Dr. Alpha Example");

    // Focus without any further typing — all suggestions must appear because
    // SuggestionInput resets filterText to "" on focus.
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");

    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-1")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-2")).toBeTruthy();
    });
  });

  it("narrows suggestions when the user types a single character after focusing", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Focus first (shows all three).
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });

    // User types "b" (1 char, so still < 2-char live-search threshold).
    // Only "Dr. Bravo Example" contains "b" — the other two do not.
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "b");

    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
      expect(screen.queryByTestId("past-doctor-result-1")).toBeNull();
    });
  });

  it("restores the full suggestion list when the field is re-focused after typing", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // First focus + type "b" to narrow (1 char, stays in past-doctor mode).
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "b");
    await waitFor(() => {
      // Only 1 result now (Dr. Bravo Example).
      expect(screen.queryByTestId("past-doctor-result-1")).toBeNull();
    });

    // Blur, then re-focus — doctorTypedSinceFocus resets, full list returns.
    await fireEvent(screen.getByTestId("new-case-doctor"), "blur");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");

    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-1")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-2")).toBeTruthy();
    });
  });
});

describe("NewCaseScreen — live-search dropdown fires after ≥2 chars typed since focus", () => {
  it("shows the live-search panel (no results message) when ≥2 chars are typed after focus", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Focus the doctor field — past-doctor list appears.
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });

    // Type 2 characters — crosses the live-search threshold.
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "Dr");

    await waitFor(() => {
      // Live-search panel must render.  The mock returns no entries by default,
      // so the "No matching doctors." empty-state text is the expected signal.
      expect(screen.getByText("No matching doctors.")).toBeTruthy();
    });
  });

  it("hides the past-doctor list once ≥2 chars are typed since focus", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Focus — past-doctor list is visible.
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });

    // Type 2 characters — switches mode.
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "Dr");

    await waitFor(() => {
      // Past-doctor items must disappear.
      expect(screen.queryByTestId("past-doctor-result-0")).toBeNull();
      expect(screen.queryByTestId("past-doctor-result-1")).toBeNull();
      expect(screen.queryByTestId("past-doctor-result-2")).toBeNull();
    });
  });

  it("switches back to past-doctor list after re-focus clears doctorTypedSinceFocus", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Focus → type ≥2 chars → live-search panel active.
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() => {
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "Dr");
    await waitFor(() => {
      expect(screen.getByText("No matching doctors.")).toBeTruthy();
    });

    // Blur then re-focus — doctorTypedSinceFocus resets to "", live-search
    // panel disappears and the past-doctor list comes back.
    await fireEvent(screen.getByTestId("new-case-doctor"), "blur");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");

    await waitFor(() => {
      expect(screen.queryByText("No matching doctors.")).toBeNull();
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-1")).toBeTruthy();
      expect(screen.getByTestId("past-doctor-result-2")).toBeTruthy();
    });
  });

  it("shows the live-search panel when typing ≥2 chars even with no past doctors seeded", async () => {
    // No cases seeded → no past-doctor suggestions.  The live-search path
    // must still activate when the threshold is crossed.
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
    });

    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    // No past-doctor items to assert (none seeded).

    // Type ≥2 chars — live-search panel must appear.
    await fireEvent.changeText(screen.getByTestId("new-case-doctor"), "Dr");

    await waitFor(() => {
      expect(screen.getByText("No matching doctors.")).toBeTruthy();
    });
  });
});

describe("NewCaseScreen — AI pre-filled doctor name survives focus/blur without a pick", () => {
  /**
   * Regression: when AI pre-fills the doctor field, the user may tap the
   * field to browse past-doctor suggestions, decide the AI was correct, and
   * tap away without selecting anything.  The field must still display the
   * AI-supplied name and providerOrgId must remain null (no accidental bind).
   */
  it("retains the AI-pre-filled name after the user focuses then blurs without picking", async () => {
    seedLabWithMultipleDoctors();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const doctorInput = screen.getByTestId("new-case-doctor");

    // Simulate AI writing a doctor name into the field.
    await fireEvent.changeText(doctorInput, "Dr. Alpha Example");

    // User opens the dropdown by focusing…
    await fireEvent(doctorInput, "focus");
    await waitFor(() => {
      // Dropdown is visible — all three past doctors appear.
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy();
    });

    // …then taps away without selecting any suggestion.
    await fireEvent(doctorInput, "blur");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // The displayed value must still be the AI-filled name.
    expect(doctorInput.props.value).toBe("Dr. Alpha Example");

    // No "Linked to …" badge — providerOrgId must still be null.
    expect(screen.queryByText(/Linked to/)).toBeNull();
  });
});
