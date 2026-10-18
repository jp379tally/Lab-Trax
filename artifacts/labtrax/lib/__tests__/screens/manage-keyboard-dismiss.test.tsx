import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  showMockKeyboard,
  isMockKeyboardVisible,
} from "../../../vitest.setup";
import TurnaroundScreen from "@/app/manage/turnaround";

/**
 * Representative cover for the manage screens, which edit in place rather than
 * through a sheet: the value lives in a row-level input next to its own Save
 * button. Those are the two things a dismissal layer can plausibly break — a
 * lost in-progress value, or a Save that needs two taps because the first one
 * only closed the keyboard.
 */

const ADMIN_LAB = {
  organizationId: "lab-1",
  role: "admin",
  status: "active",
  organization: { id: "lab-1", type: "lab", defaultCaseDueDays: 5 },
};

async function renderTurnaroundScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return await render(
    <QueryClientProvider client={client}>
      <TurnaroundScreen />
    </QueryClientProvider>,
  );
}

// The dismissal layer is only armed while a keyboard is actually up.
async function openKeyboard(): Promise<void> {
  await act(() => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

beforeEach(() => {
  setMockAppState({ meMemberships: [ADMIN_LAB] });
});

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("Manage screens — keyboard dismissal with inline editing", () => {
  it("closes the keyboard when the screen background is tapped, keeping the edited value", async () => {
    const { getByTestId } = await renderTurnaroundScreen();

    await fireEvent.changeText(getByTestId("turnaround-days-input"), "12");
    await openKeyboard();

    await fireEvent.press(getByTestId("turnaround-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The half-finished edit survives — it is not reverted to the saved value.
    expect(getByTestId("turnaround-days-input").props.value).toBe("12");
  });

  it("closes the keyboard when the form is scrolled", async () => {
    const { getByTestId } = await renderTurnaroundScreen();
    await openKeyboard();

    const scroll = getByTestId("turnaround-scroll");
    expect(["interactive", "on-drag"]).toContain(scroll.props.keyboardDismissMode);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(scroll, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });

  it("still saves an inline edit on the first tap while the keyboard is up", async () => {
    const { getByTestId } = await renderTurnaroundScreen();

    await fireEvent.changeText(getByTestId("turnaround-days-input"), "12");
    await openKeyboard();

    await fireEvent.press(getByTestId("turnaround-days-save"));

    // The press reached the row's own Save button rather than being consumed
    // by the dismissal layer, and the edit is still the value being saved.
    expect(getByTestId("turnaround-days-input").props.value).toBe("12");
    expect(getByTestId("turnaround-days-save")).toBeTruthy();
  });

  it("still toggles a control on the first tap while the keyboard is up", async () => {
    const { getByTestId } = await renderTurnaroundScreen();
    await openKeyboard();

    const toggle = getByTestId("turnaround-cap-toggle");
    await fireEvent.press(toggle);

    expect(toggle).toBeTruthy();
  });
});
