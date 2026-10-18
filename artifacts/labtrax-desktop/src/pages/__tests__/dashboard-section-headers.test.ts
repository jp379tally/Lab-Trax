import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Dashboard section headers should keep their collapse and sorting controls,
 * but should not offer navigation actions that duplicate the Cases page.
 */
describe("Desktop dashboard — section header controls", () => {
  const dashboardSource = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");

  it("does not render the Recent cases View all navigation action", () => {
    expect(dashboardSource).toContain("link-view-all-recent");
    expect(dashboardSource).not.toContain("ArrowRight");
  });

  it("removes Logged today while keeping controls for the remaining sections", () => {
    expect(dashboardSource).not.toContain("Logged today");
    expect(dashboardSource).not.toContain("loggedToday");
    expect(dashboardSource).toContain('aria-label={recentCasesOpen ? "Collapse recent cases" : "Expand recent cases"}');
    expect(dashboardSource).toContain('aria-label={pastDueOpen ? "Collapse past due" : "Expand past due"}');
    expect(dashboardSource).toContain('aria-label={dueTodayOpen ? "Collapse due today" : "Expand due today"}');
    expect(dashboardSource).toContain('aria-label={dueTomorrowOpen ? "Collapse due tomorrow" : "Expand due tomorrow"}');
  });

  it("keeps Sort controls for Past due and Due today", () => {
    // Both sections render the same shared menu (SECTION_SORT_LABELS), each
    // wired to its own selection state.
    expect(dashboardSource).toContain("SECTION_SORT_LABELS");
    expect(dashboardSource).toContain("setPastDueSort(key)");
    expect(dashboardSource).toContain("setDueTodaySort(key)");
    expect(dashboardSource).toContain("Sort");
  });

  it("adds Due Tomorrow sort choices and keeps the header controls independent", () => {
    expect(dashboardSource).toContain("DUE_TOMORROW_SORT_LABELS");
    expect(dashboardSource).toContain("Sort due tomorrow cases by");
    expect(dashboardSource).toContain("onClick={(e) => e.stopPropagation()}");
    expect(dashboardSource).toContain("setDueTomorrowSort(key)");
  });
});