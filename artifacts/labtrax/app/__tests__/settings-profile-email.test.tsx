/**
 * Regression guard for the mobile ProfileScreen email-verification UX.
 *
 * Mirrors settings-profile-phone.test.tsx for the email verification flow:
 * badge visibility, Verify button, OTP entry (Confirm / Resend / Cancel),
 * and the Save button being disabled while the OTP panel is open.
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

const UNVERIFIED_EMAIL_USER: {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  role: string;
  phone: string | null;
  phoneVerifiedAt: string | null;
  email: string;
  emailVerifiedAt: string | null;
  practiceName: string | null;
  platformAccountNumber: string | null;
  workStatus: string | null;
  profilePhotoUrl: string | null;
  practiceOrganizationId: string | null;
  practiceLogoUrl: string | null;
  practiceLogoplacements: string | null;
  practiceLogoSize: string | null;
} = {
  id: "user-email-test-mobile-1",
  username: "emailtest",
  firstName: "Test",
  lastName: "User",
  role: "admin",
  phone: null,
  phoneVerifiedAt: null,
  email: "unverified@example.com",
  emailVerifiedAt: null,
  practiceName: null,
  platformAccountNumber: null,
  workStatus: null,
  profilePhotoUrl: null,
  practiceOrganizationId: null,
  practiceLogoUrl: null,
  practiceLogoplacements: null,
  practiceLogoSize: null,
};

const VERIFIED_EMAIL_USER: typeof UNVERIFIED_EMAIL_USER = {
  ...UNVERIFIED_EMAIL_USER,
  id: "user-email-test-mobile-2",
  email: "verified@example.com",
  emailVerifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
};

// ---------------------------------------------------------------------------
// Module mocks — override the global vitest.setup.ts mocks for this file
// ---------------------------------------------------------------------------

let currentUser: typeof UNVERIFIED_EMAIL_USER = UNVERIFIED_EMAIL_USER;

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();

  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: { user: currentUser },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })),
    // Simple mutation shim: invokes mutationFn and routes to onSuccess/onError.
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

async function renderProfile() {
  return render(<ProfileScreen />);
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function openEmailOtpPanelViaVerifyButton() {
  setMockFetchHandler((url) => {
    if (url.includes("/send-email-code")) return jsonOk({ success: true });
    return jsonOk({ ok: true });
  });
  await fireEvent.press(screen.getByText("Verify"));
  await waitFor(() =>
    expect(screen.getByText("Enter verification code")).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentUser = UNVERIFIED_EMAIL_USER;
  vi.mocked(Alert.alert).mockClear();
  resetMockFetchHandler();
});

afterEach(() => {
  resetMockFetchHandler();
});

// ---------------------------------------------------------------------------
// Suite: badge state reflects emailVerifiedAt + current input match
// ---------------------------------------------------------------------------

describe("ProfileScreen — email verification badge", () => {
  it("shows a 'Not verified' badge and a Verify button for an unverified email", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("shows a 'Verified' badge and no Verify button when emailVerifiedAt matches the current input", async () => {
    currentUser = VERIFIED_EMAIL_USER;
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByDisplayValue(VERIFIED_EMAIL_USER.email)).toBeTruthy(),
    );

    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByText("Verify")).toBeNull();
  });

  it("re-shows the Verify button (and drops Verified) after editing an already-verified email", async () => {
    currentUser = VERIFIED_EMAIL_USER;
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByDisplayValue(VERIFIED_EMAIL_USER.email)).toBeTruthy(),
    );
    expect(screen.getByText("Verified")).toBeTruthy();

    const emailInput = screen.getByDisplayValue(VERIFIED_EMAIL_USER.email);
    await fireEvent.changeText(emailInput, "changed@example.com");

    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.getByText("Verify")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Suite: sending the code opens the OTP panel
// ---------------------------------------------------------------------------

describe("ProfileScreen — tapping Verify sends the email code and opens the OTP panel", () => {
  it("calls POST /send-email-code and shows the inline OTP entry", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    let sendCallCount = 0;
    let sentBody: unknown = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/send-email-code")) {
        sendCallCount += 1;
        sentBody = init?.body ? JSON.parse(init.body as string) : null;
        return jsonOk({ success: true });
      }
      return jsonOk({ ok: true });
    });

    await fireEvent.press(screen.getByText("Verify"));

    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    expect(sendCallCount).toBe(1);
    expect(sentBody).toEqual({ email: UNVERIFIED_EMAIL_USER.email });
    expect(screen.getByPlaceholderText("000000")).toBeTruthy();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("saves an edited email first, then sends the code bound to the new value", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    const emailInput = screen.getByPlaceholderText("you@example.com");
    await fireEvent.changeText(emailInput, "new-address@example.com");

    let putBody: unknown = null;
    let sendBody: unknown = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/profile")) {
        putBody = init?.body ? JSON.parse(init.body as string) : null;
        return jsonOk({});
      }
      if (url.includes("/send-email-code")) {
        sendBody = init?.body ? JSON.parse(init.body as string) : null;
        return jsonOk({ success: true });
      }
      return jsonOk({ ok: true });
    });

    await fireEvent.press(screen.getByText("Verify"));

    await waitFor(() =>
      expect(screen.getByText("Enter verification code")).toBeTruthy(),
    );

    expect((putBody as { email?: string })?.email).toBe("new-address@example.com");
    expect(sendBody).toEqual({ email: "new-address@example.com" });
  });
});

// ---------------------------------------------------------------------------
// Suite: Confirm calls verify-email-code and updates state on success
// ---------------------------------------------------------------------------

describe("ProfileScreen — confirming the email OTP code", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
  });

  afterEach(() => {
    resetMockFetchHandler();
  });

  it("calls POST /verify-email-code with the entered code and closes the panel on success", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    await openEmailOtpPanelViaVerifyButton();

    await fireEvent.changeText(screen.getByPlaceholderText("000000"), "654321");

    let verifyBody: unknown = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/verify-email-code")) {
        verifyBody = init?.body ? JSON.parse(init.body as string) : null;
        return jsonOk({ verified: true });
      }
      return jsonOk({ ok: true });
    });

    await fireEvent.press(screen.getByTestId("confirm-email-otp-btn"));

    await waitFor(() =>
      expect(screen.queryByText("Enter verification code")).toBeNull(),
    );

    expect(verifyBody).toEqual({ email: UNVERIFIED_EMAIL_USER.email, code: "654321" });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("shows an inline error and keeps the panel open when the code is incorrect", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    await openEmailOtpPanelViaVerifyButton();

    await fireEvent.changeText(screen.getByPlaceholderText("000000"), "000000");

    setMockFetchHandler((url) => {
      if (url.includes("/verify-email-code")) {
        return jsonOk({ verified: false, error: "Incorrect code. Please try again." });
      }
      return jsonOk({ ok: true });
    });

    await fireEvent.press(screen.getByTestId("confirm-email-otp-btn"));

    await waitFor(() =>
      expect(screen.getByText("Incorrect code. Please try again.")).toBeTruthy(),
    );

    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite: Resend cooldown + Cancel
// ---------------------------------------------------------------------------

describe("ProfileScreen — email OTP resend cooldown and cancel", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockFetchHandler();
  });

  it("disables Resend for 60s, then allows a resend that keeps the panel open", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    await openEmailOtpPanelViaVerifyButton();

    // Resend button shows a countdown immediately after sending.
    expect(screen.getByText(/^Resend \(\d+s\)$/)).toBeTruthy();
    expect(screen.queryByText("Resend")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(screen.getByText("Resend")).toBeTruthy(),
    );

    let resendCallCount = 0;
    setMockFetchHandler((url) => {
      if (url.includes("/send-email-code")) {
        resendCallCount += 1;
        return jsonOk({ success: true });
      }
      return jsonOk({ ok: true });
    });

    await fireEvent.press(screen.getByText("Resend"));

    await waitFor(() =>
      expect(screen.getByText(/^Resend \(\d+s\)$/)).toBeTruthy(),
    );

    expect(resendCallCount).toBe(1);
    expect(screen.getByText("Enter verification code")).toBeTruthy();
  });

  it("cancel closes the OTP panel and clears the entered code", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    await openEmailOtpPanelViaVerifyButton();
    await fireEvent.changeText(screen.getByPlaceholderText("000000"), "123456");

    // Let the initial 60s cooldown fully elapse before cancelling so the
    // Verify affordance is re-armed immediately after (matches the phone
    // flow's cancel-when-idle-cooldown behaviour).
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await fireEvent.press(screen.getByText("Cancel"));

    expect(screen.queryByText("Enter verification code")).toBeNull();
    expect(screen.queryByPlaceholderText("000000")).toBeNull();
    expect(screen.getByText("Verify")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Suite: Save button disabled while the email OTP panel is open
// ---------------------------------------------------------------------------

describe("ProfileScreen — Save button is disabled while the email OTP panel is open", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    resetMockFetchHandler();
  });

  afterEach(() => {
    resetMockFetchHandler();
  });

  it("disables the Save profile button while emailVerifyStep is otp", async () => {
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
    );

    await openEmailOtpPanelViaVerifyButton();

    expect(screen.getByText("Enter verification code")).toBeTruthy();

    const pressable = screen.getByTestId("save-profile-btn");
    expect(pressable.props.disabled).toBe(true);
  });
});
