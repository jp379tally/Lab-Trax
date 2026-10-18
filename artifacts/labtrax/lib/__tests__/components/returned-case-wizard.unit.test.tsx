/**
 * Unit tests for <ReturnedCaseWizard/>.
 *
 * The wizard is fully controlled — the parent owns `stage` — so these tests
 * drive it through a tiny host that mirrors what the case-detail screen does.
 * That makes the assertions about ORDER real: the host only ever applies the
 * stage the wizard asks for.
 *
 * vitest.setup.ts already mocks react-native, safe-area-context, vector-icons,
 * theme-context, @tanstack/react-query and @workspace/api-client-react, so no
 * extra module mocks are needed here.
 */
import React, { useState } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  mockAddCaseNoteMutateAsync,
  mockUpdateCaseMutateAsync,
} from "../../../vitest.setup";
import { ReturnedCaseWizard } from "@/components/ReturnedCaseWizard";
import {
  firstReturnedWizardStage,
  type ReturnedWizardStage,
} from "@/lib/returned-case-wizard";

const CASE_ID = "case-abc";

type HostProps = {
  canChangeStep?: boolean;
  onScanPrescription?: () => void;
  onStartRemake?: () => void;
  onPrintLabSlip?: () => void;
  onPrintCaseLabel?: () => void;
};

/** Mirrors the case-detail screen: owns the stage, starts at the first one. */
function Host({
  canChangeStep = true,
  onScanPrescription = () => undefined,
  onStartRemake = () => undefined,
  onPrintLabSlip = () => undefined,
  onPrintCaseLabel = () => undefined,
}: HostProps) {
  const [stage, setStage] = useState<ReturnedWizardStage | null>(() =>
    firstReturnedWizardStage({ canChangeStep }),
  );
  return (
    <ReturnedCaseWizard
      caseId={CASE_ID}
      stage={stage}
      canChangeStep={canChangeStep}
      currentStep={null}
      onStageChange={setStage}
      onScanPrescription={onScanPrescription}
      onStartRemake={onStartRemake}
      onPrintLabSlip={onPrintLabSlip}
      onPrintCaseLabel={onPrintCaseLabel}
    />
  );
}

function titleOf(utils: Awaited<ReturnType<typeof render>>): string {
  return String(utils.getByTestId("returned-wizard-title").props.children);
}

beforeEach(() => {
  mockUpdateCaseMutateAsync.mockClear();
  mockAddCaseNoteMutateAsync.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReturnedCaseWizard — visibility", () => {
  it("renders nothing when there is no active stage", async () => {
    const utils = await render(
      <ReturnedCaseWizard
        caseId={CASE_ID}
        stage={null}
        canChangeStep
        onStageChange={() => undefined}
        onScanPrescription={() => undefined}
        onStartRemake={() => undefined}
        onPrintLabSlip={() => undefined}
        onPrintCaseLabel={() => undefined}
      />,
    );
    // A non-returning locate never sets a stage, so nothing must render.
    expect(utils.queryByTestId("returned-case-wizard")).toBeNull();
  });

  it("opens on the due-date question", async () => {
    const utils = await render(<Host />);
    expect(titleOf(utils)).toBe("Set a new due date?");
  });
});

describe("ReturnedCaseWizard — answering No", () => {
  it("walks every question in order and closes after the last one", async () => {
    const utils = await render(<Host />);
    const expected = [
      "Set a new due date?",
      "Scan a new prescription?",
      "Is this case a remake?",
      "Is this a removable case?",
      "Would you like to add any notes?",
      "Print a new lab slip?",
      "Print a new case label?",
    ];
    for (const title of expected) {
      expect(titleOf(utils)).toBe(title);
      await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    }
    expect(utils.queryByTestId("returned-case-wizard")).toBeNull();
    // "No" is never a write.
    expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
    expect(mockAddCaseNoteMutateAsync).not.toHaveBeenCalled();
  });

  it("skips the removable question when the viewer cannot change the step", async () => {
    const utils = await render(<Host canChangeStep={false} />);
    const expected = [
      "Set a new due date?",
      "Scan a new prescription?",
      "Is this case a remake?",
      "Would you like to add any notes?",
      "Print a new lab slip?",
      "Print a new case label?",
    ];
    for (const title of expected) {
      expect(titleOf(utils)).toBe(title);
      await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    }
    expect(utils.queryByTestId("returned-case-wizard")).toBeNull();
  });
});

describe("ReturnedCaseWizard — answering Yes", () => {
  it("saves a typed due date in another year through the normal update path", async () => {
    const utils = await render(<Host />);
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date-type"));
    await fireEvent.changeText(utils.getByTestId("returned-wizard-due-date-typed-input"), "02/29/2028");
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date-typed-confirm"));
    await act(async () => { await fireEvent.press(utils.getByTestId("returned-wizard-due-date-save")); });
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: CASE_ID, data: { dueDate: "2028-02-29" },
    });
  });

  it("saves a new due date and moves on to the prescription question", async () => {
    const utils = await render(<Host />);
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));

    // The calendar sheet is DateField's own modal; pick the 15th of the month.
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date-day-15"));
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-due-date-save"));
    });

    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
    });
    // The shared spy is typed as zero-arg, so read the recorded call loosely.
    const arg = (mockUpdateCaseMutateAsync.mock.calls[0] as unknown[])[0] as {
      caseId: string;
      data: { dueDate?: string };
    };
    expect(arg.caseId).toBe(CASE_ID);
    expect(arg.data.dueDate).toMatch(/^\d{4}-\d{2}-15$/);
    await waitFor(() => expect(titleOf(utils)).toBe("Scan a new prescription?"));
  });

  it("hands the prescription question to the AI reader", async () => {
    const onScanPrescription = vi.fn();
    const utils = await render(<Host onScanPrescription={onScanPrescription} />);
    await fireEvent.press(utils.getByTestId("returned-wizard-no")); // skip due date
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    expect(onScanPrescription).toHaveBeenCalledTimes(1);
    // The wizard does NOT advance itself here — the host parks the next stage
    // and navigates, then resumes the wizard when the reader returns.
    expect(titleOf(utils)).toBe("Scan a new prescription?");
  });

  it("hands the remake question to the remake protocol", async () => {
    const onStartRemake = vi.fn();
    const utils = await render(<Host onStartRemake={onStartRemake} />);
    await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    expect(titleOf(utils)).toBe("Is this case a remake?");
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    expect(onStartRemake).toHaveBeenCalledTimes(1);
  });

  it("saves the chosen removable step and continues to the notes question", async () => {
    const utils = await render(<Host />);
    for (let i = 0; i < 3; i++) await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    expect(titleOf(utils)).toBe("Is this a removable case?");
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-step-wax_setup"));
    });
    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: CASE_ID,
        data: { step: "wax_setup" },
      });
    });
    await waitFor(() => expect(titleOf(utils)).toBe("Would you like to add any notes?"));
  });

  it("saves a lab-internal note and continues to the print questions", async () => {
    const utils = await render(<Host />);
    for (let i = 0; i < 4; i++) await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    expect(titleOf(utils)).toBe("Would you like to add any notes?");
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await fireEvent.changeText(utils.getByTestId("returned-wizard-note-input"), "Patient returned it");
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-note-save"));
    });
    await waitFor(() => {
      expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
        caseId: CASE_ID,
        data: { noteText: "Patient returned it", visibility: "internal_lab_only" },
      });
    });
    await waitFor(() => expect(titleOf(utils)).toBe("Print a new lab slip?"));
  });

  it("runs each print action and finishes", async () => {
    const onPrintLabSlip = vi.fn();
    const onPrintCaseLabel = vi.fn();
    const utils = await render(
      <Host onPrintLabSlip={onPrintLabSlip} onPrintCaseLabel={onPrintCaseLabel} />,
    );
    for (let i = 0; i < 5; i++) await fireEvent.press(utils.getByTestId("returned-wizard-no"));
    expect(titleOf(utils)).toBe("Print a new lab slip?");
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    });
    expect(onPrintLabSlip).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(titleOf(utils)).toBe("Print a new case label?"));
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    });
    expect(onPrintCaseLabel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(utils.queryByTestId("returned-case-wizard")).toBeNull());
  });
});

describe("ReturnedCaseWizard — dismissal", () => {
  it("keeps prior answers and skips the rest of the questions", async () => {
    const utils = await render(<Host />);
    // Answer the first question, then dismiss on the second.
    await fireEvent.press(utils.getByTestId("returned-wizard-yes"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date"));
    await fireEvent.press(utils.getByTestId("returned-wizard-due-date-day-15"));
    await act(async () => {
      await fireEvent.press(utils.getByTestId("returned-wizard-due-date-save"));
    });
    await waitFor(() => expect(titleOf(utils)).toBe("Scan a new prescription?"));

    await fireEvent.press(utils.getByTestId("returned-wizard-dismiss"));

    expect(utils.queryByTestId("returned-case-wizard")).toBeNull();
    // The due date it already saved stays saved; nothing else is written.
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockAddCaseNoteMutateAsync).not.toHaveBeenCalled();
  });
});
