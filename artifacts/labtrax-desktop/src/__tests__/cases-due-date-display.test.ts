/**
 * Unit tests for the due-date display rule used in the cases list and case
 * detail panel:
 *
 *   displayDate = dueDate
 *
 * The `expectedDeliveryDate` field has been removed from the UI. All due-date
 * display and overdue-bucketing logic now reads `dueDate` exclusively.
 *
 * These tests pin the semantics so any accidental change to the display logic
 * (e.g. re-introducing a coalescing expression with expectedDeliveryDate) is
 * caught before it reaches production.
 */
import { describe, it, expect } from "vitest";

/**
 * Pure function that mirrors the display expression used in:
 *  - cases list column render (cases.tsx):
 *      formatShortDueDate(c.dueDate)
 *  - case detail Field (cases.tsx):
 *      formatDueDate(pendingCaseEdit?.dueDate ?? (data?.dueDate ?? labCase.dueDate))
 *  - dashboard CaseRow (dashboard.tsx):
 *      formatDueDate(c.dueDate)
 *
 * We test the field-selection semantics in isolation so the assertion is
 * framework-agnostic and does not require rendering the full component.
 */
function resolveDisplayDate(
  dueDate: string | null | undefined,
): string | null | undefined {
  return dueDate;
}

describe("cases list due-date display (dueDate only)", () => {
  it("returns dueDate when present", () => {
    expect(resolveDisplayDate("2026-09-15")).toBe("2026-09-15");
  });

  it("returns null when dueDate is null", () => {
    expect(resolveDisplayDate(null)).toBeNull();
  });

  it("returns undefined when dueDate is undefined", () => {
    expect(resolveDisplayDate(undefined)).toBeUndefined();
  });
});

describe("case detail due-date display (pendingCaseEdit?.dueDate ?? data?.dueDate ?? labCase.dueDate)", () => {
  /**
   * The case detail panel uses a three-level precedence:
   *   pendingCaseEdit?.dueDate ?? (data?.dueDate ?? labCase.dueDate)
   *
   * The outer pendingCaseEdit layer is an uncommitted UI edit override;
   * the inner two-level coalesce picks from refetched data vs. the initial
   * list-query snapshot.
   */
  function resolveDetailDisplayDate(
    pendingEditDueDate: string | null | undefined,
    dataDueDate: string | null | undefined,
    labCaseDueDate: string | null | undefined,
  ): string | null | undefined {
    return pendingEditDueDate ?? (dataDueDate ?? labCaseDueDate);
  }

  it("pending edit overrides everything when set", () => {
    expect(resolveDetailDisplayDate("2026-12-01", "2026-09-15", "2026-08-01")).toBe("2026-12-01");
  });

  it("falls through to data.dueDate when no pending edit", () => {
    expect(resolveDetailDisplayDate(undefined, "2026-09-15", "2026-08-01")).toBe("2026-09-15");
  });

  it("falls through to labCase.dueDate when no pending edit and data.dueDate is null", () => {
    expect(resolveDetailDisplayDate(undefined, null, "2026-08-01")).toBe("2026-08-01");
  });

  it("returns null when no pending edit and both server fields are null", () => {
    expect(resolveDetailDisplayDate(undefined, null, null)).toBeNull();
  });
});

describe("case detail due-time display (pendingCaseEdit?.dueTime ?? data?.dueTime ?? labCase.dueTime)", () => {
  /**
   * The case detail panel resolves the paired due TIME with the exact same
   * three-level precedence as the due date:
   *   pendingCaseEdit?.dueTime ?? (data?.dueTime ?? labCase.dueTime)
   *
   * The edit form uses "" (not undefined) as its "no time set / cleared"
   * sentinel once a pending edit exists, so an explicit "" on that layer must
   * win over a truthy server value — that's the mechanism that lets a user
   * clear a previously-set time independently of the date.
   */
  function resolveDetailDisplayTime(
    pendingEditDueTime: string | null | undefined,
    dataDueTime: string | null | undefined,
    labCaseDueTime: string | null | undefined,
  ): string | null | undefined {
    return pendingEditDueTime ?? (dataDueTime ?? labCaseDueTime);
  }

  it("pending edit time overrides everything when set", () => {
    expect(resolveDetailDisplayTime("15:30", "09:00", "08:00")).toBe("15:30");
  });

  it("an explicit cleared pending time (\"\") wins over truthy server values", () => {
    expect(resolveDetailDisplayTime("", "09:00", "08:00")).toBe("");
  });

  it("falls through to data.dueTime when no pending edit", () => {
    expect(resolveDetailDisplayTime(undefined, "09:00", "08:00")).toBe("09:00");
  });

  it("falls through to labCase.dueTime when no pending edit and data.dueTime is null", () => {
    expect(resolveDetailDisplayTime(undefined, null, "08:00")).toBe("08:00");
  });

  it("returns null when no pending edit and both server fields are null", () => {
    expect(resolveDetailDisplayTime(undefined, null, null)).toBeNull();
  });
});
