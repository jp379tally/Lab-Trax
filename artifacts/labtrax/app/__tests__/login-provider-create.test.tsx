/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Drives the mobile sign-up flow through the provider_intent-create branch:
 *   welcome → credentials → user_type → provider_intent (provider-intent-create)
 *   → license → practice_info (fills practiceName / doctorName / address)
 *   → provider_match (skip or pick a match) → email_verify → updates_opt_in
 *   → role_select → join_group → hipaa_disclaimer → register()
 *
 * Without this test a regression in the create-a-new-practice path would
 * silently strand new independent providers at sign-up with no visible error.
 *
 * Two scenarios are covered:
 *   1. No matching practice returned → provider_match skipped → register() with
 *      createOrganization:true + practiceName/doctorName set.
 *   2. Matches returned → provider_match shown → user picks "None of these" →
 *      register() with createOrganization:true + practiceName/doctorName set.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock() factories that
// reference it, because vi.mock() factories are hoisted above all imports.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  registerFn: vi.fn(async (_payload: unknown) => ({ success: true })),
  apiRequestFn: vi.fn(async (_method: string, _path: string, _body?: unknown) => ({
    json: async () => ({}),
    ok: true,
  })),
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
import { Alert, StyleSheet } from "react-native";
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RenderResult = Awaited<ReturnType<typeof render>>;

function makeApiRequestImpl(returnMatches: boolean) {
  return async (method: string, path: string, _body?: unknown) => {
    if (method === "POST" && path === "/api/check-username") {
      return { json: async () => ({ available: true }), ok: true };
    }
    if (method === "GET" && path.startsWith("/api/auth/check-email")) {
      return {
        json: async () => ({ data: { available: true } }),
        ok: true,
      };
    }
    if (method === "GET" && path.startsWith("/api/auth/lookup-provider-matches")) {
      const matches = returnMatches
        ? [
            {
              orgId: "match-org-1",
              practiceName: "Sunrise Dental",
              labName: "Metro Lab",
              city: "Denver",
              state: "CO",
              platformAccountNumber: null,
            },
          ]
        : [];
      return {
        json: async () => ({ data: { matches } }),
        ok: true,
      };
    }
    if (method === "POST" && path === "/api/send-email-code") {
      return { json: async () => ({}), ok: true };
    }
    if (method === "POST" && (path === "/api/verify-email-code" || path === "/api/verify-phone-code")) {
      return { json: async () => ({ verified: true }), ok: true };
    }
    return { json: async () => ({}), ok: true };
  };
}

async function renderLoginScreen() {
  const utils = await render(<LoginScreen />);
  await waitFor(() => expect(utils.getByTestId("switch-mode-btn")).toBeTruthy());
  return utils;
}

/**
 * Walk welcome → credentials → user_type → provider_intent (create) → license
 * → practice_info with all fields filled, stopping just before pressing Continue.
 */
async function walkToPracticeInfoFilled(
  getByTestId: RenderResult["getByTestId"],
) {
  // ── Step 1: switch to signup mode ────────────────────────────────────────
  await fireEvent.press(getByTestId("switch-mode-btn"));

  // ── Step 2: welcome ───────────────────────────────────────────────────────
  await waitFor(() => expect(getByTestId("welcome-get-started-btn")).toBeTruthy());
  await fireEvent.press(getByTestId("welcome-get-started-btn"));

  // ── Step 3: credentials ──────────────────────────────────────────────────
  await waitFor(() => expect(getByTestId("signup-username")).toBeTruthy());
  await fireEvent.changeText(getByTestId("signup-username"), "drjones");
  await fireEvent.changeText(getByTestId("signup-email"), "drjones@example.com");
  await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
  await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word1");
  await fireEvent.press(getByTestId("signup-next-btn"));

  // ── Step 4: user_type → provider ─────────────────────────────────────────
  await waitFor(() => expect(getByTestId("user-type-provider")).toBeTruthy(), {
    timeout: 3000,
  });
  await fireEvent.press(getByTestId("user-type-provider"));

  // ── Step 5: provider_intent → create ─────────────────────────────────────
  await waitFor(() =>
    expect(getByTestId("provider-intent-create")).toBeTruthy(),
  );
  await fireEvent.press(getByTestId("provider-intent-create"));

  // ── Step 6: license ───────────────────────────────────────────────────────
  await waitFor(() => expect(getByTestId("license-number")).toBeTruthy());
  await fireEvent.changeText(getByTestId("license-number"), "DDS-12345");
  await fireEvent.press(getByTestId("license-next-btn"));

  // ── Step 7: practice_info — fill all required fields ─────────────────────
  await waitFor(() => expect(getByTestId("practice-name")).toBeTruthy());
  await fireEvent.changeText(getByTestId("practice-name"), "Jones Dental Group");
  await fireEvent.changeText(getByTestId("doctor-name"), "Dr. Avery Example");
  await fireEvent.changeText(getByTestId("street-address"), "456 Oak Ave");
  await fireEvent.changeText(getByTestId("city"), "Denver");
  await fireEvent.changeText(getByTestId("state"), "CO");
  await fireEvent.changeText(getByTestId("zip-code"), "80201");
  await fireEvent.changeText(getByTestId("practice-phone"), "3035550199");
}

/**
 * Walk email_verify → updates_opt_in (decline) →
 * join_group (skip) → hipaa_disclaimer (accept).
 *
 * The "Skip for now" button in join_group has no testID so we locate it by
 * text content via `getByText`.
 */
async function walkEmailVerifyToHipaa(
  getByTestId: RenderResult["getByTestId"],
  getByText: RenderResult["getByText"],
  updatesOrSelect: boolean | (() => Promise<void>) = false,
) {
  const updates = typeof updatesOrSelect === "boolean" ? updatesOrSelect : false;
  const selectPartners = typeof updatesOrSelect === "function" ? updatesOrSelect : undefined;
  // ── email_verify — 6-digit OTP ────────────────────────────────────────────
  await waitFor(() => expect(getByTestId("email-code-0")).toBeTruthy(), {
    timeout: 3000,
  });
  for (let i = 0; i < 6; i++) {
    await fireEvent.changeText(getByTestId(`email-code-${i}`), String(i + 1));
  }
  await fireEvent.press(getByTestId("verify-email-btn"));

  // ── updates_opt_in → decline (no phone steps) ─────────────────────────────
  await waitFor(() => expect(getByTestId("updates-no-btn")).toBeTruthy(), {
    timeout: 3000,
  });
  await fireEvent.press(getByTestId(updates ? "updates-yes-btn" : "updates-no-btn"));
  if (updates) {
    await fireEvent.changeText(getByTestId("signup-phone"), "3035550188");
    await fireEvent.press(getByTestId("send-phone-code-btn"));
    await waitFor(() => expect(getByTestId("phone-code-0")).toBeTruthy());
    for (let i = 0; i < 6; i++) await fireEvent.changeText(getByTestId(`phone-code-${i}`), String(i + 1));
    await fireEvent.press(getByTestId("verify-phone-btn"));
    await waitFor(() => expect(getByTestId("phone-contact-name")).toBeTruthy());
    await fireEvent.changeText(getByTestId("phone-contact-name"), "Dr. Avery Example");
    await fireEvent.press(getByTestId("phone-contact-next-btn"));
    await waitFor(() => expect(getByText("Skip for now")).toBeTruthy());
    await fireEvent.press(getByTestId("signup-back-btn"));
    expect(getByTestId("phone-contact-name").props.value).toBe("Dr. Avery Example");
    await fireEvent.press(getByTestId("phone-contact-next-btn"));
  }

  // ── join_group → skip (button has no testID, located by text) ────────────
  await waitFor(() => expect(getByText("Skip for now")).toBeTruthy(), {
    timeout: 3000,
  });
  if (selectPartners) await selectPartners();
  else await fireEvent.press(getByText("Skip for now"));

  // ── hipaa_disclaimer → check + accept ────────────────────────────────────
  await waitFor(() => expect(getByTestId("provider-plan-free")).toBeTruthy());
  await fireEvent.press(getByTestId("provider-plan-free"));
  await fireEvent.press(getByTestId("provider-plan-continue"));
  await waitFor(() => expect(getByTestId("hipaa-checkbox")).toBeTruthy(), {
    timeout: 3000,
  });
  await fireEvent.press(getByTestId("hipaa-checkbox"));
  await fireEvent.press(getByTestId("hipaa-accept-btn"));
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(Alert, "alert").mockReset().mockImplementation(() => {});
  mockState.registerFn.mockReset();
  mockState.registerFn.mockResolvedValue({ success: true });
  mockState.apiRequestFn.mockReset();
  mockState.apiRequestFn.mockImplementation(makeApiRequestImpl(false));
});

afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoginScreen — provider create-a-new-practice sign-up flow", () => {
  it.each([false, true])("new practice omits role selection and preserves the optional contact branch (updates=%s)", async (updates) => {
    mockState.apiRequestFn.mockImplementation(makeApiRequestImpl(false));

    const { getByTestId, getByText, queryByTestId } = await renderLoginScreen();

    await walkToPracticeInfoFilled(getByTestId);
    expect(getByTestId("creator-ownership-guidance")).toBeTruthy();
    expect(queryByTestId("role-user")).toBeNull();
    expect(queryByTestId("role-admin")).toBeNull();

    // Continue from practice_info — lookup returns no matches, so sendEmailCode
    // is called immediately and the screen jumps to email_verify.
    await fireEvent.press(getByTestId("practice-info-next-btn"));

    await walkEmailVerifyToHipaa(getByTestId, getByText, updates);

    // ── Assertion ──────────────────────────────────────────────────────────
    await waitFor(
      () => expect(mockState.registerFn).toHaveBeenCalledOnce(),
      { timeout: 3000 },
    );

    const payload = mockState.registerFn.mock.calls[0][0] as Record<string, unknown>;
    expect(
      payload.createOrganization,
      "createOrganization must be true when creating a new practice",
    ).toBe(true);
    expect(
      payload.practiceName,
      "practiceName must be the value entered in practice_info",
    ).toBe("Jones Dental Group");
    expect(
      payload.doctorName,
      "doctorName must be the value entered in practice_info",
    ).toBe("Dr. Avery Example");
    expect(
      payload.joinOrganizationId,
      "joinOrganizationId must be absent when no match is selected",
    ).toBeUndefined();
    expect(payload.practiceAddress).toBe("456 Oak Ave, Denver, CO, 80201");
    expect(payload.address).toEqual({
      line1: "456 Oak Ave",
      city: "Denver",
      state: "CO",
      zip: "80201",
    });
    expect(
      payload.accountNumber,
      "provider account numbers must not be synthesized by the mobile client",
    ).toBeUndefined();
  });

  it("matches found + 'None of these': registers with createOrganization:true + practiceName/doctorName", async () => {
    mockState.apiRequestFn.mockImplementation(makeApiRequestImpl(true));

    const { getByTestId, getByText } = await renderLoginScreen();

    await walkToPracticeInfoFilled(getByTestId);

    // Continue from practice_info — lookup returns a match, so the screen
    // transitions to provider_match.
    await fireEvent.press(getByTestId("practice-info-next-btn"));

    // ── provider_match → "None of these" ──────────────────────────────────
    await waitFor(() => expect(getByTestId("provider-match-none")).toBeTruthy(), {
      timeout: 3000,
    });
    await fireEvent.press(getByTestId("provider-match-none"));

    await walkEmailVerifyToHipaa(getByTestId, getByText);

    // ── Assertion ──────────────────────────────────────────────────────────
    await waitFor(
      () => expect(mockState.registerFn).toHaveBeenCalledOnce(),
      { timeout: 3000 },
    );

    const payload = mockState.registerFn.mock.calls[0][0] as Record<string, unknown>;
    expect(
      payload.createOrganization,
      "createOrganization must be true when user rejects all matches",
    ).toBe(true);
    expect(
      payload.practiceName,
      "practiceName must be the value entered in practice_info",
    ).toBe("Jones Dental Group");
    expect(
      payload.doctorName,
      "doctorName must be the value entered in practice_info",
    ).toBe("Dr. Avery Example");
    expect(
      payload.joinOrganizationId,
      "joinOrganizationId must be absent when no match is selected",
    ).toBeUndefined();
    expect(payload.practiceAddress).toBe("456 Oak Ave, Denver, CO, 80201");
    expect(payload.address).toEqual({
      line1: "456 Oak Ave",
      city: "Denver",
      state: "CO",
      zip: "80201",
    });
    expect(payload.accountNumber).toBeUndefined();
  });

  it("selecting an existing match requests approval instead of creating an owned practice", async () => {
    mockState.apiRequestFn.mockImplementation(makeApiRequestImpl(true));
    const { getByTestId, queryByTestId } = await renderLoginScreen();
    await walkToPracticeInfoFilled(getByTestId);
    await fireEvent.press(getByTestId("practice-info-next-btn"));
    await waitFor(() => expect(getByTestId("provider-match-card-match-org-1")).toBeTruthy());
    await fireEvent.press(getByTestId("provider-match-card-match-org-1"));
    await waitFor(() => expect(getByTestId("email-code-0")).toBeTruthy());
    for (let i = 0; i < 6; i++) await fireEvent.changeText(getByTestId(`email-code-${i}`), String(i + 1));
    await fireEvent.press(getByTestId("verify-email-btn"));
    await waitFor(() => expect(getByTestId("updates-no-btn")).toBeTruthy());
    await fireEvent.press(getByTestId("updates-no-btn"));
    await waitFor(() => expect(getByTestId("hipaa-checkbox")).toBeTruthy());
    expect(queryByTestId("partner-lab-search")).toBeNull();
    expect(queryByTestId("role-user")).toBeNull();
    expect(queryByTestId("role-admin")).toBeNull();
    await fireEvent.press(getByTestId("hipaa-checkbox"));
    await fireEvent.press(getByTestId("hipaa-accept-btn"));
    await waitFor(() => expect(mockState.registerFn).toHaveBeenCalledOnce());
    const payload = mockState.registerFn.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ joinOrganizationId: "match-org-1", createOrganization: false, partnerLabSelections: [], role: "user" });
    expect(payload.practiceName).toBeUndefined();
    expect(payload.address).toBeUndefined();
  });

  it.each([1, 2])("retains %i independently selected partner labs and submits them with practice creation", async (count) => {
    const base = makeApiRequestImpl(false);
    mockState.apiRequestFn.mockImplementation(async (method, path, body) => {
      if (path.startsWith("/api/labs/lookup")) {
        const query = decodeURIComponent(path.split("q=")[1]);
        const i = query.includes("Two") ? 2 : 1;
        return { ok: true, json: async () => ({ labs: [{ id: `token-${i}`, selectionKey: `key-${i}`, displayName: i === 1 ? "Lab One" : "Lab Two", city: "Denver", state: "CO" }] }) };
      }
      return base(method, path, body);
    });
    const utils = await renderLoginScreen();
    const { getByTestId, getByText } = utils;
    await walkToPracticeInfoFilled(getByTestId);
    await fireEvent.press(getByTestId("practice-info-next-btn"));
    await walkEmailVerifyToHipaa(getByTestId, getByText, async () => {
      expect(getByText("Partner with a lab")).toBeTruthy();
      expect(getByText("Select one or multiple labs")).toBeTruthy();
      expect(within(getByTestId("signup-scroll")).queryByTestId("partnership-action-bar")).toBeNull();
      expect(StyleSheet.flatten(getByTestId("partnership-action-bar").props.style).paddingBottom).toBe(34);
      expect(getByTestId("partner-labs-continue").props.accessibilityState.disabled).toBe(true);
      for (let i = 1; i <= count; i++) {
        await fireEvent.changeText(getByTestId("partner-lab-search"), i === 1 ? "One" : "Two");
        await waitFor(() => expect(getByTestId(`partner-result-key-${i}`)).toBeTruthy());
        await fireEvent.press(getByTestId(`partner-result-key-${i}`));
        expect(getByTestId(`partner-result-key-${i}`).props.accessibilityState.checked).toBe(true);
        expect(mockState.registerFn).not.toHaveBeenCalled();
      }
      if (count === 2) {
        await fireEvent.press(getByTestId("remove-partner-key-2"));
        expect(getByTestId("remove-partner-key-1")).toBeTruthy();
        expect(getByTestId("partner-result-key-2").props.accessibilityState.checked).toBe(false);
        await fireEvent.press(getByTestId("partner-result-key-2"));
      }
      await fireEvent.press(getByTestId("partner-labs-continue"));
      expect(getByTestId("partners-confirmed")).toBeTruthy();
      expect(Alert.alert).not.toHaveBeenCalled();
      await fireEvent.press(getByTestId("signup-back-btn"));
      for (let i = 1; i <= count; i++) expect(getByTestId(`remove-partner-key-${i}`)).toBeTruthy();
      await fireEvent.press(getByTestId("partner-labs-continue"));
    });
    await waitFor(() => expect(mockState.registerFn).toHaveBeenCalledOnce());
    expect(mockState.registerFn.mock.calls[0][0]).toMatchObject({
      createOrganization: true, practiceName: "Jones Dental Group",
      partnerLabSelections: Array.from({ length: count }, (_, i) => `token-${i + 1}`),
    });
    expect(mockState.apiRequestFn.mock.calls.some(([, path]) => path.includes("/join-requests") || path === "/api/labs/groups")).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith("Partnership requests submitted", expect.stringContaining("Lab One"));
  });

  it("prevents repeated lookup-token duplicates, supports removal, and ignores stale searches", async () => {
    const base = makeApiRequestImpl(false);
    let token = 0;
    let resolveOld!: (value: { ok: boolean; json: () => Promise<object> }) => void;
    mockState.apiRequestFn.mockImplementation(async (method, path, body) => {
      if (path.includes("/api/labs/lookup")) {
        if (path.endsWith("q=old")) return new Promise((resolve) => { resolveOld = resolve; });
        return { ok: true, json: async () => ({ labs: [{ id: `token-${++token}`, selectionKey: "stable", displayName: "One Lab", city: null, state: null }] }) };
      }
      return base(method, path, body);
    });
    const { getByTestId, getByText, queryByText, queryByTestId } = await renderLoginScreen();
    await walkToPracticeInfoFilled(getByTestId);
    await fireEvent.press(getByTestId("practice-info-next-btn"));
    await walkEmailVerifyToHipaa(getByTestId, getByText, async () => {
      await fireEvent.changeText(getByTestId("partner-lab-search"), "One");
      await waitFor(() => expect(getByTestId("partner-result-stable")).toBeTruthy());
      await fireEvent.press(getByTestId("partner-result-stable"));
      await fireEvent.changeText(getByTestId("partner-lab-search"), "again");
      await waitFor(() => expect(token).toBe(2));
      await waitFor(() => expect(getByTestId("partner-result-stable")).toBeTruthy());
      await fireEvent.press(getByTestId("partner-result-stable"));
      expect(queryByTestId("remove-partner-stable")).toBeNull();
      await fireEvent.press(getByTestId("partner-result-stable"));
      expect(getByText("1 labs selected")).toBeTruthy();
      await fireEvent.press(getByTestId("remove-partner-stable"));
      expect(queryByTestId("remove-partner-stable")).toBeNull();
      await fireEvent.changeText(getByTestId("partner-lab-search"), "old");
      await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
      await fireEvent.changeText(getByTestId("partner-lab-search"), "");
      resolveOld({ ok: true, json: async () => ({ labs: [{ id: "stale", displayName: "Stale Lab" }] }) });
      expect(queryByText("Stale Lab")).toBeNull();
      await fireEvent.press(getByText("Skip for now"));
    });
    await waitFor(() => expect(mockState.registerFn).toHaveBeenCalledOnce());
    expect(mockState.registerFn.mock.calls[0][0]).toMatchObject({ partnerLabSelections: [], createOrganization: true });
  });

  it("keeps confirmed labs on failed registration and guards processing before a successful retry", async () => {
    const base = makeApiRequestImpl(false);
    mockState.apiRequestFn.mockImplementation(async (method, path, body) =>
      path.startsWith("/api/labs/lookup")
        ? { ok: true, json: async () => ({ labs: [{ id: "sdr-token", selectionKey: "sdr", displayName: "SDR1", city: null, state: null }] }) }
        : base(method, path, body));
    mockState.registerFn.mockResolvedValueOnce({ success: false, error: "Correct the request and retry" } as { success: boolean });
    const utils = await renderLoginScreen();
    await walkToPracticeInfoFilled(utils.getByTestId);
    await fireEvent.press(utils.getByTestId("practice-info-next-btn"));
    await walkEmailVerifyToHipaa(utils.getByTestId, utils.getByText, async () => {
      await fireEvent.changeText(utils.getByTestId("partner-lab-search"), "SDR");
      await waitFor(() => expect(utils.getByTestId("partner-result-sdr")).toBeTruthy());
      await fireEvent.press(utils.getByTestId("partner-result-sdr"));
      await fireEvent.changeText(utils.getByTestId("partner-lab-search"), "");
      expect(utils.getByTestId("remove-partner-sdr")).toBeTruthy();
      await fireEvent.press(utils.getByTestId("partner-labs-continue"));
      expect(utils.getByTestId("partners-confirmed")).toBeTruthy();
    });
    await waitFor(() => expect(utils.getByText("Correct the request and retry")).toBeTruthy());
    expect(Alert.alert).not.toHaveBeenCalled();
    let resolve!: (value: { success: boolean }) => void;
    mockState.registerFn.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await act(async () => {
      const first = utils.getByTestId("hipaa-accept-btn").props.onPress();
      const second = utils.getByTestId("hipaa-accept-btn").props.onPress();
      expect(mockState.registerFn).toHaveBeenCalledTimes(2);
      expect(mockState.registerFn.mock.calls[1][0]).toMatchObject({ partnerLabSelections: ["sdr-token"] });
      resolve({ success: true });
      await Promise.all([first, second]);
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Partnership requests submitted", expect.stringContaining("SDR1")));
  });
});
