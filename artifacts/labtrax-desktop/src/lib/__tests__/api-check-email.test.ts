import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkEmailAvailable } from "../api";

describe("checkEmailAvailable", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows the shared test email regardless of casing or surrounding spaces", async () => {
    const fetchMock = vi.mocked(fetch);

    await expect(
      checkEmailAvailable(" SHARED-TEST@EXAMPLE.COM "),
    ).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the server's duplicate rejection for other email addresses", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { available: false } }),
    } as Response);

    await expect(checkEmailAvailable("taken@example.com")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/check-email?email=taken%40example.com",
      { method: "GET" },
    );
  });
});
