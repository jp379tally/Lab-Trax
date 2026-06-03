import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * The iOS/Android "Share to LabTrax" feature (LabTrax appearing in the system
 * share sheet so users can send screenshots / photos / PDFs into a case) is
 * built entirely by the `expo-share-intent` config plugin in app.json. If that
 * plugin block is removed, the native Share Extension is NOT compiled, the JS
 * `useShareIntent` hook in app/_layout.tsx goes dead, and LabTrax silently
 * disappears from the share sheet.
 *
 * This has already regressed in production once (the plugin block was deleted
 * from app.json), so this test pins the exact configuration. If a future change
 * needs to legitimately alter the share-intent config, update the expectations
 * here ON PURPOSE — that deliberate edit is the gate.
 */
describe("share-intent config (app.json) — regression firewall", () => {
  const appJson = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "app.json"), "utf8"),
  ) as {
    expo: { plugins: Array<string | [string, Record<string, unknown>]> };
  };

  const plugins = appJson.expo.plugins;

  function findPlugin(
    name: string,
  ): [string, Record<string, unknown>] | undefined {
    return plugins.find(
      (p): p is [string, Record<string, unknown>] =>
        Array.isArray(p) && p[0] === name,
    );
  }

  it("registers the expo-share-intent config plugin", () => {
    const entry = findPlugin("expo-share-intent");
    expect(
      entry,
      "expo-share-intent plugin is missing from app.json plugins — LabTrax will NOT appear in the iOS/Android share sheet. Restore the plugin block.",
    ).toBeDefined();
  });

  it("keeps the iOS share extension name and App Group identifier", () => {
    const [, opts] = findPlugin("expo-share-intent")!;
    expect(opts.iosShareExtensionName).toBe("LabTraxShare");
    // App Group is required for the share extension to hand files to the app.
    expect(opts.iosAppGroupIdentifier).toBe("group.app.replit.labtrax.sdr");
  });

  it("accepts images, videos and files from the iOS share sheet", () => {
    const [, opts] = findPlugin("expo-share-intent")!;
    const rules = opts.iosActivationRules as Record<string, number>;
    expect(rules.NSExtensionActivationSupportsImageWithMaxCount).toBeGreaterThan(
      0,
    );
    expect(rules.NSExtensionActivationSupportsMovieWithMaxCount).toBeGreaterThan(
      0,
    );
    expect(rules.NSExtensionActivationSupportsFileWithMaxCount).toBeGreaterThan(
      0,
    );
  });

  it("accepts images from the Android share sheet (single and multi)", () => {
    const [, opts] = findPlugin("expo-share-intent")!;
    expect(opts.androidIntentFilters).toContain("image/*");
    expect(opts.androidMultiIntentFilters).toContain("image/*");
  });
});
