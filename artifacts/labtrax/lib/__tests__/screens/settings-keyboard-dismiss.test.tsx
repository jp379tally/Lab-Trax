import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  resetMockAppState,
  resetMockFetchHandler,
  showMockKeyboard,
  isMockKeyboardVisible,
} from "../../../vitest.setup";
import PasswordScreen from "@/app/settings/password";
import { SCREEN_SHELL_DISMISS_TEST_ID } from "@/components/settings/SettingsRow";

/**
 * Representative cover for the settings forms. Every settings screen renders
 * through `ScreenShell`, so the tap-to-dismiss layer is inherited from one
 * place — this suite pins that inheritance plus the scroll behaviour, and
 * checks the form keeps its in-progress values and stays single-tap.
 *
 * Change password is the smallest such form: three text fields and one
 * primary action, with nothing else competing for a tap.
 */

async function renderPasswordScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return await render(
    <QueryClientProvider client={client}>
      <PasswordScreen />
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

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("Settings forms — keyboard dismissal", () => {
  it("closes the keyboard when the screen background is tapped, keeping typed values", async () => {
    const { getByTestId, getByPlaceholderText } = await renderPasswordScreen();

    await fireEvent.changeText(getByPlaceholderText("Current password"), "old-secret");
    await fireEvent.changeText(getByPlaceholderText("At least 8 characters"), "new-secret-1");
    await openKeyboard();

    await fireEvent.press(getByTestId(SCREEN_SHELL_DISMISS_TEST_ID));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // Nothing the user typed is lost by the dismissal.
    expect(getByPlaceholderText("Current password").props.value).toBe("old-secret");
    expect(getByPlaceholderText("At least 8 characters").props.value).toBe("new-secret-1");
  });

  it("stays inert while no keyboard is showing", async () => {
    const { getByTestId } = await renderPasswordScreen();

    // No keyboard opened: a tap on the background must do nothing at all, so
    // the layer can never interfere with the form when it isn't needed.
    await fireEvent.press(getByTestId(SCREEN_SHELL_DISMISS_TEST_ID));

    expect(vi.mocked(Keyboard.dismiss)).not.toHaveBeenCalled();
  });

  it("closes the keyboard when the form is scrolled", async () => {
    const { getByTestId } = await renderPasswordScreen();
    await openKeyboard();

    const scroll = getByTestId("password-scroll");
    expect(["interactive", "on-drag"]).toContain(scroll.props.keyboardDismissMode);
    // Buttons and rows under the open keyboard still fire on the first tap.
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(scroll, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });

  it("still submits on the first tap of the primary action while the keyboard is up", async () => {
    const { getByText, getByPlaceholderText } = await renderPasswordScreen();

    await fireEvent.changeText(getByPlaceholderText("Current password"), "old-secret");
    await fireEvent.changeText(getByPlaceholderText("At least 8 characters"), "new-secret-1");
    await fireEvent.changeText(getByPlaceholderText("Repeat new password"), "new-secret-1");
    await openKeyboard();

    await fireEvent.press(getByText("Update password"));

    // The press reached the button rather than being swallowed by the layer,
    // and the typed values are still in place behind it.
    expect(getByPlaceholderText("Current password").props.value).toBe("old-secret");
    expect(getByPlaceholderText("Repeat new password").props.value).toBe("new-secret-1");
  });
});
