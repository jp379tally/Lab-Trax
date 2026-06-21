/** @vitest-environment jsdom */
/**
 * Regression guard for ProfilePanel phone-verification UX behaviour.
 *
 * The three failure modes protected here:
 *  1. "Resend code" silently collapsed the OTP panel back to idle state — fixed
 *     by keeping phoneVerifyStep === "otp" throughout a resend attempt.
 *  2. A resend failure showed the error in the idle-state slot (below the phone
 *     input) instead of inside the OTP panel, giving the user no way to retry
 *     without re-entering the phone step.
 *  3. The Cancel button left a stale `resending: true` flag that disabled the
 *     Resend button when the panel was re-opened on the same render.
 *
 * A second suite below covers the auto-save OTP path: when a user saves their
 * profile with a changed phone number, the mutation onSuccess handler
 * auto-triggers the SMS send without a separate "Verify" click.  The OTP
 * panel behaviour (resend stays visible, errors stay inside the panel) mirrors
 * the manual-verify suite above.
 *
 * Strategy:
 *  - apiFetch is mocked at the module level so no network calls are made.
 *  - vi.useFakeTimers({ shouldAdvanceTime: true }) lets waitFor poll normally
 *    (real time auto-advances the fake clock, so testing-library's setTimeout
 *    retries fire), while still allowing vi.advanceTimersByTime() to
 *    fast-forward the 60-second resend countdown.
 *  - The full SettingsPage is rendered; ProfilePanel is the default tab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

const refreshMock = vi.fn(async () => {});

// A user with an unverified phone so the Verify button is visible.
const UNVERIFIED_PHONE_USER = {
  id: "user-phone-test-1",
  username: "phonetest",
  firstName: "Test",
  lastName: "User",
  role: "admin",
  phone: "555-123-4567",
  phoneVerifiedAt: null,
};

function renderProfile() {
  const Wrapper = makeAuthWrapper("/settings", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: UNVERIFIED_PHONE_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: refreshMock,
  });
  render(
    <Wrapper>
      <SettingsPage />
    </Wrapper>,
  );
}

/**
 * Click "Verify" and wait for the OTP panel to appear.
 *
 * Uses waitFor (not act) so that timer-based React scheduling can settle.
 * apiFetchMock must be set up by the caller before invoking this helper.
 */
async function openOtpPanel() {
  apiFetchMock.mockResolvedValueOnce({ success: true });
  fireEvent.click(screen.getByRole("button", { name: /^Verify$/i }));
  await waitFor(() =>
    expect(screen.getByText(/enter verification code/i)).toBeInTheDocument(),
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  refreshMock.mockClear();
  // shouldAdvanceTime: true — real time advances the fake clock automatically,
  // which lets waitFor's internal setTimeout retries fire without manual
  // time advancement. vi.advanceTimersByTime() can then fast-forward specific
  // intervals (like the 60-second resend countdown) on demand.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProfilePanel — phone verification OTP flow", () => {
  it("shows the OTP panel after a successful send", async () => {
    renderProfile();

    await openOtpPanel();

    expect(screen.getByText(/enter verification code/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("000000")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).toBeInTheDocument();
  });

  it("resend keeps the OTP panel visible on success", async () => {
    renderProfile();
    await openOtpPanel();

    // Fast-forward the 60-second resend countdown so the button is enabled.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );

    apiFetchMock.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole("button", { name: /^resend code$/i }));

    // OTP panel must remain visible after a successful resend.
    await waitFor(() =>
      expect(
        screen.getByText(/enter verification code/i),
      ).toBeInTheDocument(),
    );

    // The Verify button is always rendered (just disabled while in OTP state).
    // It being disabled confirms we have NOT dropped back to idle.
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });

  it("resend failure shows an error inside the OTP panel, not idle state", async () => {
    renderProfile();
    await openOtpPanel();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );

    apiFetchMock.mockRejectedValueOnce(new Error("SMS service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: /^resend code$/i }));

    // The OTP panel must remain visible — user must not be dropped to idle.
    await waitFor(() =>
      expect(
        screen.getByText(/enter verification code/i),
      ).toBeInTheDocument(),
    );

    // Error text must appear within the panel.
    expect(screen.getByText(/SMS service unavailable/i)).toBeInTheDocument();

    // The Verify button is always rendered (just disabled while in OTP state).
    // It being disabled confirms we have NOT dropped back to idle.
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });

  it("editing an unrelated field (firstName) while OTP panel is open does not dismiss the panel", async () => {
    renderProfile();
    await openOtpPanel();

    // The OTP panel is open; now touch the First name input without changing the phone.
    const firstNameInput = screen.getByDisplayValue("Test");
    fireEvent.change(firstNameInput, { target: { value: "Testing" } });

    // The OTP panel must remain visible — phone value did not change.
    expect(screen.getByText(/enter verification code/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });

  it("cancel while resend is in-flight clears resending state so the button is not stuck after reopening", async () => {
    renderProfile();
    await openOtpPanel();

    // Advance past the 60-second resend countdown to enable the button.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );

    // Queue a resend whose promise will never resolve → setResending(true) is
    // called synchronously before the first await, so the component enters the
    // "Sending…" state. The button text changes away from "Resend code" while
    // resending is in-flight, so we go straight to Cancel without querying it.
    apiFetchMock.mockReturnValueOnce(new Promise<never>(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /^resend code$/i }));

    // Cancel must clear resending (and phoneVerifyStep → idle).
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(
      screen.queryByText(/enter verification code/i),
    ).not.toBeInTheDocument();

    // Reopen the OTP panel with a fresh send.
    await openOtpPanel();

    // Advance past the new resend countdown.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // The Resend button must become enabled — stale resending=true must NOT block it.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );
  });
});

// ---------------------------------------------------------------------------
// Auto-save OTP path
// ---------------------------------------------------------------------------
// When the user saves their profile with a changed phone number the mutation
// onSuccess handler calls /send-phone-code automatically — without the user
// having clicked "Verify".  This suite guards that the OTP panel:
//   a) appears after Save (no "Verify" click required), and
//   b) behaves identically to the manual-verify path for resend + error cases.
// ---------------------------------------------------------------------------

/**
 * Change the phone input to a new value and click "Save profile", with the
 * PUT profile and POST /send-phone-code calls both mocked to succeed.
 * Waits until the OTP panel is visible before returning.
 */
async function openOtpPanelViaSave() {
  // PUT /auth/users/:id/profile succeeds (mutation resolves).
  apiFetchMock.mockResolvedValueOnce({});
  // POST /send-phone-code succeeds (auto-triggered by onSuccess).
  apiFetchMock.mockResolvedValueOnce({ success: true });

  // Change the phone to a value that differs from the user's stored phone
  // ("555-123-4567") so that onSuccess detects phoneChanged === true.
  const phoneInput = screen.getByPlaceholderText("000-000-0000");
  fireEvent.change(phoneInput, { target: { value: "555-987-6543" } });

  fireEvent.click(screen.getByRole("button", { name: /^Save profile$/i }));

  await waitFor(() =>
    expect(screen.getByText(/enter verification code/i)).toBeInTheDocument(),
  );
}

describe("ProfilePanel — auto-save OTP path (phone changed on Save)", () => {
  it("shows the OTP panel automatically after saving with a new phone (no Verify click)", async () => {
    renderProfile();

    await openOtpPanelViaSave();

    expect(screen.getByText(/enter verification code/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("000000")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).toBeInTheDocument();
    // The Verify button is rendered but disabled while the OTP panel is open.
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });

  it("resend keeps the OTP panel visible on success (auto-save path)", async () => {
    renderProfile();
    await openOtpPanelViaSave();

    // Fast-forward the 60-second resend countdown so the button is enabled.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );

    apiFetchMock.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole("button", { name: /^resend code$/i }));

    // OTP panel must remain visible after a successful resend.
    await waitFor(() =>
      expect(
        screen.getByText(/enter verification code/i),
      ).toBeInTheDocument(),
    );

    // Verify button disabled confirms we have NOT dropped back to idle.
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });

  it("resend failure shows an error inside the OTP panel, not idle state (auto-save path)", async () => {
    renderProfile();
    await openOtpPanelViaSave();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^resend code$/i }),
      ).not.toBeDisabled(),
    );

    apiFetchMock.mockRejectedValueOnce(new Error("SMS service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: /^resend code$/i }));

    // OTP panel must remain visible — user must not be dropped to idle.
    await waitFor(() =>
      expect(
        screen.getByText(/enter verification code/i),
      ).toBeInTheDocument(),
    );

    // Error text must appear within the panel.
    expect(screen.getByText(/SMS service unavailable/i)).toBeInTheDocument();

    // Verify button disabled confirms we have NOT dropped back to idle.
    expect(
      screen.getByRole("button", { name: /^Verify$/i }),
    ).toBeDisabled();
  });
});
