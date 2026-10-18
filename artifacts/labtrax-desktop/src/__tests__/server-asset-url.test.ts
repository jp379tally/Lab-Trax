// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const renderer = window as Window & { electronAPI?: object };
afterEach(() => {
  renderer.electronAPI = {};
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("serverAssetUrl", () => {
  it("uses the browser's server root instead of /api or the desktop preview path", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    renderer.electronAPI = undefined;
    vi.resetModules();
    const { serverAssetUrl } = await import("@/lib/api");
    expect(serverAssetUrl("/uploads/profile-photos/a.png"))
      .toBe(`${window.location.origin}/uploads/profile-photos/a.png`);
  });

  it("uses the configured API origin in Electron", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/");
    renderer.electronAPI = {};
    vi.resetModules();
    const { serverAssetUrl } = await import("@/lib/api");
    expect(serverAssetUrl("/uploads/profile-photos/a.png"))
      .toBe("https://api.example.test/uploads/profile-photos/a.png");
    expect(serverAssetUrl("https://cdn.example.test/photo.png"))
      .toBe("https://cdn.example.test/photo.png");
  });

  it("uses the Electron API fallback when the installer has no configured origin", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    renderer.electronAPI = {};
    vi.resetModules();
    const { serverAssetUrl } = await import("@/lib/api");
    expect(serverAssetUrl("/uploads/profile-photos/a.png"))
      .toBe("https://lab-trax.replit.app/uploads/profile-photos/a.png");
  });
});