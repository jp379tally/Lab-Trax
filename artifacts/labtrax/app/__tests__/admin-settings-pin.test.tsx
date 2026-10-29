import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mocks = vi.hoisted(() => ({
  pathname: "/settings/users",
  userId: "admin-1",
  role: "admin",
  userType: "lab",
  authenticated: true,
  authLoading: false,
  meLoading: false,
  mutateAsync: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("expo-router", async () => {
  const ReactModule = await import("react");
  const ReactNative = await import("react-native");
  return {
    Stack: () =>
      ReactModule.createElement(
        ReactNative.Text,
        { testID: "protected-settings-screen" },
        "Protected settings destination",
      ),
    router: { replace: mocks.replace },
    usePathname: () => mocks.pathname,
  };
});

vi.mock("react-native-keyboard-controller", async () => {
  const ReactModule = await import("react");
  const ReactNative = await import("react-native");
  return {
    KeyboardAvoidingView: ({ children, ...props }: any) =>
      ReactModule.createElement(ReactNative.View, props, children),
  };
});

vi.mock("@workspace/api-client-react", () => ({
  useVerifyAdminPin: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    currentUserId: mocks.userId,
    userType: mocks.userType,
    isAuthenticated: mocks.authenticated,
    isAuthLoading: mocks.authLoading,
  }),
}));

vi.mock("@/lib/auth-me", () => ({
  useMe: () => ({
    data: { user: { role: mocks.role } },
    isLoading: mocks.meLoading,
  }),
}));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      backgroundSolid: "#fff",
      surface: "#fff",
      surfaceAlt: "#f4f4f5",
      border: "#ddd",
      text: "#111",
      textSecondary: "#555",
      textTertiary: "#777",
      tint: "#2563eb",
      error: "#dc2626",
    },
  }),
}));

import SettingsLayout from "../settings/_layout";
import {
  clearAdminSettingsPin,
  isAdminSettingsPath,
} from "@/lib/admin-settings-pin";

describe("mobile admin settings PIN gate", () => {
  beforeEach(() => {
    clearAdminSettingsPin();
    mocks.pathname = "/settings/users";
    mocks.userId = "admin-1";
    mocks.role = "admin";
    mocks.userType = "lab";
    mocks.authenticated = true;
    mocks.authLoading = false;
    mocks.meLoading = false;
    mocks.mutateAsync.mockReset();
    mocks.replace.mockReset();
  });

  it("guards admin destinations opened directly, including query-string entries", () => {
    expect(isAdminSettingsPath("/settings/users")).toBe(true);
    expect(isAdminSettingsPath("/settings/invoice-layout?tab=direct")).toBe(true);
    expect(isAdminSettingsPath("/settings/profile")).toBe(false);
    expect(isAdminSettingsPath("/settings/desktop")).toBe(false);
  });

  it("submits once as soon as four numeric digits are entered and reveals the destination only after success", async () => {
    mocks.mutateAsync.mockResolvedValue({ ok: true });
    const rendered = await render(<SettingsLayout />);

    expect(rendered.queryByTestId("protected-settings-screen")).toBeNull();
    fireEvent.changeText(rendered.getByTestId("admin-settings-pin"), "12a34");

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({ data: { pin: "1234" } }),
    );
    await waitFor(() =>
      expect(rendered.getByTestId("protected-settings-screen")).toBeTruthy(),
    );
  });

  it("keeps direct routes hidden after an incorrect PIN", async () => {
    mocks.mutateAsync.mockRejectedValue({ status: 403 });
    const rendered = await render(<SettingsLayout />);
    fireEvent.changeText(rendered.getByTestId("admin-settings-pin"), "4321");

    expect(await rendered.findByTestId("admin-settings-pin-error")).toBeTruthy();
    expect(rendered.queryByTestId("protected-settings-screen")).toBeNull();
  });

  it("relocks previously protected routes when the in-memory session gate is cleared", async () => {
    mocks.mutateAsync.mockResolvedValue({ ok: true });
    const rendered = await render(<SettingsLayout />);
    fireEvent.changeText(rendered.getByTestId("admin-settings-pin"), "1234");
    await waitFor(() =>
      expect(rendered.getByTestId("protected-settings-screen")).toBeTruthy(),
    );

    await act(async () => {
      clearAdminSettingsPin();
    });

    expect(rendered.queryByTestId("protected-settings-screen")).toBeNull();
    expect(rendered.getByTestId("admin-settings-pin")).toBeTruthy();
  });

  it("does not render a protected route for a non-admin", async () => {
    mocks.role = "user";
    const rendered = await render(<SettingsLayout />);

    expect(rendered.queryByTestId("protected-settings-screen")).toBeNull();
    expect(rendered.getByText("Admin access required")).toBeTruthy();
  });
});
