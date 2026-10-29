import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_SECTION_LABELS } from "@workspace/dashboard-labels";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Dashboard section headers should keep their collapse and sorting controls,
 * but should not offer navigation actions that duplicate the Cases page.
 */
describe("Desktop dashboard — section header controls", () => {
  const dashboardSource = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");
  const exceptionCardSource = readFileSync(
    join(__dirname, "../../components/ExceptionCasesCard.tsx"),
    "utf8",
  );
  const allDashboardSources = `${dashboardSource}\n${exceptionCardSource}`;
  const unassignedCardSource = readFileSync(
    join(__dirname, "../../components/UnassignedDocumentsCard.tsx"),
    "utf8",
  );

  it("does not render the Recent cases View all navigation action", () => {
    expect(dashboardSource).toContain("link-view-all-recent");
    expect(dashboardSource).not.toContain("ArrowRight");
  });

  it("uses title case for visible dashboard section titles and summary cards", () => {
    for (const [key, label] of Object.entries(DASHBOARD_SECTION_LABELS)) {
      expect(allDashboardSources).toContain(`DASHBOARD_SECTION_LABELS.${key}`);
      expect(label).toMatch(/^[A-Z]/);
    }
    expect(dashboardSource).toContain(
      "title: DASHBOARD_SECTION_LABELS.pastDue",
    );
    expect(dashboardSource).toContain(
      "title: DASHBOARD_SECTION_LABELS.dueToday",
    );
    expect(dashboardSource).toContain(
      "title: DASHBOARD_SECTION_LABELS.dueTomorrow",
    );
    expect(dashboardSource).toContain(
      "title: DASHBOARD_SECTION_LABELS.unassignedDocuments",
    );
    expect(exceptionCardSource).toContain(
      "DASHBOARD_SECTION_LABELS.exceptionCases",
    );
    expect(dashboardSource).not.toContain(
      '<h2 className="text-sm font-semibold">Recent cases</h2>',
    );
    expect(dashboardSource).toContain("Most recently active, excluding completed.");
  });

  it("keeps the specified small words lowercase in section title case", () => {
    const hasRequestedTitleCase = (title: string) =>
      title
        .split(/\s+/)
        .every(
          (word, index) =>
            index === 0
              ? word[0] === word[0].toUpperCase()
              : ["of", "and", "a"].includes(word.toLowerCase())
                ? word === word.toLowerCase()
                : word[0] === word[0].toUpperCase(),
        );

    expect(hasRequestedTitleCase("Recent Cases")).toBe(true);
    expect(hasRequestedTitleCase("Case Details of a Section and Records")).toBe(
      true,
    );
    expect(
      hasRequestedTitleCase("Case Details Of a Section And Records"),
    ).toBe(false);
  });

  it("removes Logged today while keeping controls for the remaining sections", () => {
    expect(dashboardSource).not.toContain("Logged today");
    expect(dashboardSource).not.toContain("loggedToday");
    expect(dashboardSource).toContain('aria-label={recentCasesOpen ? "Collapse recent cases" : "Expand recent cases"}');
    expect(dashboardSource).toContain('aria-label={pastDueOpen ? "Collapse past due" : "Expand past due"}');
    expect(dashboardSource).toContain('aria-label={dueTodayOpen ? "Collapse due today" : "Expand due today"}');
    expect(dashboardSource).toContain('aria-label={dueTomorrowOpen ? "Collapse due tomorrow" : "Expand due tomorrow"}');
  });

  it("exposes expanded state and visible keyboard focus on every collapsible header", () => {
    for (const state of [
      "recentCasesOpen",
      "pastDueOpen",
      "dueTodayOpen",
      "dueTomorrowOpen",
      "noDueDateOpen",
    ]) {
      expect(dashboardSource).toContain(`aria-expanded={${state}}`);
    }
    expect(unassignedCardSource).toContain("aria-expanded={!collapsed}");
    expect(exceptionCardSource).toContain("aria-expanded={open}");

    for (const source of [
      dashboardSource,
      unassignedCardSource,
      exceptionCardSource,
    ]) {
      expect(source).toContain("focus-visible:ring-2");
    }
    expect(unassignedCardSource).toContain("Expand unassigned documents");
    expect(exceptionCardSource).toContain("Expand exception cases");
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
