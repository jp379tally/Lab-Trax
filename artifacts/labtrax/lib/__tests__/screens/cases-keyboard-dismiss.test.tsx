import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  resetMockFetchHandler,
  showMockKeyboard,
  isMockKeyboardVisible,
  lastUseCasesParams,
} from "../../../vitest.setup";
import CasesListScreen from "@/app/(tabs)/index";
import { completedCaseWithInvoice, inProgressCase } from "./__fixtures__/cases";

// Regression cover for the Cases search keyboard, which previously had no
// reliable way out: the chrome ignored taps, the list did not dismiss on drag,
// and every visible row navigated away instead of closing the keyboard.

async function renderCasesScreen() {
  const screen = await render(<CasesListScreen />);
  await act(async () => undefined);
  await waitFor(() => expect(screen.getByTestId("cases-search")).toBeTruthy());
  return screen;
}

// The dismissal layer is only armed while a keyboard is actually up, so every
// case here opens one first.
async function openKeyboard(): Promise<void> {
  await act(async () => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

beforeEach(() => {
  setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
});

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CasesListScreen — keyboard dismissal", () => {
  it("closes the keyboard when the screen chrome is tapped, keeping the search text", async () => {
    const { getByTestId } = await renderCasesScreen();

    await fireEvent.changeText(getByTestId("cases-search"), "newman");
    await waitFor(() => {
      expect(lastUseCasesParams()).toMatchObject({ search: "newman" });
    });
    await openKeyboard();

    await fireEvent.press(getByTestId("cases-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The typed term and the search it drives both survive the dismissal.
    expect(getByTestId("cases-search").props.value).toBe("newman");
    expect(lastUseCasesParams()).toMatchObject({ search: "newman" });
  });

  it("keeps an active filter applied when the chrome is tapped", async () => {
    const { getByTestId } = await renderCasesScreen();

    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));
    await waitFor(() => {
      expect(lastUseCasesParams()).toMatchObject({ conflictsOnly: true });
    });
    await openKeyboard();

    await fireEvent.press(getByTestId("cases-keyboard-dismiss"));

    expect(isMockKeyboardVisible()).toBe(false);
    expect(lastUseCasesParams()).toMatchObject({ conflictsOnly: true });
  });

  it("closes the keyboard when the results list is dragged", async () => {
    const { getByTestId } = await renderCasesScreen();
    await openKeyboard();

    const list = getByTestId("cases-list");
    expect(["interactive", "on-drag"]).toContain(list.props.keyboardDismissMode);
    await fireEvent(list, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });

  it("closes the keyboard when the Search key is pressed, leaving the search applied", async () => {
    const { getByTestId } = await renderCasesScreen();

    await fireEvent.changeText(getByTestId("cases-search"), "newman");
    await waitFor(() => {
      expect(lastUseCasesParams()).toMatchObject({ search: "newman" });
    });
    await openKeyboard();

    await fireEvent(getByTestId("cases-search"), "submitEditing");

    expect(isMockKeyboardVisible()).toBe(false);
    expect(getByTestId("cases-search").props.value).toBe("newman");
    expect(lastUseCasesParams()).toMatchObject({ search: "newman" });
  });

  it("closes the keyboard from the barcode filter's Search key", async () => {
    const { getByTestId } = await renderCasesScreen();

    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await openKeyboard();

    await fireEvent(getByTestId("cases-barcode-filter-input"), "submitEditing");

    expect(isMockKeyboardVisible()).toBe(false);
    expect(getByTestId("cases-barcode-filter-input")).toBeTruthy();
  });

  it("still opens a case on the first row tap while the keyboard is up", async () => {
    const { getByTestId } = await renderCasesScreen();
    await openKeyboard();

    await fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(`/case/${inProgressCase.id}`);
  });

  it("still applies a filter chip on the first tap while the keyboard is up", async () => {
    const { getByTestId } = await renderCasesScreen();
    await openKeyboard();

    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    await waitFor(() => {
      expect(lastUseCasesParams()).toMatchObject({ conflictsOnly: true });
    });
  });
});
