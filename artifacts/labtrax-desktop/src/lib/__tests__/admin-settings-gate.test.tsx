/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminSettingsPinGate, requiresAdminSettingsPin } from "@/lib/admin-settings-gate";
import { clearSessionSecret, getSessionSecret } from "@/lib/platform-admin-session";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useVerifyAdminPin: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
}));

describe("desktop admin settings PIN gate", () => {
  beforeEach(() => {
    clearSessionSecret();
    mocks.mutateAsync.mockReset();
  });

  afterEach(() => {
    clearSessionSecret();
  });

  it("gates admin-only panels but not personal settings", () => {
    expect(requiresAdminSettingsPin("backup", true)).toBe(true);
    expect(requiresAdminSettingsPin("invoice-layout", true)).toBe(true);
    expect(requiresAdminSettingsPin("platform-admin", true)).toBe(true);
    expect(requiresAdminSettingsPin("profile", true)).toBe(false);
    expect(requiresAdminSettingsPin("password", true)).toBe(false);
    expect(requiresAdminSettingsPin("sessions", true)).toBe(false);
    expect(requiresAdminSettingsPin("notifications", true)).toBe(false);
  });

  it("does not expand access to owners or other non-admin users", () => {
    expect(requiresAdminSettingsPin("backup", false)).toBe(false);
    expect(requiresAdminSettingsPin("permission-outline", false)).toBe(false);
  });

  it("automatically verifies four numeric digits and keeps the PIN in memory after success", async () => {
    mocks.mutateAsync.mockResolvedValue({ ok: true });
    render(<AdminSettingsPinGate />);

    fireEvent.change(screen.getByTestId("admin-settings-pin"), {
      target: { value: "12a34" },
    });

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({ data: { pin: "1234" } }),
    );
    await waitFor(() => expect(getSessionSecret()).toBe("1234"));
  });

  it("shows a clear error and leaves the settings PIN unset after failure", async () => {
    mocks.mutateAsync.mockRejectedValue({ status: 403 });
    render(<AdminSettingsPinGate />);

    fireEvent.change(screen.getByTestId("admin-settings-pin"), {
      target: { value: "4321" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN");
    expect(getSessionSecret()).toBeNull();
  });

  it("does not submit a completed PIN repeatedly while verification is pending", async () => {
    let resolveRequest!: (value: unknown) => void;
    mocks.mutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<AdminSettingsPinGate />);
    const input = screen.getByTestId("admin-settings-pin");

    fireEvent.change(input, { target: { value: "1234" } });
    fireEvent.change(input, { target: { value: "1234" } });

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    resolveRequest({ ok: true });
    await waitFor(() => expect(getSessionSecret()).toBe("1234"));

    clearSessionSecret();
    expect(getSessionSecret()).toBeNull();
  });
});
