/**
 * Integration test for the cross-lab doctor identity helpers + the
 * platform-account-number allocator. Skipped when no DATABASE_URL
 * is configured (matches the project convention used by
 * `installer-storage-e2e.test.ts`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { generateAccountNumberFromSequence } from "@workspace/account-number";

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

  it("allocator increments one global sequence", async () => {
    const { db } = dbMod as any;

    const allocate = () =>
      db.transaction((tx: any) =>
        allocator.allocatePlatformAccountNumber({ tx }),
      );
    const a = await allocate();
    const b = await allocate();
    expect(a).toMatch(/^7\d{11}$/);
    expect(b).toMatch(/^7\d{11}$/);
    expect(a).not.toBe(b);

    // Concurrent allocations: every result is unique.
    const concurrent = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        allocate()
      )
    );
    expect(new Set(concurrent).size).toBe(concurrent.length);
  });

  it("skips a number already used by an organization", async () => {
    const { db } = dbMod as any;
    await db.transaction(async (tx: any) => {
      const resultRows = (result: any): any[] =>
        Array.isArray(result) ? result : (result?.rows ?? []);

      await tx.execute(sql`
        INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
        VALUES (0, 'global', 1, now())
        ON CONFLICT (year, entity_type) DO NOTHING
      `);
      const locked: any = await tx.execute(sql`
        SELECT next_seq
        FROM platform_account_sequences
        WHERE year = 0 AND entity_type = 'global'
        FOR UPDATE
      `);
      const rows = resultRows(locked);
      // The shared development database keeps rows from earlier runs, so the
      // slot the sequence currently points at may already be taken. Inserting
      // the blocker there would fail the unique index at random, so walk
      // forward to the first free slot and point the sequence at it — the
      // allocator must then meet our blocker and step over it.
      let sequence = BigInt(String(rows[0].next_seq));
      let occupied = generateAccountNumberFromSequence(sequence);
      let freeSlotFound = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const taken = resultRows(
          await tx.execute(sql`
            SELECT 1 FROM users WHERE platform_account_number = ${occupied}
            UNION ALL
            SELECT 1 FROM organizations WHERE platform_account_number = ${occupied}
            LIMIT 1
          `)
        );
        if (taken.length === 0) {
          freeSlotFound = true;
          break;
        }
        sequence += 1n;
        occupied = generateAccountNumberFromSequence(sequence);
      }
      expect(
        freeSlotFound,
        "no unoccupied platform account-number slot found for the blocker"
      ).toBe(true);
      await tx.execute(sql`
        UPDATE platform_account_sequences
        SET next_seq = ${Number(sequence)}, updated_at = now()
        WHERE year = 0 AND entity_type = 'global'
      `);

      const blockerId = `allocator_collision_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
      await tx.execute(sql`
        INSERT INTO organizations (id, type, name, platform_account_number)
        VALUES (${blockerId}, 'provider', ${blockerId}, ${occupied})
      `);

      try {
        const allocated = await allocator.allocatePlatformAccountNumber({ tx });
        expect(allocated).toMatch(/^7\d{11}$/);
        expect(allocated).not.toBe(occupied);
      } finally {
        // Leave nothing behind: a surviving blocker would occupy this number
        // for every later run.
        await tx.execute(sql`DELETE FROM organizations WHERE id = ${blockerId}`);
      }
    });
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
