import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * The "N rush" stat chip in the dashboard header must be clickable and jump
 * to the first section (in on-screen order) that contains a rush case,
 * expanding that section first if it's collapsed. Mirrors the Due Tomorrow
 * chip's scroll-to-section behavior.
 */
describe("Desktop dashboard — rush chip jump-to-section", () => {
  const dashboardSource = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");

  it("renders the rush count as a clickable button, not a static span", () => {
    expect(dashboardSource).toContain("onClick={scrollToFirstRushSection}");
    expect(dashboardSource).toMatch(/rushCount > 0 && \(\s*<button/);
  });

  it("checks sections in on-screen order and expands a collapsed target before scrolling", () => {
    expect(dashboardSource).toContain("function scrollToFirstRushSection()");
    // Order matches the rendered section order: recent, past due, due today,
    // due tomorrow, no due date.
    const fnStart = dashboardSource.indexOf("function scrollToFirstRushSection()");
    const fnBody = dashboardSource.slice(fnStart, fnStart + 1800);
    const recentIdx = fnBody.indexOf("recentCasesRef");
    const pastDueIdx = fnBody.indexOf("pastDueRef");
    const dueTodayIdx = fnBody.indexOf("dueTodayRef");
    const dueTomorrowIdx = fnBody.indexOf("dueTomorrowRef");
    const noDueDateIdx = fnBody.indexOf("noDueDateRef");
    expect(recentIdx).toBeGreaterThan(-1);
    expect(pastDueIdx).toBeGreaterThan(recentIdx);
    expect(dueTodayIdx).toBeGreaterThan(pastDueIdx);
    expect(dueTomorrowIdx).toBeGreaterThan(dueTodayIdx);
    expect(noDueDateIdx).toBeGreaterThan(dueTomorrowIdx);

    expect(fnBody).toContain("if (!target.isOpen) target.setOpen(true);");
    expect(fnBody).toContain('scrollIntoView({ behavior: "smooth", block: "start" })');
  });

  it("attaches a ref to every jump target section", () => {
    expect(dashboardSource).toContain("ref={recentCasesRef}");
    expect(dashboardSource).toContain("ref={pastDueRef}");
    expect(dashboardSource).toContain("ref={dueTodayRef}");
    expect(dashboardSource).toContain("ref={dueTomorrowRef}");
    expect(dashboardSource).toContain("ref={noDueDateRef}");
  });
});
