// Tests for `lib/authed-media-cache.ts`.
//
// The global vitest.setup.ts mocks authed-media-cache so screen tests don't
// hit the filesystem. These tests need the REAL implementation, so we unmock
// it here (hoisted above the import). expo-file-system/legacy and
// @/lib/query-client are re-mocked inline below with controllable stubs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("@/lib/authed-media-cache");

// All vi.mock factories are hoisted — they cannot reference variables declared
// in the module body. Define the stubs entirely inside each factory.
vi.mock("@/lib/query-client", () => ({
  getAccessToken: vi.fn(() => "tok-initial"),
  getApiUrl: vi.fn(() => "https://api.labtrax.test/"),
  refreshAndGetAccessToken: vi.fn(async () => "tok-refreshed"),
}));

vi.mock("@/lib/case-media-source", () => ({
  isSameApiOrigin: vi.fn((url: string) =>
    url.startsWith("https://api.labtrax.test/"),
  ),
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  downloadAsync: vi.fn(async (_url: string, dest: string) => ({
    status: 200,
    uri: dest,
  })),
  deleteAsync: vi.fn(async () => undefined),
}));

import { getAuthedMediaUri, refreshAuthedMediaUri } from "@/lib/authed-media-cache";
import { getAccessToken, refreshAndGetAccessToken } from "@/lib/query-client";
import * as FileSystemLegacy from "expo-file-system/legacy";

const SAME_ORIGIN_URL =
  "https://api.labtrax.test/api/cases/c1/attachments/a1/file";
const EXTERNAL_URL = "https://evil.example.com/steal.jpg";

// Compute the cache path the way authed-media-cache.ts does it
function expectedCachePath(url: string): string {
  const cleaned = url.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(-120);
  return `file:///cache/labtrax-media/${cleaned || "media"}`;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: valid token, refresh returns a fresh token
  vi.mocked(getAccessToken).mockReturnValue("tok-initial");
  vi.mocked(refreshAndGetAccessToken).mockResolvedValue("tok-refreshed");

  // Default filesystem: no cached files, downloads succeed
  vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({ exists: false } as any);
  vi.mocked(FileSystemLegacy.downloadAsync).mockImplementation(
    async (_url: string, dest: string) => ({ status: 200, uri: dest } as any),
  );
  vi.mocked(FileSystemLegacy.deleteAsync).mockResolvedValue(undefined);
  vi.mocked(FileSystemLegacy.makeDirectoryAsync).mockResolvedValue(undefined);
});

describe("getAuthedMediaUri", () => {
  it("returns local URIs without auth", async () => {
    expect(await getAuthedMediaUri("file:///photos/x.jpg")).toBe(
      "file:///photos/x.jpg",
    );
    expect(await getAuthedMediaUri("ph://asset-id")).toBe("ph://asset-id");
    expect(await getAuthedMediaUri("data:image/jpeg;base64,abc")).toBe(
      "data:image/jpeg;base64,abc",
    );
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("returns null for null/undefined input", async () => {
    expect(await getAuthedMediaUri(null)).toBeNull();
    expect(await getAuthedMediaUri(undefined)).toBeNull();
  });

  it("downloads with bearer on a successful first attempt", async () => {
    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
    const [url, , opts] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[0]!;
    expect(url).toBe(SAME_ORIGIN_URL);
    expect((opts as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-initial",
    );
  });

  it("never sends Bearer to external URLs", async () => {
    vi.mocked(getAccessToken).mockReturnValue("supersecret");
    const result = await getAuthedMediaUri(EXTERNAL_URL);
    // Returns the raw URL without downloading — no auth header leakage
    expect(result).toBe(EXTERNAL_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("returns cached file path without a network round-trip when cached", async () => {
    const cachePath = expectedCachePath(SAME_ORIGIN_URL);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({
      exists: true,
      uri: cachePath,
    } as any);

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBe(cachePath);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("refreshes token and retries after a 401 response", async () => {
    // First download: 401 (expired token); second (after refresh): 200
    vi.mocked(FileSystemLegacy.downloadAsync)
      .mockResolvedValueOnce({ status: 401, uri: "" } as any)
      .mockImplementation(async (_url: string, dest: string) => ({
        status: 200,
        uri: dest,
      } as any));

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(result).not.toBeNull();

    // refreshAndGetAccessToken called exactly once
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);

    // downloadAsync called twice: initial + retry with fresh token
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(2);
    const [, , opts2] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[1]!;
    expect((opts2 as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-refreshed",
    );
  });

  it("returns null when 401 occurs and token refresh fails", async () => {
    vi.mocked(refreshAndGetAccessToken).mockResolvedValue(null);
    vi.mocked(FileSystemLegacy.downloadAsync).mockResolvedValueOnce({
      status: 401,
      uri: "",
    } as any);

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeNull();
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);
    // No retry after failed refresh
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
  });

  it("returns raw URL when there is no access token", async () => {
    vi.mocked(getAccessToken).mockReturnValue(null);
    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBe(SAME_ORIGIN_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });
});

describe("refreshAuthedMediaUri", () => {
  it("forces a fresh download and returns the file URI", async () => {
    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
  });

  it("refreshes token and retries after a 401", async () => {
    vi.mocked(FileSystemLegacy.downloadAsync)
      .mockResolvedValueOnce({ status: 401, uri: "" } as any)
      .mockImplementation(async (_url: string, dest: string) => ({
        status: 200,
        uri: dest,
      } as any));

    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(2);
    const [, , opts2] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[1]!;
    expect((opts2 as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-refreshed",
    );
  });

  it("returns null when refresh fails after 401", async () => {
    vi.mocked(refreshAndGetAccessToken).mockResolvedValue(null);
    vi.mocked(FileSystemLegacy.downloadAsync).mockResolvedValueOnce({
      status: 401,
      uri: "",
    } as any);

    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeNull();
  });

  it("never sends Bearer to external URLs", async () => {
    vi.mocked(getAccessToken).mockReturnValue("supersecret");
    const result = await refreshAuthedMediaUri(EXTERNAL_URL);
    expect(result).toBe(EXTERNAL_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });
});
