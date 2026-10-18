import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react-native/pure";
import { QueryClientProvider } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

vi.unmock("@/lib/auth-context");
vi.unmock("@/lib/query-client");
vi.unmock("@/lib/authed-media-cache");
vi.unmock("@tanstack/react-query");

import DashboardScreen from "../(tabs)/dashboard";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { useMe } from "@/lib/auth-me";
import { clearTokens, queryClient } from "@/lib/query-client";

let auth: ReturnType<typeof useAuth> | undefined;
let me: ReturnType<typeof useMe> | undefined;
const nativeSecureStorage = new Map<string, string>();
const secureDefaults = {
  get: vi.mocked(SecureStore.getItemAsync).getMockImplementation(),
  set: vi.mocked(SecureStore.setItemAsync).getMockImplementation(),
  remove: vi.mocked(SecureStore.deleteItemAsync).getMockImplementation(),
};
const user = { id: "test-user-id", username: "test-lab", userType: "lab" };
const membership = {
  id: "test-membership", organizationId: "test-lab-org", role: "owner",
  status: "active", organization: { id: "test-lab-org", name: "Test lab", type: "lab" },
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function SignedInApp() {
  auth = useAuth();
  me = useMe();
  return auth.isAuthenticated ? <DashboardScreen /> : null;
}

async function mount() {
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider><SignedInApp /></AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(auth?.isAuthLoading).toBe(false));
  return view;
}

beforeEach(async () => {
  await cleanup();
  await clearTokens();
  await AsyncStorage.clear();
  queryClient.clear();
  nativeSecureStorage.clear();
  auth = undefined;
  me = undefined;
  // Reproduce native's defined window with no browser event methods. Requests
  // are intercepted with fake users: no production credentials or server calls.
  vi.stubGlobal("window", globalThis);
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
    nativeSecureStorage.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    nativeSecureStorage.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    nativeSecureStorage.delete(key);
  });
  setMockFetchHandler((url) => {
    if (url.endsWith("/api/auth/login") || url.endsWith("/api/auth/refresh")) {
      return response({
        success: true, user, accessToken: "fake-test-access", refreshToken: "fake-test-refresh",
      });
    }
    if (url.endsWith("/api/auth/me")) {
      return response({ success: true, user, memberships: [membership] });
    }
    if (url.endsWith("/api/auth/users")) return response({ users: [] });
    if (url.includes("/api/invoices/reports/sales?")) {
      return response({ data: {
        totalRevenue: 0, totalPaid: 0, totalOutstanding: 0,
        totalInvoices: 0, paidInvoices: 0, openInvoices: 0,
      } });
    }
    return response({ success: true, data: [], items: [] });
  });
});

afterEach(async () => {
  await cleanup();
  queryClient.clear();
  await clearTokens();
  await AsyncStorage.clear();
  nativeSecureStorage.clear();
  if (secureDefaults.get) vi.mocked(SecureStore.getItemAsync).mockImplementation(secureDefaults.get);
  if (secureDefaults.set) vi.mocked(SecureStore.setItemAsync).mockImplementation(secureDefaults.set);
  if (secureDefaults.remove) vi.mocked(SecureStore.deleteItemAsync).mockImplementation(secureDefaults.remove);
  resetMockFetchHandler();
  vi.unstubAllGlobals();
});

describe("native password login to the actual DashboardScreen", () => {
  it("renders user/organization data, restores a session, logs out, and signs in again", async () => {
    expect(typeof window.addEventListener).toBe("undefined");
    const first = await mount();
    expect(auth?.isAuthenticated).toBe(false);
    await act(async () => {
      expect((await auth!.login("test-lab", "fake-password")).success).toBe(true);
    });
    await waitFor(() => expect(first.getByTestId("dashboard-profile-header")).toBeTruthy());
    await waitFor(() => expect(me?.data?.memberships).toEqual([membership]));
    expect(auth?.currentUserId).toBe(user.id);
    expect(me?.data?.user).toEqual(user);
    // Prove the full dashboard remains present, not a stubbed landing screen.
    expect(first.getByTestId("dashboard-ai-reader-btn")).toBeTruthy();
    expect(first.getByTestId("dashboard-case-lookup-btn")).toBeTruthy();
    expect(first.getByTestId("dashboard-batch-locate-btn")).toBeTruthy();

    await first.unmount();
    queryClient.clear();
    const reopened = await mount();
    await waitFor(() => expect(reopened.getByTestId("dashboard-profile-header")).toBeTruthy());
    expect(auth?.isAuthenticated).toBe(true);
    expect(auth?.currentUserId).toBe(user.id);
    await waitFor(() => expect(me?.data?.memberships).toEqual([membership]));

    await act(async () => { await auth!.logout(); });
    expect(auth?.isAuthenticated).toBe(false);
    expect(reopened.queryByTestId("dashboard-profile-header")).toBeNull();
    await act(async () => {
      expect((await auth!.login("test-lab", "fake-password")).success).toBe(true);
    });
    await waitFor(() => expect(reopened.getByTestId("dashboard-profile-header")).toBeTruthy());
    await waitFor(() => expect(me?.data?.memberships).toEqual([membership]));
    expect(auth?.currentUserId).toBe(user.id);
  });
});
