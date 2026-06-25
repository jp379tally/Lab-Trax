import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * The mobile app must land on the Dashboard tab (not the Cases list) after
 * login and on every authenticated relaunch, while still honoring case
 * deep-links (https://<domain>/cases/<caseNumber>). This is enforced by three
 * cooperating pieces:
 *
 *   1. `unstable_settings.initialRouteName === "dashboard"` in
 *      app/(tabs)/_layout.tsx — picks Dashboard as the default tab.
 *   2. `redirectSystemPath()` in app/+native-intent.tsx — squashes the system
 *      entry path to /dashboard so a cold start never opens Cases.
 *   3. The Linking handler + pendingCaseNumber drain in app/_layout.tsx —
 *      resolves case deep-links independently and pushes /case/<id>, so
 *      squashing the system path to Dashboard does NOT drop deep-links.
 *
 * If any of these regress, the app silently reverts to landing on Cases (or
 * worse, drops case deep-links). If a future change needs to legitimately
 * alter the landing behavior, update the expectations here ON PURPOSE — that
 * deliberate edit is the gate.
 */
describe("Dashboard landing — regression firewall", () => {
  it("sets the authenticated tab group's initial route to dashboard", async () => {
    const layout = await import("../(tabs)/_layout");
    expect(
      (layout as { unstable_settings?: { initialRouteName?: string } })
        .unstable_settings?.initialRouteName,
      "app/(tabs)/_layout.tsx must export unstable_settings.initialRouteName === 'dashboard' — otherwise the tab group defaults to the Cases `index` route.",
    ).toBe("dashboard");
  });

  it("resolves the system entry path to /dashboard", async () => {
    const { redirectSystemPath } = await import("../+native-intent");
    expect(redirectSystemPath({ path: "/", initial: true })).toBe("/dashboard");
    // Even an arbitrary non-case system path lands on Dashboard.
    expect(redirectSystemPath({ path: "/(tabs)", initial: false })).toBe(
      "/dashboard",
    );
  });

  it("still navigates captured case deep-links to the case detail screen", () => {
    // The deep-link resolver lives in app/_layout.tsx (not exported), so this
    // pins the source: a /cases/<caseNumber> URL must be parsed and resolved to
    // /case/<id> rather than being overridden by the Dashboard landing, and a
    // pre-auth deep-link must be stashed in pendingCaseNumber and drained once
    // the user authenticates.
    const layoutSource = readFileSync(
      join(__dirname, "..", "_layout.tsx"),
      "utf8",
    );

    // Parses case deep-links of the form /cases/<caseNumber>.
    expect(
      layoutSource.includes("/^\\/cases\\/([^/?#]+)/"),
      "app/_layout.tsx must still match /cases/<caseNumber> deep-links.",
    ).toBe(true);

    // Navigates resolved case deep-links to the case detail route.
    expect(
      layoutSource.includes("router.push(`/case/${caseId}`"),
      "app/_layout.tsx must push /case/<id> when a case deep-link resolves — Dashboard landing must not override it.",
    ).toBe(true);

    // Stashes a pre-auth deep-link and drains it after authentication.
    expect(
      layoutSource.includes("pendingCaseNumber = caseNumber"),
      "app/_layout.tsx must stash an unresolved (pre-auth) case deep-link in pendingCaseNumber.",
    ).toBe(true);
    expect(
      layoutSource.includes("resolveCaseAndNavigate(cn)"),
      "AuthGate must drain pendingCaseNumber via resolveCaseAndNavigate after login.",
    ).toBe(true);
  });
});
