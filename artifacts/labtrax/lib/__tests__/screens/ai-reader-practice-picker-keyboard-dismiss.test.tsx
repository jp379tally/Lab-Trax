import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  isMockKeyboardVisible,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockSearchParams,
  showMockKeyboard,
} from "../../../vitest.setup";
import {
  clearAiReaderSession,
  getAiReaderSession,
  setAiReaderSession,
  type ExtractedRx,
} from "@/lib/ai-reader-store";

/**
 * The practice picker is a `<Modal>` inside an already-wrapped screen, which is
 * the one shape the screen's own dismissal layer cannot cover: a modal renders
 * in its own touch tree, so a tap inside it never reaches a layer outside it.
 * The sheet therefore carries its own layer, and this suite is the runtime
 * proof of that — the repo gate only proves the JSX contains one.
 */

const LAB_MEMBERSHIP = {
  organizationId: "lab-picker",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

const EXTRACTED: ExtractedRx = {
  doctorName: "Dr. Jane Smith",
  patientName: "Ann Lee",
  patientInitials: "AL",
  caseType: "Crown & Bridge",
  toothIndices: "14",
  shade: "A2",
  material: "Zirconia",
  dueDate: null,
  isRush: false,
  notes: null,
  practiceName: null,
  practiceAddress: null,
  practicePhone: null,
  confidence: 0.9,
  step: null,
  gingivialShade: null,
};

const PRACTICES = [
  { id: "prov-1", name: "Northside Dental", displayName: "Northside Dental" },
  { id: "prov-2", name: "Harbor Smile Studio", displayName: "Harbor Smile Studio" },
];

async function renderExtractedScreen() {
  const ExtractedScreen = (await import("@/app/ai-reader/extracted")).default;
  const utils = await render(<ExtractedScreen />);
  // The screen resolves the doctor/practice in an async effect before it can
  // offer the picker.
  await act(async () => undefined);
  await waitFor(() => expect(utils.getByText("Select a practice…")).toBeTruthy());
  return utils;
}

/** Open the practice picker the way a user does, from the Doctor / Practice row. */
async function openPracticePicker(
  utils: Awaited<ReturnType<typeof renderExtractedScreen>>,
) {
  await act(async () => {
    await fireEvent.press(utils.getByText("Select a practice…"));
  });
  return utils.getByTestId("practice-picker-search");
}

beforeEach(() => {
  clearAiReaderSession();
  setAiReaderSession({ extracted: EXTRACTED });
  setMockSearchParams({});
  setMockAppState({ meMemberships: [LAB_MEMBERSHIP], labProviders: PRACTICES });
});

afterEach(() => {
  cleanup();
  clearAiReaderSession();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("AI reader — practice picker keyboard dismissal", () => {
  it("keeps a typed Rx due-date correction as a user override", async () => {
    const utils = await renderExtractedScreen();
    // A manually corrected prescription date must survive a re-scan.
    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date"));
    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date-type"));
    await fireEvent.changeText(
      utils.getByTestId("ai-reader-rx-due-date-typed-input"),
      "02/29/2028",
    );
    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date-typed-confirm"));
    expect(getAiReaderSession().userOverrides?.rxDueDate).toBe("2028-02-29");
  });

  it("keeps an edited Rx date separate from the lab turnaround schedule", async () => {
    setMockAppState({
      meMemberships: [{
        ...LAB_MEMBERSHIP,
        organization: { type: "lab", defaultCaseDueDays: 7 },
      }],
      labProviders: PRACTICES,
    });
    setAiReaderSession({ userOverrides: { receivedAt: "2026-08-01" } });
    const utils = await renderExtractedScreen();
    expect(utils.getByText("08/08/2026")).toBeTruthy();

    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date"));
    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date-type"));
    await fireEvent.changeText(
      utils.getByTestId("ai-reader-rx-due-date-typed-input"),
      "08/05/2026",
    );
    await fireEvent.press(utils.getByTestId("ai-reader-rx-due-date-typed-confirm"));

    expect(utils.getByText("08/08/2026")).toBeTruthy();
    expect(getAiReaderSession().userOverrides?.rxDueDate).toBe("2026-08-05");
    expect(getAiReaderSession().userOverrides?.labDueDate).toBeUndefined();
  });

  it("closes the keyboard when the picker sheet is tapped, keeping the filter text", async () => {
    const utils = await renderExtractedScreen();
    const filter = await openPracticePicker(utils);

    await fireEvent.changeText(filter, "harbor");
    await act(() => {
      showMockKeyboard();
    });
    expect(isMockKeyboardVisible()).toBe(true);

    await fireEvent.press(utils.getByTestId("practice-picker-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The tap only closed the keyboard: the sheet stays open on what was typed.
    expect(utils.getByTestId("practice-picker-search").props.value).toBe("harbor");
  });

  it("stays inert while no keyboard is showing, so the sheet still works normally", async () => {
    const utils = await renderExtractedScreen();
    await openPracticePicker(utils);

    await fireEvent.press(utils.getByTestId("practice-picker-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).not.toHaveBeenCalled();
    // A practice is still one tap away underneath the layer. Selecting one
    // remembers it for the doctor in the background, so the press has to
    // settle inside act.
    await act(async () => {
      await fireEvent.press(utils.getByTestId("practice-option-prov-2"));
    });
    // The Doctor / Practice row now shows a resolved practice, which only
    // happens once the row's press actually landed.
    expect(utils.getByLabelText("Change practice")).toBeTruthy();
  });

  it("dismisses on a drag of the practice list too", async () => {
    const utils = await renderExtractedScreen();
    await openPracticePicker(utils);
    await act(() => {
      showMockKeyboard();
    });

    const list = utils.getByTestId("practice-picker-list");
    expect(["interactive", "on-drag"]).toContain(list.props.keyboardDismissMode);
    // Rows under an open keyboard must still take the first tap.
    expect(list.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(list, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });
});
