import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import {
  resetMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../../vitest.setup";

import TwoFactorScreen from "@/app/settings/two-factor";

const DEVICE = {
  id: "dev-1",
  deviceName: "Ada's iPhone",
  userAgent: "LabTrax/1.0 (iPhone; iOS)",
  ipAddress: "203.0.113.7",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: null,
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

function mockHandler(devices: unknown[], onDelete?: (url: string) => void) {
  setMockFetchHandler((url, init) => {
    if (url.includes("/api/auth/2fa/status")) {
      return new Response(JSON.stringify({ data: { twoFactorEnabled: true } }), {
        status: 200,
      });
    }
    if (url.includes("/api/auth/2fa/trusted-devices/") && init?.method === "DELETE") {
      onDelete?.(url);
      return new Response(JSON.stringify({ data: { success: true } }), { status: 200 });
    }
    if (url.includes("/api/auth/2fa/trusted-devices")) {
      return new Response(JSON.stringify({ data: { devices } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("TwoFactorScreen — remembered devices section", () => {
  it("renders a remembered-device row and signs it out via DELETE", async () => {
    let deletedUrl: string | null = null;
    mockHandler([DEVICE], (url) => {
      deletedUrl = url;
    });

    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    try {
      const { getByText } = render(<TwoFactorScreen />);

      // The device row appears once status (enabled) + device list resolve.
      await waitFor(() => {
        expect(getByText("Ada's iPhone")).toBeTruthy();
      });

      // Pressing "Sign out" asks for confirmation rather than deleting outright.
      fireEvent.press(getByText("Sign out"));
      expect(alertSpy).toHaveBeenCalled();

      // Invoke the destructive action from the confirm dialog.
      const buttons = alertSpy.mock.calls[0][2];
      const signOut = buttons?.find((b) => b.style === "destructive");
      expect(signOut).toBeTruthy();
      await signOut?.onPress?.();

      await waitFor(() => {
        expect(deletedUrl).toContain(`/api/auth/2fa/trusted-devices/${DEVICE.id}`);
      });
    } finally {
      alertSpy.mockRestore();
    }
  });

  it("shows the empty state when there are no remembered devices", async () => {
    mockHandler([]);

    const { getByText } = render(<TwoFactorScreen />);

    await waitFor(() => {
      expect(getByText(/No remembered devices/i)).toBeTruthy();
    });
  });
});
