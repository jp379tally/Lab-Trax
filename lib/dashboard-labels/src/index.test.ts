import { describe, expect, it } from "vitest";
import { DASHBOARD_SECTION_LABELS } from "./index";

describe("dashboard section labels", () => {
  it("preserves the dashboard's title-case names", () => {
    expect(DASHBOARD_SECTION_LABELS).toEqual({
      recentCases: "Recent Cases",
      pastDue: "Past Due",
      dueToday: "Due Today",
      dueTomorrow: "Due Tomorrow",
      noDueDate: "No Due Date",
      unassignedDocuments: "Unassigned Documents",
      exceptionCases: "Exception Cases",
    });
  });

  it("keeps title-case exceptions lowercase", () => {
    const hasRequestedTitleCase = (title: string) =>
      title
        .split(/\s+/)
        .every((word, index) =>
          index === 0
            ? word[0] === word[0].toUpperCase()
            : ["of", "and", "a"].includes(word.toLowerCase())
              ? word === word.toLowerCase()
              : word[0] === word[0].toUpperCase(),
        );

    expect(hasRequestedTitleCase("Case Details of a Section and Records")).toBe(
      true,
    );
    expect(
      hasRequestedTitleCase("Case Details Of a Section And Records"),
    ).toBe(false);
    for (const label of Object.values(DASHBOARD_SECTION_LABELS)) {
      expect(hasRequestedTitleCase(label)).toBe(true);
    }
  });
});
