import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * The "N rush" stats chip on the mobile dashboard must be tappable and jump
 * to whichever section (in on-screen order) contains the first rush case,
 * expanding that section first if it's collapsed. Mirrors the existing Due
 * Tomorrow chip's scroll-to-section behavior.
 */
describe("Mobile dashboard — rush chip jump-to-section", () => {
  const dashboardSource = readFileSync(join(__dirname, "../(tabs)/dashboard.tsx"), "utf8");

  it("renders a tappable rush chip wired to the scroll handler", async () => {
    expect(dashboardSource).toContain("rushCases.length > 0 &&");
    expect(dashboardSource).toContain("onPress={scrollToFirstRushSection}");
    expect(dashboardSource).toContain('accessibilityLabel="Scroll to rush cases"');
  });

  it("checks sections in on-screen order and expands a collapsed target before scrolling", async () => {
    expect(dashboardSource).toContain("function scrollToFirstRushSection()");
    const fnStart = dashboardSource.indexOf("function scrollToFirstRushSection()");
    const nextFunction = dashboardSource.indexOf("\n  function ", fnStart + 1);
    const fnBody = dashboardSource.slice(
      fnStart,
      nextFunction > fnStart ? nextFunction : fnStart + 4_000,
    );
    const recentIdx = fnBody.indexOf("recentYRef");
    const pastDueIdx = fnBody.indexOf("pastDueYRef");
    const dueTodayIdx = fnBody.indexOf("dueTodayYRef");
    const dueTomorrowIdx = fnBody.indexOf("dueTomorrowYRef");
    expect(recentIdx).toBeGreaterThan(-1);
    expect(pastDueIdx).toBeGreaterThan(recentIdx);
    expect(dueTodayIdx).toBeGreaterThan(pastDueIdx);
    expect(dueTomorrowIdx).toBeGreaterThan(dueTodayIdx);

    expect(fnBody).toContain("if (!target.isOpen) target.expand();");
    expect(fnBody).toMatch(
      /scrollViewRef\.current\?\.scrollTo\(\{\s*y: target\.yRef\.current,\s*animated: true,\s*\}\);/,
    );
  });

  it("tracks the ScrollView-relative y offset of every jump target section", async () => {
    expect(dashboardSource).toContain("recentYRef.current = e.nativeEvent.layout.y");
    expect(dashboardSource).toContain("pastDueYRef.current = e.nativeEvent.layout.y");
    expect(dashboardSource).toContain("dueTodayYRef.current = e.nativeEvent.layout.y");
    expect(dashboardSource).toContain("dueTomorrowYRef.current = e.nativeEvent.layout.y");
  });
});
