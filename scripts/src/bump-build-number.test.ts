import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const source = readFileSync(resolve(import.meta.dirname, "bump-build-number.ts"), "utf8");
function fixture(ios: unknown, android: unknown) {
  const root = mkdtempSync(join(tmpdir(), "mobile-counter-"));
  roots.push(root);
  mkdirSync(join(root, "scripts/src"), { recursive: true });
  mkdirSync(join(root, "artifacts/labtrax"), { recursive: true });
  const script = join(root, "scripts/src/bump-build-number.mjs");
  writeFileSync(script, source); // Source uses JavaScript-compatible syntax.
  const app = join(root, "artifacts/labtrax/app.json");
  const original = JSON.stringify({ expo: { name: "Preserve me", ios: { buildNumber: ios }, android: { versionCode: android, package: "com.example.app" } } });
  writeFileSync(app, original);
  return { script, app, original };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("mobile release counter", () => {
  it.each([["341", 341, 342], ["341", 350, 351], ["350", 341, 351]])(
    "increments past both platform counters (%s, %s)", (ios, android, expected) => {
      const f = fixture(ios, android);
      execFileSync(process.execPath, [f.script]);
      const app = JSON.parse(readFileSync(f.app, "utf8"));
      expect(app.expo.ios.buildNumber).toBe(String(expected));
      expect(app.expo.android.versionCode).toBe(expected);
      expect(app.expo.name).toBe("Preserve me");
      expect(app.expo.android.package).toBe("com.example.app");
    },
  );
  it.each([["341oops", 341], ["-1", 341], [341, 341], ["341", -1], ["341", 1.5], ["341", "350"], ["2100000000", 341], ["9007199254740992", 341]])(
    "refuses invalid or exhausted counters without modifying configuration (%s, %s)", (ios, android) => {
      const f = fixture(ios, android);
      expect(spawnSync(process.execPath, [f.script]).status).not.toBe(0);
      expect(readFileSync(f.app, "utf8")).toBe(f.original);
    },
  );
});
