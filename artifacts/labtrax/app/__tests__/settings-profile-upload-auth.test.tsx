// Regression test for Task 3592: the profile photo and lab-logo XHR uploads
// silently 401'd when the in-memory access token hadn't been hydrated yet
// from SecureStore. The fix is `await loadTokens()` immediately before the
// token is read via `getAccessToken()` and the XHR is built/sent.
//
// These tests prove the fix by making `loadTokens()` resolve asynchronously
// (simulating a real SecureStore read) and only THEN "hydrating" the token
// that `getAccessToken()` returns. If the `await loadTokens()` call is ever
// removed or the ordering regresses, `getAccessToken()` — and therefore the
// XHR's Authorization header — would run before the token exists, exactly
// reproducing the original silent-401 bug, and the ordering assertions below
// would fail.
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
  vi,
} from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { flushPendingReactUpdates } from "../../vitest.setup";
import * as ImagePicker from "expo-image-picker";
import { Alert } from "react-native";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import { useProfilePhotoUpload } from "@/lib/use-profile-photo-upload";

import ProfileScreen from "../settings/profile";

// --- Hoisted mock state -----------------------------------------------
// vi.mock factories are hoisted above imports, so anything they close over
// must itself be created via vi.hoisted() (see login-provider-join.test.tsx
// for the established pattern in this codebase).
const mockState = vi.hoisted(() => {
  const callOrder: string[] = [];
  let hydratedToken: string | null = null;
  let currentUser: Record<string, unknown> | null = null;

  const loadTokensMock = vi.fn(async () => {
    callOrder.push("loadTokens:start");
    // Simulate the real SecureStore read taking a couple of microtask ticks.
    // A caller that fires the XHR without awaiting this would read
    // `hydratedToken` while it is still null.
    await Promise.resolve();
    await Promise.resolve();
    hydratedToken = "hydrated-access-token";
    callOrder.push("loadTokens:end");
  });

  const getAccessTokenMock = vi.fn(() => {
    callOrder.push(`getAccessToken:${hydratedToken ?? "null"}`);
    return hydratedToken;
  });

  return {
    setPhoto: vi.fn(),
    uploadStatus: 200,
    uploadBody: "",
    callOrder,
    loadTokensMock,
    getAccessTokenMock,
    reset() {
      callOrder.length = 0;
      hydratedToken = null;
      loadTokensMock.mockClear();
      getAccessTokenMock.mockClear();
    },
    setUser(u: Record<string, unknown> | null) {
      currentUser = u;
    },
    getUser() {
      return currentUser;
    },
  };
});
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    currentUserId: mockState.getUser()?.id,
    isAuthenticated: true,
    setProfilePicUri: mockState.setPhoto,
  }),
}));

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  getAccessToken: mockState.getAccessTokenMock,
  loadTokens: mockState.loadTokensMock,
  refreshAndGetAccessToken: vi.fn(async () => null),
  resilientFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  apiRequest: vi.fn(),
  chunkedUploadCaseMedia: vi.fn(async () => ({ ok: true })),
  uploadCaseMedia: vi.fn(async () => ({ ok: true })),
  logDebugEvent: vi.fn(),
  queryClient: { clear: vi.fn(), invalidateQueries: vi.fn(async () => undefined) },
}));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      tint: "#2563EB",
      text: "#0F172A",
      textSecondary: "#475569",
      textTertiary: "#94A3B8",
      border: "#E2E8F0",
      surface: "#FFFFFF",
      surfaceAlt: "#F1F5F9",
      success: "#16A34A",
      error: "#DC2626",
      warning: "#F59E0B",
    },
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: { user: mockState.getUser(), memberships: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })),
    useMutation: vi.fn((opts: any) => {
      const execute = vi.fn(async (variables: unknown) => {
        try {
          const result = await opts.mutationFn(variables);
          await opts.onSuccess?.(result, variables);
          return result;
        } catch (err) {
          opts.onError?.(err, variables);
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

// --- XHR mock -----------------------------------------------------------
// Mirrors the MockXHR pattern used in ai-assistant.test.tsx: records every
// open/setRequestHeader/send call (with ordering) so the test can assert the
// Authorization header carries the token loadTokens() hydrated, and that it
// was set/sent only after loadTokens() resolved.
class MockXHR {
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(_method: string, url: string) {
    mockState.callOrder.push(`xhr:open:${url}`);
  }

  setRequestHeader(name: string, value: string) {
    mockState.callOrder.push(`xhr:header:${name}=${value}`);
  }

  send(_body?: unknown) {
    mockState.callOrder.push("xhr:send");
    setTimeout(() => {
      this.status = mockState.uploadStatus;
      this.responseText = mockState.uploadBody;
      this.onload?.();
    }, 0);
  }
}

function pickedAsset(uri: string) {
  return { canceled: false, assets: [{ uri }] };
}
const it = (
  name: string,
  testFn: () => void | Promise<void>,
  timeout?: number,
): void => {
  vitestIt(
    name,
    async () => {
      await testFn();
      await flushPendingReactUpdates();
    },
    timeout,
  );
};

describe("Profile screen uploads — token hydration before auth header", () => {
  let realXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    mockState.reset();
    mockState.setPhoto.mockReset();
    mockState.uploadStatus = 200;
    mockState.uploadBody = "";
    realXHR = globalThis.XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;

    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: true,
      status: "granted",
    } as any);
  });

  afterEach(() => {
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
  });

  function assertLoadTokensAwaitedBeforeAuthHeader(expectedToken: string) {
    const order = mockState.callOrder;
    const loadStartIdx = order.indexOf("loadTokens:start");
    const loadEndIdx = order.indexOf("loadTokens:end");
    const getAccessIdx = order.findIndex((e) => e.startsWith("getAccessToken:"));
    const headerIdx = order.findIndex((e) => e.startsWith("xhr:header:Authorization="));
    const sendIdx = order.indexOf("xhr:send");

    // loadTokens() was actually called and allowed to finish.
    expect(loadStartIdx).toBeGreaterThanOrEqual(0);
    expect(loadEndIdx).toBeGreaterThan(loadStartIdx);

    // getAccessToken() (and therefore the token used for the XHR) was read
    // only AFTER loadTokens() resolved — this is the exact ordering the fix
    // guarantees and the original bug violated.
    expect(getAccessIdx).toBeGreaterThan(loadEndIdx);
    expect(order[getAccessIdx]).toBe(`getAccessToken:${expectedToken}`);

    // The Authorization header carries the hydrated token and was set after
    // the token was read, before the request was sent.
    expect(headerIdx).toBeGreaterThan(getAccessIdx);
    expect(order[headerIdx]).toBe(`xhr:header:Authorization=Bearer ${expectedToken}`);
    expect(sendIdx).toBeGreaterThan(headerIdx);
  }

  it("awaits loadTokens() before building the profile-photo XHR's Authorization header", async () => {
    mockState.setUser({ id: "user-1", role: "user", practiceOrganizationId: null });
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(
      pickedAsset("file:///tmp/photo.jpg") as any,
    );

    const { getByText } = await render(<ProfileScreen />);

    await act(async () => {
      await fireEvent.press(getByText("Upload photo"));
    });

    await waitFor(() => {
      expect(mockState.callOrder).toContain("xhr:send");
    });

    assertLoadTokensAwaitedBeforeAuthHeader("hydrated-access-token");
    // Sanity check: it really was the profile-photo endpoint, not the logo one.
    expect(
      mockState.callOrder.some((e) => e.startsWith("xhr:open:") && e.includes("/profile-photo")),
    ).toBe(true);
  });

  it("awaits loadTokens() before building the lab-logo XHR's Authorization header", async () => {
    mockState.setUser({
      id: "admin-1",
      role: "admin",
      practiceOrganizationId: "org-1",
    });
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(
      pickedAsset("file:///tmp/logo.png") as any,
    );

    const { getByText } = await render(<ProfileScreen />);

    await act(async () => {
      await fireEvent.press(getByText("Upload logo"));
    });

    await waitFor(() => {
      expect(mockState.callOrder).toContain("xhr:send");
    });
    await waitFor(() => {
      expect(getByText("Upload logo")).toBeTruthy();
    });

    assertLoadTokensAwaitedBeforeAuthHeader("hydrated-access-token");
    expect(
      mockState.callOrder.some((e) => e.startsWith("xhr:open:") && e.includes("/logo")),
    ).toBe(true);
  });

  it("would fail this way if loadTokens() were not awaited (documents the regression it catches)", async () => {
    // Simulate the pre-fix bug directly against the same ordering helper used
    // above: reading the token before loadTokens() resolves means the
    // Authorization header is built from a still-null token.
    const order: string[] = [];
    let hydrated: string | null = null;
    const buggyLoadTokens = async () => {
      order.push("loadTokens:start");
      await Promise.resolve();
      await Promise.resolve();
      hydrated = "hydrated-access-token";
      order.push("loadTokens:end");
    };
    const buggyGetAccessToken = () => {
      order.push(`getAccessToken:${hydrated ?? "null"}`);
      return hydrated;
    };

    // Bug: fire loadTokens() but don't await it before reading the token.
    void buggyLoadTokens();
    const token = buggyGetAccessToken();

    expect(token).toBeNull();
    expect(order).toEqual(["loadTokens:start", "getAccessToken:null"]);
  });

  it("installs a confirmed photo in the account cache and auth avatars even when refresh fails", async () => {
    mockState.setUser({ id: "user-1" });
    const qc = new QueryClient();
    qc.setQueryData(["auth-me", "user-1"], { user: { id: "user-1", profilePhotoUrl: "/old.jpg" }, memberships: [] });
    qc.setQueryData(["auth-me", "other"], { user: { id: "other", profilePhotoUrl: "/other.jpg" }, memberships: [] });
    vi.spyOn(qc, "invalidateQueries").mockRejectedValue(new Error("Offline after commit"));
    vi.mocked(useQueryClient).mockReturnValueOnce(qc);
    mockState.uploadBody = JSON.stringify({ profilePhotoUrl: "/uploads/profile-photos/new.jpg" });
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(pickedAsset("file:///photo.jpg") as any);
    const { result } = await renderHook(() => useProfilePhotoUpload("user-1"));
    const alert = vi.spyOn(Alert, "alert");
    await act(async () => { await result.current.pickAndUploadPhoto(); });
    expect(mockState.setPhoto).toHaveBeenCalledWith("http://localhost/uploads/profile-photos/new.jpg", "user-1");
    expect(qc.getQueryData<any>(["auth-me", "user-1"]).user.profilePhotoUrl).toBe("/uploads/profile-photos/new.jpg");
    expect(qc.getQueryData<any>(["auth-me", "other"]).user.profilePhotoUrl).toBe("/other.jpg");
    expect(alert).not.toHaveBeenCalled();
    expect(result.current.isUploading).toBe(false);
    qc.clear();
  });

  it("leaves the confirmed photo alone on cancellation, denied permission, and a rejected image", async () => {
    mockState.setUser({ id: "user-1" });
    const { result } = await renderHook(() => useProfilePhotoUpload("user-1"));
    const alert = vi.spyOn(Alert, "alert");
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: [] } as any);
    await act(async () => { await result.current.pickAndUploadPhoto(); });
    expect(mockState.callOrder).not.toContain("xhr:send");
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted: false } as any);
    await act(async () => { await result.current.pickAndUploadPhoto(); });
    expect(alert).toHaveBeenCalledWith("Permission required", expect.any(String));
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted: true } as any);
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(pickedAsset("file:///photo.jpg") as any);
    mockState.uploadStatus = 400;
    mockState.uploadBody = JSON.stringify({ message: "Profile photos must be 5 MB or smaller." });
    await act(async () => { await result.current.pickAndUploadPhoto(); });
    expect(alert).toHaveBeenCalledWith("Photo upload failed", "Profile photos must be 5 MB or smaller.");
    expect(mockState.setPhoto).not.toHaveBeenCalled();
    expect(result.current.isUploading).toBe(false);
  });
});
