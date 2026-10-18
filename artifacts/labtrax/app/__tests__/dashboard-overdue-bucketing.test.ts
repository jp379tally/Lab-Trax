import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import React from "react";
import { act, cleanup, render, within } from "@testing-library/react-native";
import type { CanonicalCase } from "@workspace/api-client-react";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen, {
  caseIsOverdue,
  caseIsDueToday,
  dueSortKey,
  caseIsDueTomorrow,
} from "../(tabs)/dashboard";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Tests exercise the REAL exported predicates from app/(tabs)/dashboard.tsx
 * (`caseIsOverdue` / `caseIsDueToday`) so any change to
 * the date field used in those functions will fail CI immediately.
 *
 * Contract: Past Due follows the mobile dashboard's effective due date
 * (expectedDeliveryDate first, then dueDate) and its paired time. Due Today
 * and Due Tomorrow retain their existing due-date rules.
 */

// Pin "today" to 2026-07-20 so all comparisons are stable across environments.
const TODAY = new Date(2026, 6, 20, 12, 0, 0).toISOString();
const PAST = "2026-01-01T00:00:00.000Z";       // always before TODAY
const FUTURE = "2026-12-31T00:00:00.000Z";     // always after TODAY
const IN_1_DAY = "2026-07-21T00:00:00.000Z";   // 1 day after TODAY
const TODAY_DATE = "2026-07-20T00:00:00.000Z"; // same calendar day as TODAY

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TODAY));
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await cleanup();
  resetMockAppState();
});

function makeCase(
  overrides: Partial<
    Pick<
      CanonicalCase,
      | "id"
      | "caseNumber"
      | "patientFirstName"
      | "patientLastName"
      | "status"
      | "dueDate"
      | "dueTime"
      | "expectedDeliveryDate"
      | "receivedAt"
      | "createdAt"
    >
  >,
): CanonicalCase {
  return {
    id: "test-id",
    caseNumber: "1",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    patientFirstName: "Test",
    patientLastName: "Patient",
    doctorName: "Dr. Synthetic063",
    status: "received",
    priority: "normal",
    dueDate: null,
    expectedDeliveryDate: null,
    receivedAt: null,
    createdAt: null,
    ...overrides,
  } as unknown as CanonicalCase;
}

describe("Mobile dashboard — caseIsOverdue (pastDueCases predicate)", () => {
  it("includes a past effective due date regardless of when the case was received", () => {
    expect(caseIsOverdue(makeCase({ dueDate: PAST, receivedAt: TODAY }))).toBe(true);
  });

  it("does not include a future due date or a missing due date, even for an old received case", () => {
    expect(caseIsOverdue(makeCase({ dueDate: FUTURE, receivedAt: PAST }))).toBe(false);
    expect(caseIsOverdue(makeCase({ receivedAt: PAST }))).toBe(false);
    expect(caseIsOverdue(makeCase({ dueDate: "not-a-date", receivedAt: PAST }))).toBe(false);
  });

  it("does not treat a date-only due date of today as overdue", () => {
    expect(caseIsOverdue(makeCase({ dueDate: TODAY_DATE }))).toBe(false);
  });

  it("uses the paired due time for a case due today", () => {
    expect(caseIsOverdue(makeCase({ dueDate: TODAY_DATE, dueTime: "08:00" }))).toBe(true);
    expect(caseIsOverdue(makeCase({ dueDate: TODAY_DATE, dueTime: "18:00" }))).toBe(false);
  });

  it("prefers expectedDeliveryDate and applies dueTime only to dueDate", () => {
    expect(
      caseIsOverdue(makeCase({ dueDate: FUTURE, expectedDeliveryDate: PAST })),
    ).toBe(true);
    expect(
      caseIsOverdue(makeCase({ dueDate: PAST, dueTime: "23:59", expectedDeliveryDate: FUTURE })),
    ).toBe(false);
  });

  it("keeps complete, delivered, cancelled, and void cases excluded", () => {
    for (const status of ["complete", "delivered", "cancelled", "void"] as const) {
      expect(caseIsOverdue(makeCase({ status, dueDate: PAST }))).toBe(false);
    }
  });
});

describe("Mobile dashboard — Past Due count and visible cases", () => {
  it("keeps the badge and list aligned when a denture case's due date is refreshed", async () => {
    const cases = [
      makeCase({
        id: "denture-case",
        caseNumber: "DENTURE-1",
        patientFirstName: "Denture",
        patientLastName: "Case",
        receivedAt: "2026-07-01",
        dueDate: PAST,
      }),
      makeCase({
        id: "future-due",
        caseNumber: "FUTURE-DUE",
        patientFirstName: "Future",
        patientLastName: "Due",
        receivedAt: PAST,
        dueDate: FUTURE,
      }),
      makeCase({
        id: "missing-due",
        caseNumber: "MISSING-DUE",
        patientFirstName: "Missing",
        patientLastName: "Due",
        receivedAt: PAST,
      }),
      makeCase({
        id: "today-date-only",
        caseNumber: "TODAY-DATE-ONLY",
        patientFirstName: "Today",
        patientLastName: "DateOnly",
        dueDate: TODAY_DATE,
      }),
      makeCase({
        id: "today-elapsed",
        caseNumber: "TODAY-ELAPSED",
        patientFirstName: "Today",
        patientLastName: "Elapsed",
        dueDate: TODAY_DATE,
        dueTime: "08:00",
      }),
      makeCase({
        id: "today-upcoming",
        caseNumber: "TODAY-UPCOMING",
        patientFirstName: "Today",
        patientLastName: "Upcoming",
        dueDate: TODAY_DATE,
        dueTime: "18:00",
      }),
      makeCase({
        id: "closed-case",
        caseNumber: "CLOSED",
        patientFirstName: "Closed",
        patientLastName: "Case",
        status: "delivered",
        dueDate: PAST,
      }),
    ];
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "technician",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Test Lab" },
        },
      ],
      cases,
    });

    const view = await render(React.createElement(DashboardScreen));
    const section = view.getByText("Active cases with past due dates.").parent;
    const badgeCount = () =>
      within(section!).getByTestId("dashboard-past-due-count").props.children.props.children;
    const visiblePastDueCases = () =>
      ["Denture Case", "Today Elapsed", "Future Due", "Missing Due", "Today DateOnly", "Today Upcoming", "Closed Case"]
        .filter((label) => within(section!).queryByText(label) !== null);

    expect(badgeCount()).toBe(2);
    expect(view.getByText("Active cases with past due dates.")).toBeTruthy();
    expect(visiblePastDueCases()).toEqual(["Denture Case", "Today Elapsed"]);

    setMockAppState({
      cases: cases.map((caseItem) =>
        caseItem.id === "denture-case" ? { ...caseItem, dueDate: FUTURE } : caseItem,
      ),
    });
    await view.rerender(React.createElement(DashboardScreen));

    expect(badgeCount()).toBe(1);
    expect(visiblePastDueCases()).toEqual(["Today Elapsed"]);
  });
});

describe("Mobile dashboard — caseIsDueToday (dueTodayCases predicate)", () => {
  it("is due today when dueDate is today (day diff = 0)", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE }))).toBe(true);
  });

  it("is NOT due today when dueDate is 1 day in the future (day diff = 1)", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: IN_1_DAY }))).toBe(false);
  });

  it("is NOT due today when dueDate is in the past", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: PAST }))).toBe(false);
  });

  it("is NOT due today when both dates are absent", async () => {
    expect(caseIsDueToday(makeCase({}))).toBe(false);
  });

  it("is NOT due today for a closed case even if dueDate is today", async () => {
    expect(caseIsDueToday(makeCase({ status: "complete", dueDate: TODAY_DATE }))).toBe(false);
    expect(caseIsDueToday(makeCase({ status: "delivered", dueDate: TODAY_DATE }))).toBe(false);
  });

  // ── expectedDeliveryDate takes priority ───────────────────────────────────

  it("is due today when expectedDeliveryDate is today even if dueDate is tomorrow", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: IN_1_DAY, expectedDeliveryDate: TODAY_DATE }))).toBe(true);
  });

  it("is NOT due today when expectedDeliveryDate is tomorrow even if dueDate is today", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, expectedDeliveryDate: IN_1_DAY }))).toBe(false);
  });
});

/**
 * dueTime only ever pairs with dueDate (expectedDeliveryDate has no time-of-day
 * companion field) and only ever changes the outcome for a case due "today" —
 * every other day-diff bucket is decided by the day alone, exactly as before.
 * "now" is pinned to TODAY = 2026-07-20T12:00:00.000Z, i.e. local noon.
 */
describe("Mobile dashboard — dueTime awareness for the unchanged Due Today bucket", () => {
  it("keeps a case due today at a still-upcoming time in Due Today", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, dueTime: "15:30" }))).toBe(true);
  });

  it("a case due today at a time that has already passed is no longer due today", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, dueTime: "09:00" }))).toBe(false);
  });

  it("treats the exact current minute as already past (inclusive boundary)", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, dueTime: "12:00" }))).toBe(false);
  });

  it("a date-only case due today keeps its current date-level behavior (no time set)", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE }))).toBe(true);
  });

  it("a cleared time (null or empty string) behaves exactly like no time at all", async () => {
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, dueTime: null as unknown as string }))).toBe(true);
    expect(caseIsDueToday(makeCase({ dueDate: TODAY_DATE, dueTime: "" }))).toBe(true);
  });

  it("does not let a past same-day time affect a case that is not actually due today", async () => {
    // dueDate in the future: not due yet, regardless of dueTime.
    expect(caseIsDueToday(makeCase({ dueDate: FUTURE, dueTime: "00:00" }))).toBe(false);
  });

  it("ignores dueTime when expectedDeliveryDate (no time companion) wins the fallback", async () => {
    // expectedDeliveryDate is in the future, so the case is not due yet even
    // though its dueDate is today with an already-passed time.
    // expectedDeliveryDate resolves to today; a leftover dueTime from dueDate
    // must not be applied to it, so the case reads as due today regardless.
    expect(
      caseIsDueToday(makeCase({ dueDate: FUTURE, dueTime: "09:00", expectedDeliveryDate: TODAY_DATE })),
    ).toBe(true);
  });
});

describe("Mobile dashboard — dueSortKey (pastDueCases / dueTodayCases ordering)", () => {
  it("orders whole days ahead of minutes-of-day (earlier day always sorts first)", async () => {
    const yesterday = dueSortKey(makeCase({ dueDate: PAST }), 0);
    const today = dueSortKey(makeCase({ dueDate: TODAY_DATE }), 0);
    expect(yesterday).toBeLessThan(today);
  });

  it("within the same day, an earlier due time sorts before a later one", async () => {
    const morning = dueSortKey(makeCase({ dueDate: TODAY_DATE, dueTime: "09:00" }), 0);
    const afternoon = dueSortKey(makeCase({ dueDate: TODAY_DATE, dueTime: "15:30" }), 0);
    expect(morning).toBeLessThan(afternoon);
  });

  it("an untimed case on the same day sorts after a timed one", async () => {
    const timed = dueSortKey(makeCase({ dueDate: TODAY_DATE, dueTime: "23:00" }), 0);
    const untimed = dueSortKey(makeCase({ dueDate: TODAY_DATE }), 0);
    expect(timed).toBeLessThan(untimed);
  });

  it("two untimed cases on the same day keep an equal (stable-sort) key", async () => {
    const a = dueSortKey(makeCase({ dueDate: TODAY_DATE }), 0);
    const b = dueSortKey(makeCase({ dueDate: TODAY_DATE }), 0);
    expect(a).toBe(b);
  });

  it("ignores dueTime once expectedDeliveryDate (no time companion) wins the fallback", async () => {
    const withStaleTime = dueSortKey(
      makeCase({ dueDate: TODAY_DATE, dueTime: "09:00", expectedDeliveryDate: FUTURE }),
      0,
    );
    const withoutTime = dueSortKey(makeCase({ expectedDeliveryDate: FUTURE }), 0);
    expect(withStaleTime).toBe(withoutTime);
  });
});

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Tests exercise the REAL exported caseIsDueTomorrow predicate from
 * app/(tabs)/dashboard.tsx so any change to nextBizDayOffset or the date-field
 * fallback will fail CI immediately.
 *
 * Key scenario: on a Friday the next business day is Monday (offset = 3).
 * Saturday (+1) and Sunday (+2) cases must NOT appear in the "Due tomorrow"
 * section. The tests run with real fake-timer setSystemTime so the day-of-week
 * logic is exercised under the three relevant starting days (Mon, Fri, Sat).
 */
describe("Mobile dashboard — caseIsDueTomorrow (dueTomorrowCases predicate)", () => {
  // ── Monday baseline (top-level fake timer already set to 2026-07-20 = Mon) ─

  describe("on a Monday (nextBizDayOffset = 1, target = Tuesday)", () => {
    // vi.setSystemTime is already pinned to TODAY = 2026-07-20 (Monday) by the
    // top-level beforeAll/afterAll in this file; no extra setup needed.

    it("is due tomorrow when dueDate is the next calendar day (Tuesday, offset 1)", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: IN_1_DAY }))).toBe(true);
    });

    it("is NOT due tomorrow when dueDate is today (offset 0)", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: TODAY_DATE }))).toBe(false);
    });

    it("is NOT due tomorrow when dueDate is in the past", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: PAST }))).toBe(false);
    });

    it("is NOT due tomorrow when dueDate is two days away (offset mismatch)", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: "2026-07-22T00:00:00.000Z" }))).toBe(false);
    });

    it("is NOT due tomorrow when both date fields are absent", async () => {
      expect(caseIsDueTomorrow(makeCase({}))).toBe(false);
    });

    it("is NOT due tomorrow for a closed case even if dueDate matches the offset", async () => {
      expect(caseIsDueTomorrow(makeCase({ status: "complete", dueDate: IN_1_DAY }))).toBe(false);
      expect(caseIsDueTomorrow(makeCase({ status: "delivered", dueDate: IN_1_DAY }))).toBe(false);
      expect(caseIsDueTomorrow(makeCase({ status: "cancelled", dueDate: IN_1_DAY }))).toBe(false);
      expect(caseIsDueTomorrow(makeCase({ status: "void", dueDate: IN_1_DAY }))).toBe(false);
    });

    // expectedDeliveryDate takes priority over dueDate (desktop-parity)
    it("uses expectedDeliveryDate: due tomorrow when expectedDeliveryDate matches, dueDate past", async () => {
      expect(
        caseIsDueTomorrow(makeCase({ dueDate: PAST, expectedDeliveryDate: IN_1_DAY })),
      ).toBe(true);
    });

    it("uses expectedDeliveryDate: NOT due tomorrow when expectedDeliveryDate is past, dueDate matches", async () => {
      expect(
        caseIsDueTomorrow(makeCase({ dueDate: IN_1_DAY, expectedDeliveryDate: PAST })),
      ).toBe(false);
    });
  });

  // ── Friday (Fri→Mon skip) ────────────────────────────────────────────────

  describe("on a Friday (nextBizDayOffset = 3, target = following Monday)", () => {
    // 2026-07-24 is a Friday.
    const FRIDAY = "2026-07-24T12:00:00.000Z";
    const FRI_PLUS_1 = "2026-07-25T00:00:00.000Z"; // Saturday — NOT the next biz day
    const FRI_PLUS_2 = "2026-07-26T00:00:00.000Z"; // Sunday  — NOT the next biz day
    const FRI_PLUS_3 = "2026-07-27T00:00:00.000Z"; // Monday  — IS the next biz day

    beforeAll(() => {
      vi.setSystemTime(new Date(FRIDAY));
    });

    afterAll(() => {
      // Restore to the Monday baseline so sibling suites are unaffected.
      vi.setSystemTime(new Date(TODAY));
    });

    it("skips Saturday: a case due in 1 day (Sat) is NOT due tomorrow", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: FRI_PLUS_1 }))).toBe(false);
    });

    it("skips Sunday: a case due in 2 days (Sun) is NOT due tomorrow", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: FRI_PLUS_2 }))).toBe(false);
    });

    it("targets Monday: a case due in 3 days (Mon) IS due tomorrow", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: FRI_PLUS_3 }))).toBe(true);
    });

    it("respects expectedDeliveryDate on Friday (Mon by expectedDeliveryDate, Sat by dueDate)", async () => {
      expect(
        caseIsDueTomorrow(makeCase({ dueDate: FRI_PLUS_1, expectedDeliveryDate: FRI_PLUS_3 })),
      ).toBe(true);
    });

    it("rejects expectedDeliveryDate on Saturday even though it is 2 days away (target is +3)", async () => {
      expect(
        caseIsDueTomorrow(makeCase({ dueDate: FRI_PLUS_3, expectedDeliveryDate: FRI_PLUS_2 })),
      ).toBe(false);
    });
  });

  // ── Saturday (Sat→Mon skip) ──────────────────────────────────────────────

  describe("on a Saturday (nextBizDayOffset = 2, target = following Monday)", () => {
    // 2026-07-25 is a Saturday.
    const SATURDAY = "2026-07-25T12:00:00.000Z";
    const SAT_PLUS_1 = "2026-07-26T00:00:00.000Z"; // Sunday — NOT the next biz day
    const SAT_PLUS_2 = "2026-07-27T00:00:00.000Z"; // Monday — IS the next biz day

    beforeAll(() => {
      vi.setSystemTime(new Date(SATURDAY));
    });

    afterAll(() => {
      vi.setSystemTime(new Date(TODAY));
    });

    it("skips Sunday: a case due in 1 day (Sun) is NOT due tomorrow", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: SAT_PLUS_1 }))).toBe(false);
    });

    it("targets Monday: a case due in 2 days (Mon) IS due tomorrow", async () => {
      expect(caseIsDueTomorrow(makeCase({ dueDate: SAT_PLUS_2 }))).toBe(true);
    });
  });
});
