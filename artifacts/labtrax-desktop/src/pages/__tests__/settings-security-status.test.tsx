/** @vitest-environment jsdom */
/**
 * Regression guard: desktop Settings → Profile security-status card.
 *
 * Protected workflows:
 *   - "Desktop Settings phone-verification security status"
 *   - "No stale two-factor / 2FA wording in desktop Settings"
 *
 * A stale installed Electron build displayed "Two-factor authentication: Not
 * enabled" because an older revision had a 2FA section. LabTrax has no TOTP
 * authenticator-app feature — it uses phone (SMS) verification only.
 *
 * These tests assert:
 *   1. The Settings Profile tab renders a "Security" card with a
 *      "Phone verification" row (data-testid="security-status-card").
 *   2. The card shows "Verified" when the user's phone is verified
 *      (phoneVerifiedAt is set and matches the current phone).
 *   3. The card shows "Not verified" when phoneVerifiedAt is null.
 *   4. Nowhere in the rendered Settings page output does the text
 *      "Two-factor authentication" or "2FA" appear.
 *
 * Keep these tests permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ team: [], members: [], items: [], sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  // Ensure no electronAPI bridge so IPC-dependent paths short-circuit cleanly.
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

const PHONE_VERIFIED_USER = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
  phone: "555-123-4567",
  phoneVerifiedAt: new Date().toISOString(),
  practiceOrganizationId: null,
  practiceLogoUrl: null,
};

const PHONE_UNVERIFIED_USER = {
  ...PHONE_VERIFIED_USER,
  phone: "555-987-6543",
  phoneVerifiedAt: null,
};

const NO_PHONE_USER = {
  ...PHONE_VERIFIED_USER,
  phone: null,
  phoneVerifiedAt: null,
};

function renderWithUser(user: Record<string, unknown>) {
  const Wrapper = makeAuthWrapper("/settings", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: user as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Profile security-status card", () => {
  it("renders the Security card on the Profile tab", async () => {
    renderWithUser(PHONE_VERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("security-status-card")).toBeInTheDocument(),
    );
  });

  it("shows Verified badge when phoneVerifiedAt is set and matches the current phone", async () => {
    renderWithUser(PHONE_VERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("phone-verified-badge")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("phone-verified-badge")).toHaveTextContent("Verified");
  });

  it("shows Not verified badge when phoneVerifiedAt is null", async () => {
    renderWithUser(PHONE_UNVERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("phone-not-verified-badge")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("phone-not-verified-badge")).toHaveTextContent("Not verified");
  });

  it("shows No phone on file badge when user has no phone", async () => {
    renderWithUser(NO_PHONE_USER);
    await waitFor(() =>
      expect(screen.getByTestId("phone-not-verified-badge")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("phone-not-verified-badge")).toHaveTextContent("No phone on file");
  });

  it("renders a link to view sessions from the security card", async () => {
    renderWithUser(PHONE_VERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("view-sessions-link")).toBeInTheDocument(),
    );
  });
});

describe("Settings — no stale two-factor / 2FA wording", () => {
  it("does not render 'Two-factor authentication' anywhere on the Profile tab", async () => {
    const { container } = renderWithUser(PHONE_VERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("security-status-card")).toBeInTheDocument(),
    );
    expect(container.textContent).not.toMatch(/two.?factor authentication/i);
  });

  it("does not render '2FA' anywhere on the Profile tab", async () => {
    const { container } = renderWithUser(PHONE_VERIFIED_USER);
    await waitFor(() =>
      expect(screen.getByTestId("security-status-card")).toBeInTheDocument(),
    );
    expect(container.textContent).not.toMatch(/\b2fa\b/i);
  });
});
