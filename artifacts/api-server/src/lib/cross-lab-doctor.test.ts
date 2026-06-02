/**
 * Integration test for the cross-lab doctor identity helpers + the
 * platform-account-number allocator (Task #320). Skipped when no DATABASE_URL
 * is configured (matches the project convention used by
 * `installer-storage-e2e.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("cross-lab doctor + allocator (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let allocator: typeof import("./platform-account-number.js");
  let crossLab: typeof import("./cross-lab-doctor.js");

  // Per-process sentinel year so that two concurrent test runs sharing the same
  // dev DATABASE_URL (e.g. the validation harness runs the api-server suite
  // twice in parallel) don't race on the same (year, entity) sequence rows.
  // Kept far beyond real data and ending in 99 so the YY component of the
  // expected account numbers below ("199JW", etc.) stays 99.
  const SENTINEL_YEAR = 2099 + 100 * (process.pid % 95); // won't collide with real data

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    allocator = await import("./platform-account-number.js");
    crossLab = await import("./cross-lab-doctor.js");

    // Drain any leftover rows from a previous run that may have crashed before
    // afterAll could clean up. Must run before any allocation in this suite.
    const { db, platformAccountSequences } = dbMod as any;
    await db
      .delete(platformAccountSequences)
      .where(eq(platformAccountSequences.year, SENTINEL_YEAR));
  });

  afterAll(async () => {
    // Always clean up, even when an assertion fails mid-test, so that
    // subsequent runs start from a clean slate on the shared dev DB.
    const { db, platformAccountSequences } = dbMod as any;
    await db
      .delete(platformAccountSequences)
      .where(eq(platformAccountSequences.year, SENTINEL_YEAR));
  });

  it("allocator increments sequence per (year, entity)", async () => {
    const year = SENTINEL_YEAR;
    const { db, platformAccountSequences } = dbMod as any;

    // Re-drain at test start in case a concurrent worker left rows since
    // beforeAll ran (unlikely but makes the assertion deterministic).
    await db
      .delete(platformAccountSequences)
      .where(eq(platformAccountSequences.year, year));

    const a = await allocator.allocatePlatformAccountNumber(
      "user",
      { first: "J", last: "W" },
      { year }
    );
    const b = await allocator.allocatePlatformAccountNumber(
      "user",
      { first: "J", last: "W" },
      { year }
    );
    expect(a).toBe("199JW");
    expect(b).toBe("299JW");

    // Different entity type uses an independent sequence.
    const c = await allocator.allocatePlatformAccountNumber(
      "org",
      { first: "P", last: "G" },
      { year }
    );
    expect(c).toBe("199PG");

    // Concurrent allocations: every result is unique.
    const concurrent = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        allocator.allocatePlatformAccountNumber(
          "user",
          { first: "X", last: "Y" },
          { year }
        )
      )
    );
    expect(new Set(concurrent).size).toBe(concurrent.length);
  });

  it("canonicalLinkPair orders user ids deterministically", () => {
    expect(crossLab.canonicalLinkPair("b", "a")).toEqual({
      low: "a",
      high: "b",
    });
    expect(crossLab.canonicalLinkPair("a", "b")).toEqual({
      low: "a",
      high: "b",
    });
    expect(crossLab.canonicalLinkPair("a", "a")).toBeNull();
  });
});
