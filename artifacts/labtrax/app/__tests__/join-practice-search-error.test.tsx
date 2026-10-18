/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Verifies that the join_practice step shows a distinct error state (not the
 * empty-results message) when the practices/lookup API call throws, and that
 * the Retry button re-fires the search so the user can recover without
 * retyping their query.
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
// Hoisted mock state — must be declared before vi.mock() factories.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  apiRequestFn: vi.fn(async (_method: string, _path: string, _body?: unknown) => {
    return { json: async () => ({}), ok: true };
  }),
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { name: "LabTrax", slug: "labtrax", version: "1.0.0" },
  },
}));

vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
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
    register: vi.fn(async () => ({ success: true })),
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function renderLoginScreen() {
  return render(<LoginScreen />);
}

/** Navigate to the join_practice step via the fastest path through sign-up. */
async function navigateToJoinPractice(
  utils: Awaited<ReturnType<typeof renderLoginScreen>>,
) {
  const { getByTestId } = utils;

  // signin → signup
  await fireEvent.press(getByTestId("switch-mode-btn"));

  // welcome → credentials
  await waitFor(() => expect(getByTestId("welcome-get-started-btn")).toBeTruthy());
  await fireEvent.press(getByTestId("welcome-get-started-btn"));

  // fill credentials
  await waitFor(() => expect(getByTestId("signup-username")).toBeTruthy());
  await fireEvent.changeText(getByTestId("signup-username"), "drjones");
  await fireEvent.changeText(getByTestId("signup-email"), "drjones@example.com");
  await fireEvent.changeText(getByTestId("signup-password"), "Pass@word1");
  await fireEvent.changeText(getByTestId("signup-confirm-password"), "Pass@word1");
  await fireEvent.press(getByTestId("signup-next-btn"));

  // user_type → provider
  await waitFor(() => expect(getByTestId("user-type-provider")).toBeTruthy(), {
    timeout: 3000,
  });
  await fireEvent.press(getByTestId("user-type-provider"));

  // provider_intent → join
  await waitFor(() => expect(getByTestId("provider-intent-join")).toBeTruthy());
  await fireEvent.press(getByTestId("provider-intent-join"));

  // license → continue
  await waitFor(() => expect(getByTestId("license-number")).toBeTruthy());
  await fireEvent.changeText(getByTestId("license-number"), "DDS-12345");
  await fireEvent.press(getByTestId("license-next-btn"));

  // arrive at join_practice
  await waitFor(() =>
    expect(getByTestId("practice-search-input")).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.apiRequestFn.mockReset();
  mockState.apiRequestFn.mockImplementation(
    async (method: string, path: string) => {
      if (method === "POST" && path === "/api/check-username") {
        return { json: async () => ({ available: true }), ok: true };
      }
      if (method === "GET" && path.startsWith("/api/auth/check-email")) {
        return { json: async () => ({ data: { available: true } }), ok: true };
      }
      // Default: success with empty practices list
      if (method === "GET" && path.startsWith("/api/practices/lookup")) {
        return { json: async () => ({ practices: [] }), ok: true };
      }
      return { json: async () => ({}), ok: true };
    },
  );
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoginScreen — join_practice search error state", () => {
  it("shows a distinct error message (not empty-results) when apiRequest throws", async () => {
    // Make the lookup call throw a network error
    mockState.apiRequestFn.mockImplementation(
      async (method: string, path: string) => {
        if (method === "POST" && path === "/api/check-username") {
          return { json: async () => ({ available: true }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/auth/check-email")) {
          return { json: async () => ({ data: { available: true } }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/practices/lookup")) {
          throw new Error("Network request failed");
        }
        return { json: async () => ({}), ok: true };
      },
    );

    const utils = await renderLoginScreen();
    await navigateToJoinPractice(utils);

    const { getByTestId, getByText, queryByText } = utils;

    // Type a query long enough to fire the search
    await fireEvent.changeText(getByTestId("practice-search-input"), "Metro Dental");

    // The error panel must appear
    await waitFor(() => expect(getByTestId("practice-search-error")).toBeTruthy(), {
      timeout: 3000,
    });

    // The error message text is distinct from the empty-results copy
    expect(
      getByText(/Could not search practices/i),
    ).toBeTruthy();

    // The empty-results copy must NOT be shown at the same time
    expect(queryByText("No practices match your search")).toBeNull();

    // The Retry button is present
    expect(getByTestId("practice-search-retry-btn")).toBeTruthy();
  });

  it("clears the error and re-fires the search when Retry is pressed", async () => {
    let lookupCallCount = 0;

    mockState.apiRequestFn.mockImplementation(
      async (method: string, path: string) => {
        if (method === "POST" && path === "/api/check-username") {
          return { json: async () => ({ available: true }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/auth/check-email")) {
          return { json: async () => ({ data: { available: true } }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/practices/lookup")) {
          lookupCallCount += 1;
          if (lookupCallCount === 1) {
            // First attempt fails
            throw new Error("Network request failed");
          }
          // Subsequent attempts succeed
          return {
            json: async () => ({
              practices: [
                {
                  id: "org-recover-1",
                  name: "Recovery Dental",
                  displayName: "Recovery Dental",
                  addressLine1: null,
                  city: "Boston",
                  state: "MA",
                  zip: null,
                  phone: null,
                  parentLabName: null,
                },
              ],
            }),
            ok: true,
          };
        }
        return { json: async () => ({}), ok: true };
      },
    );

    const utils = await renderLoginScreen();
    await navigateToJoinPractice(utils);

    const { getByTestId } = utils;

    // Type to trigger the (failing) search
    await fireEvent.changeText(getByTestId("practice-search-input"), "Recovery");

    // Wait for error state
    await waitFor(() => expect(getByTestId("practice-search-error")).toBeTruthy(), {
      timeout: 3000,
    });

    // Press Retry — the second attempt succeeds
    await fireEvent.press(getByTestId("practice-search-retry-btn"));

    // The result from the successful retry must be visible
    await waitFor(
      () => expect(getByTestId("practice-result-org-recover-1")).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  it("clears the error state when the user modifies the search query", async () => {
    let lookupCallCount = 0;

    mockState.apiRequestFn.mockImplementation(
      async (method: string, path: string) => {
        if (method === "POST" && path === "/api/check-username") {
          return { json: async () => ({ available: true }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/auth/check-email")) {
          return { json: async () => ({ data: { available: true } }), ok: true };
        }
        if (method === "GET" && path.startsWith("/api/practices/lookup")) {
          lookupCallCount += 1;
          if (lookupCallCount === 1) {
            throw new Error("Network request failed");
          }
          return { json: async () => ({ practices: [] }), ok: true };
        }
        return { json: async () => ({}), ok: true };
      },
    );

    const utils = await renderLoginScreen();
    await navigateToJoinPractice(utils);

    const { getByTestId, queryByTestId } = utils;

    // Trigger failing search
    await fireEvent.changeText(getByTestId("practice-search-input"), "Fail Dental");

    await waitFor(() => expect(getByTestId("practice-search-error")).toBeTruthy(), {
      timeout: 3000,
    });

    // Modify the search text — error should clear immediately
    await fireEvent.changeText(getByTestId("practice-search-input"), "New");

    // Query is now < 2 chars effectively the typed value changes from "Fail Dental"
    // to "New" (3 chars) but the effect clears error immediately on launch.
    // After the debounce resolves the second request succeeds, so error is gone.
    await waitFor(
      () => expect(queryByTestId("practice-search-error")).toBeNull(),
      { timeout: 3000 },
    );
  });
});
