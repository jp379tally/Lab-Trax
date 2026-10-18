import React from "react";
import {
  act,
  cleanup,
  render,
  waitFor,
} from "@testing-library/react-native/pure";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";

vi.unmock("@/lib/auth-context");
vi.unmock("@/lib/query-client");

import { AuthProvider, useAuth } from "@/lib/auth-context";
import { clearTokens, getAccessToken } from "@/lib/query-client";

const AUTH_KEY = "@drivesync_auth";
const defaultSetItem = vi.mocked(AsyncStorage.setItem).getMockImplementation();

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validLoginResponse() {
  return {
    success: true,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    user: { id: "test-user-id", username: "test-lab", userType: "lab" },
  };
}

let currentAuth: ReturnType<typeof useAuth> | null = null;

function AuthProbe() {
  currentAuth = useAuth();
  return null;
}

function mockServer(loginBody: unknown, loginStatus = 200) {
  setMockFetchHandler((url) => {
    if (url.endsWith("/api/auth/login")) {
      return response(loginBody, loginStatus);
    }
    if (url.endsWith("/api/auth/users")) {
      return response({ users: [] });
    }
    return response({ success: true });
  });
}

async function mountAuthProvider() {
  const view = render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
  await waitFor(() => expect(currentAuth?.isAuthLoading).toBe(false));
  return view;
}

beforeEach(async () => {
  currentAuth = null;
  resetMockFetchHandler();
  await cleanup();
  await AsyncStorage.clear();
  if (defaultSetItem) {
    vi.mocked(AsyncStorage.setItem).mockImplementation(defaultSetItem);
  }
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue(undefined);
  await clearTokens();
});

afterEach(async () => {
  await cleanup();
  await AsyncStorage.clear();
  await clearTokens();
  currentAuth = null;
  resetMockFetchHandler();
  vi.restoreAllMocks();
});

describe("mobile login session atomicity", () => {
  it("authenticates only after a successful login and required session setup", async () => {
    mockServer(validLoginResponse());
    await mountAuthProvider();

    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["login"]>> | undefined;
    await act(async () => {
      result = await currentAuth!.login("test-lab", "test-password");
    });

    expect(result?.success).toBe(true);
    expect(currentAuth?.isAuthenticated).toBe(true);
    expect(currentAuth?.currentUser).toBe("test-lab");
    expect(currentAuth?.currentUserId).toBe("test-user-id");
  });

  it("keeps the app unauthenticated when the server rejects credentials", async () => {
    mockServer({ message: "Invalid username or password." }, 401);
    await mountAuthProvider();

    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["login"]>> | undefined;
    await act(async () => {
      result = await currentAuth!.login("test-lab", "wrong-password");
    });

    expect(result?.success).toBe(false);
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(currentAuth?.currentUser).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("keeps the app unauthenticated while a two-factor challenge is pending", async () => {
    mockServer({ requiresTwoFactor: true, pendingToken: "pending-test-token" });
    await mountAuthProvider();

    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["login"]>> | undefined;
    await act(async () => {
      result = await currentAuth!.login("test-lab", "test-password");
    });

    expect(result?.requiresTwoFactor).toBe(true);
    expect(result?.pendingToken).toBe("pending-test-token");
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(currentAuth?.currentUser).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("rejects a native success response that has no usable token pair", async () => {
    mockServer({
      ...validLoginResponse(),
      accessToken: "",
      refreshToken: "",
    });
    await mountAuthProvider();

    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["login"]>> | undefined;
    await act(async () => {
      result = await currentAuth!.login("test-lab", "test-password");
    });

    expect(result?.success).toBe(false);
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(currentAuth?.currentUser).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(await AsyncStorage.getItem(AUTH_KEY)).toBeNull();
  });

  it("rolls back tokens and auth state if remembered-session persistence fails", async () => {
    mockServer(validLoginResponse());
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === AUTH_KEY) {
        throw new Error("storage write failed");
      }
      await defaultSetItem?.(key, value);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mountAuthProvider();

    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["login"]>> | undefined;
    await act(async () => {
      result = await currentAuth!.login("test-lab", "test-password");
    });

    expect(result?.success).toBe(false);
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(currentAuth?.currentUser).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(await AsyncStorage.getItem(AUTH_KEY)).toBeNull();
  });
});
