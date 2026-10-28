import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { shouldUseAutoUpdater } = require("../auto-updater-policy.cjs") as {
  shouldUseAutoUpdater: (options: {
    isDev: boolean;
    isWindowsStore: boolean;
    skipAutoUpdater: boolean;
    updateChannel?: string | null;
  }) => boolean;
};
const { resolveUpdateFeedUrl, manualInstallerDetails } =
  require("../auto-updater-policy.cjs") as {
    resolveUpdateFeedUrl: (options: {
      runtimeOverride?: string | null;
      packagedFeed?: string | null;
      fallback?: string | null;
    }) => string | null;
    manualInstallerDetails: (options: {
      isWindowsStore: boolean;
      platform: string;
      feedUrl: string | null;
    }) => { url: string | null; platform: "windows" | "macos" | null };
  };

describe("Windows desktop update channel policy", () => {
  it("keeps the existing updater enabled for packaged direct-download installs", () => {
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: false,
        skipAutoUpdater: false,
        updateChannel: "installer",
      }),
    ).toBe(true);
  });

  it("does not advertise in-place updates for portable-only or manual builds", () => {
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: false,
        skipAutoUpdater: false,
        updateChannel: "portable",
      }),
    ).toBe(false);
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: false,
        skipAutoUpdater: false,
        updateChannel: "manual",
      }),
    ).toBe(false);
  });

  it("leaves Store MSIX updates to Microsoft Store", () => {
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: true,
        skipAutoUpdater: false,
      }),
    ).toBe(false);
  });

  it("continues to skip auto-updates in development and smoke-test builds", () => {
    expect(
      shouldUseAutoUpdater({
        isDev: true,
        isWindowsStore: false,
        skipAutoUpdater: false,
      }),
    ).toBe(false);
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: false,
        skipAutoUpdater: true,
      }),
    ).toBe(false);
  });

  it("prefers the runbook override, then the packaged feed, then the production fallback", () => {
    expect(
      resolveUpdateFeedUrl({
        runtimeOverride: "http://127.0.0.1:8765",
        packagedFeed: "https://stage.example.test/downloads",
        fallback: "https://lab-trax.replit.app/downloads",
      }),
    ).toBe("http://127.0.0.1:8765/");
    expect(
      resolveUpdateFeedUrl({
        runtimeOverride: "file:///tmp/feed",
        packagedFeed: "https://stage.example.test/downloads",
        fallback: "https://lab-trax.replit.app/downloads",
      }),
    ).toBe("https://stage.example.test/downloads/");
    expect(
      resolveUpdateFeedUrl({
        runtimeOverride: "file:///tmp/feed",
        packagedFeed: null,
        fallback: "https://lab-trax.replit.app/downloads",
      }),
    ).toBe("https://lab-trax.replit.app/downloads/");
  });

  it("only offers signed installer downloads for supported desktop platforms", () => {
    expect(
      manualInstallerDetails({
        isWindowsStore: false,
        platform: "win32",
        feedUrl: "https://lab-trax.replit.app/downloads/",
      }),
    ).toEqual({
      url: "https://lab-trax.replit.app/downloads/LabTrax-Setup.exe",
      platform: "windows",
    });
    expect(
      manualInstallerDetails({
        isWindowsStore: false,
        platform: "darwin",
        feedUrl: "https://lab-trax.replit.app/downloads/",
      }),
    ).toEqual({
      url: "https://lab-trax.replit.app/downloads/LabTrax.dmg",
      platform: "macos",
    });
    expect(
      manualInstallerDetails({
        isWindowsStore: true,
        platform: "win32",
        feedUrl: "https://lab-trax.replit.app/downloads/",
      }),
    ).toEqual({ url: null, platform: null });
  });
});
