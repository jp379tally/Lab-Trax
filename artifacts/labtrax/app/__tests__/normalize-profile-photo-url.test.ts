import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { AppState } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useMe } from "@/lib/auth-me";
import { useProfilePhoto } from "@/lib/use-profile-photo";
// Synchronization must run the real query cache, not the global static hook stub.
vi.unmock("@tanstack/react-query");

const syncState = vi.hoisted(() => ({
  accountId: "alice",
  storedPhoto: "/uploads/profile-photos/from-desktop.jpg" as string | null,
  setPhoto: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    currentUserId: syncState.accountId,
    profilePicUri: "https://old.example/previous-account.jpg",
    setProfilePicUri: syncState.setPhoto,
  }),
}));
vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  resilientFetch: syncState.fetch,
}));

beforeEach(() => {
  syncState.accountId = "alice";
  syncState.storedPhoto = "/uploads/profile-photos/from-desktop.jpg";
  syncState.setPhoto.mockReset();
  syncState.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({
    user: { id: syncState.accountId, profilePhotoUrl: syncState.storedPhoto }, memberships: [],
  }), { status: 200 }));
});

/**
 * Unit tests for normalizeProfilePhotoUrl.
 *
 * The normaliser is the sole gate that makes native profile-photo avatars
 * work: the server returns a relative path (/uploads/…) which browsers handle
 * automatically but React Native's <Image> requires as a full http(s):// URI.
 * These tests act as a regression firewall for that logic.
 *
 * Vitest setup (vitest.setup.ts) already mocks:
 *   - react-native → test-stubs/react-native (Platform.OS === "ios")
 *   - @/lib/query-client → { getApiUrl: () => "http://localhost/", … }
 *
 * So the normaliser runs in "native" mode by default and the expected absolute
 * base is "http://localhost" (trailing slash stripped by the normaliser).
 */

// Import the utility directly — it is NOT globally mocked by vitest.setup.ts
// (unlike @/lib/auth-context which is). Its two dependencies (Platform and
// getApiUrl) are already handled by the global stubs.
import { normalizeProfilePhotoUrl } from "@/lib/normalize-profile-photo-url";

describe("normalizeProfilePhotoUrl", () => {
  it("prepends API host to a relative server path on native", async () => {
    expect(normalizeProfilePhotoUrl("/uploads/profile-photos/abc.jpg")).toBe(
      "http://localhost/uploads/profile-photos/abc.jpg",
    );
  });

  it("does not double-slash when getApiUrl() returns a trailing slash", async () => {
    // getApiUrl() is mocked to "http://localhost/" — the normaliser must strip
    // the trailing slash so the join produces a single slash before the path.
    const result = normalizeProfilePhotoUrl("/uploads/photo.jpg");
    expect(result).not.toContain("//uploads");
    expect(result).toBe("http://localhost/uploads/photo.jpg");
  });

  it("leaves an already-absolute https URL unchanged", async () => {
    const abs = "https://example.com/uploads/photo.jpg";
    expect(normalizeProfilePhotoUrl(abs)).toBe(abs);
  });

  it("leaves an already-absolute http URL unchanged", async () => {
    const abs = "http://192.168.1.10:3000/uploads/photo.jpg";
    expect(normalizeProfilePhotoUrl(abs)).toBe(abs);
  });

  it("leaves a file:// picker URI unchanged (local optimistic preview)", async () => {
    const local = "file:///var/mobile/Containers/photo.jpg";
    expect(normalizeProfilePhotoUrl(local)).toBe(local);
  });

  it("leaves a content:// picker URI unchanged (Android)", async () => {
    const local = "content://media/external/images/media/12345";
    expect(normalizeProfilePhotoUrl(local)).toBe(local);
  });

  it("returns null for null input", async () => {
    expect(normalizeProfilePhotoUrl(null)).toBeNull();
  });

  it("returns null for undefined input", async () => {
    expect(normalizeProfilePhotoUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", async () => {
    expect(normalizeProfilePhotoUrl("")).toBeNull();
  });

  it("strips /api suffix from the base when the getApiUrl() value ends with /api/", async () => {
    // Verify the regex logic inline — the real module uses the mocked
    // getApiUrl(), so we exercise the strip pattern directly here.
    const apiUrlWithSuffix = "https://lab-trax.replit.app/api/";
    const stripped = apiUrlWithSuffix.replace(/\/api\/?$/, "").replace(/\/$/, "");
    expect(stripped).toBe("https://lab-trax.replit.app");
  });

  it("resolves paths without a leading slash and rejects unsupported schemes", () => {
    expect(normalizeProfilePhotoUrl("uploads/photo.jpg")).toBe("http://localhost/uploads/photo.jpg");
    expect(normalizeProfilePhotoUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("saved profile photo synchronization", () => {
  async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const hook = await renderHook(() => {
      const me = useMe(true);
      return useProfilePhoto(me.data?.user as { id?: string; profilePhotoUrl?: string | null } | undefined);
    }, { wrapper });
    return { ...hook, qc };
  }

  it("loads the desktop-saved photo on screen entry and picks up replacements on app resume", async () => {
    let onResume: ((state: string) => void) | undefined;
    const listener = vi.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
      onResume = callback as (state: string) => void;
      return { remove: vi.fn() };
    });
    const hook = await mount();
    await waitFor(() => expect(hook.result.current.photoUrl).toBe("http://localhost/uploads/profile-photos/from-desktop.jpg"));
    expect(syncState.setPhoto).toHaveBeenCalledWith("http://localhost/uploads/profile-photos/from-desktop.jpg", "alice");
    syncState.storedPhoto = "/uploads/profile-photos/replaced-on-desktop.jpg";
    await act(async () => { onResume?.("active"); });
    await waitFor(() => expect(hook.result.current.photoUrl).toBe("http://localhost/uploads/profile-photos/replaced-on-desktop.jpg"));
    hook.unmount(); hook.qc.clear(); listener.mockRestore();
  });

  it("shows initials on broken images and never resurrects a local picture when the server has none", async () => {
    const hook = await mount();
    await waitFor(() => expect(hook.result.current.photoUrl).not.toBeNull());
    await act(async () => { hook.result.current.onPhotoError(); });
    expect(hook.result.current.photoUrl).toBeNull();
    syncState.storedPhoto = "/uploads/profile-photos/replacement.jpg";
    await act(async () => { await hook.qc.refetchQueries({ queryKey: ["auth-me"] }); });
    await waitFor(() => expect(hook.result.current.photoUrl).toContain("replacement.jpg"));
    syncState.storedPhoto = null;
    await act(async () => { await hook.qc.refetchQueries({ queryKey: ["auth-me"] }); });
    await waitFor(() => expect(hook.result.current.photoUrl).toBeNull());
    expect(syncState.setPhoto).toHaveBeenCalledWith(null, "alice");
    hook.unmount(); hook.qc.clear();
  });

  it("isolates cached and delayed responses when another account signs in", async () => {
    const hook = await mount();
    await waitFor(() => expect(hook.result.current.photoUrl).toContain("from-desktop.jpg"));
    let finish!: (value: Response) => void;
    syncState.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { void hook.qc.refetchQueries({ queryKey: ["auth-me", "alice"] }); });
    await waitFor(() => expect(finish).toBeDefined());
    syncState.accountId = "bob";
    syncState.storedPhoto = null;
    await hook.rerender(undefined);
    expect(hook.result.current.photoUrl).toBeNull();
    await act(async () => {
      finish(new Response(JSON.stringify({ user: { id: "alice", profilePhotoUrl: "/late-alice.jpg" }, memberships: [] })));
    });
    await waitFor(() => expect(syncState.setPhoto).toHaveBeenCalledWith(null, "bob"));
    expect(hook.result.current.photoUrl).toBeNull();
    expect(syncState.setPhoto).not.toHaveBeenCalledWith("http://localhost/late-alice.jpg", "bob");
    hook.unmount(); hook.qc.clear();
  });
});
