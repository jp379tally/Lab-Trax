import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { shouldUseAutoUpdater } = require("../auto-updater-policy.cjs") as {
  shouldUseAutoUpdater: (options: {
    isDev: boolean;
    isWindowsStore: boolean;
    skipAutoUpdater: boolean;
  }) => boolean;
};

describe("Windows desktop update channel policy", () => {
  it("keeps the existing updater enabled for packaged direct-download installs", () => {
    expect(
      shouldUseAutoUpdater({
        isDev: false,
        isWindowsStore: false,
        skipAutoUpdater: false,
      }),
    ).toBe(true);
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
});
