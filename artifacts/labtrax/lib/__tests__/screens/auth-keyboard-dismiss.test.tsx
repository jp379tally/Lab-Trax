import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Keyboard, StyleSheet } from "react-native";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  showMockKeyboard,
  isMockKeyboardVisible,
  flushPendingReactUpdates,
} from "../../../vitest.setup";
import LoginScreen from "@/components/LoginScreen";
import LockScreen from "@/components/LockScreen";

/**
 * The two doors into the app: sign-in and the lock screen.
 *
 * They are the highest-consequence surfaces of the tap-to-dismiss rollout.
 * Everywhere else a swallowed first tap is an annoyance; here it locks the
 * user out, because Sign In and Unlock are the only ways forward and both sit
 * directly under an open keyboard. So each screen is checked for both halves:
 * a background tap closes the keyboard without losing what was typed, and the
 * primary action still fires on the FIRST tap with the keyboard up.
 */

// Stable auth doubles — the screens read these from `useAuth()` on every
// render, so they must keep their identity across re-renders.
const authMock = vi.hoisted(() => ({
  login: vi.fn(async (_id: string, _password: string, _remember?: boolean) => ({
    success: true as boolean,
  })),
  unlockWithPassword: vi.fn((_password: string) => ({ success: true as const })),
  unlockWithBiometric: vi.fn(async () => ({ success: true as const })),
  logout: vi.fn(),
}));

// Not mocked in the shared setup, and LoginScreen imports it at module load.
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
  getCurrentPositionAsync: vi.fn(async () => ({
    coords: { latitude: 0, longitude: 0 },
  })),
  reverseGeocodeAsync: vi.fn(async () => []),
  Accuracy: { Balanced: 3 },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

// Widen the shared auth mock: the lock screen needs the unlock calls, sign-in
// needs the login calls.
vi.mock("@/lib/auth-context", () => {
  const auth = {
    currentUser: "dr.smith",
    userType: "lab",
    registeredUsers: [],
    isAuthenticated: false,
    accessToken: null,
    login: authMock.login,
    logout: authMock.logout,
    completeTwoFactor: vi.fn(),
    loginWithBiometric: vi.fn(),
    register: vi.fn(),
    unlockWithPassword: authMock.unlockWithPassword,
    unlockWithBiometric: authMock.unlockWithBiometric,
  };
  return {
    useAuth: () => auth,
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      children as React.ReactElement,
  };
});

// The dismissal layer is only armed while a keyboard is actually up.
async function openKeyboard(): Promise<void> {
  await act(async () => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sign-in screen — keyboard dismissal", () => {
  // Both screens probe the biometric hardware on mount; drain that before the
  // body runs so the resolution can't land outside act().
  async function renderSignIn() {
    const screen = await render(<LoginScreen />);
    await flushPendingReactUpdates();
    return screen;
  }

  it("closes the keyboard on a background tap, keeping the typed credentials", async () => {
    const { getByTestId } = await renderSignIn();

    await fireEvent.changeText(getByTestId("login-username"), "dr.smith");
    await fireEvent.changeText(getByTestId("login-password"), "s3cret-pw");
    await openKeyboard();

    await fireEvent.press(getByTestId("login-screen-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // Credentials survive the dismissal, so nobody has to retype them.
    expect(getByTestId("login-username").props.value).toBe("dr.smith");
    expect(getByTestId("login-password").props.value).toBe("s3cret-pw");
    // And the tap that closed the keyboard never doubles as a sign-in attempt.
    expect(authMock.login).not.toHaveBeenCalled();
  });

  it("stays inert while no keyboard is showing", async () => {
    const { getByTestId } = await renderSignIn();

    await fireEvent.press(getByTestId("login-screen-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).not.toHaveBeenCalled();
  });

  it("closes the keyboard when the form is dragged", async () => {
    const { getByTestId } = await renderSignIn();
    await openKeyboard();

    const scroll = getByTestId("login-scroll");
    expect(["interactive", "on-drag"]).toContain(scroll.props.keyboardDismissMode);
    // Sign In sits under the keyboard: taps must reach it, not be eaten by the
    // scroll view's own dismissal.
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(scroll, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });

  it("still signs in on the FIRST tap while the keyboard is open", async () => {
    const { getByTestId } = await renderSignIn();

    await fireEvent.changeText(getByTestId("login-username"), "dr.smith");
    await fireEvent.changeText(getByTestId("login-password"), "s3cret-pw");
    await openKeyboard();

    await act(async () => {
      await fireEvent.press(getByTestId("login-submit"));
    });

    // One tap, one sign-in, with exactly what was typed.
    expect(authMock.login).toHaveBeenCalledTimes(1);
    expect(authMock.login).toHaveBeenCalledWith("dr.smith", "s3cret-pw", true);
  });
});

describe("mobile sign-in presentation", () => {
  async function renderSignIn() {
    const screen = await render(<LoginScreen />);
    await flushPendingReactUpdates();
    return screen;
  }

  it("shows the compact brand header and sign-in card with an accessible password toggle", async () => {
    const { getByTestId } = await renderSignIn();

    expect(getByTestId("login-brand-header")).toBeTruthy();
    expect(getByTestId("login-card")).toBeTruthy();
    const scroll = getByTestId("login-scroll");
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(["interactive", "on-drag"]).toContain(
      scroll.props.keyboardDismissMode,
    );
    expect(StyleSheet.flatten(getByTestId("login-brand-header").props.style)).toMatchObject({
      paddingTop: 79,
    });
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      paddingBottom: 54,
    });

    const password = getByTestId("login-password");
    expect(password.props.secureTextEntry).toBe(true);
    expect(getByTestId("login-toggle-password").props.accessibilityLabel).toBe("Show password");
    await fireEvent.press(getByTestId("login-toggle-password"));
    expect(getByTestId("login-password").props.secureTextEntry).toBe(false);
    expect(getByTestId("login-toggle-password").props.accessibilityLabel).toBe("Hide password");

    await fireEvent.press(getByTestId("remember-me-toggle"));
    expect(getByTestId("remember-me-toggle").props.accessibilityState).toEqual({ checked: false });
  });

  it("announces a failed sign-in without removing the current credential fields", async () => {
    authMock.login.mockImplementation(async () => ({
      success: false,
      error: "Invalid username or password.",
    }));
    const { getByTestId, getByText } = await renderSignIn();

    await fireEvent.changeText(getByTestId("login-username"), "dr.smith");
    await fireEvent.changeText(getByTestId("login-password"), "incorrect");
    await fireEvent.press(getByTestId("login-submit"));

    await waitFor(() => expect(getByText("Invalid username or password.")).toBeTruthy());
    expect(getByTestId("login-username").props.value).toBe("dr.smith");
    expect(getByTestId("login-password").props.value).toBe("incorrect");
  });

  it("keeps both username and password recovery entry points available", async () => {
    const { getByText } = await renderSignIn();

    await fireEvent.press(getByText("Forgot password?"));
    expect(getByText("Forgot Password")).toBeTruthy();
  });

  it("opens the username recovery flow from the sign-in card", async () => {
    const { getByText } = await renderSignIn();

    await fireEvent.press(getByText("Forgot username?"));
    expect(getByText("Forgot Username")).toBeTruthy();
  });
});

describe("Lock screen — keyboard dismissal", () => {
  async function renderLock() {
    const screen = await render(<LockScreen />);
    await flushPendingReactUpdates();
    // The password field is the lock screen's only text entry, and it is
    // behind "Use Password".
    await fireEvent.press(screen.getByText("Use Password"));
    return screen;
  }

  it("closes the keyboard on a background tap, keeping the entered passcode", async () => {
    const { getByTestId, getByPlaceholderText } = await renderLock();

    await fireEvent.changeText(getByPlaceholderText("Enter your password"), "8317-open");
    await openKeyboard();

    await fireEvent.press(getByTestId("lock-screen-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    expect(getByPlaceholderText("Enter your password").props.value).toBe("8317-open");
    // The dismissal tap neither tries the passcode nor hits "Sign Out" behind
    // it — both would be worse than a stuck keyboard.
    expect(authMock.unlockWithPassword).not.toHaveBeenCalled();
    expect(authMock.logout).not.toHaveBeenCalled();
  });

  it("stays inert while no keyboard is showing", async () => {
    const { getByTestId } = await renderLock();

    await fireEvent.press(getByTestId("lock-screen-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).not.toHaveBeenCalled();
  });

  it("still unlocks on the FIRST tap while the keyboard is open", async () => {
    const { getByText, getByPlaceholderText } = await renderLock();

    await fireEvent.changeText(getByPlaceholderText("Enter your password"), "8317-open");
    await openKeyboard();

    await fireEvent.press(getByText("Unlock"));

    expect(authMock.unlockWithPassword).toHaveBeenCalledTimes(1);
    expect(authMock.unlockWithPassword).toHaveBeenCalledWith("8317-open");
  });

  it("unlocks from the return key with the keyboard open", async () => {
    const { getByPlaceholderText } = await renderLock();

    await fireEvent.changeText(getByPlaceholderText("Enter your password"), "8317-open");
    await openKeyboard();

    // The other way out of this keyboard: submitting the field unlocks rather
    // than doing nothing. (The stub does not emulate the keyboard closing on
    // submit, so only the unlock itself is asserted here.)
    await fireEvent(getByPlaceholderText("Enter your password"), "submitEditing");

    expect(authMock.unlockWithPassword).toHaveBeenCalledTimes(1);
    expect(authMock.unlockWithPassword).toHaveBeenCalledWith("8317-open");
  });
});
