/** @vitest-environment jsdom */
/**
 * Regression guard: `authedMediaFetch` prefers the Electron main-process media
 * bridge, and falls back to a normal browser fetch when the bridge is absent.
 *
 * Protected workflow: "Desktop Case Photo Cross-Platform Visibility"
 *
 * On the desktop client the renderer runs from `app://labtrax`, so a direct
 * browser fetch of the protected /file endpoint is cross-origin and can render
 * blank. `authedMediaFetch` routes through `window.electronAPI.media
 * .fetchAuthenticated` (main-process net.fetch with the bearer token) and hands
 * the bytes back as a Response. On the web (no bridge) it must behave exactly
 * like the old direct fetch so browser/mobile paths stay untouched.
 *
 * Keep this test permanently per the REGRESSION_GUARDRAILS.md policy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { authedMediaFetch } from "../api";

const URL_UNDER_TEST = "https://lab-trax.replit.app/api/cases/x/attachments/y/file";

afterEach(() => {
  (window as { electronAPI?: unknown }).electronAPI = undefined;
  vi.restoreAllMocks();
});

describe("authedMediaFetch", () => {
  it("uses the Electron media bridge when present and returns the bytes as a Response", async () => {
    const fetchAuthenticated = vi.fn(async () => ({
      ok: true,
      status: 200,
      mimeType: "image/jpeg",
      buffer: new Uint8Array([9, 8, 7]),
    }));
    (window as { electronAPI?: unknown }).electronAPI = {
      media: { fetchAuthenticated },
    };
    const globalFetch = vi.spyOn(globalThis, "fetch");

    const resp = await authedMediaFetch(URL_UNDER_TEST);

    expect(fetchAuthenticated).toHaveBeenCalledWith(URL_UNDER_TEST);
    // The browser fetch must NOT be used when the bridge handled it.
    expect(globalFetch).not.toHaveBeenCalled();
    expect(resp.ok).toBe(true);
    expect(resp.headers.get("content-type")).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await resp.arrayBuffer()))).toEqual([9, 8, 7]);
  });

  it("returns a non-ok Response when the bridge reports failure", async () => {
    const fetchAuthenticated = vi.fn(async () => ({
      ok: false,
      status: 404,
      error: "not found",
    }));
    (window as { electronAPI?: unknown }).electronAPI = {
      media: { fetchAuthenticated },
    };

    const resp = await authedMediaFetch(URL_UNDER_TEST);
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(404);
  });

  it("falls back to a normal browser fetch when no Electron bridge is present", async () => {
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200 }),
      );

    const resp = await authedMediaFetch(URL_UNDER_TEST);

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch.mock.calls[0]?.[0]).toBe(URL_UNDER_TEST);
    expect(resp.ok).toBe(true);
  });
});
