import React, { useState } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  mockAddCaseNoteMutateAsync,
  mockUpdateCaseMutateAsync,
  showMockKeyboard,
  isMockKeyboardVisible,
} from "../../../vitest.setup";
import { ReturnedCaseWizard } from "@/components/ReturnedCaseWizard";
import {
  firstReturnedWizardStage,
  type ReturnedWizardStage,
} from "@/lib/returned-case-wizard";

/**
 * The returned-case wizard is the third risky surface of the tap-to-dismiss
 * rollout, and the only one that dismisses across multi-step navigation: the
 * same sheet re-renders as a new question while the keyboard stays up. So this
 * suite checks the dismissal both within a step (tap closes the keyboard, the
 * typed answer survives, the wizard does not close behind it) and across steps
 * (each answer is still written while the keyboard is open the whole way).
 *
 * vitest.setup.ts already mocks react-native, theme-context, react-query and
 * @workspace/api-client-react, so no extra module mocks are needed here.
 */

const CASE_ID = "case-abc";

/** Mirrors the case-detail screen: owns the stage, starts at the first one. */
function Host() {
  const [stage, setStage] = useState<ReturnedWizardStage | null>(() =>
    firstReturnedWizardStage({ canChangeStep: true }),
  );
  return (
    <ReturnedCaseWizard
      caseId={CASE_ID}
      stage={stage}
      canChangeStep
      currentStep={null}
      onStageChange={setStage}
      onScanPrescription={() => undefined}
      onStartRemake={() => undefined}
      onPrintLabSlip={() => undefined}
      onPrintCaseLabel={() => undefined}
    />
  );
}

function titleOf(utils: Awaited<Awaited<ReturnType<typeof render>>>): string {
  return String(utils.getByTestId("returned-wizard-title").props.children);
}

/** Answers "No" until the wizard reaches the notes question. */
async function skipToNotes(utils: Awaited<Awaited<ReturnType<typeof render>>>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await fireEvent.press(utils.getByTestId("returned-wizard-no"));
  }
  expect(titleOf(utils)).toBe("Would you like to add any notes?");
}

// The dismissal layer is only armed while a keyboard is actually up.
async function openKeyboard(): Promise<void> {
  await act(() => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

beforeEach(() => {
  mockUpdateCaseMutateAsync.mockClear();
  mockAddCaseNoteMutateAsync.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReturnedCaseWizard — keyboard dismissal", () => {
  it("closes the keyboard on a tap inside the sheet without closing the wizard", async () => {
    const utils = await render(<Host />);
    await skipToNotes(utils);
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));

    await fireEvent.changeText(
      utils.getByTestId("returned-wizard-note-input"),
      "Patient returned it",
    );
    await openKeyboard();

    await fireEvent.press(utils.getByTestId("returned-case-wizard-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The sheet sits on a backdrop that closes the wizard: the tap that closes
    // the keyboard must stop at the sheet, with the answer still in the field.
    expect(utils.queryByTestId("returned-case-wizard")).not.toBeNull();
    expect(titleOf(utils)).toBe("Would you like to add any notes?");
    expect(utils.getByTestId("returned-wizard-note-input").props.value).toBe(
      "Patient returned it",
    );
    expect(mockAddCaseNoteMutateAsync).not.toHaveBeenCalled();
  });

  it("stays inert while no keyboard is showing", async () => {
    const utils = await render(<Host />);

    await fireEvent.press(utils.getByTestId("returned-case-wizard-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).not.toHaveBeenCalled();
    expect(utils.queryByTestId("returned-case-wizard")).not.toBeNull();
  });

  it("leaves the backdrop closing the wizard, exactly as before", async () => {
    const utils = await render(<Host />);
    await openKeyboard();

    await fireEvent.press(utils.getByLabelText("Dismiss"));

    expect(utils.queryByTestId("returned-case-wizard")).toBeNull();
  });

  it("still saves the answer on the FIRST tap while the keyboard is open", async () => {
    const utils = await render(<Host />);
    await skipToNotes(utils);
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));

    await fireEvent.changeText(
      utils.getByTestId("returned-wizard-note-input"),
      "Patient returned it",
    );
    await openKeyboard();

    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-note-save"));
    });

    // One tap, one write, carrying exactly what was typed.
    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
      caseId: CASE_ID,
      data: { noteText: "Patient returned it", visibility: "internal_lab_only" },
    });
    await waitFor(() => expect(titleOf(utils)).toBe("Print a new lab slip?"));
  });

  it("advances one question per tap while the keyboard is open", async () => {
    const utils = await render(<Host />);
    await openKeyboard();

    await fireEvent.press(utils.getByTestId("returned-wizard-no"));

    // Not swallowed (still on the first question) and not doubled (skipping a
    // question the user never answered).
    expect(titleOf(utils)).toBe("Scan a new prescription?");
    expect(isMockKeyboardVisible()).toBe(true);
  });

  it("keeps every answer when moving between steps with the keyboard open", async () => {
    const utils = await render(<Host />);
    await openKeyboard();

    // Step one: a new due date, answered with the keyboard up.
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date-day-15"));
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-due-date-save"));
    });

    await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1));
    const dueDateCall = (mockUpdateCaseMutateAsync.mock.calls[0] as unknown[])[0] as {
      caseId: string;
      data: { dueDate?: string };
    };
    expect(dueDateCall.caseId).toBe(CASE_ID);
    expect(dueDateCall.data.dueDate).toMatch(/^\d{4}-\d{2}-15$/);
    await waitFor(() => expect(titleOf(utils)).toBe("Scan a new prescription?"));

    // Cross two more questions, still with the keyboard up.
    await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    expect(titleOf(utils)).toBe("Is this a removable case?");

    // Step two: a workflow step, chosen on the first tap.
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    const stepList = utils.getByTestId("returned-wizard-step-list");
    expect(["interactive", "on-drag"]).toContain(stepList.props.keyboardDismissMode);
    expect(stepList.props.keyboardShouldPersistTaps).toBe("handled");
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-step-wax_setup"));
    });
    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenLastCalledWith({
        caseId: CASE_ID,
        data: { step: "wax_setup" },
      });
    });
    await waitFor(() => expect(titleOf(utils)).toBe("Would you like to add any notes?"));

    // Step three: a note typed after the navigation, saved intact.
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await fireEvent.changeText(
      utils.getByTestId("returned-wizard-note-input"),
      "Patient returned it",
    );
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-note-save"));
    });

    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
      caseId: CASE_ID,
      data: { noteText: "Patient returned it", visibility: "internal_lab_only" },
    });
    // Three answers given, three answers written: none lost in a transition,
    // and none re-sent by one.
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledTimes(1);
  });
});
