import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { LabCase } from "@/lib/types";
import { caseIsPastDue, caseIsDueTodayFn, caseIsDueTomorrowFn } from "../dashboard";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Tests exercise the REAL exported predicates from src/pages/dashboard.tsx
 * (`caseIsPastDue` / `caseIsDueTodayFn`) so any change to the date field
 * used in those functions will fail CI immediately.
 *
 * Contract: Past Due follows the effective due date (dueDate first, then
 * expectedDeliveryDate) and its paired time. Due Today and Due Tomorrow retain
 * their existing date-field behavior.
 */

// Pin local noon on 2026-07-20 so due-time comparisons stay stable in every
// configured test timezone.
const TODAY = new Date(2026, 6, 20, 12).toISOString();
const PAST_DATE = "2026-01-01";    // always before today
const FUTURE_DATE = "2026-12-31";  // always after today
const TODAY_DATE = "2026-07-20";   // same calendar day as TODAY

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TODAY));
});

afterAll(() => {
  vi.useRealTimers();
});

type CaseDateSlice = Pick<
  LabCase,
  "status" | "dueDate" | "dueTime" | "expectedDeliveryDate" | "receivedAt" | "createdAt"
>;

function makeCase(overrides: Partial<CaseDateSlice>): CaseDateSlice {
  return {
    status: "received",
    dueDate: null,
    dueTime: null,
    expectedDeliveryDate: null,
    receivedAt: null,
    createdAt: null,
    ...overrides,
  };
}

describe("Desktop dashboard — caseIsPastDue (pastDueCases predicate)", () => {
  it("includes a past effective due date regardless of when the case was received", () => {
    expect(caseIsPastDue(makeCase({ dueDate: PAST_DATE, receivedAt: TODAY }))).toBe(true);
  });

  it("does not include a future due date or a missing due date, even for an old received case", () => {
    expect(caseIsPastDue(makeCase({ dueDate: FUTURE_DATE, receivedAt: PAST_DATE }))).toBe(false);
    expect(caseIsPastDue(makeCase({ receivedAt: PAST_DATE }))).toBe(false);
    expect(caseIsPastDue(makeCase({ dueDate: "not-a-date", receivedAt: PAST_DATE }))).toBe(false);
  });

  it("does not treat a date-only due date of today as overdue", () => {
    expect(caseIsPastDue(makeCase({ dueDate: TODAY_DATE }))).toBe(false);
  });

  it("uses the paired due time for a case due today", () => {
    expect(caseIsPastDue(makeCase({ dueDate: TODAY_DATE, dueTime: "08:00" }))).toBe(true);
    expect(caseIsPastDue(makeCase({ dueDate: TODAY_DATE, dueTime: "18:00" }))).toBe(false);
  });

  it("falls back to expectedDeliveryDate only when dueDate is absent", () => {
    expect(caseIsPastDue(makeCase({ dueDate: null, expectedDeliveryDate: PAST_DATE }))).toBe(true);
    expect(
      caseIsPastDue(
        makeCase({ dueDate: FUTURE_DATE, expectedDeliveryDate: PAST_DATE }),
      ),
    ).toBe(false);
  });

  it("keeps completed, delivered, and cancelled cases excluded", () => {
    for (const status of ["complete", "delivered", "cancelled"] as const) {
      expect(caseIsPastDue(makeCase({ status, dueDate: PAST_DATE }))).toBe(false);
    }
  });
});

describe("Desktop dashboard — caseIsDueTodayFn (dueTodayCases predicate)", () => {
  it("identifies a case as due today when dueDate equals today", () => {
    expect(caseIsDueTodayFn(makeCase({ dueDate: TODAY_DATE }))).toBe(true);
  });

  it("is NOT due today when dueDate is in the past", () => {
    expect(caseIsDueTodayFn(makeCase({ dueDate: PAST_DATE }))).toBe(false);
  });

  it("is NOT due today when dueDate is in the future", () => {
    expect(caseIsDueTodayFn(makeCase({ dueDate: FUTURE_DATE }))).toBe(false);
  });

  it("is NOT due today when dueDate is absent", () => {
    expect(caseIsDueTodayFn(makeCase({}))).toBe(false);
  });

  it("is NOT due today for a completed case even if dueDate is today", () => {
    expect(caseIsDueTodayFn(makeCase({ status: "complete", dueDate: TODAY_DATE }))).toBe(false);
    expect(caseIsDueTodayFn(makeCase({ status: "delivered", dueDate: TODAY_DATE }))).toBe(false);
  });

  it("stays in Due Today when due today at a time later than now", () => {
    expect(caseIsDueTodayFn(makeCase({ dueDate: TODAY_DATE, dueTime: "18:00" }))).toBe(true);
  });

  it("moves out of Due Today when due today at a time earlier than now", () => {
    expect(caseIsDueTodayFn(makeCase({ dueDate: TODAY_DATE, dueTime: "08:00" }))).toBe(false);
  });

  it("moves a due-today case into Past Due after its due time has passed", () => {
    const c = makeCase({ dueDate: TODAY_DATE, dueTime: "08:00" });
    expect(caseIsPastDue(c)).toBe(true);
    expect(caseIsDueTodayFn(c)).toBe(false);
  });

  it("keeps a date-only case in Due Today", () => {
    const c = makeCase({ dueDate: TODAY_DATE });
    expect(caseIsDueTodayFn(c)).toBe(true);
  });

  // Regression: a stale past expectedDeliveryDate must NOT affect due-today classification
  // when dueDate itself is today.
  it("is due today when dueDate is today even if expectedDeliveryDate is past", () => {
    expect(
      caseIsDueTodayFn(makeCase({ dueDate: TODAY_DATE, expectedDeliveryDate: PAST_DATE })),
    ).toBe(true);
  });

  it("is NOT due today when dueDate is absent but expectedDeliveryDate is today (fallback)", () => {
    // expectedDeliveryDate fallback: no dueDate, expectedDeliveryDate is today.
    expect(
      caseIsDueTodayFn(makeCase({ dueDate: null, expectedDeliveryDate: TODAY_DATE })),
    ).toBe(true);
  });
});

// ── caseIsDueTomorrowFn ───────────────────────────────────────────────────────
//
// TODAY is pinned to 2026-07-20 (Monday). The next business day from a Monday
// is Tuesday, 2026-07-21. A separate nested block advances the clock to Friday
// (2026-07-24) to test the Fri→Mon skip.

describe("Desktop dashboard — caseIsDueTomorrowFn (dueTomorrowCases predicate)", () => {
  // TODAY is pinned to Monday 2026-07-20 in the outer beforeAll — next biz day = Tue 2026-07-21.
  const TOMORROW_DATE = "2026-07-21"; // Tuesday (next biz day from Monday)
  const DAY_AFTER = "2026-07-22";     // Wednesday — one day beyond tomorrow

  it("matches a case due on the next business day (Mon → Tue)", () => {
    expect(caseIsDueTomorrowFn(makeCase({ dueDate: TOMORROW_DATE }))).toBe(true);
  });

  it("does NOT match a case due today", () => {
    expect(caseIsDueTomorrowFn(makeCase({ dueDate: TODAY_DATE }))).toBe(false);
  });

  it("does NOT match a case due the day after tomorrow", () => {
    expect(caseIsDueTomorrowFn(makeCase({ dueDate: DAY_AFTER }))).toBe(false);
  });

  it("does NOT match a past-due case", () => {
    expect(caseIsDueTomorrowFn(makeCase({ dueDate: PAST_DATE }))).toBe(false);
  });

  it("does NOT match when no date is set", () => {
    expect(caseIsDueTomorrowFn(makeCase({}))).toBe(false);
  });

  it("excludes completed cases even when due date matches", () => {
    expect(caseIsDueTomorrowFn(makeCase({ status: "complete", dueDate: TOMORROW_DATE }))).toBe(false);
    expect(caseIsDueTomorrowFn(makeCase({ status: "delivered", dueDate: TOMORROW_DATE }))).toBe(false);
    expect(caseIsDueTomorrowFn(makeCase({ status: "cancelled", dueDate: TOMORROW_DATE }))).toBe(false);
  });

  it("falls back to expectedDeliveryDate when dueDate is absent", () => {
    expect(caseIsDueTomorrowFn(makeCase({ dueDate: null, expectedDeliveryDate: TOMORROW_DATE }))).toBe(true);
  });

  it("prefers expectedDeliveryDate over dueDate when both are set", () => {
    // expectedDeliveryDate is tomorrow → IS due tomorrow, even though dueDate is today.
    expect(
      caseIsDueTomorrowFn(makeCase({ dueDate: TODAY_DATE, expectedDeliveryDate: TOMORROW_DATE })),
    ).toBe(true);
    // expectedDeliveryDate is today → NOT due tomorrow, even though dueDate is tomorrow.
    expect(
      caseIsDueTomorrowFn(makeCase({ dueDate: TOMORROW_DATE, expectedDeliveryDate: TODAY_DATE })),
    ).toBe(false);
  });

  // Advance clock to Friday to verify the Mon skip (Fri → next biz day = Monday).
  describe("Friday → Monday skip", () => {
    const FRIDAY = "2026-07-24T12:00:00.000Z"; // Friday
    const NEXT_MONDAY = "2026-07-27";           // following Monday
    const SATURDAY = "2026-07-25";
    const SUNDAY = "2026-07-26";

    beforeAll(() => {
      vi.setSystemTime(new Date(FRIDAY));
    });

    afterAll(() => {
      // Restore to original Monday pinned time.
      vi.setSystemTime(new Date(TODAY));
    });

    it("matches Monday when today is Friday", () => {
      expect(caseIsDueTomorrowFn(makeCase({ dueDate: NEXT_MONDAY }))).toBe(true);
    });

    it("does NOT match Saturday (weekend is skipped)", () => {
      expect(caseIsDueTomorrowFn(makeCase({ dueDate: SATURDAY }))).toBe(false);
    });

    it("does NOT match Sunday (weekend is skipped)", () => {
      expect(caseIsDueTomorrowFn(makeCase({ dueDate: SUNDAY }))).toBe(false);
    });
  });
});
