import { describe, expect, it } from "vitest";
import { backfillProviderAccountNumbers, isProviderBackfillEligible } from "./provider-account-number-backfill";

describe("provider account number backfill eligibility", () => {
  const address = {
    type: "provider", isActive: true, deletedAt: null,
    accountNumber: null, addressLine1: "10 Oak St", city: "Austin",
    state: "TX", zip: "78701",
  };

  it("selects only active, addressed providers missing a number", () => {
    expect(isProviderBackfillEligible(address)).toBe(true);
    expect(isProviderBackfillEligible({ ...address, accountNumber: "P-10-O-1" })).toBe(false);
    expect(isProviderBackfillEligible({ ...address, isActive: false })).toBe(false);
    expect(isProviderBackfillEligible({ ...address, city: null, state: null, zip: null })).toBe(false);
  });

  it("preserves existing numbers and is idempotent by eligibility", () => {
    const once = [address, { ...address, accountNumber: "P-10-O-1" }]
      .filter(isProviderBackfillEligible);
    const twice = once.filter(isProviderBackfillEligible);
    expect(once).toHaveLength(1);
    expect(twice).toHaveLength(1);
  });

  it("proposes unique suffixes in dry-run without updating and applies the same proposals", async () => {
    const rows: any[] = [
      { id: "standalone-1", type: "provider", isActive: true, deletedAt: null, accountNumber: null, addressLine1: "10 Oak", name: "Oak Care", city: "Austin" },
      { id: "standalone-2", type: "provider", isActive: true, deletedAt: null, accountNumber: null, addressLine1: "10 Oak", name: "Oak Care", city: "Austin" },
    ];
    const updateCalls: string[] = [];
    const fakeDb: any = { query: { organizations: { findMany: async () => rows } } };
    const lock = async (_parent: string | null, fn: any) => fn({
      update: () => ({
        set: (v: any) => ({ where: () => ({ returning: async () => {
          updateCalls.push(v.accountNumber); return [{ id: "updated" }];
        } }) }),
      }),
    });
    const standalone = async (_input: any, _client: any, reserved?: Set<string>) =>
      reserved?.has("P-10-OC-1") ? "P-10-OC-2" : "P-10-OC-1";
    const dry = await backfillProviderAccountNumbers({
      dryRun: true, database: fakeDb, lock: lock as any, generateStandalone: standalone as any,
    });
    expect(dry.assignments.map((a) => a.accountNumber)).toEqual(["P-10-OC-1", "P-10-OC-2"]);
    expect(dry.applied).toBe(0);
    expect(updateCalls).toEqual([]);
    const applied = await backfillProviderAccountNumbers({
      dryRun: false, database: fakeDb, lock: lock as any, generateStandalone: standalone as any,
    });
    expect(applied.assignments.map((a) => a.accountNumber)).toEqual(dry.assignments.map((a) => a.accountNumber));
    expect(applied.applied).toBe(2);
    expect(updateCalls).toEqual(["P-10-OC-1", "P-10-OC-2"]);
  });

  it("dispatches linked providers to the lab generator and standalone providers to P allocation", async () => {
    const rows: any[] = [
      { id: "linked", type: "provider", isActive: true, deletedAt: null, accountNumber: null, parentLabOrganizationId: "lab-1", addressLine1: "1 Main", name: "Linked", city: "Austin" },
      { id: "standalone", type: "provider", isActive: true, deletedAt: null, accountNumber: null, parentLabOrganizationId: null, addressLine1: "2 Main", name: "Solo", city: "Austin" },
    ];
    const seen: string[] = [];
    const fakeDb: any = { query: { organizations: { findMany: async () => rows } } };
    const lock = async (parent: string | null, fn: any) => { seen.push(`lock:${parent ?? "standalone"}`); return fn({}); };
    const result = await backfillProviderAccountNumbers({
      database: fakeDb, lock: lock as any,
      generateLinked: async () => "LAB-1-1",
      generateStandalone: async () => "P-2-SO-1",
    });
    expect(result.assignments).toEqual([
      { organizationId: "linked", accountNumber: "LAB-1-1" },
      { organizationId: "standalone", accountNumber: "P-2-SO-1" },
    ]);
    expect(seen).toEqual(["lock:lab-1", "lock:standalone"]);
  });

  it("has no eligible rows on the second apply and never overwrites an existing number", async () => {
    const rows: any[] = [
      { id: "one", type: "provider", isActive: true, deletedAt: null, accountNumber: null, addressLine1: "8 Main", name: "Eight", city: "Austin" },
      { id: "existing", type: "provider", isActive: true, deletedAt: null, accountNumber: "P-EXISTING", addressLine1: "9 Main", name: "Existing", city: "Austin" },
    ];
    const fakeDb: any = { query: { organizations: { findMany: async () => rows.filter((r) => !r.accountNumber) } } };
    const lock = async (_parent: string | null, fn: any) => fn({
      update: () => ({ set: (v: any) => ({ where: () => ({ returning: async () => {
        rows[0].accountNumber = v.accountNumber; return [{ id: "one" }];
      } }) }) }),
    });
    const opts: any = { dryRun: false, database: fakeDb, lock, generateStandalone: async () => "P-8-EI-1" };
    const first = await backfillProviderAccountNumbers(opts);
    const second = await backfillProviderAccountNumbers(opts);
    expect(first.applied).toBe(1);
    expect(second.eligible).toBe(0);
    expect(second.applied).toBe(0);
    expect(rows[1].accountNumber).toBe("P-EXISTING");
  });
});