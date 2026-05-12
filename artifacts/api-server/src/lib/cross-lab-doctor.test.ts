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

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    allocator = await import("./platform-account-number.js");
    crossLab = await import("./cross-lab-doctor.js");
  });

  it("allocator increments sequence per (year, entity)", async () => {
    const year = 2999; // sentinel year that won't collide with real data
    // Drain any existing row so this test is hermetic.
    const { db, platformAccountSequences } = dbMod as any;
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

    // Cleanup so re-runs are idempotent.
    await db
      .delete(platformAccountSequences)
      .where(eq(platformAccountSequences.year, year));
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
