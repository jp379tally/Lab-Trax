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
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
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

// ---------------------------------------------------------------------------
// Helper: open OTP panel via the "Verify phone number" button.
// The test user has an unverified phone, so the Verify button is visible
// immediately without changing any field or saving.
// ---------------------------------------------------------------------------

async function openOtpPanelViaVerifyButton() {
  setMockFetchHandler((url) => {
    if (url.includes("/send-phone-code")) return jsonOk({ success: true });
    return jsonOk({ ok: true });
  });
  fireEvent.press(screen.getByText("Verify phone number"));
  await waitFor(() =>
    expect(screen.getByText("Enter verification code")).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// Suite: resend failure shows inline error and keeps OTP panel open
// ---------------------------------------------------------------------------

describe("ProfileScreen — resend failure keeps OTP panel visible with inline error", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
    // shouldAdvanceTime: true lets waitFor retries fire normally while still
    // allowing vi.advanceTimersByTime() to skip the 60-second countdown.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockFetchHandler();
  });

  it("shows the resend error inside the OTP panel and does not close it", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel.
    await openOtpPanelViaVerifyButton();

    // Advance past the 60-second countdown so the Resend button is enabled.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );

    // Wire the resend call to fail.
    setMockFetchHandler((url) => {
      if (url.includes("/send-phone-code")) {
        return Promise.reject(new Error("SMS service unavailable")) as unknown as Response;
      }
      return jsonOk({ ok: true });
    });

    fireEvent.press(screen.getByText("Resend"));

    // The OTP panel must remain visible — user must not be dropped to idle.
    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    // The error must appear inside the panel (not as an Alert).
    await waitFor(() =>
      expect(screen.getByText(/SMS service unavailable/i)).toBeTruthy(),
    );

    // The OTP code input must still be present.
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No Alert.alert should have been called — the error is inline.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: cancel mid-resend clears stuck state so button is not stuck after
// reopening the OTP panel
// ---------------------------------------------------------------------------

describe("ProfileScreen — cancel mid-resend clears resending state", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockFetchHandler();
  });

  it("does not leave the resend button stuck disabled after cancelling mid-resend", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel.
    await openOtpPanelViaVerifyButton();

    // Advance past the initial 60-second resend countdown.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );

    // Start a resend whose promise never resolves — the button enters "Sending…"
    // state (resending=true) but the OTP panel stays open.
    setMockFetchHandler((url) => {
      if (url.includes("/send-phone-code")) {
        return new Promise<never>(() => {}) as unknown as Response;
      }
      return jsonOk({ ok: true });
    });

    fireEvent.press(screen.getByText("Resend"));

    // The OTP panel must still be open (step remains "otp") while resending.
    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    // Cancel while resend is in-flight — must clear resending state and close panel.
    fireEvent.press(screen.getByText("Cancel"));
    expect(screen.queryByText("Enter verification code")).toBeNull();

    // Reopen the OTP panel with a fresh successful send.
    await openOtpPanelViaVerifyButton();

    // Advance past the new 60-second countdown.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // The Resend button must be enabled — stale resending=true must NOT block it.
    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: Save button is disabled while the OTP panel is open
// ---------------------------------------------------------------------------

describe("ProfileScreen — Save button is disabled while OTP panel is open", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
  });

  afterEach(() => {
    resetMockFetchHandler();
  });

  it("disables the Save profile button while phoneVerifyStep is otp", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel via the Verify button (phone is set + unverified).
    await openOtpPanelViaVerifyButton();

    // The OTP panel must be open.
    expect(screen.getByText("Enter verification code")).toBeTruthy();

    // The Save profile button must be disabled.
    // fireEvent.press bypasses the disabled prop in RNTL, so we inspect the
    // Pressable element's props directly via its testID.
    const pressable = screen.getByTestId("save-profile-btn");
    expect(pressable.props.disabled).toBe(true);

    // The OTP panel must still be visible.
    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No Alert should have been shown.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: successful resend resets the countdown and keeps the OTP panel open
// ---------------------------------------------------------------------------

describe("ProfileScreen — successful resend resets countdown and keeps OTP panel open", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockFetchHandler();
  });

  it("keeps the OTP panel open and disables Resend for 60 s after a successful resend", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel via the Verify button.
    await openOtpPanelViaVerifyButton();

    // Advance past the initial 60-second resend countdown so the button is enabled.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );

    // Wire the resend call to succeed.
    setMockFetchHandler((url) => {
      if (url.includes("/send-phone-code")) return jsonOk({ success: true });
      return jsonOk({ ok: true });
    });

    fireEvent.press(screen.getByText("Resend"));

    // The OTP panel must remain open — step must NOT go back to "idle".
    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    // The countdown must have restarted: "Resend (60s)" (or any Xs > 0).
    // The plain "Resend" text must NOT be present — the button is disabled.
    await waitFor(() =>
      expect(screen.getByText(/^Resend \(\d+s\)$/)).toBeTruthy(),
    );

    expect(screen.queryByText("Resend")).toBeNull();

    // The OTP code input must still be present for the user to enter their code.
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No alert should have been shown — this is a success path.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: editing an unrelated field while the OTP panel is open does not
// dismiss the panel
// ---------------------------------------------------------------------------

describe("ProfileScreen — editing an unrelated field does not dismiss the OTP panel", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
  });

  afterEach(() => {
    resetMockFetchHandler();
  });

  it("keeps the OTP panel open when the user edits firstName while the panel is visible", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel via the Verify button.
    await openOtpPanelViaVerifyButton();

    // The OTP panel is open; now edit the First name field — an unrelated field.
    const firstNameInput = screen.getByPlaceholderText("First name");
    fireEvent.changeText(firstNameInput, "Testing");

    // The OTP panel must still be visible — phone value did not change.
    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No Alert should have fired.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: Confirm button is disabled while a verify request is in-flight;
// double-tapping does NOT fire a second /verify-phone-code request
// ---------------------------------------------------------------------------

describe("ProfileScreen — Confirm button disabled while verification is in-flight", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
  });

  afterEach(() => {
    resetMockFetchHandler();
  });

  it("does not fire a second /verify-phone-code when Confirm is tapped twice while the first request is in-flight", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel.
    await openOtpPanelViaVerifyButton();

    // Enter a 6-digit code so the button is enabled.
    fireEvent.changeText(screen.getByPlaceholderText("000000"), "123456");

    // Wire /verify-phone-code to a never-resolving promise so the request
    // stays in-flight indefinitely — this is the stall that triggers isVerifying.
    let verifyCallCount = 0;
    setMockFetchHandler((url) => {
      if (url.includes("/verify-phone-code")) {
        verifyCallCount += 1;
        return new Promise<never>(() => {}) as unknown as Response;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // First tap — starts the in-flight request.
    const confirmBtn = screen.getByTestId("confirm-otp-btn");
    fireEvent.press(confirmBtn);

    // Wait for the button to become disabled (isVerifying=true).
    await waitFor(() =>
      expect(screen.getByTestId("confirm-otp-btn").props.disabled).toBe(true),
    );

    // Record the count after the first press.
    expect(verifyCallCount).toBe(1);

    // Second tap — must be a no-op because disabled=true / onPress=undefined.
    fireEvent.press(screen.getByTestId("confirm-otp-btn"));

    // Give any async work a tick to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // No additional /verify-phone-code request should have been fired.
    expect(verifyCallCount).toBe(1);

    // The OTP panel must still be open and the code input still present.
    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No Alert should have been shown — the request is still pending, not errored.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: Resend button is disabled during countdown and pressing it while
// disabled does NOT fire a second /send-phone-code request
// ---------------------------------------------------------------------------

describe("ProfileScreen — Resend button disabled during countdown is a no-op", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockFetchHandler();
  });

  it("does not fire a second /send-phone-code when the Resend button is pressed during the countdown", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("000-000-0000")).toBeTruthy(),
    );

    // Open the OTP panel — this fires the first /send-phone-code (for verification).
    await openOtpPanelViaVerifyButton();

    // Advance past the initial 60-second countdown so the Resend button becomes enabled.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );

    // Track /send-phone-code calls from here onwards (after the initial send).
    let resendCallCount = 0;
    setMockFetchHandler((url) => {
      if (url.includes("/send-phone-code")) {
        resendCallCount += 1;
        return jsonOk({ success: true });
      }
      return jsonOk({ ok: true });
    });

    // Press Resend once — this is the legitimate resend.
    fireEvent.press(screen.getByText("Resend"));

    // Wait for the countdown to restart after the successful resend.
    await waitFor(() =>
      expect(screen.getByText(/^Resend \(\d+s\)$/)).toBeTruthy(),
    );

    // The Resend Pressable must report disabled=true while the countdown runs.
    const resendPressable = screen.getByTestId("resend-otp-btn");
    expect(resendPressable.props.disabled).toBe(true);

    // Record the call count after the one legitimate resend.
    const countAfterLegitimateResend = resendCallCount;
    expect(countAfterLegitimateResend).toBe(1);

    // Press the button again while the countdown is active — this must be a no-op.
    fireEvent.press(resendPressable);

    // Give any async work a chance to settle.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // No additional /send-phone-code request should have been made.
    expect(resendCallCount).toBe(countAfterLegitimateResend);

    // The OTP panel must still be visible and the countdown still running.
    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(screen.getByText(/^Resend \(\d+s\)$/)).toBeTruthy();
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();

    // No Alert should have been shown.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
