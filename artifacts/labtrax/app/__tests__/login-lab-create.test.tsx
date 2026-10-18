/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Drives the mobile sign-up flow through the lab-owner creation path and
 * verifies that the final registration payload contains userType:"lab",
 * createOrganization:true, and the expected lab name.  Without this test a
 * regression in the lab-create path would silently break sign-up for new lab
 * owners.
 *
 * Steps exercised:
 *   welcome → credentials → user_type (user-type-lab)
 *   → lab_intent (lab-intent-create) → lab_name (lab-name-input + lab-name-next-btn)
 *   → lab_info (lab-info-* fields + lab-info-next-btn)
 *   → email_verify → updates_opt_in → hipaa_disclaimer → register()
 *
 * Assertion: register() is called with userType:"lab", createOrganization:true,
 * and practiceName equal to the lab name entered in the lab_name step.
 */
import React from "react";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock() factories that
// reference it, because vi.mock() factories are hoisted above all imports.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  registerFn: vi.fn(async (_payload: unknown) => ({ success: true })),
  registeredUsers: [] as { username: string; email?: string }[],
  safeAreaInsets: { top: 59, bottom: 34, left: 0, right: 0 },
  apiRequestFn: vi.fn(
    async (method: string, path: string, _body?: unknown) => {
      if (method === "POST" && path === "/api/check-username") {
        return { json: async () => ({ available: true }), ok: true };
      }
      if (method === "GET" && path.startsWith("/api/auth/check-email")) {
        return {
          json: async () => ({ data: { available: true } }),
          ok: true,
        };
      }
      if (method === "GET" && path.startsWith("/api/labs/groups")) {
        return {
          json: async () => ({ groups: [] }),
          ok: true,
        };
      }
      if (method === "POST" && path === "/api/send-email-code") {
        return { json: async () => ({}), ok: true };
      }
      if (method === "POST" && path === "/api/verify-email-code") {
        return { json: async () => ({ verified: true }), ok: true };
      }
      return { json: async () => ({}), ok: true };
    },
  ),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockState.safeAreaInsets,
}));

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { name: "LabTrax", slug: "labtrax", version: "1.0.0" },
  },
}));

vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn(async () => ({
    status: "granted",
  })),
  getCurrentPositionAsync: vi.fn(async () => ({
    coords: { latitude: 0, longitude: 0 },
  })),
  reverseGeocodeAsync: vi.fn(async () => []),
  Accuracy: { Balanced: 3 },
}));

// Override the global setup-file mock to include `register`.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    currentUser: null,
    userType: null,
    registeredUsers: mockState.registeredUsers,
    isAuthenticated: false,
    accessToken: null,
    login: vi.fn(),
    logout: vi.fn(),
    completeTwoFactor: vi.fn(),
    loginWithBiometric: vi.fn(),
    register: mockState.registerFn,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

// Override the global setup-file mock to include `apiRequest`.
vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  getAccessToken: vi.fn(async () => null),
  refreshAndGetAccessToken: vi.fn(async () => null as string | null),
  resilientFetch: vi.fn(
    async () => new Response(JSON.stringify({ data: null }), { status: 200 }),
  ),
  apiRequest: mockState.apiRequestFn,
  chunkedUploadCaseMedia: vi.fn(async () => ({ ok: true, url: "" })),
  uploadCaseMedia: vi.fn(async () => ({ ok: true, url: "" })),
  logDebugEvent: vi.fn(),
  queryClient: {
    clear: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
  },
}));

import LoginScreen from "@/components/LoginScreen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderLoginScreen() {
  const utils = await render(<LoginScreen />);
  await waitFor(() => expect(utils.getByTestId("switch-mode-btn")).toBeTruthy());
  return utils;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.registerFn.mockReset();
  mockState.registerFn.mockResolvedValue({ success: true });
  mockState.registeredUsers = [];
  mockState.apiRequestFn.mockReset();
  mockState.apiRequestFn.mockImplementation(
    async (method: string, path: string, _body?: unknown) => {
      if (method === "POST" && path === "/api/check-username") {
        return { json: async () => ({ available: true }), ok: true };
      }
      if (method === "GET" && path.startsWith("/api/auth/check-email")) {
        return {
          json: async () => ({ data: { available: true } }),
          ok: true,
        };
      }
      if (method === "GET" && path.startsWith("/api/labs/groups")) {
        return {
          json: async () => ({ groups: [] }),
          ok: true,
        };
      }
      if (method === "POST" && path === "/api/send-email-code") {
        return { json: async () => ({}), ok: true };
      }
      if (method === "POST" && path === "/api/verify-email-code") {
        return { json: async () => ({ verified: true }), ok: true };
      }
      return { json: async () => ({}), ok: true };
    },
  );
});

afterEach(() => cleanup());

describe("LoginScreen — lab-owner create-lab sign-up flow", () => {
  it("renders the compact branded credentials step and preserves validation, visibility, and continue behavior", async () => {
    const { getByTestId, getByText, queryByTestId } = await renderLoginScreen();
    await fireEvent.press(getByTestId("switch-mode-btn"));
    await fireEvent.press(getByTestId("welcome-get-started-btn"));

    expect(getByTestId("signup-brand-header")).toBeTruthy();
    expect(getByTestId("signup-credentials-card")).toBeTruthy();
    expect(getByTestId("signup-credentials-progress").props.accessibilityLabel).toBe(
      "Step 2 of 3",
    );
    expect(getByText("Create your account")).toBeTruthy();
    expect(getByText("3–12 characters: letters, numbers, or underscores.")).toBeTruthy();
    expect(getByText("Special character")).toBeTruthy();

    const password = getByTestId("signup-password");
    const confirmation = getByTestId("signup-confirm-password");
    expect(password.props.secureTextEntry).toBe(true);
    await fireEvent.press(getByTestId("signup-password-visibility"));
    expect(getByTestId("signup-password").props.secureTextEntry).toBe(false);
    expect(getByTestId("signup-confirm-password").props.secureTextEntry).toBe(false);
    await fireEvent.press(getByTestId("signup-password-visibility"));
    expect(password.props.secureTextEntry).toBe(true);

    await fireEvent.changeText(getByTestId("signup-username"), "mobilelab");
    await fireEvent.changeText(getByTestId("signup-email"), "lab@example.com");
    await fireEvent.changeText(getByTestId("signup-password"), "weak");
    await fireEvent.changeText(getByTestId("signup-confirm-password"), "weak");
    await fireEvent.press(getByTestId("signup-next-btn"));
    expect(getByText("Password does not meet requirements.")).toBeTruthy();
    expect(queryByTestId("user-type-lab")).toBeNull();

    await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
    await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word2");
    await fireEvent.press(getByTestId("signup-next-btn"));
    expect(getByText("Passwords do not match.")).toBeTruthy();

    await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word1");
    await fireEvent.press(getByTestId("signup-next-btn"));
    await waitFor(() => expect(getByTestId("user-type-lab")).toBeTruthy());
  });

  it("allows the shared test email despite a local duplicate and explains username sign-in", async () => {
    mockState.registeredUsers = [
      { username: "existing", email: "Shared-Test@Example.com" },
    ];
    mockState.apiRequestFn.mockImplementation(
      async (method: string, path: string) => {
        if (method === "GET" && path.startsWith("/api/auth/check-email")) {
          return { json: async () => ({ data: { available: false } }), ok: true };
        }
        if (method === "POST" && path === "/api/check-username") {
          return { json: async () => ({ available: true }), ok: true };
        }
        return { json: async () => ({}), ok: true };
      },
    );

    const { getByTestId } = await renderLoginScreen();
    await fireEvent.press(getByTestId("switch-mode-btn"));
    await fireEvent.press(getByTestId("welcome-get-started-btn"));
    await fireEvent.changeText(getByTestId("signup-username"), "sharedlab");
    await fireEvent.changeText(
      getByTestId("signup-email"),
      "shared-test@example.com",
    );
    await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
    await fireEvent.changeText(
      getByTestId("signup-confirm-password"),
      "Pass@word1",
    );
    await fireEvent(getByTestId("signup-email"), "blur");

    expect(getByTestId("shared-email-signup-guidance")).toBeTruthy();
    await fireEvent.press(getByTestId("signup-next-btn"));
    await waitFor(() => expect(getByTestId("user-type-lab")).toBeTruthy());
    expect(mockState.apiRequestFn).toHaveBeenCalledWith(
      "POST",
      "/api/check-username",
      { username: "sharedlab" },
    );
  });

  it("continues to block a duplicate ordinary email", async () => {
    mockState.apiRequestFn.mockImplementation(
      async (method: string, path: string) => {
        if (method === "GET" && path.startsWith("/api/auth/check-email")) {
          return { json: async () => ({ data: { available: false } }), ok: true };
        }
        return { json: async () => ({ available: true }), ok: true };
      },
    );
    const { getByTestId, queryByTestId } = await renderLoginScreen();
    await fireEvent.press(getByTestId("switch-mode-btn"));
    await fireEvent.press(getByTestId("welcome-get-started-btn"));
    await fireEvent.changeText(getByTestId("signup-username"), "ordinary");
    await fireEvent.changeText(getByTestId("signup-email"), "taken@example.com");
    await fireEvent(getByTestId("signup-email"), "blur");

    await waitFor(() => expect(getByTestId("email-conflict-error")).toBeTruthy());
    expect(queryByTestId("shared-email-signup-guidance")).toBeNull();
    expect(getByTestId("signup-next-btn").props.disabled).toBe(true);
  });

  it("explains that shared-email test accounts sign in with their usernames", async () => {
    const { getByTestId } = await renderLoginScreen();
    await fireEvent.changeText(
      getByTestId("login-username"),
      "SHARED-TEST@EXAMPLE.COM",
    );
    expect(getByTestId("shared-email-login-guidance")).toBeTruthy();
  });

  it("shows an accessible full-width Create account button above the compliance notice on a compact iPhone screen", async () => {
    const { getByTestId, getByText } = await render(
      <View
        testID="compact-iphone-viewport"
        style={{ width: 375, height: 667 }}
      >
        <LoginScreen />
      </View>,
    );
    const createAccountButton = await waitFor(() =>
      getByTestId("switch-mode-btn"),
    );
    const complianceNotice = getByTestId("login-hipaa-notice");

    expect(getByTestId("compact-iphone-viewport").props.style).toEqual({
      width: 375,
      height: 667,
    });
    expect(createAccountButton.props.accessibilityRole).toBe("button");
    expect(createAccountButton.props.accessibilityLabel).toBe("Create account");
    expect(getByText("Create account")).toBeTruthy();
    expect(getByTestId("login-submit")).toBeTruthy();
    expect(getByText("Sign In")).toBeTruthy();
    expect(getByTestId("login-privacy-policy")).toBeTruthy();
    expect(getByTestId("login-terms-of-service")).toBeTruthy();
    expect(getByText(/By logging in, you acknowledge that this system contains Protected Health Information/)).toBeTruthy();
    const bottomSection = createAccountButton.parent;
    if (!bottomSection) throw new Error("Create account button has no footer parent");
    expect(complianceNotice.parent).toBe(bottomSection);
    expect(bottomSection.children.indexOf(createAccountButton)).toBeLessThan(
      bottomSection.children.indexOf(complianceNotice),
    );
    expect(
      createAccountButton.props.style({ pressed: false }),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ width: "100%", minHeight: 52 }),
    ]));
    expect(
      createAccountButton.props.style({ pressed: true }),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ opacity: 0.82 }),
    ]));

    await fireEvent.press(createAccountButton);
    await waitFor(() => expect(getByTestId("welcome-get-started-btn")).toBeTruthy());
  });

  it("keeps welcome content scrollable above a safe-area-aware footer on a short iPhone viewport", async () => {
    const { getByTestId, queryByTestId } = await render(
      <View
        testID="short-iphone-viewport"
        style={{ width: 375, height: 667 }}
      >
        <LoginScreen />
      </View>,
    );
    expect(getByTestId("short-iphone-viewport").props.style).toEqual({
      width: 375,
      height: 667,
    });
    await fireEvent.press(getByTestId("switch-mode-btn"));

    const scroll = await waitFor(() => getByTestId("signup-scroll"));
    const footer = getByTestId("welcome-action-footer");

    expect(getByTestId("signup-screen")).toBeTruthy();
    expect(scroll.props.style).toMatchObject({ flex: 1 });
    expect(scroll.props.contentContainerStyle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flexGrow: 1 }),
        expect.objectContaining({ paddingTop: 89, paddingBottom: 54 }),
      ]),
    );
    expect(footer.parent).toBe(scroll.parent);
    expect(footer.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 46 })]),
    );

    await fireEvent.press(getByTestId("welcome-get-started-btn"));
    expect(getByTestId("signup-username")).toBeTruthy();
    expect(queryByTestId("welcome-action-footer")).toBeNull();
    const credentialsScroll = getByTestId("signup-scroll");
    expect(credentialsScroll.props.style).toMatchObject({ flex: 1 });
    expect(credentialsScroll.props.keyboardDismissMode).toBe("interactive");
  });

  it("walks user_type-lab → lab-intent-create → lab_name → lab_info path and registers with userType:lab + createOrganization:true", async () => {
    const { getByTestId, queryByTestId } = await renderLoginScreen();

    // ── Step 1: switch from signin to signup mode ──────────────────────────
    await fireEvent.press(getByTestId("switch-mode-btn"));

    // ── Step 2: welcome → credentials ─────────────────────────────────────
    await waitFor(() => expect(getByTestId("welcome-get-started-btn")).toBeTruthy());
    await fireEvent.press(getByTestId("welcome-get-started-btn"));

    // ── Step 3: fill credentials ───────────────────────────────────────────
    await waitFor(() => expect(getByTestId("signup-username")).toBeTruthy());
    await fireEvent.changeText(getByTestId("signup-username"), "labowner1");
    await fireEvent.changeText(getByTestId("signup-email"), "labowner@example.com");
    await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
    await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word1");

    // Press Continue → handleCredentialsNext → POST /api/check-username → user_type
    await fireEvent.press(getByTestId("signup-next-btn"));

    // ── Step 4: user_type → choose lab ────────────────────────────────────
    await waitFor(() => expect(getByTestId("user-type-lab")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("user-type-lab"));

    // ── Step 5: lab_intent → create ───────────────────────────────────────
    await waitFor(() =>
      expect(getByTestId("lab-intent-create")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("lab-intent-create"));

    // ── Step 6: lab_name → enter name and continue ────────────────────────
    // checkLabName() calls GET /api/labs/groups; our mock returns [] so no
    // match is found and the component transitions to lab_info.
    await waitFor(() => expect(getByTestId("lab-name-input")).toBeTruthy());
    await fireEvent.changeText(getByTestId("lab-name-input"), "Sunrise Dental Lab");
    await fireEvent.press(getByTestId("lab-name-next-btn"));

    // ── Step 7: lab_info → fill in address, phone, email ──────────────────
    await waitFor(() => expect(getByTestId("lab-info-street")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.changeText(getByTestId("lab-info-street"), "123 Lab Ave");
    expect(getByTestId("creator-ownership-guidance")).toBeTruthy();
    expect(queryByTestId("role-user")).toBeNull();
    expect(queryByTestId("role-admin")).toBeNull();
    await fireEvent.changeText(getByTestId("lab-info-city"), "Phoenix");
    await fireEvent.changeText(getByTestId("lab-info-state"), "AZ");
    await fireEvent.changeText(getByTestId("lab-info-zip"), "85001");
    await fireEvent.changeText(getByTestId("lab-info-phone"), "6025550100");
    await fireEvent.changeText(getByTestId("lab-info-email"), "lab@sunrise.com");

    // Continue calls sendEmailCode() → POST /api/send-email-code → email_verify
    await fireEvent.press(getByTestId("lab-info-next-btn"));

    // ── Step 8: email_verify — fill 6-digit OTP ───────────────────────────
    await waitFor(() => expect(getByTestId("email-code-0")).toBeTruthy(), {
      timeout: 3000,
    });
    const digits = ["1", "2", "3", "4", "5", "6"];
    for (let i = 0; i < 6; i++) {
      await fireEvent.changeText(getByTestId(`email-code-${i}`), digits[i]);
    }
    await fireEvent.press(getByTestId("verify-email-btn"));

    // ── Step 9: updates_opt_in — decline (lab+create always goes to hipaa) ─
    await waitFor(() => expect(getByTestId("updates-no-btn")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("updates-no-btn"));

    // ── Step 10: hipaa_disclaimer → accept and create account ─────────────
    await waitFor(() => expect(getByTestId("hipaa-checkbox")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("hipaa-checkbox"));
    await fireEvent.press(getByTestId("hipaa-accept-btn"));

    // ── Assertion: register() received the expected payload ───────────────
    await waitFor(
      () => expect(mockState.registerFn).toHaveBeenCalledOnce(),
      { timeout: 3000 },
    );

    const payload = mockState.registerFn.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.userType, "userType must be 'lab' for a lab-owner registration").toBe("lab");
    expect(payload.createOrganization, "createOrganization must be true when creating a new lab").toBe(true);
    expect(payload.practiceName, "practiceName must be the lab name entered in lab_name step").toBe("Sunrise Dental Lab");
  });
});
