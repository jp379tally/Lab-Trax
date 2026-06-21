/**
 * Regression guard for the mobile ProfileScreen phone-verification UX.
 *
 * Mirrors the behaviour tested in
 * `artifacts/labtrax-desktop/src/pages/__tests__/settings-profile-phone.test.tsx`
 * for the mobile (Expo) profile edit screen.
 *
 * The key failure mode protected here:
 *   When the user saves their profile with a changed phone number and the
 *   PUT /auth/users/:id/profile request rejects (network error, 422, etc.),
 *   the OTP verification panel must NOT appear and the profile-level error
 *   must be surfaced (via Alert.alert on mobile) instead.
 *
 * Strategy:
 *   - @tanstack/react-query is re-mocked in this file to give full control
 *     over useQuery (returns the seeded user) and useMutation (runs the
 *     actual mutationFn so we can observe real state transitions).
 *   - @/lib/theme-context is stubbed with light-mode colours so the screen
 *     renders without a ThemeProvider in the test tree.
 *   - resilientFetch is driven by setMockFetchHandler from vitest.setup.ts.
 *   - Alert from react-native is the vi.fn() from the project stub, so we
 *     can assert it was called with the expected message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import ProfileScreen from "../settings/profile";
import {
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../vitest.setup";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const UNVERIFIED_PHONE_USER = {
  id: "user-phone-test-mobile-1",
  username: "phonetest",
  firstName: "Test",
  lastName: "User",
  role: "admin",
  phone: "555-123-4567",
  phoneVerifiedAt: null,
  email: "test@example.com",
  practiceName: null,
  platformAccountNumber: null,
  workStatus: null,
  profilePhotoUrl: null,
  practiceOrganizationId: null,
  practiceLogoUrl: null,
  practiceLogoplacements: null,
  practiceLogoSize: null,
};

// ---------------------------------------------------------------------------
// Module mocks — override the global vitest.setup.ts mocks for this file
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();

  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: { user: UNVERIFIED_PHONE_USER },
      isLoading: false,
      isError: false,
    })),
    // Simple mutation shim: invokes mutationFn and routes to onSuccess/onError.
    // Each render creates a fresh shim capturing the latest opts closure so
    // state changes (e.g. phone input) are visible to the mutationFn.
    useMutation: vi.fn((opts: {
      mutationFn: () => Promise<unknown>;
      onSuccess?: () => Promise<void> | void;
      onError?: (err: Error) => void;
    }) => {
      const execute = vi.fn(async () => {
        try {
          await opts.mutationFn();
          await opts.onSuccess?.();
        } catch (err) {
          opts.onError?.(err as Error);
        }
      });
      return {
        mutate: execute,
        mutateAsync: execute,
        isPending: false,
        isError: false,
        isSuccess: false,
        reset: vi.fn(),
      };
    }),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(async () => undefined),
      setQueryData: vi.fn(),
      getQueryData: vi.fn(() => undefined),
    })),
  };
});

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      text: "#111827",
      textSecondary: "#6B7280",
      textTertiary: "#9CA3AF",
      tint: "#007AFF",
      border: "#E5E7EB",
      surface: "#FFFFFF",
      surfaceAlt: "#F9FAFB",
      background: "#F3F4F6",
      backgroundSolid: "#FFFFFF",
      error: "#EF4444",
      success: "#10B981",
    },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderProfile() {
  return render(<ProfileScreen />);
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonFail(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(Alert.alert).mockClear();
  resetMockFetchHandler();
});

afterEach(() => {
  resetMockFetchHandler();
});

// ---------------------------------------------------------------------------
// Suite: auto-save OTP path — PUT failure guard
// ---------------------------------------------------------------------------

describe("ProfileScreen — OTP panel absent when PUT profile rejects", () => {
  it("shows Alert with the server error and does NOT open the OTP panel when PUT rejects", async () => {
    renderProfile();

    // Wait for the form to be populated from the seeded user.
    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Set up the fetch handler: PUT /profile returns a 422 error body.
    setMockFetchHandler((url) => {
      if (url.includes("/profile")) {
        return jsonFail({ error: "Validation failed" });
      }
      return jsonOk({ ok: true });
    });

    // Change the phone to a new value so the save mutation has something to send.
    const phoneInput = screen.getByPlaceholderText("000-000-0000");
    fireEvent.changeText(phoneInput, "555-987-6543");

    // Tap "Save profile".
    const saveBtn = screen.getByText("Save profile");
    fireEvent.press(saveBtn);

    // The profile-level error must surface as an Alert.
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Could not save profile",
        expect.stringContaining("Validation failed"),
      ),
    );

    // The OTP panel must NOT appear — onSuccess was never reached.
    expect(screen.queryByText("Enter verification code")).toBeNull();
    expect(screen.queryByPlaceholderText("000000")).toBeNull();
  });

  it("does NOT open the OTP panel when PUT rejects with a network-level error", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // PUT call throws a network error (rejected promise, no Response).
    setMockFetchHandler((url) => {
      if (url.includes("/profile")) {
        return Promise.reject(new Error("Network error")) as unknown as Response;
      }
      return jsonOk({ ok: true });
    });

    const phoneInput = screen.getByPlaceholderText("000-000-0000");
    fireEvent.changeText(phoneInput, "555-000-0000");

    const saveBtn = screen.getByText("Save profile");
    fireEvent.press(saveBtn);

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Could not save profile",
        expect.any(String),
      ),
    );

    expect(screen.queryByText("Enter verification code")).toBeNull();
    expect(screen.queryByPlaceholderText("000000")).toBeNull();
  });

  it("opens the OTP panel automatically after a successful save with a changed phone", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // PUT /profile succeeds, then POST /send-phone-code succeeds.
    setMockFetchHandler((url) => {
      if (url.includes("/profile")) return jsonOk({});
      if (url.includes("/send-phone-code")) return jsonOk({ success: true });
      return jsonOk({ ok: true });
    });

    const phoneInput = screen.getByPlaceholderText("000-000-0000");
    fireEvent.changeText(phoneInput, "555-987-6543");

    const saveBtn = screen.getByText("Save profile");
    fireEvent.press(saveBtn);

    // The OTP panel must appear automatically (no separate "Verify" press).
    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    expect(screen.getByPlaceholderText("000000")).toBeTruthy();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
