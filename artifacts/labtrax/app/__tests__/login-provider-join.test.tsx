/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Drives the mobile sign-up flow through the provider_intent and join_practice
 * steps and verifies that the final registration payload contains
 * joinOrganizationId with createOrganization:false.  Without this test a
 * regression in the join-a-practice path would silently strand new providers
 * at sign-up with no visible error.
 *
 * Steps exercised (testIDs called out in the task spec):
 *   welcome → credentials → user_type → provider_intent (provider-intent-join)
 *   → license → join_practice (practice-search-input → practice-result-<id>
 *   → join-practice-continue-btn) → email_verify → updates_opt_in
 *   → hipaa_disclaimer → register()
 *
 * Assertion: register() is called with joinOrganizationId set to the selected
 * practice id and createOrganization:false.
 */
import React from "react";
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
  apiRequestFn: vi.fn(
    async (method: string, path: string, _body?: unknown) => {
      if (method === "POST" && path === "/api/check-username") {
        return { json: async () => ({ available: true }), ok: true };
      }
      if (
        method === "GET" &&
        path.startsWith("/api/auth/check-email")
      ) {
        return {
          json: async () => ({ data: { available: true } }),
          ok: true,
        };
      }
      if (
        method === "GET" &&
        path.startsWith("/api/practices/lookup")
      ) {
        return {
          json: async () => ({
            practices: [
              {
                id: "org-1",
                name: "Sunridge Dental",
                displayName: "Sunridge Dental",
                addressLine1: "100 Main St",
                city: "Austin",
                state: "TX",
                zip: "78701",
                phone: null,
                parentLabName: "Metro Lab",
              },
            ],
          }),
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
    registeredUsers: [],
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
      if (method === "GET" && path.startsWith("/api/practices/lookup")) {
        return {
          json: async () => ({
            practices: [
              {
                id: "org-1",
                name: "Sunridge Dental",
                displayName: "Sunridge Dental",
                addressLine1: "100 Main St",
                city: "Austin",
                state: "TX",
                zip: "78701",
                phone: null,
                parentLabName: "Metro Lab",
              },
            ],
          }),
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

describe("LoginScreen — provider join-a-practice sign-up flow", () => {
  it("walks the provider_intent → join_practice path and registers with joinOrganizationId + createOrganization:false", async () => {
    const { getByTestId, getByText } = await renderLoginScreen();

    // ── Step 1: switch from signin to signup mode ──────────────────────────
    await fireEvent.press(getByTestId("switch-mode-btn"));

    // ── Step 2: welcome → credentials ─────────────────────────────────────
    await waitFor(() => expect(getByTestId("welcome-get-started-btn")).toBeTruthy());
    await fireEvent.press(getByTestId("welcome-get-started-btn"));

    // ── Step 3: fill credentials ───────────────────────────────────────────
    await waitFor(() => expect(getByTestId("signup-username")).toBeTruthy());
    await fireEvent.changeText(getByTestId("signup-username"), "drsmith");
    await fireEvent.changeText(getByTestId("signup-email"), "drsmith@example.com");
    await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
    await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word1");

    // Press Continue → handleCredentialsNext → POST /api/check-username → user_type
    await fireEvent.press(getByTestId("signup-next-btn"));

    // ── Step 4: user_type → choose provider ───────────────────────────────
    await waitFor(() => expect(getByTestId("user-type-provider")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("user-type-provider"));

    // ── Step 5: provider_intent → join ────────────────────────────────────
    await waitFor(() =>
      expect(getByTestId("provider-intent-join")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("provider-intent-join"));

    // ── Step 6: license → fill and continue ───────────────────────────────
    await waitFor(() => expect(getByTestId("license-number")).toBeTruthy());
    await fireEvent.changeText(getByTestId("license-number"), "DDS-99999");
    await fireEvent.press(getByTestId("license-next-btn"));

    // ── Step 7: join_practice → search for a practice ─────────────────────
    await waitFor(() =>
      expect(getByTestId("practice-search-input")).toBeTruthy(),
    );
    await fireEvent.changeText(getByTestId("practice-search-input"), "Sunridge");

    // Wait for the 300 ms debounce + async search result to resolve.
    await waitFor(
      () => expect(getByTestId("practice-result-org-1")).toBeTruthy(),
      { timeout: 3000 },
    );

    // ── Step 8: select the practice ───────────────────────────────────────
    await fireEvent.press(getByTestId("practice-result-org-1"));

    // ── Step 9: confirm selection and continue to email verify ────────────
    await waitFor(() =>
      expect(getByTestId("join-practice-continue-btn")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("join-practice-continue-btn"));

    // ── Step 10: email_verify — fill 6-digit OTP ──────────────────────────
    await waitFor(() => expect(getByTestId("email-code-0")).toBeTruthy(), {
      timeout: 3000,
    });
    const digits = ["1", "2", "3", "4", "5", "6"];
    for (let i = 0; i < 6; i++) {
      await fireEvent.changeText(getByTestId(`email-code-${i}`), digits[i]);
    }
    await fireEvent.press(getByTestId("verify-email-btn"));

    // ── Step 11: updates_opt_in → decline (→ hipaa_disclaimer directly, no
    //   phone steps, because providerIntent === "join") ────────────────────
    await waitFor(() => expect(getByTestId("updates-no-btn")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("updates-no-btn"));

    // ── Step 12: hipaa_disclaimer → accept and create account ─────────────
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
    expect(payload.joinOrganizationId, "joinOrganizationId must be the selected practice id").toBe("org-1");
    expect(payload.createOrganization, "createOrganization must be false for a practice join").toBe(false);
    // Sanity-check: practice name is omitted when joining (no new org created)
    expect(payload.practiceName, "practiceName must be omitted when joining an existing practice").toBeUndefined();
    expect(payload.practiceAddress, "joining must not overwrite the existing practice address").toBeUndefined();
    expect(payload.address, "joining must not send an address").toBeUndefined();
    expect(payload.accountNumber, "provider account numbers must not be synthesized by the mobile client").toBeUndefined();
  });
});
