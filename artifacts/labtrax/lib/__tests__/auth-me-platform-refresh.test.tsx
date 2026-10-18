import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native/pure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

vi.unmock("@tanstack/react-query");

const auth = vi.hoisted(() => ({
  currentUserId: "test-user-id",
  isAuthenticated: true,
  userType: "lab",
  setProfilePicUri: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));

import { useMe } from "@/lib/auth-me";

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, "OS")!;
const clients: QueryClient[] = [];
let appStateCallback: ((state: AppStateStatus) => void) | undefined;
const removeSubscription = vi.fn();
const fetchMe = vi.fn(() => new Response(JSON.stringify({
  success: true,
  user: { id: "test-user-id", profilePhotoUrl: null },
  memberships: [{
    id: "test-membership",
    role: "owner",
    status: "active",
    organizationId: "test-lab",
    organization: { id: "test-lab", name: "Test lab", type: "lab" },
  }],
}), { headers: { "content-type": "application/json" } }));

function setPlatform(os: "ios" | "android" | "web") {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
}

async function mount(syncPhoto = true) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 },
  } });
  clients.push(client);
  return await renderHook(() => useMe(syncPhoto), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.setProfilePicUri.mockClear();
  appStateCallback = undefined;
  removeSubscription.mockClear();
  fetchMe.mockClear();
  setPlatform("ios");
  // React Native's setUpGlobals assigns global.window = global. That does not
  // provide DOM addEventListener/removeEventListener methods.
  vi.stubGlobal("window", globalThis);
  vi.mocked(AppState.addEventListener).mockClear();
  vi.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
    appStateCallback = callback;
    return { remove: removeSubscription };
  });
  setMockFetchHandler((url) => {
    if (url.endsWith("/api/auth/me")) return fetchMe();
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  await cleanup();
  clients.splice(0).forEach((client) => client.clear());
  resetMockFetchHandler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(Platform, "OS", originalPlatform);
});

describe("authenticated profile focus refresh by platform", () => {
  it.each(["ios", "android"] as const)(
    "loads user and organization data on %s when window exists without DOM listeners",
    async (os) => {
      setPlatform(os);
      expect(typeof window.addEventListener).toBe("undefined");
      const view = await mount();
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
      expect(view.result.current.data?.user).toEqual({
        id: "test-user-id", profilePhotoUrl: null,
      });
      expect(view.result.current.data?.memberships[0].organizationId).toBe("test-lab");
      await waitFor(() => expect(auth.setProfilePicUri).toHaveBeenCalledWith(null, "test-user-id"));
      await view.unmount();
      expect(removeSubscription).toHaveBeenCalledOnce();
    },
  );

  it("uses native AppState refresh without touching browser listeners", async () => {
    const browser = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("window", browser);
    const view = await mount();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const beforeResume = fetchMe.mock.calls.length;
    await act(async () => { appStateCallback?.("active"); });
    await waitFor(() => expect(fetchMe.mock.calls.length).toBeGreaterThan(beforeResume));
    expect(browser.addEventListener).not.toHaveBeenCalled();
    await view.unmount();
    expect(browser.removeEventListener).not.toHaveBeenCalled();
    expect(removeSubscription).toHaveBeenCalledOnce();
  });

  it("preserves browser focus refresh and removes the same listener on unmount", async () => {
    setPlatform("web");
    const browser = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("window", browser);
    const view = await mount();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(browser.addEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
    const callback = browser.addEventListener.mock.calls[0][1] as () => void;
    const beforeFocus = fetchMe.mock.calls.length;
    await act(async () => { callback(); });
    await waitFor(() => expect(fetchMe.mock.calls.length).toBeGreaterThan(beforeFocus));
    await view.unmount();
    expect(browser.removeEventListener).toHaveBeenCalledWith("focus", callback);
    expect(removeSubscription).toHaveBeenCalledOnce();
  });

  it("handles a web environment without DOM listener methods", async () => {
    setPlatform("web");
    const view = await mount();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await view.unmount();
    expect(removeSubscription).toHaveBeenCalledOnce();
  });

  it("does not register photo-refresh listeners when synchronization is disabled", async () => {
    const view = await mount(false);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(auth.setProfilePicUri).not.toHaveBeenCalled();
  });

  it("mounts the authenticated hook after login, cleans up at logout, and mounts again", async () => {
    auth.isAuthenticated = false;
    const view = await mount();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
    auth.isAuthenticated = true;
    await view.rerender(undefined);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
    auth.isAuthenticated = false;
    await view.rerender(undefined);
    expect(removeSubscription).toHaveBeenCalledTimes(1);
    auth.isAuthenticated = true;
    await view.rerender(undefined);
    await waitFor(() => expect(AppState.addEventListener).toHaveBeenCalledTimes(2));
    await view.unmount();
    expect(removeSubscription).toHaveBeenCalledTimes(2);
  });
});
