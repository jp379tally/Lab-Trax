/**
 * Integration tests for the read-only Stats analytics routes.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - RBAC: 401 unauthenticated, 403 non-billing member, 200 owner
 *  - /stats/summary — case counts include canonical + legacy, revenue from
 *    invoices only (void + soft-deleted excluded, legacy blob invoices
 *    excluded), previous-period comparison, averageCaseValue is per-CASE
 *    (distinct billed cases, not per-invoice), topCategory follows filters,
 *    elapsedBusinessDays unchanged when a labClosedDays row falls on a Saturday or Sunday
 *  - /stats/case-categories — category buckets incl. uncategorized legacy,
 *    legacyCount, normalized material breakdown, material filter
 *  - /stats/revenue-series — month bucketing, category/material filters
 *    exclude caseless invoices, groupBy validation
 *  - /stats/weekday-volume — weekday attribution (0 = Monday), material filter
 *  - material filter matches canonical restorations (normalized) and legacy
 *    blob material strings
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.setConfig({ hookTimeout: 30_000 });
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-stats"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// Pure helper — no DB required, so runs unconditionally.
describe("nthBusinessDay (pace-trend prior-window helper)", () => {
  it("returns the Nth Mon–Fri from the start", async () => {
    const { nthBusinessDay } = await import("../lib/stats-utils.js");
    // Jan 1 2024 is a Monday. 1st business day = Jan 1, 5th = Jan 5 (Fri).
    expect(nthBusinessDay({ yr: 2024, mo: 0, day: 1 }, 1)).toEqual({
      yr: 2024,
      mo: 0,
      day: 1,
    });
    expect(nthBusinessDay({ yr: 2024, mo: 0, day: 1 }, 5)).toEqual({
      yr: 2024,
      mo: 0,
      day: 5,
    });
    // 6th business day skips the weekend to Jan 8 (Mon).
    expect(nthBusinessDay({ yr: 2024, mo: 0, day: 1 }, 6)).toEqual({
      yr: 2024,
      mo: 0,
      day: 8,
    });
  });

  it("returns null for a non-positive count", async () => {
    const { nthBusinessDay } = await import("../lib/stats-utils.js");
    expect(nthBusinessDay({ yr: 2024, mo: 0, day: 1 }, 0)).toBeNull();
    expect(nthBusinessDay({ yr: 2024, mo: 0, day: 1 }, -3)).toBeNull();
  });

  it("returns null (does not spill past the period) when the Nth day is beyond the end bound", async () => {
    const { nthBusinessDay } = await import("../lib/stats-utils.js");
    // Feb 2021: 20 business days, ending Feb 28 (Sun -> last biz day Feb 26).
    // Asking for the 25th business day would land in March without a bound;
    // with the end bound it must return null so the caller clamps to Feb end.
    const priorStart = { yr: 2021, mo: 1, day: 1 };
    const priorEnd = { yr: 2021, mo: 1, day: 28 };
    expect(nthBusinessDay(priorStart, 25, priorEnd)).toBeNull();
    // Without the bound the old behavior spilled into March (regression guard).
    const spill = nthBusinessDay(priorStart, 25);
    expect(spill).not.toBeNull();
    expect(spill!.mo).toBe(2); // March
  });

  it("still returns an in-range day when the Nth day fits inside the end bound", async () => {
    const { nthBusinessDay } = await import("../lib/stats-utils.js");
    const priorStart = { yr: 2021, mo: 1, day: 1 };
    const priorEnd = { yr: 2021, mo: 1, day: 28 };
    // 20th business day of Feb 2021 is Feb 26 (Fri) — inside the bound.
    expect(nthBusinessDay(priorStart, 20, priorEnd)).toEqual({
      yr: 2021,
      mo: 1,
      day: 26,
    });
  });
});

describe("remake reason reporting buckets", () => {
  it("groups keyed custom reasons as Other while preserving standard labels", async () => {
    const { remakeReasonBucket } = await import("../lib/stats-utils.js");
    expect(remakeReasonBucket("Occlusal interference", "other")).toBe("Other");
    expect(remakeReasonBucket("Didn't fit — margins", "fit_margins")).toBe(
      "Didn't fit — margins",
    );
    expect(remakeReasonBucket("Legacy text", null)).toBe("Legacy text");
  });
});

describe("lastCompletedBusinessDay (daily-sales cutoff helper)", () => {
  // Must use en-CA locale ("YYYY-MM-DD") — same as the production tzFormatter —
  // because localYmd() splits the formatted string on "-".
  const utcFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  it("Monday Jul 13 2026 → previous Friday Jul 10 2026", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    // 2026-07-13 is a Monday.
    const now = new Date("2026-07-13T09:00:00Z");
    expect(lastCompletedBusinessDay(now, utcFmt)).toEqual({
      yr: 2026,
      mo: 6, // 0-indexed July
      day: 10,
    });
  });

  it("Tuesday Jul 14 2026 → Monday Jul 13 2026 (yesterday)", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    const now = new Date("2026-07-14T09:00:00Z");
    expect(lastCompletedBusinessDay(now, utcFmt)).toEqual({
      yr: 2026,
      mo: 6,
      day: 13,
    });
  });

  it("Friday Jul 17 2026 → Thursday Jul 16 2026 (yesterday)", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    const now = new Date("2026-07-17T09:00:00Z");
    expect(lastCompletedBusinessDay(now, utcFmt)).toEqual({
      yr: 2026,
      mo: 6,
      day: 16,
    });
  });

  it("Saturday Jul 11 2026 → Friday Jul 10 2026 (yesterday)", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    const now = new Date("2026-07-11T09:00:00Z");
    expect(lastCompletedBusinessDay(now, utcFmt)).toEqual({
      yr: 2026,
      mo: 6,
      day: 10,
    });
  });

  it("Sunday Jul 12 2026 → Friday Jul 10 2026 (2 days back)", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    const now = new Date("2026-07-12T09:00:00Z");
    expect(lastCompletedBusinessDay(now, utcFmt)).toEqual({
      yr: 2026,
      mo: 6,
      day: 10,
    });
  });
});

describe("countBusinessDays (Mon–Fri business-day counter)", () => {
  it("Jul 1–10 2026 = 8 elapsed business days", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 1 Wed, 2 Thu, 3 Fri, 6 Mon, 7 Tue, 8 Wed, 9 Thu, 10 Fri = 8
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 1 }, { yr: 2026, mo: 6, day: 10 }),
    ).toBe(8);
  });

  it("Jul 1–31 2026 = 23 total business days", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    // 5 full weeks (Mon-Fri) = 5×5 = 25, minus Jul 4 (Sat) and Jul 5 (Sun) already excluded.
    // Weeks: Jul 1-3 (3) + Jul 6-10 (5) + Jul 13-17 (5) + Jul 20-24 (5) + Jul 27-31 (5) = 23.
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 1 }, { yr: 2026, mo: 6, day: 31 }),
    ).toBe(23);
  });

  it("returns 0 when end is before start (empty range)", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 10 }, { yr: 2026, mo: 6, day: 1 }),
    ).toBe(0);
  });

  it("weekend-only range returns 0", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 4–5 2026 is Sat–Sun.
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 4 }, { yr: 2026, mo: 6, day: 5 }),
    ).toBe(0);
  });

  it("skips holidays when a holidays set is supplied", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 1–10 2026 = 8 weekdays without holidays.
    // Marking Jul 1 (Wed) and Jul 7 (Tue) as holidays reduces count to 6.
    const holidays = new Set(["2026-07-01", "2026-07-07"]);
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 1 }, { yr: 2026, mo: 6, day: 10 }, holidays),
    ).toBe(6);
  });

  it("a holiday that falls on a weekend is already excluded (no double-count penalty)", async () => {
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 4–5 2026 is Sat–Sun; marking both as holidays still returns 0.
    const holidays = new Set(["2026-07-04", "2026-07-05"]);
    expect(
      countBusinessDays({ yr: 2026, mo: 6, day: 4 }, { yr: 2026, mo: 6, day: 5 }, holidays),
    ).toBe(0);
  });
});

describe("usHolidaysForYear (US federal holiday calendar)", () => {
  it("2026 observed dates hit the right calendar dates", async () => {
    const { usHolidaysForYear } = await import("../lib/us-holidays.js");
    const h = usHolidaysForYear(2026);
    // New Year's Day Jan 1 2026 is a Thursday → observed Thu Jan 1.
    expect(h.has("2026-01-01")).toBe(true);
    // Independence Day Jul 4 2026 is a Saturday → omitted (no Friday shift).
    expect(h.has("2026-07-03")).toBe(false);
    expect(h.has("2026-07-04")).toBe(false);
    // Christmas Dec 25 2026 is a Friday → observed Fri Dec 25.
    expect(h.has("2026-12-25")).toBe(true);
    // Thanksgiving 4th Thursday of November 2026 = Nov 26.
    expect(h.has("2026-11-26")).toBe(true);
    // Labor Day 1st Monday of September 2026 = Sep 7.
    expect(h.has("2026-09-07")).toBe(true);
    // Memorial Day last Monday of May 2026 = May 25.
    expect(h.has("2026-05-25")).toBe(true);
  });

  it("2023 Christmas falls on Monday Dec 25 (no shift)", async () => {
    const { usHolidaysForYear } = await import("../lib/us-holidays.js");
    const h = usHolidaysForYear(2023);
    expect(h.has("2023-12-25")).toBe(true);
  });

  it("2022 New Year falls on Saturday Jan 1 → omitted (no Friday shift, no entry in 2022 set)", async () => {
    const { usHolidaysForYear } = await import("../lib/us-holidays.js");
    // Jan 1 2022 is a Saturday → omitted rather than shifted to Fri Dec 31 2021.
    // Neither set should contain Dec 31 2021 as a New Year's observance.
    const h2022 = usHolidaysForYear(2022);
    expect(h2022.has("2021-12-31")).toBe(false);
    const h2021 = usHolidaysForYear(2021);
    expect(h2021.has("2021-12-31")).toBe(false);
    // 2022 has one Saturday holiday (New Year's) → 10 entries, not 11.
    expect(h2022.size).toBe(10);
  });

  it("returns 11 entries when no holidays fall on Saturday, fewer when they do", async () => {
    const { usHolidaysForYear } = await import("../lib/us-holidays.js");
    // 2024 and 2025: no fixed-date holidays fall on Saturday → 11 each.
    expect(usHolidaysForYear(2024).size).toBe(11);
    expect(usHolidaysForYear(2025).size).toBe(11);
    // 2026: Independence Day (Jul 4) falls on Saturday → omitted → 10 entries.
    expect(usHolidaysForYear(2026).size).toBe(10);
  });
});

describe("lastCompletedBusinessDay skips holidays", () => {
  const utcFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  it("skips a holiday that falls on a weekday", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    // Today is Tuesday Jul 14 2026; yesterday (Mon Jul 13) is marked as holiday.
    // Should skip to Friday Jul 10.
    const now = new Date("2026-07-14T09:00:00Z");
    const holidays = new Set(["2026-07-13"]);
    expect(lastCompletedBusinessDay(now, utcFmt, holidays)).toEqual({
      yr: 2026,
      mo: 6,
      day: 10,
    });
  });

  it("skips a multi-day holiday+weekend cluster (e.g. Christmas week)", async () => {
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    // Today is Tue Dec 29 2026; Dec 28 Mon is a custom closed day, Dec 25 is
    // Christmas (Fri), leaving Dec 24 Thu as the last worked day.
    const now = new Date("2026-12-29T09:00:00Z");
    const holidays = new Set(["2026-12-25", "2026-12-28"]);
    expect(lastCompletedBusinessDay(now, utcFmt, holidays)).toEqual({
      yr: 2026,
      mo: 11,
      day: 24,
    });
  });
});

describe("listExcludedBusinessDays (Mon–Fri holiday enumerator)", () => {
  it("returns federal holidays that fall on Mon–Fri within the window", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 1–10 2026: manually inject Jul 3 (Fri) as a federal holiday to test
    // the basic weekday-inclusion path (usHolidaysForYear(2026) no longer emits
    // Jul 3 since Jul 4 falls on Saturday and is omitted rather than shifted).
    const federal = new Set(["2026-07-03"]);
    const custom = new Set<string>();
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 10 },
      federal,
      custom,
    );
    expect(result).toEqual([{ date: "2026-07-03", reason: "holiday" }]);
  });

  it("skips a holiday that falls on a weekend (no weekday exclusion emitted)", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 4 2026 is a Saturday — even if it is in the federal set it must not appear.
    const federal = new Set(["2026-07-04"]);
    const custom = new Set<string>();
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 10 },
      federal,
      custom,
    );
    expect(result).toEqual([]);
  });

  it("returns custom closed days tagged with reason 'custom'", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 7 2026 is a Tuesday.
    const federal = new Set<string>();
    const custom = new Set(["2026-07-07"]);
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 10 },
      federal,
      custom,
    );
    expect(result).toEqual([{ date: "2026-07-07", reason: "custom" }]);
  });

  it("federal takes priority over custom when a day appears in both sets", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 3 is in both federal and custom → reason must be "holiday".
    const federal = new Set(["2026-07-03"]);
    const custom = new Set(["2026-07-03", "2026-07-07"]);
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 10 },
      federal,
      custom,
    );
    expect(result).toEqual([
      { date: "2026-07-03", reason: "holiday" },
      { date: "2026-07-07", reason: "custom" },
    ]);
  });

  it("returns empty array when end is before start (empty range)", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    const federal = new Set(["2026-07-03"]);
    const custom = new Set<string>();
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 10 },
      { yr: 2026, mo: 6, day: 1 }, // end before start
      federal,
      custom,
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when neither set contains any date in the window", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 10 },
      new Set<string>(),
      new Set<string>(),
    );
    expect(result).toEqual([]);
  });

  it("single Mon–Fri day that is a holiday returns exactly that entry", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Jul 3 2026 is a Friday.
    const federal = new Set(["2026-07-03"]);
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 3 },
      { yr: 2026, mo: 6, day: 3 },
      federal,
      new Set<string>(),
    );
    expect(result).toEqual([{ date: "2026-07-03", reason: "holiday" }]);
  });

  it("every entry in dates is a Mon–Fri date (dow 1–5)", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    // Build a set with every day of July 2026, then verify none of the returned
    // dates falls on a Saturday or Sunday.
    const federal = new Set(
      Array.from({ length: 31 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 6, i + 1));
        return d.toISOString().slice(0, 10);
      }),
    );
    const result = listExcludedBusinessDays(
      { yr: 2026, mo: 6, day: 1 },
      { yr: 2026, mo: 6, day: 31 },
      federal,
      new Set<string>(),
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      const dow = new Date(entry.date + "T12:00:00Z").getUTCDay();
      expect(dow, `${entry.date} must be Mon–Fri`).toBeGreaterThanOrEqual(1);
      expect(dow, `${entry.date} must be Mon–Fri`).toBeLessThanOrEqual(5);
    }
  });

  it("cross-year window Dec 31 2025 – Jan 14 2026: New Year's Day 2026 (Thu Jan 1) counted exactly once", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    // Build the holiday set spanning both sides of the year boundary.
    // usHolidaysForYear(2026) includes "2026-01-01" (Jan 1 2026 is a Thursday).
    // Without year 2026 in the set this holiday would be silently missing.
    const federal = usHolidaySet([2025, 2026]);
    const result = listExcludedBusinessDays(
      { yr: 2025, mo: 11, day: 31 }, // Dec 31 2025 (mo is 0-indexed)
      { yr: 2026, mo: 0, day: 14 },  // Jan 14 2026 (before MLK Jr. Day Jan 19)
      federal,
      new Set<string>(),
    );
    // Jan 1 2026 (Thursday) is the only federal holiday in this window.
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: "2026-01-01", reason: "holiday" });
  });

  it("Sunday-shift New Year's: Jan 1 2023 is Sunday → observed Mon Jan 2 2023 lands in window, Jan 1 not returned", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    // Jan 1 2023 is a Sunday → usHolidaysForYear(2023) emits "2023-01-02" (Mon).
    // The observed date stays in the same year so no cross-year logic is needed,
    // but this test confirms: (a) Mon Jan 2 appears exactly once in the result,
    // (b) "2023-01-01" (Sunday) is absent because the Mon–Fri filter drops it.
    const federal = usHolidaySet([2023]);
    const result = listExcludedBusinessDays(
      { yr: 2023, mo: 0, day: 1 },  // Jan 1 2023 (0-indexed month)
      { yr: 2023, mo: 0, day: 14 }, // Jan 14 2023 (before MLK Jr. Day Jan 16)
      federal,
      new Set<string>(),
    );
    // Exactly one holiday in this window: Mon Jan 2 2023 (New Year's observed).
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: "2023-01-02", reason: "holiday" });
    // Jan 1 (Sunday) must NOT appear — it is filtered out by the Mon–Fri guard.
    expect(result.map((r) => r.date)).not.toContain("2023-01-01");
  });

  it("regression: New Year's Day Jan 1 2022 falls on Saturday → omitted from both single-year and multi-year sets", async () => {
    const { listExcludedBusinessDays } = await import("../lib/stats-utils.js");
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    // Jan 1 2022 is a Saturday → omitted (not shifted to Fri Dec 31 2021).
    // Neither a single-year [2021] set nor a multi-year [2021, 2022] set should
    // include Dec 31 2021 as a federal holiday observance.
    const federalWithNextYear = usHolidaySet([2021, 2022]);
    const federalYearOnly = usHolidaySet([2021]);
    // Multi-year set: Dec 31 2021 is NOT a holiday (Saturday → omit).
    const withNext = listExcludedBusinessDays(
      { yr: 2021, mo: 11, day: 31 }, // Dec 31 2021
      { yr: 2021, mo: 11, day: 31 },
      federalWithNextYear,
      new Set<string>(),
    );
    expect(withNext).toHaveLength(0);
    // Single-year set: same result — Dec 31 2021 is not a holiday.
    const withoutNext = listExcludedBusinessDays(
      { yr: 2021, mo: 11, day: 31 },
      { yr: 2021, mo: 11, day: 31 },
      federalYearOnly,
      new Set<string>(),
    );
    expect(withoutNext).toHaveLength(0);
  });
});

maybe("Stats analytics routes (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u");
  const memberId = rid("m");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  // Fixed, deterministic window (UTC).
  const FROM = "2026-03-01T00:00:00.000Z";
  const TO = "2026-03-31T23:59:59.999Z";

  // Case ids (created in beforeAll).
  const zirCaseId = rid("c_zir");
  const implantCaseId = rid("c_imp");
  const blankCaseId = rid("c_blank");
  const remakeCaseId = rid("c_remake");
  const legacyCatId = rid("lc_denture");
  const legacyUncatId = rid("lc_blank");
  const legacyRemakeId = rid("lc_remake");

  // Additional remake case ids for filter / timeSeries / records tests.
  const remakeCaseId2 = rid("c_remake2"); // crown_bridge, material_quality, returnedToLab, not recharged
  const remakeCaseId3 = rid("c_remake3"); // removable, no reasonKey, not recharged, doctorName="Dr Second"

  const invoiceIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  function baseQs(extra: Record<string, string> = {}) {
    return new URLSearchParams({
      organizationId: labOrgId,
      dateFrom: FROM,
      dateTo: TO,
      timeZone: "UTC",
      ...extra,
    }).toString();
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-stats";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      caseRestorations,
      labCases,
      invoices,
    } = dbMod as any;

    await db.insert(users).values([
      { id: ownerId, username: `statsowner_${ownerId}`, password: "x" },
      { id: memberId, username: `statsmem_${memberId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("StatsTestLab") },
      { id: providerOrgId, type: "provider", name: rid("StatsTestProv") },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
    ]);

    // Canonical cases inside the window. 2026-03-02 is a Monday.
    const caseDefaults = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Stat",
      patientLastName: "Patient",
      doctorName: "Dr Stats",
      createdByUserId: ownerId,
    };
    await db.insert(cases).values([
      {
        ...caseDefaults,
        id: zirCaseId,
        caseNumber: rid("SC-Z"),
        receivedAt: "2026-03-02", // Monday
      },
      {
        ...caseDefaults,
        id: implantCaseId,
        caseNumber: rid("SC-I"),
        receivedAt: "2026-03-03", // Tuesday
      },
      {
        ...caseDefaults,
        id: blankCaseId,
        caseNumber: rid("SC-B"),
        receivedAt: "2026-03-02", // Monday
      },
      {
        ...caseDefaults,
        id: remakeCaseId,
        caseNumber: rid("SC-R"),
        receivedAt: "2026-03-05", // Thursday (week of Mar 2)
        remakeOfCaseId: zirCaseId,
        remakeReason: "Shade mismatch",
        remakeCharged: true,
      },
      {
        // crown_bridge + reasonKey="material_quality" + returnedToLab + not recharged
        // Received Monday 2026-03-09 → week bucket "2026-03-09"
        ...caseDefaults,
        id: remakeCaseId2,
        caseNumber: rid("SC-R2"),
        receivedAt: "2026-03-09", // Monday (week of Mar 9)
        remakeOfCaseId: zirCaseId,
        remakeReason: "Wrong material used",
        remakeReasonKey: "material_quality",
        remakeCharged: false,
        remakeReturnedToLab: true,
        remakeCategory: "crown_bridge",
      },
      {
        // removable category + no reasonKey + not recharged + not returnedToLab
        // Received Monday 2026-03-16 → week bucket "2026-03-16"
        // doctorName overridden (distinct from the shared "Dr Stats" default)
        // so doctor-filter tests have a second real doctor to narrow to.
        ...caseDefaults,
        id: remakeCaseId3,
        caseNumber: rid("SC-R3"),
        doctorName: "Dr Second",
        receivedAt: "2026-03-16", // Monday (week of Mar 16)
        remakeOfCaseId: zirCaseId,
        remakeReason: "Fit issue",
        remakeCharged: false,
        remakeReturnedToLab: false,
        remakeCategory: "removable",
      },
    ]);
    await db.insert(caseRestorations).values([
      {
        id: rid("r1"),
        caseId: zirCaseId,
        toothNumber: "8",
        restorationType: "Crown",
        material: "BruxZir", // normalizes to Zirconia
        quantity: 2,
      },
      {
        id: rid("r2"),
        caseId: implantCaseId,
        toothNumber: "19",
        restorationType: "Implant Crown",
        material: "Zirconia", // implants outranks zirconia at case level
        quantity: 1,
      },
      // blankCaseId has no restoration rows → uncategorized
    ]);

    // Legacy lab_cases: one categorizable (denture → removable), one blank,
    // one remake. Legacy blob invoiceTotal must NOT count toward revenue.
    await db.insert(labCases).values([
      {
        id: legacyCatId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Legacy One",
          caseType: "Full Denture",
          material: "Acrylic", // legacy blob material (passes through unchanged)
          createdAt: "2026-03-04T09:00:00.000Z", // Wednesday
          invoiceTotal: "9999.00",
          invoices: [{ id: "blob-inv", total: "9999.00" }],
        }),
      },
      {
        id: legacyUncatId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Legacy Two",
          createdAt: "2026-03-05T09:00:00.000Z", // Thursday
        }),
      },
      {
        id: legacyRemakeId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Legacy Remake",
          isRemake: true,
          remakeReason: "", // blank → should roll up to "Unspecified"
          remakeCharged: false,
          createdAt: "2026-03-06T09:00:00.000Z", // Friday
        }),
      },
    ]);

    // Invoices: three counted (two on the zirconia case — proves the
    // per-CASE average — one on the implant case), one void (excluded),
    // one soft-deleted (excluded), one caseless manual invoice (excluded
    // under a category/material filter), one in the previous period (Feb).
    const invDefaults = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      createdByUserId: ownerId,
    };
    const mkInv = (over: Record<string, unknown>) => {
      const id = rid("inv");
      invoiceIds.push(id);
      return { ...invDefaults, id, invoiceNumber: rid("SINV"), ...over };
    };
    await db.insert(invoices).values([
      mkInv({
        caseId: zirCaseId,
        total: "100.00",
        status: "sent",
        issuedAt: new Date("2026-03-10T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId, // second invoice on the SAME case
        total: "60.00",
        status: "sent",
        issuedAt: new Date("2026-03-18T00:00:00.000Z"),
      }),
      mkInv({
        caseId: implantCaseId,
        total: "250.00",
        status: "sent",
        issuedAt: new Date("2026-03-20T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "5000.00",
        status: "void",
        issuedAt: new Date("2026-03-11T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "7000.00",
        status: "sent",
        issuedAt: new Date("2026-03-12T00:00:00.000Z"),
        deletedAt: new Date(),
      }),
      mkInv({
        caseId: null,
        total: "40.00",
        status: "sent",
        issuedAt: new Date("2026-03-15T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "80.00",
        status: "sent",
        issuedAt: new Date("2026-02-10T00:00:00.000Z"), // previous period
      }),
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      invoices,
      caseRestorations,
      cases,
      labCases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (invoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    await db
      .delete(caseRestorations)
      .where(inArray(caseRestorations.caseId, [zirCaseId, implantCaseId, blankCaseId]));
    await db
      .delete(cases)
      .where(
        inArray(cases.id, [
          zirCaseId,
          implantCaseId,
          blankCaseId,
          remakeCaseId,
          remakeCaseId2,
          remakeCaseId3,
        ]),
      );
    await db.delete(labCases).where(inArray(labCases.id, [legacyCatId, legacyUncatId, legacyRemakeId]));
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerId, memberId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [ownerId, memberId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
  });

  // ── RBAC ──────────────────────────────────────────────────────────────

  it("returns 401 without a token", async () => {
    const r = await request(appMod.default).get(`/api/stats/summary?${baseQs()}`);
    expect(r.status).toBe(401);
  });

  it("returns 403 for a non-billing member on all five endpoints", async () => {
    const { access } = await makeSession(memberId);
    for (const ep of [
      "summary",
      "case-categories",
      "revenue-series",
      "weekday-volume",
      "remakes",
    ]) {
      const r = await request(appMod.default)
        .get(`/api/stats/${ep}?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status, ep).toBe(403);
    }
  });

  it("returns 403 for a billing-only member on remakes (owner/admin only)", async () => {
    const billingId = rid("billing");
    const {
      db,
      users,
      organizationMemberships,
    } = dbMod as any;
    await db.insert(users).values({
      id: billingId,
      username: `statsbilling_${billingId}`,
      password: "x",
    });
    await db.insert(organizationMemberships).values({
      id: rid("m_billing"),
      labId: labOrgId,
      userId: billingId,
      role: "billing",
      status: "active",
      approvedByUserId: ownerId,
      joinedAt: new Date(),
    });
    const { access } = await makeSession(billingId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(403);
    // Cleanup
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, billingId));
    await db.delete(users).where(eq(users.id, billingId));
  });

  // ── /stats/summary ────────────────────────────────────────────────────

  it("summary counts canonical + legacy cases and invoice-only revenue", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // 6 canonical (zir, implant, blank, remake, remake2, remake3) + 3 legacy;
    // legacy blob invoiceTotal (9999) NOT in revenue,
    // void (5000) and soft-deleted (7000) invoices excluded.
    expect(d.totalCases).toBe(9);
    expect(d.legacyCases).toBe(3);
    expect(d.totalRevenue).toBe("450.00"); // 100 + 60 + 250 + 40 (caseless counts unfiltered)
    expect(d.invoiceCount).toBe(4);
    // Per-CASE average: 450 / 3 billed cases (zir counted ONCE despite two
    // invoices, implant, caseless-as-one). Per-invoice would be 112.50.
    expect(d.averageCaseValue).toBe("150.00");
    expect(d.topCategoryCount).toBeGreaterThan(0);

    // Monday (2 non-remake cases) is the busiest weekday; remake is Thursday.
    expect(d.busiestWeekday).toBe(0);
    expect(d.busiestWeekdayLabel).toBe("Monday");

    // Previous period picked up the Feb invoice.
    expect(d.previousPeriod.invoiceCount).toBe(1);
    expect(d.previousPeriod.totalRevenue).toBe("80.00");
    expect(d.previousPeriod.revenueChangePct).not.toBeNull();

    // Edge case: March 2026 has zero US federal holidays on Mon–Fri.
    // Verify the excludedDays structure is present and correctly empty.
    expect(d.excludedDays.holidayCount).toBe(0);
    expect(d.excludedDays.customClosedCount).toBe(0);
    expect(d.excludedDays.dates).toEqual([]);
  });

  it("summary with category filter narrows cases, revenue, and topCategory", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ category: "zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // only the zirconia case
    // Only the zirconia case's non-void invoices; caseless invoice excluded.
    expect(d.totalRevenue).toBe("160.00");
    expect(d.invoiceCount).toBe(2);
    // Per-CASE average: 160 / 1 case (per-invoice would be 80.00).
    expect(d.averageCaseValue).toBe("160.00");
    // topCategory follows the active filter.
    expect(d.topCategory).toBe("zirconia");
    expect(d.topCategoryCount).toBe(1);
  });

  it("summary with material filter matches canonical restorations", async () => {
    const { access } = await makeSession(ownerId);
    // BruxZir (zir case) and Zirconia (implant case) both normalize to
    // "Zirconia", so the material filter matches BOTH cases.
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2);
    expect(d.totalRevenue).toBe("410.00"); // 100 + 60 + 250; caseless excluded
    expect(d.invoiceCount).toBe(3);
    expect(d.averageCaseValue).toBe("205.00"); // 410 / 2 distinct cases
  });

  it("summary combines category and material filters", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/summary?${baseQs({ category: "implants", material: "Zirconia" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // only the implant case
    expect(d.totalRevenue).toBe("250.00");
    expect(d.topCategory).toBe("implants");
  });

  it("summary material filter matches legacy blob material strings", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ material: "Acrylic" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // the legacy denture blob
    expect(d.legacyCases).toBe(1);
    expect(d.totalRevenue).toBe("0.00"); // legacy blob invoices never count
    expect(d.invoiceCount).toBe(0);
    expect(d.topCategory).toBe("removable");
  });

  it.each([
    [
      "Pacific/Kiritimati",
      "2026-08-31T10:00:00.000Z",
      "2026-09-01T09:59:59.999Z",
    ],
    [
      "Etc/GMT+12",
      "2026-09-01T12:00:00.000Z",
      "2026-09-02T11:59:59.999Z",
    ],
  ])(
    "filters received calendar dates by the client's local day in %s",
    async (timeZone, dateFrom, dateTo) => {
      const { db, cases: casesTable } = dbMod as any;
      const ids = [
        rid("outside-before"),
        rid("inside"),
        rid("outside-after"),
      ];
      await db.insert(casesTable).values([
        {
          id: ids[0],
          caseNumber: rid("STATS-BEFORE"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Outside",
          patientLastName: "Before",
          doctorName: "Dr. Boundary",
          status: "received",
          receivedAt: "2026-08-31",
          createdByUserId: ownerId,
        },
        {
          id: ids[1],
          caseNumber: rid("STATS-INSIDE"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Inside",
          patientLastName: "Boundary",
          doctorName: "Dr. Boundary",
          status: "received",
          receivedAt: "2026-09-01",
          createdByUserId: ownerId,
        },
        {
          id: ids[2],
          caseNumber: rid("STATS-AFTER"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Outside",
          patientLastName: "After",
          doctorName: "Dr. Boundary",
          status: "received",
          receivedAt: "2026-09-02",
          createdByUserId: ownerId,
        },
      ]);

      try {
        const { access } = await makeSession(ownerId);
        const response = await request(appMod.default)
          .get(
            `/api/stats/case-categories?${baseQs({
              dateFrom,
              dateTo,
              timeZone,
            })}`,
          )
          .set("Authorization", `Bearer ${access}`);

        expect(response.status).toBe(200);
        expect(response.body.data.totalCases).toBe(1);
      } finally {
        await db.delete(casesTable).where(inArray(casesTable.id, ids));
      }
    },
  );

  it("compares equal calendar-day periods across the New York fall-back transition", async () => {
    const { db, cases: casesTable } = dbMod as any;
    const ids = [rid("dst-extra"), rid("dst-previous"), rid("dst-current")];
    const dates = ["2026-10-30", "2026-10-31", "2026-11-01"];
    await db.insert(casesTable).values(
      ids.map((id, index) => ({
        id,
        caseNumber: rid(`DST-${index}`),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "DST",
        patientLastName: String(index),
        doctorName: "Dr. Boundary",
        status: "received",
        receivedAt: dates[index],
        createdByUserId: ownerId,
      })),
    );

    try {
      const { access } = await makeSession(ownerId);
      const response = await request(appMod.default)
        .get(
          `/api/stats/summary?${baseQs({
            dateFrom: "2026-11-01T04:00:00.000Z",
            dateTo: "2026-11-02T04:59:59.999Z",
            timeZone: "America/New_York",
          })}`,
        )
        .set("Authorization", `Bearer ${access}`);

      expect(response.status).toBe(200);
      expect(response.body.data.totalCases).toBe(1);
      expect(response.body.data.previousPeriod.totalCases).toBe(1);
    } finally {
      await db.delete(casesTable).where(inArray(casesTable.id, ids));
    }
  });

  it("summary elapsedBusinessDays is unchanged when a labClosedDays row falls on a Saturday", async () => {
    // 2026-03-07 is a Saturday. Inserting it as a lab closed day must not
    // reduce elapsedBusinessDays because countBusinessDays already skips
    // weekends before consulting the holidays set — no double-subtraction.
    // March 2026 has 22 Mon–Fri days (no US federal holidays in March);
    // the period is fully in the past so effectiveCutoff == periodEnd.
    const { db, labClosedDays: labClosedDaysTable } = dbMod as any;
    const satClosedDayId = rid("lcd_sat");
    await db.insert(labClosedDaysTable).values({
      id: satClosedDayId,
      labOrganizationId: labOrgId,
      date: "2026-03-07", // Saturday
    });
    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;
      // 22 Mon–Fri days in March 2026; the Saturday closed-day row must not
      // subtract an additional day (it was already excluded as a weekend).
      expect(d.elapsedBusinessDays).toBe(22);
      expect(d.totalBusinessDays).toBe(22);
    } finally {
      await db
        .delete(labClosedDaysTable)
        .where(eq(labClosedDaysTable.id, satClosedDayId));
    }
  });

  it("summary elapsedBusinessDays is unchanged when a labClosedDays row falls on a Sunday", async () => {
    // 2026-03-01 is a Sunday (UTC getUTCDay() === 0). Inserting it as a lab
    // closed day must not reduce elapsedBusinessDays because countBusinessDays
    // skips days where dow < 1 before consulting the holidays set.  Sunday
    // exercises the dow === 0 branch, which is distinct from Saturday
    // (dow === 6) and was not previously covered by a DB round-trip test.
    // March 2026 has 22 Mon–Fri days (no US federal holidays in March);
    // the period is fully in the past so effectiveCutoff == periodEnd.
    const { db, labClosedDays: labClosedDaysTable } = dbMod as any;
    const sunClosedDayId = rid("lcd_sun");
    await db.insert(labClosedDaysTable).values({
      id: sunClosedDayId,
      labOrganizationId: labOrgId,
      date: "2026-03-01", // Sunday
    });
    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;
      // 22 Mon–Fri days in March 2026; the Sunday closed-day row must not
      // subtract an additional day (it was already excluded as a weekend).
      expect(d.elapsedBusinessDays).toBe(22);
      expect(d.totalBusinessDays).toBe(22);
    } finally {
      await db
        .delete(labClosedDaysTable)
        .where(eq(labClosedDaysTable.id, sunClosedDayId));
    }
  });

  it("summary avgTurnaroundDays uses case_locations received→complete anchors", async () => {
    // Two cases with known durations: 10 days and 5 days → average 7.5 days.
    // A third case has only a 'received' location (no 'complete') and must be
    // excluded from the average.
    const tCaseId1 = rid("c_ta1");
    const tCaseId2 = rid("c_ta2");
    const tCaseId3 = rid("c_ta3"); // received-only, no complete

    const { db, cases: casesTable, caseLocations: caseLocationsTable } = dbMod as any;

    const caseBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Turn",
      patientLastName: "Around",
      doctorName: "Dr Turnaround",
      createdByUserId: ownerId,
      receivedAt: "2026-03-02",
    };

    await db.insert(casesTable).values([
      { ...caseBase, id: tCaseId1, caseNumber: rid("TA1") },
      { ...caseBase, id: tCaseId2, caseNumber: rid("TA2") },
      { ...caseBase, id: tCaseId3, caseNumber: rid("TA3") },
    ]);

    // Case 1: received Mar 2, complete Mar 12 → 10 days
    // Case 2: received Mar 2, complete Mar 7 → 5 days
    // Case 3: received Mar 2, no complete entry
    const locBase = { movedByUserId: ownerId };
    await db.insert(caseLocationsTable).values([
      { ...locBase, id: rid("loc1r"), caseId: tCaseId1, locationCode: "received", locationName: "Received", movedAt: new Date("2026-03-02T00:00:00.000Z") },
      { ...locBase, id: rid("loc1c"), caseId: tCaseId1, locationCode: "complete", locationName: "Complete", movedAt: new Date("2026-03-12T00:00:00.000Z") },
      { ...locBase, id: rid("loc2r"), caseId: tCaseId2, locationCode: "received", locationName: "Received", movedAt: new Date("2026-03-02T00:00:00.000Z") },
      { ...locBase, id: rid("loc2c"), caseId: tCaseId2, locationCode: "complete", locationName: "Complete", movedAt: new Date("2026-03-07T00:00:00.000Z") },
      { ...locBase, id: rid("loc3r"), caseId: tCaseId3, locationCode: "received", locationName: "Received", movedAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      // (10 days + 5 days) / 2 = 7.5 days
      expect(d.avgTurnaroundDays).toBe(7.5);
      // Only 2 of the 3 new cases qualify (case3 has no 'complete' location).
      expect(d.eligibleTurnaroundCaseCount).toBe(2);
    } finally {
      await db
        .delete(caseLocationsTable)
        .where(inArray(caseLocationsTable.caseId, [tCaseId1, tCaseId2, tCaseId3]));
      await db
        .delete(casesTable)
        .where(inArray(casesTable.id, [tCaseId1, tCaseId2, tCaseId3]));
    }
  });

  it("summary avgTurnaroundDays is null when org has canonical cases but zero case_locations rows", async () => {
    // Edge case: cases exist but the lab has never set up stations or the feature
    // was rolled out after these cases were created — no location rows at all.
    // The stat must return null/null, not crash or return 0.
    const tCaseId = rid("c_noloc");

    const { db, cases: casesTable } = dbMod as any;

    await db.insert(casesTable).values([
      {
        id: tCaseId,
        caseNumber: rid("NL1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "No",
        patientLastName: "Location",
        doctorName: "Dr NoLoc",
        createdByUserId: ownerId,
        receivedAt: "2026-03-05",
      },
    ]);

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      // No case_locations rows → both turnaround fields stay null.
      expect(d.avgTurnaroundDays).toBeNull();
      expect(d.eligibleTurnaroundCaseCount).toBeNull();
    } finally {
      await db.delete(casesTable).where(eq(casesTable.id, tCaseId));
    }
  });

  it("summary avgTurnaroundDays is null when the only case has 'received' but no 'complete' location", async () => {
    // Edge case: a single canonical case entered the lab (received stamp) but
    // was never marked complete — e.g. still in progress or cancelled in legacy.
    // Result must be null/null (no eligible cases).
    const tCaseId = rid("c_nocomplete");

    const { db, cases: casesTable, caseLocations: caseLocationsTable } = dbMod as any;

    await db.insert(casesTable).values([
      {
        id: tCaseId,
        caseNumber: rid("NC1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "No",
        patientLastName: "Complete",
        doctorName: "Dr NoComplete",
        createdByUserId: ownerId,
        receivedAt: "2026-03-10",
      },
    ]);

    await db.insert(caseLocationsTable).values([
      {
        id: rid("locncr"),
        caseId: tCaseId,
        locationCode: "received",
        locationName: "Received",
        movedAt: new Date("2026-03-10T00:00:00.000Z"),
        movedByUserId: ownerId,
      },
    ]);

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      // 'received' but no 'complete' → ineligible; both fields must be null.
      expect(d.avgTurnaroundDays).toBeNull();
      expect(d.eligibleTurnaroundCaseCount).toBeNull();
    } finally {
      await db
        .delete(caseLocationsTable)
        .where(eq(caseLocationsTable.caseId, tCaseId));
      await db.delete(casesTable).where(eq(casesTable.id, tCaseId));
    }
  });

  it("summary avgTurnaroundDays counts only canonical cases in a mixed legacy+canonical set", async () => {
    // Edge case: the window contains both a legacy lab_cases row AND a canonical
    // case with full location anchors. Legacy cases have no case_locations rows
    // and must not affect avgTurnaroundDays. Only the canonical case qualifies.
    const tCaseId = rid("c_mixcan");
    const tLegacyId = rid("lc_mix");

    const {
      db,
      cases: casesTable,
      caseLocations: caseLocationsTable,
      labCases: labCasesTable,
    } = dbMod as any;

    await db.insert(casesTable).values([
      {
        id: tCaseId,
        caseNumber: rid("MX1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Mix",
        patientLastName: "Canonical",
        doctorName: "Dr Mix",
        createdByUserId: ownerId,
        receivedAt: "2026-03-03",
      },
    ]);

    // Canonical case: received Mar 3, complete Mar 11 → 8 days.
    await db.insert(caseLocationsTable).values([
      {
        id: rid("locmxr"),
        caseId: tCaseId,
        locationCode: "received",
        locationName: "Received",
        movedAt: new Date("2026-03-03T00:00:00.000Z"),
        movedByUserId: ownerId,
      },
      {
        id: rid("locmxc"),
        caseId: tCaseId,
        locationCode: "complete",
        locationName: "Complete",
        movedAt: new Date("2026-03-11T00:00:00.000Z"),
        movedByUserId: ownerId,
      },
    ]);

    // Legacy case in the same window: has NO case_locations; must not count.
    await db.insert(labCasesTable).values([
      {
        id: tLegacyId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Mix Legacy",
          createdAt: "2026-03-04T09:00:00.000Z",
        }),
      },
    ]);

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      // Only the canonical case qualifies; legacy case is excluded.
      expect(d.avgTurnaroundDays).toBe(8);
      expect(d.eligibleTurnaroundCaseCount).toBe(1);
    } finally {
      await db
        .delete(caseLocationsTable)
        .where(eq(caseLocationsTable.caseId, tCaseId));
      await db.delete(casesTable).where(eq(casesTable.id, tCaseId));
      await db.delete(labCasesTable).where(eq(labCasesTable.id, tLegacyId));
    }
  });

  it("summary totalBusinessDays does not deduct anything for Jul 4-on-Saturday (omitted, not shifted to Friday)", async () => {
    // July 4 2026 falls on a Saturday → usHolidaySet now OMITS the holiday
    // rather than shifting it to Friday July 3.  Neither Jul 3 nor Jul 4 should
    // appear in the excluded-holiday list, and no extra deduction should occur.
    //
    // July 2026 weekday count (no federal holiday on a Mon–Fri):
    //   Jul  1 (Wed), 2 (Thu), 3 (Fri), 4 (Sat), 5 (Sun),
    //   6–10, 13–17, 20–24, 27–31 (Mon–Fri each week)
    //   = 23 weekdays − 0 observed holidays = 23 total business days.
    //
    // totalBusinessDays always uses the full period end (Jul 31) so it is
    // deterministic regardless of when the test runs.
    const { access } = await makeSession(ownerId);
    const julQs = new URLSearchParams({
      organizationId: labOrgId,
      dateFrom: "2026-07-01T00:00:00.000Z",
      dateTo:   "2026-07-31T23:59:59.999Z",
      timeZone: "UTC",
    }).toString();
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${julQs}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // 23 total business days: Jul 4 (Sat) is omitted, not shifted to Fri Jul 3,
    // so no weekday is deducted for Independence Day 2026.
    expect(d.totalBusinessDays).toBe(23);

    // elapsedBusinessDays must be ≤ totalBusinessDays and must be at least 1
    // (the endpoint clamps to max(1, ...)).
    expect(d.elapsedBusinessDays).toBeGreaterThanOrEqual(1);
    expect(d.elapsedBusinessDays).toBeLessThanOrEqual(23);

    // Neither Jul 3 nor Jul 4 should appear as a holiday exclusion.
    const dateStrings: string[] = d.excludedDays.dates.map(
      (e: { date: string }) => e.date,
    );
    expect(dateStrings).not.toContain("2026-07-03"); // NOT observed Friday
    // The raw Saturday Jul 4 must NOT appear in the excluded list — it was
    // never in the business-day pool in the first place.
    expect(dateStrings).not.toContain("2026-07-04");

    // Independence Day is the only federal holiday in July.
    // Independence Day (Jul 4) falls on Saturday → omitted, so 0 federal
    // holidays fall on a Mon–Fri weekday in July 2026.
    expect(d.excludedDays.holidayCount).toBe(0);
  });

  // ── excludedDays denominator correctness ─────────────────────────────

  it("summary excludedDays.holidayCount matches federal Mon–Fri holidays in the window", async () => {
    const { access } = await makeSession(ownerId);
    // January 2026 contains two US federal holidays that fall on weekdays:
    //   Jan  1 (Thu) — New Year's Day
    //   Jan 19 (Mon) — Martin Luther King Jr. Day (3rd Monday of January)
    // The period is entirely in the past so effectiveCutoff = Jan 31 2026,
    // and both holidays fall within [Jan 1, Jan 31].
    const janQs = new URLSearchParams({
      organizationId: labOrgId,
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-01-31T23:59:59.999Z",
      timeZone: "UTC",
    }).toString();
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${janQs}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    expect(d.excludedDays.holidayCount).toBe(2);
    expect(d.excludedDays.customClosedCount).toBe(0);
    expect(d.excludedDays.dates).toHaveLength(2);

    const dateStrings = d.excludedDays.dates.map((e: { date: string }) => e.date);
    expect(dateStrings).toContain("2026-01-01"); // New Year's Day (Thursday)
    expect(dateStrings).toContain("2026-01-19"); // MLK Day (Monday)

    // All returned dates must be Mon–Fri (dow 1–5).
    for (const entry of d.excludedDays.dates as Array<{ date: string; reason: string }>) {
      expect(entry.reason).toBe("holiday");
      const dow = new Date(entry.date + "T12:00:00Z").getUTCDay();
      expect(dow, `${entry.date} must be Mon–Fri`).toBeGreaterThanOrEqual(1);
      expect(dow, `${entry.date} must be Mon–Fri`).toBeLessThanOrEqual(5);
    }
  });

  it("summary excludedDays.customClosedCount reflects lab_closed_days rows", async () => {
    const { access } = await makeSession(ownerId);
    const { db, labClosedDays: closedDaysTable } = dbMod as any;

    // Insert a custom closed day on a weekday in the March 2026 window
    // (March 2026 has no federal holidays, so holidayCount stays 0).
    // 2026-03-02 is a Monday.
    const closedDayId = rid("lcd");
    await db.insert(closedDaysTable).values({
      id: closedDayId,
      labOrganizationId: labOrgId,
      date: "2026-03-02",
      createdByUserId: ownerId,
    });

    try {
      const r = await request(appMod.default)
        .get(`/api/stats/summary?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      expect(d.excludedDays.holidayCount).toBe(0);
      expect(d.excludedDays.customClosedCount).toBe(1);
      expect(d.excludedDays.dates).toHaveLength(1);

      const entry = d.excludedDays.dates[0] as { date: string; reason: string };
      expect(entry.date).toBe("2026-03-02");
      expect(entry.reason).toBe("custom");

      // The custom date must be a Mon–Fri.
      const dow = new Date("2026-03-02T12:00:00Z").getUTCDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    } finally {
      await db.delete(closedDaysTable).where(eq(closedDaysTable.id, closedDayId));
    }
  });

  // ── /stats/case-categories ────────────────────────────────────────────

  it("case-categories buckets canonical + legacy with legacyCount and materials", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/case-categories?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    // 6 canonical + 3 legacy = 9 total.
    expect(d.totalCases).toBe(9);

    const byKey = Object.fromEntries(
      d.categories.map((c: any) => [c.category, c]),
    );
    expect(byKey["implants"].count).toBe(1);
    expect(byKey["zirconia"].count).toBe(1);
    expect(byKey["removable"].count).toBe(1); // legacy denture
    expect(byKey["removable"].legacyCount).toBe(1);
    // canonical blank (blank + remake + remake2 + remake3) + 2 legacy blank cases = 6
    expect(byKey["uncategorized"].count).toBe(6);
    expect(byKey["uncategorized"].legacyCount).toBe(2);
    expect(byKey["uncategorized"].label).toBe("Uncategorized / Legacy");

    // Materials: BruxZir + Zirconia normalize to one "Zirconia" row,
    // units = 2 + 1.
    const zir = d.materials.find((m: any) => m.material === "Zirconia");
    expect(zir).toBeDefined();
    expect(zir.restorations).toBe(2);
    expect(zir.units).toBe(3);
  });

  it("case-categories honors the material filter on buckets and materials", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/case-categories?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2); // zirconia + implant cases only

    const byKey = Object.fromEntries(
      d.categories.map((c: any) => [c.category, c]),
    );
    expect(byKey["zirconia"].count).toBe(1);
    expect(byKey["implants"].count).toBe(1);
    expect(byKey["removable"]?.count ?? 0).toBe(0);
    expect(byKey["uncategorized"]?.count ?? 0).toBe(0);

    // Material breakdown restricted to the filtered material.
    expect(d.materials).toHaveLength(1);
    expect(d.materials[0].material).toBe("Zirconia");
    expect(d.materials[0].units).toBe(3);
  });

  it("case-categories caseTypes breakdown lists Restorative for inferred crown/implant restorations", async () => {
    // The seeded zirCaseId (restorationType:"Crown") and implantCaseId
    // (restorationType:"Implant Crown") both derive hierarchy.caseType===
    // "restorative" via free-text inference. This guards against a silent
    // taxonomy key mismatch that would empty the caseTypes array.
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/case-categories?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    const caseTypes: Array<{ label: string; count: number }> = d.caseTypes ?? [];
    expect(caseTypes.length).toBeGreaterThan(0);

    const restorative = caseTypes.find((ct) => ct.label === "Restorative");
    expect(restorative, "caseTypes must include a Restorative entry").toBeDefined();
    // zirconia case + implant case both map to restorative.
    expect(restorative!.count).toBeGreaterThanOrEqual(2);
  });

  it("case-categories caseTypes breakdown respects explicit restorationSubtype key", async () => {
    // An explicit restorationSubtype key must be decoded by deriveCaseHierarchy
    // and mapped to the correct taxonomy label. A wrong slash format or
    // unrecognized key would silently produce an empty caseTypes breakdown.
    //
    // Isolation strategy: the temp case is placed in May 2026 — a month that
    // contains NO other seeded cases — and the stats query uses that isolated
    // window. This prevents the existing March-window restorative cases (zirCaseId,
    // implantCaseId) from inflating counts and hiding a decoding regression.
    //
    // Free-text isolation: restorationType:"LabWork" + material:"TitaniumAlloy"
    // do not match any CASE_TYPE_ALIASES or MATERIAL_SUBTYPE_ALIASES patterns in
    // taxonomy.ts. If explicit-key decoding were broken, deriveCaseHierarchy would
    // fall back to inference and return { caseType:null } — the case would appear
    // under label "Other" (not "Restorative") and the subtype/materialSubtype
    // breakdowns would be empty entirely.
    const { db, cases: casesTable, caseRestorations } = dbMod as any;

    const tmpCaseId = rid("c_rst_tx");
    const tmpRestId = rid("r_rst_tx");

    // May 2026 — isolated from the March 2026 fixtures used by all other tests.
    const MAY_FROM = "2026-05-01T00:00:00.000Z";
    const MAY_TO   = "2026-05-31T23:59:59.999Z";

    await db.insert(casesTable).values({
      id: tmpCaseId,
      caseNumber: rid("TXRST"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Taxonomy",
      patientLastName: "Test",
      doctorName: "Dr. TaxTest",
      createdByUserId: ownerId,
      receivedAt: "2026-05-12",
    });
    await db.insert(caseRestorations).values({
      id: tmpRestId,
      caseId: tmpCaseId,
      toothNumber: "14",
      restorationType: "LabWork",
      restorationSubtype: "restorative/crown_and_bridge/zirconia",
      material: "TitaniumAlloy",
      quantity: 1,
    });

    try {
      const { access } = await makeSession(ownerId);
      const mayQs = new URLSearchParams({
        organizationId: labOrgId,
        dateFrom: MAY_FROM,
        dateTo: MAY_TO,
        timeZone: "UTC",
      }).toString();
      const r = await request(appMod.default)
        .get(`/api/stats/case-categories?${mayQs}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const d = r.body.data;

      // The isolated window contains exactly one case: the temp case above.
      expect(d.totalCases).toBe(1);

      // Its restorationSubtype must be decoded to caseType "restorative" →
      // label "Restorative". Without explicit-key decoding the fallback inference
      // on "LabWork"/"TitaniumAlloy" yields caseType:null → label "Other".
      const caseTypes: Array<{ label: string; count: number }> = d.caseTypes ?? [];
      expect(caseTypes).toHaveLength(1);
      expect(caseTypes[0].label).toBe("Restorative");
      expect(caseTypes[0].count).toBe(1);

      // Level-2: subtype must decode to crown_and_bridge.
      const caseSubtypes: Array<{ key: string; label: string; count: number }> =
        d.caseSubtypes ?? [];
      expect(caseSubtypes).toHaveLength(1);
      expect(caseSubtypes[0].key).toBe("restorative/crown_and_bridge");
      expect(caseSubtypes[0].count).toBe(1);

      // Level-3: materialSubtype must decode to zirconia.
      const caseMaterialSubtypes: Array<{ key: string; label: string; count: number }> =
        d.caseMaterialSubtypes ?? [];
      expect(caseMaterialSubtypes).toHaveLength(1);
      expect(caseMaterialSubtypes[0].key).toBe("restorative/crown_and_bridge/zirconia");
      expect(caseMaterialSubtypes[0].count).toBe(1);
    } finally {
      await db
        .delete(caseRestorations)
        .where(eq(caseRestorations.id, tmpRestId));
      await db
        .delete(casesTable)
        .where(eq(casesTable.id, tmpCaseId));
    }
  });

  // ── /stats/revenue-series ─────────────────────────────────────────────

  it("revenue-series buckets by month and matches totals", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/revenue-series?${baseQs({ groupBy: "month" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.groupBy).toBe("month");
    expect(d.series).toHaveLength(1);
    expect(d.series[0].period).toBe("2026-03");
    expect(d.series[0].revenue).toBe("450.00");
    expect(d.series[0].invoiceCount).toBe(4);
    expect(d.totals.revenue).toBe("450.00");
    expect(d.totals.invoiceCount).toBe(4);
  });

  it("revenue-series material filter excludes caseless + non-matching invoices", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/revenue-series?${baseQs({ groupBy: "month", material: "Zirconia" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totals.revenue).toBe("410.00"); // 100 + 60 + 250
    expect(d.totals.invoiceCount).toBe(3);
  });

  it("revenue-series category filter excludes caseless invoices", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/revenue-series?${baseQs({ groupBy: "day", category: "implants" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals.revenue).toBe("250.00");
    expect(d.totals.invoiceCount).toBe(1);
    expect(d.series).toHaveLength(1);
    expect(d.series[0].period).toBe("2026-03-20");
  });

  it("revenue-series rejects a bad groupBy", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/revenue-series?${baseQs({ groupBy: "decade" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(400);
  });

  // ── /stats/weekday-volume ─────────────────────────────────────────────

  it("weekday-volume attributes cases to Monday-indexed weekdays", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.weekdays).toHaveLength(7);
    // 6 canonical + 3 legacy = 9 total.
    expect(d.totalCases).toBe(9);

    const monday = d.weekdays[0];
    expect(monday.label).toBe("Monday");
    // zirconia (Mar 2) + blank (Mar 2) + remakeCaseId2 (Mar 9) + remakeCaseId3 (Mar 16) = 4
    expect(monday.total).toBe(4);
    expect(monday.byCategory["zirconia"]).toBe(1);
    // blank + remakeCaseId2 + remakeCaseId3 are all uncategorized on Monday = 3
    expect(monday.byCategory["uncategorized"]).toBe(3);

    expect(d.weekdays[1].total).toBe(1); // Tuesday: implant case
    expect(d.weekdays[2].total).toBe(1); // Wednesday: legacy denture
    expect(d.weekdays[2].byCategory["removable"]).toBe(1);
    expect(d.weekdays[3].total).toBe(2); // Thursday: legacy blank + canonical remake
    expect(d.weekdays[4].total).toBe(1); // Friday: legacy remake
  });

  it("weekday-volume honors the category filter", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs({ category: "removable" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1);
    expect(d.weekdays[2].total).toBe(1); // Wednesday legacy denture
    expect(d.weekdays[0].total).toBe(0);
  });

  it("weekday-volume honors the material filter", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2);
    expect(d.weekdays[0].total).toBe(1); // Monday: zirconia case
    expect(d.weekdays[1].total).toBe(1); // Tuesday: implant case
    expect(d.weekdays[2].total).toBe(0); // Wednesday legacy denture excluded
  });

  // ── /stats/remakes ───────────────────────────────────────────

  it("remakes totals canonical + legacy, recharged split, and reasons", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // remakeCaseId (shade mismatch, recharged) + remakeCaseId2 (wrong material, not recharged) +
    // remakeCaseId3 (fit issue, not recharged) + legacyRemakeId (blank → Unspecified, not recharged).
    expect(d.totalRemakes).toBe(4);
    expect(d.rechargedRemakes).toBe(1);
    expect(d.nonRechargedRemakes).toBe(3);

    // 4 distinct reasons (all count = 1); sorted alphabetically when tied.
    expect(d.remakeReasons).toHaveLength(4);
    const byReason = Object.fromEntries(
      d.remakeReasons.map((x: any) => [x.reason, x.count]),
    );
    expect(byReason["Shade mismatch"]).toBe(1);
    expect(byReason["Unspecified"]).toBe(1);
    expect(byReason["Wrong material used"]).toBe(1);
    expect(byReason["Fit issue"]).toBe(1);
  });

  it("remakes returns empty when there are no remakes", async () => {
    const { access } = await makeSession(ownerId);
    // A date range before any cases were inserted.
    const qs = new URLSearchParams({
      organizationId: labOrgId,
      dateFrom: "2025-01-01T00:00:00.000Z",
      dateTo: "2025-01-31T23:59:59.999Z",
      timeZone: "UTC",
    }).toString();
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${qs}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalRemakes).toBe(0);
    expect(d.rechargedRemakes).toBe(0);
    expect(d.nonRechargedRemakes).toBe(0);
    expect(d.remakeReasons).toEqual([]);
  });

  it("remakes records are sorted newest-first with complete fields", async () => {
    // All 4 remakes: canonical remakeCaseId (Mar 5), remakeCaseId2 (Mar 9),
    // remakeCaseId3 (Mar 16), legacy legacyRemakeId (Mar 6).
    // Sorted newest-first: Mar 16, Mar 9, Mar 6, Mar 5.
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // 4 total remakes now that remakeCaseId2 and remakeCaseId3 are inserted.
    expect(d.totalRemakes).toBe(4);
    // rechargedRemakes: only remakeCaseId (recharged=true). The rest are false.
    expect(d.rechargedRemakes).toBe(1);
    expect(d.nonRechargedRemakes).toBe(3);

    // Records sorted newest-first.
    expect(d.records).toHaveLength(4);
    const dates = d.records.map((r: any) => r.receivedAt);
    expect(dates.every((value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value))).toBe(true);
    expect(dates[0]).toBe("2026-03-16"); // remakeCaseId3
    expect(dates[1]).toBe("2026-03-09"); // remakeCaseId2
    expect(dates[2]).toBe("2026-03-06"); // legacyRemakeId (Friday)
    expect(dates[3]).toBe("2026-03-05"); // remakeCaseId (Thursday)

    // Verify expected fields are present and typed correctly on a canonical record.
    const r2 = d.records.find((r: any) => r.receivedAt.startsWith("2026-03-09"));
    expect(r2).toBeDefined();
    expect(r2.source).toBe("canonical");
    expect(r2.reasonKey).toBe("material_quality");
    expect(r2.recharged).toBe(false);
    expect(r2.returnedToLab).toBe(true);
    expect(r2.category).toBe("crown_bridge");
    // originalCaseNumber must be resolved (zirCaseId is the original).
    expect(typeof r2.originalCaseNumber).toBe("string");
    expect(r2.originalCaseNumber).not.toBe("");

    // Legacy record must expose source="legacy" and reasonKey=null.
    const legacyRec = d.records.find((r: any) => r.receivedAt.startsWith("2026-03-06"));
    expect(legacyRec).toBeDefined();
    expect(legacyRec.source).toBe("legacy");
    expect(legacyRec.reasonKey).toBeNull();
  });

  it("remakes reasonKey filter narrows totalRemakes and records", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ reasonKey: "material_quality" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId2 has reasonKey="material_quality".
    expect(d.totalRemakes).toBe(1);
    expect(d.rechargedRemakes).toBe(0);
    expect(d.nonRechargedRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].reasonKey).toBe("material_quality");
    expect(d.records[0].source).toBe("canonical");

    // timeSeries should have exactly one bucket.
    expect(d.timeSeries).toHaveLength(1);
    expect(d.timeSeries[0].count).toBe(1);
  });

  it("remakes recharged=yes filter returns only recharged remakes", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ recharged: "yes" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId (remakeCharged=true).
    expect(d.totalRemakes).toBe(1);
    expect(d.rechargedRemakes).toBe(1);
    expect(d.nonRechargedRemakes).toBe(0);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].recharged).toBe(true);
    expect(d.records[0].source).toBe("canonical");
  });

  it("remakes recharged=no filter excludes recharged remakes", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ recharged: "no" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // remakeCaseId2 (false), remakeCaseId3 (false), legacyRemakeId (false) = 3 records.
    expect(d.totalRemakes).toBe(3);
    expect(d.rechargedRemakes).toBe(0);
    expect(d.nonRechargedRemakes).toBe(3);
    expect(d.records.every((r: any) => r.recharged === false)).toBe(true);
  });

  it("remakes returnedToLab filter returns only returned remakes", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ returnedToLab: "yes" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId2 has remakeReturnedToLab=true.
    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].returnedToLab).toBe(true);
    expect(d.records[0].reasonKey).toBe("material_quality");
  });

  it("remakes remakeCategory=crown_bridge filter narrows to crown_bridge cases", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ remakeCategory: "crown_bridge" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId2 has remakeCategory="crown_bridge".
    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].category).toBe("crown_bridge");
  });

  it("remakes remakeCategory=removable filter narrows to removable cases", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ remakeCategory: "removable" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId3 has remakeCategory="removable".
    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].category).toBe("removable");
    expect(d.records[0].receivedAt.startsWith("2026-03-16")).toBe(true);
  });

  it("remakes doctorName filter narrows to the matching doctor", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ doctorName: "Dr Second" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only remakeCaseId3 was overridden to doctorName="Dr Second".
    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].category).toBe("removable");
    expect(d.byDoctor).toEqual([{ doctorName: "Dr Second", count: 1 }]);
  });

  it('remakes doctorName="Unknown" filter matches blank/missing doctor names', async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ doctorName: "Unknown" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Only legacyRemakeId has no doctorName (legacy blobs never carry one).
    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].source).toBe("legacy");
    expect(d.byDoctor).toEqual([{ doctorName: "Unknown", count: 1 }]);
  });

  it("remakes doctorName filter combines with other filters", async () => {
    // doctorName="Dr Stats" matches remakeCaseId + remakeCaseId2; adding
    // recharged=yes narrows that pair down to remakeCaseId alone.
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ doctorName: "Dr Stats", recharged: "yes" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    expect(d.totalRemakes).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.records[0].recharged).toBe(true);
    expect(d.records[0].reasonKey).toBeNull();
  });

  it("remakes byDoctor breakdown lists every doctor with remakes, including the Unknown bucket", async () => {
    // Backs the desktop doctor-filter dropdown: it must only ever offer
    // doctors (or "Unknown") that actually have remakes in the window.
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    const byDoctor = Object.fromEntries(
      d.byDoctor.map((x: any) => [x.doctorName, x.count]),
    );
    // remakeCaseId + remakeCaseId2 → "Dr Stats"; remakeCaseId3 → "Dr Second";
    // legacyRemakeId (no doctorName) → "Unknown".
    expect(byDoctor).toEqual({ "Dr Stats": 2, "Dr Second": 1, Unknown: 1 });
  });

  it("remakes groupBy=week produces correct timeSeries buckets (Mon-anchored)", async () => {
    // Fixtures by week (UTC, Mon-anchored):
    //   Week "2026-03-02": remakeCaseId (Thu Mar 5) + legacyRemakeId (Fri Mar 6) → count 2
    //   Week "2026-03-09": remakeCaseId2 (Mon Mar 9)                             → count 1
    //   Week "2026-03-16": remakeCaseId3 (Mon Mar 16)                            → count 1
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ groupBy: "week" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    expect(d.timeSeries).toHaveLength(3);
    // Sorted ascending by period key.
    expect(d.timeSeries[0].period).toBe("2026-03-02");
    expect(d.timeSeries[0].count).toBe(2);
    expect(d.timeSeries[1].period).toBe("2026-03-09");
    expect(d.timeSeries[1].count).toBe(1);
    expect(d.timeSeries[2].period).toBe("2026-03-16");
    expect(d.timeSeries[2].count).toBe(1);

    // periodStart of each bucket must be a valid ISO string.
    for (const bucket of d.timeSeries) {
      expect(new Date(bucket.periodStart).getTime()).not.toBeNaN();
    }
  });

  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "keeps received calendar days in the same remake buckets for %s",
    async (timeZone) => {
      const { access } = await makeSession(ownerId);
      const response = await request(appMod.default)
        .get(
          `/api/stats/remakes?${baseQs({
            groupBy: "week",
            timeZone,
          })}`,
        )
        .set("Authorization", `Bearer ${access}`);

      expect(response.status).toBe(200);
      expect(
        response.body.data.timeSeries.map((bucket: any) => [
          bucket.period,
          bucket.count,
        ]),
      ).toEqual([
        ["2026-03-02", 2],
        ["2026-03-09", 1],
        ["2026-03-16", 1],
      ]);
    },
  );

  it("remakes groupBy=month collapses all March remakes into one bucket", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/remakes?${baseQs({ groupBy: "month" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // All 4 remakes are in March 2026 → single bucket.
    expect(d.timeSeries).toHaveLength(1);
    expect(d.timeSeries[0].period).toBe("2026-03");
    expect(d.timeSeries[0].count).toBe(4);
    expect(new Date(d.timeSeries[0].periodStart).getTime()).not.toBeNaN();
  });

  it("remakes combined filters apply simultaneously to summary, timeSeries, and records", async () => {
    // remakeCategory=crown_bridge + recharged=no + returnedToLab=yes → only remakeCaseId2
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/remakes?${baseQs({
          remakeCategory: "crown_bridge",
          recharged: "no",
          returnedToLab: "yes",
        })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // Summary.
    expect(d.totalRemakes).toBe(1);
    expect(d.rechargedRemakes).toBe(0);
    expect(d.nonRechargedRemakes).toBe(1);

    // timeSeries — one bucket for the single matching record.
    expect(d.timeSeries).toHaveLength(1);
    expect(d.timeSeries[0].count).toBe(1);

    // Records.
    expect(d.records).toHaveLength(1);
    expect(d.records[0].category).toBe("crown_bridge");
    expect(d.records[0].recharged).toBe(false);
    expect(d.records[0].returnedToLab).toBe(true);
    expect(d.records[0].reasonKey).toBe("material_quality");
  });
});

/**
 * Integration tests for the owner-only Sales Forecaster
 * (GET /stats/sales-forecast).
 *
 * Self-contained fixtures (separate from the Stats suite above) because the
 * forecast is "now"-relative — it projects the CURRENT week/month/year — so
 * revenue rows are dated relative to `Date.now()` rather than a fixed window.
 *
 * Coverage:
 *  - RBAC: 401 unauthenticated, 403 for a plain member, 403 for a BILLING role
 *    (proving billing is still excluded — gate is ADMIN_ROLES not BILLING_ROLES),
 *    200 admin, 200 owner
 *  - Business-day math: year forecast = salesSoFar + avgPerDay × remainingDays;
 *    week/month = avgPerDay × totalDays; counting Mon–Fri only; void +
 *    soft-deleted + legacy blob invoices excluded from periodToDateSales
 *  - Zero-sales guard: a lab with no invoices returns insufficientData with a
 *    $0 forecast and no divide-by-zero
 *  - Custom closed days: a lab_closed_days row in the remaining part of the year
 *    reduces remainingBusinessDays (preventing silent over-projection)
 */
maybe("Sales forecast route (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u");
  const adminId = rid("a");
  const billingId = rid("b");
  const memberId = rid("m");
  const labOrgId = rid("lab"); // has sales
  const emptyLabOrgId = rid("lab2"); // owned, no sales
  const providerOrgId = rid("prov");

  const invoiceIds: string[] = [];

  // UTC "today" — the forecast uses timeZone=UTC in these tests.
  const now = new Date();
  const today = {
    yr: now.getUTCFullYear(),
    mo: now.getUTCMonth(),
    day: now.getUTCDate(),
  };

  // Populated in beforeAll from the production holiday-aware calendar helper
  // so fixtures also handle weekdays such as Labor Day.
  const todayUtcMs = Date.UTC(today.yr, today.mo, today.day);
  let cutoffMs = 0;
  let cutoff = { yr: today.yr, mo: today.mo, day: today.day };

  // Mirror of the server's countBusinessDays (Mon–Fri inclusive) so the test
  // can compute the expected forecast without importing a non-exported helper.
  function countBiz(
    start: { yr: number; mo: number; day: number },
    end: { yr: number; mo: number; day: number },
  ): number {
    let cur = Date.UTC(start.yr, start.mo, start.day);
    const last = Date.UTC(end.yr, end.mo, end.day);
    let n = 0;
    while (cur <= last) {
      const dow = new Date(cur).getUTCDay();
      if (dow >= 1 && dow <= 5) n += 1;
      cur += 86_400_000;
    }
    return n;
  }

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return { access: authLib.signAccessToken(userId, sessionId) };
  }

  function qs(orgId: string) {
    return new URLSearchParams({
      organizationId: orgId,
      timeZone: "UTC",
    }).toString();
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-forecast";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    const { lastCompletedBusinessDay } = await import("../lib/stats-utils.js");
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    cutoff = lastCompletedBusinessDay(
      new Date(todayUtcMs),
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      usHolidaySet([today.yr - 1, today.yr, today.yr + 1]),
    );
    cutoffMs = Date.UTC(cutoff.yr, cutoff.mo, cutoff.day);

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      invoices,
    } = dbMod as any;

    await db.insert(users).values([
      { id: ownerId, username: `fcowner_${ownerId}`, password: "x" },
      { id: adminId, username: `fcadmin_${adminId}`, password: "x" },
      { id: billingId, username: `fcbill_${billingId}`, password: "x" },
      { id: memberId, username: `fcmem_${memberId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("FcLab") },
      { id: emptyLabOrgId, type: "lab", name: rid("FcLabEmpty") },
      { id: providerOrgId, type: "provider", name: rid("FcProv") },
    ]);
    await db.insert(organizationMemberships).values([
      // Owner of BOTH labs.
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m1b"),
        labId: emptyLabOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      // Admin role on the lab-with-sales — must be permitted (ADMIN_ROLES gate).
      {
        id: rid("m1c"),
        labId: labOrgId,
        userId: adminId,
        role: "admin",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      // Billing role on the lab-with-sales — must still be forbidden.
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: billingId,
        role: "billing",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      // Plain member.
      {
        id: rid("m3"),
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
    ]);

    // Two counted invoices dated at midday on the last completed business day
    // so they fall within the server's cutoff window (which excludes today's
    // partial data and weekends). One void, one soft-deleted. Sum = 350.00.
    const issued = new Date(cutoffMs + 12 * 3_600_000); // midday of cutoff day
    const invDefaults = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      createdByUserId: ownerId,
    };
    const mkInv = (over: Record<string, unknown>) => {
      const id = rid("inv");
      invoiceIds.push(id);
      return { ...invDefaults, id, invoiceNumber: rid("FINV"), ...over };
    };
    await db.insert(invoices).values([
      mkInv({ caseId: null, total: "100.00", status: "sent", issuedAt: issued }),
      mkInv({ caseId: null, total: "250.00", status: "sent", issuedAt: issued }),
      mkInv({ caseId: null, total: "5000.00", status: "void", issuedAt: issued }),
      mkInv({
        caseId: null,
        total: "7000.00",
        status: "sent",
        issuedAt: issued,
        deletedAt: new Date(),
      }),
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      invoices,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    if (invoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerId, adminId, billingId, memberId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [ownerId, adminId, billingId, memberId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, emptyLabOrgId, providerOrgId]));
    await db
      .delete(users)
      .where(inArray(users.id, [ownerId, adminId, billingId, memberId]));
  });

  // ── RBAC ────────────────────────────────────────────────────────────────

  it("returns 401 without a token", async () => {
    const r = await request(appMod.default).get(
      `/api/stats/sales-forecast?${qs(labOrgId)}`,
    );
    expect(r.status).toBe(401);
  });

  it("returns 403 for a plain member", async () => {
    const { access } = await makeSession(memberId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(labOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(403);
  });

  it("returns 403 for a BILLING role (billing is not in ADMIN_ROLES)", async () => {
    const { access } = await makeSession(billingId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(labOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(403);
  });

  it("returns 200 for an admin role", async () => {
    const { access } = await makeSession(adminId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(labOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data.organizationId).toBe(labOrgId);
  });

  // ── Business-day math ─────────────────────────────────────────────────────

  it("projects year sales from the current business-day pace", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(labOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.organizationId).toBe(labOrgId);
    expect(d.timeZone).toBe("UTC");
    expect(d.week).toBeTruthy();
    expect(d.month).toBeTruthy();
    expect(d.year).toBeTruthy();

    // Void + soft-deleted excluded → 100 + 250 = 350.00 counted for the year.
    const year = d.year;
    expect(year.periodToDateSales).toBe("350.00");
    expect(year.insufficientData).toBe(false);

    // Elapsed uses the cutoff (last completed business day), not today.
    // The server now skips US federal holidays, so mirror that here using the
    // exported helpers (no custom closed days for the test org).
    const { countBusinessDays } = await import("../lib/stats-utils.js");
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    const holidays = usHolidaySet([today.yr - 1, today.yr, today.yr + 1]);
    const elapsed = countBusinessDays({ yr: today.yr, mo: 0, day: 1 }, cutoff, holidays);
    const total = countBusinessDays(
      { yr: today.yr, mo: 0, day: 1 },
      { yr: today.yr, mo: 11, day: 31 },
      holidays,
    );
    expect(year.elapsedBusinessDays).toBe(elapsed);
    expect(year.totalBusinessDays).toBe(total);

    const expectedAvg = 350 / elapsed;
    // Year forecast: salesSoFar + (avgPerDay × remainingWorkdaysAfterCutoff).
    const dacMs = cutoffMs + 86_400_000;
    const dac = new Date(dacMs);
    const remaining = countBusinessDays(
      { yr: dac.getUTCFullYear(), mo: dac.getUTCMonth(), day: dac.getUTCDate() },
      { yr: today.yr, mo: 11, day: 31 },
      holidays,
    );
    const expectedForecast = 350 + expectedAvg * remaining;
    expect(year.averagePerBusinessDay).toBe(expectedAvg.toFixed(2));
    expect(year.forecast).toBe(expectedForecast.toFixed(2));

    // forecast always includes all sales booked so far.
    expect(Number(year.forecast)).toBeGreaterThanOrEqual(350);
  });

  it("returns insufficientData with a $0 forecast for a lab with no sales", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(emptyLabOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    for (const key of ["week", "month", "year"] as const) {
      expect(d[key].periodToDateSales, key).toBe("0.00");
      expect(d[key].insufficientData, key).toBe(true);
      expect(d[key].forecast, key).toBe("0.00");
      expect(d[key].averagePerBusinessDay, key).toBe("0.00");
      // Nothing to trend against when the current period has no data.
      expect(d[key].paceChangePct, key).toBeNull();
      expect(d[key].previousPeriod, key).toBeNull();
    }
  });

  // ── Pace trend vs prior comparable period ────────────────────────────────

  it("reports paceChangePct null when there is no prior comparable sales", async () => {
    // The primary lab has current-year sales but no prior-year sales, so the
    // YEAR card has a defined pace now but nothing to compare against.
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/sales-forecast?${qs(labOrgId)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const year = r.body.data.year;
    expect(year.insufficientData).toBe(false);
    // previousPeriod is always present for a sufficient current period, but its
    // comparable sales are zero here, so the change is undefined (null).
    expect(year.previousPeriod).toBeTruthy();
    expect(year.previousPeriod.comparableSales).toBe("0.00");
    expect(year.paceChangePct).toBeNull();
  });

  it("computes paceChangePct from the prior comparable business-day window", async () => {
    // Insert prior-year sales for a fresh owned lab so the YEAR pace trend has
    // a comparable prior window. Prior-year sales are placed on Jan 2 (or the
    // period's first business day) so they fall inside the comparable window
    // for any "today".
    const { db, organizations, organizationMemberships, invoices } = dbMod as any;
    const trendLab = rid("lab3");
    const trendMemId = rid("m4");
    await db
      .insert(organizations)
      .values([{ id: trendLab, type: "lab", name: rid("FcTrend") }]);
    await db.insert(organizationMemberships).values([
      {
        id: trendMemId,
        labId: trendLab,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
    ]);

    // Prior year, first business day (Jan 1 is a holiday-agnostic weekday check
    // — use Jan 2 which is a weekday in most years; fall back handled by the
    // server capping to prior period end). Total prior comparable = 100.
    const priorYr = today.yr - 1;
    // First Mon–Fri on/after Jan 1 of the prior year.
    let jan = Date.UTC(priorYr, 0, 1);
    while ([0, 6].includes(new Date(jan).getUTCDay())) jan += 86_400_000;
    const priorIssued = new Date(jan + 12 * 3_600_000); // midday UTC

    // Current year sales already exist on labOrgId, but this lab needs its own
    // current sales too. Place 200 on the first business day of THIS year.
    let curJan = Date.UTC(today.yr, 0, 1);
    while ([0, 6].includes(new Date(curJan).getUTCDay())) curJan += 86_400_000;
    const curIssued = new Date(curJan + 12 * 3_600_000);

    const mk = (over: Record<string, unknown>) => {
      return {
        labOrganizationId: trendLab,
        providerOrganizationId: providerOrgId,
        createdByUserId: ownerId,
        caseId: null,
        invoiceNumber: rid("TINV"),
        ...over,
      };
    };
    await db.insert(invoices).values([
      mk({ total: "100.00", status: "sent", issuedAt: priorIssued }),
      mk({ total: "200.00", status: "sent", issuedAt: curIssued }),
    ]);

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/sales-forecast?${qs(trendLab)}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const year = r.body.data.year;
      expect(year.insufficientData).toBe(false);
      expect(year.previousPeriod).toBeTruthy();
      // The comparable window is the same number of elapsed business days into
      // the prior year, which includes the Jan prior-year invoice (100.00).
      expect(year.previousPeriod.comparableSales).toBe("100.00");
      expect(year.previousPeriod.comparableBusinessDays).toBe(
        year.elapsedBusinessDays,
      );
      // paceChangePct compares current avg/day (200 / elapsed) to prior avg/day
      // (100 / elapsed) → +100.0%.
      expect(year.paceChangePct).toBe(100);
    } finally {
      // Delete by lab org id (not tracked ids) so the org can never be left
      // with a dangling invoice FK, then memberships, then the org itself.
      await db
        .delete(invoices)
        .where(eq(invoices.labOrganizationId, trendLab));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, trendMemId));
      await db.delete(organizations).where(eq(organizations.id, trendLab));
    }
  });

  // ── Custom closed days ────────────────────────────────────────────────────

  it("year forecast is lower when lab has a custom closed day in the remaining period", async () => {
    // A custom lab_closed_days row on a future weekday must reduce
    // remainingBusinessDays by 1 and therefore produce a strictly lower year
    // forecast than the same lab without that row.  This guards against the
    // regression where countBusinessDays for remainingBusinessDays ignores the
    // lab's custom closed days and silently over-projects.
    const {
      db,
      organizations,
      organizationMemberships,
      invoices: invTable,
      labClosedDays: closedDaysTable,
    } = dbMod as any;

    const closedLab = rid("lab5");
    const closedLabMemId = rid("m6");

    await db.insert(organizations).values([{ id: closedLab, type: "lab", name: rid("FcClosed") }]);
    await db.insert(organizationMemberships).values([{
      id: closedLabMemId,
      labId: closedLab,
      userId: ownerId,
      role: "owner",
      status: "active",
      approvedByUserId: ownerId,
      joinedAt: new Date(),
    }]);

    // Single invoice dated at midday of the cutoff day so it falls inside the
    // server's periodToDateSales window.
    const issued = new Date(cutoffMs + 12 * 3_600_000);
    const invId = rid("inv5");
    await db.insert(invTable).values([{
      id: invId,
      labOrganizationId: closedLab,
      providerOrganizationId: providerOrgId,
      createdByUserId: ownerId,
      caseId: null,
      invoiceNumber: rid("CINV"),
      total: "260.00",
      status: "sent",
      issuedAt: issued,
    }]);

    // Find the first weekday AFTER the cutoff that is not a US federal holiday,
    // so the custom closed day actually removes one count from remainingBusinessDays.
    const { usHolidaySet } = await import("../lib/us-holidays.js");
    const federalHolidays = usHolidaySet([today.yr - 1, today.yr, today.yr + 1]);

    const yearEndMs = Date.UTC(today.yr, 11, 31);
    const dacMs2 = cutoffMs + 86_400_000; // day after cutoff
    let futureDayMs = dacMs2;
    while (futureDayMs <= yearEndMs) {
      const dow = new Date(futureDayMs).getUTCDay();
      const d = new Date(futureDayMs);
      const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      if (dow >= 1 && dow <= 5 && !federalHolidays.has(ymd)) break;
      futureDayMs += 86_400_000;
    }

    if (futureDayMs > yearEndMs) {
      // No remaining non-holiday weekday exists — skip rather than assert on a
      // degenerate window (only possible when running on Dec 31).
      await db.delete(invTable).where(eq(invTable.id, invId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, closedLabMemId));
      await db.delete(organizations).where(eq(organizations.id, closedLab));
      return;
    }

    const futureDay = new Date(futureDayMs);
    const futureDateStr =
      `${futureDay.getUTCFullYear()}-` +
      `${String(futureDay.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(futureDay.getUTCDate()).padStart(2, "0")}`;

    const closedDayId = rid("lcd2");
    await db.insert(closedDaysTable).values({
      id: closedDayId,
      labOrganizationId: closedLab,
      date: futureDateStr,
      createdByUserId: ownerId,
    });

    try {
      const { access } = await makeSession(ownerId);
      const r = await request(appMod.default)
        .get(`/api/stats/sales-forecast?${qs(closedLab)}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const year = r.body.data.year;
      expect(year.insufficientData).toBe(false);

      // Compute expected forecast with the custom closed day included.
      // The custom day is after the cutoff, so elapsedBusinessDays is unaffected.
      const { countBusinessDays } = await import("../lib/stats-utils.js");
      const allHolidays = new Set<string>([...federalHolidays, futureDateStr]);
      const yearStart = { yr: today.yr, mo: 0, day: 1 };
      const yearEndYmd = { yr: today.yr, mo: 11, day: 31 };
      const dacD = new Date(dacMs2);
      const dacYmd = {
        yr: dacD.getUTCFullYear(),
        mo: dacD.getUTCMonth(),
        day: dacD.getUTCDate(),
      };

      const elapsed = countBusinessDays(yearStart, cutoff, allHolidays);
      const remainingWith = countBusinessDays(dacYmd, yearEndYmd, allHolidays);
      const remainingWithout = countBusinessDays(dacYmd, yearEndYmd, federalHolidays);

      // The custom closed day must reduce the remaining count by exactly 1.
      expect(remainingWith).toBe(remainingWithout - 1);

      const avg = 260 / elapsed;
      const expectedForecast = 260 + avg * remainingWith;
      const forecastWithout = 260 + avg * remainingWithout;

      // Actual forecast must match the with-custom-day calculation …
      expect(year.forecast).toBe(expectedForecast.toFixed(2));
      // … and must be strictly lower than it would be without the closed day.
      expect(Number(year.forecast)).toBeLessThan(forecastWithout);
    } finally {
      await db.delete(closedDaysTable).where(eq(closedDaysTable.id, closedDayId));
      await db.delete(invTable).where(eq(invTable.id, invId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, closedLabMemId));
      await db.delete(organizations).where(eq(organizations.id, closedLab));
    }
  });
});
