import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, users, organizations, organizationMemberships } from "@workspace/db";
import { chooseProviderOrganization, getActiveProviderOrganizations } from "./provider-selection";

describe("provider organization selection", () => {
  const practices = [{ id: "practice-a" }, { id: "practice-b" }];
  it("requires an explicit selection for multiple practices", () => {
    expect(() => chooseProviderOrganization(practices)).toThrow(/Select a practice/);
  });
  it("accepts only an assigned active candidate", () => {
    expect(chooseProviderOrganization(practices, "practice-b").id).toBe("practice-b");
    expect(() => chooseProviderOrganization(practices, "practice-c")).toThrow(/not assigned/);
  });
  it("auto-selects a single practice", () => {
    expect(chooseProviderOrganization([{ id: "only" }]).id).toBe("only");
  });
  it("reports missing access and never substitutes a single practice for a revoked selection", () => {
    expect(() => chooseProviderOrganization([])).toThrow(/No active provider organization/);
    expect(() => chooseProviderOrganization([{ id: "only" }], "revoked")).toThrow(/not assigned/);
  });
});

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
maybe("provider startup membership authorization", () => {
  it("distinguishes pending, one, multiple and revoked practices without treating lab partnerships as membership", async () => {
    const rollback = new Error("rollback-provider-startup-fixture");
    await expect(db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        username: `portal_${randomUUID()}`, password: "fixture-not-a-login", userType: "provider",
      }).returning();
      const practices = await tx.insert(organizations).values([
        { name: "Portal north fixture", type: "provider" },
        { name: "Portal south fixture", type: "provider" },
        { name: "Portal lab fixture", type: "lab" },
      ]).returning();
      // Resolve through the same query with this transaction; the fixture is
      // fully rolled back and never approved or visible outside it.
      const resolver = (userId: string) => getActiveProviderOrganizations(userId, tx);
      expect(await resolver(user.id)).toEqual([]);
      const [pending] = await tx.insert(organizationMemberships).values({
        userId: user.id, labId: practices[0].id, role: "owner", status: "pending",
      }).returning();
      expect(await resolver(user.id)).toEqual([]);
      await tx.update(organizationMemberships).set({ status: "active" }).where(eq(organizationMemberships.id, pending.id));
      expect((await resolver(user.id)).map((row) => row.id)).toEqual([practices[0].id]);
      await tx.insert(organizationMemberships).values([
        { userId: user.id, labId: practices[1].id, role: "admin", status: "active" },
        { userId: user.id, labId: practices[2].id, role: "admin", status: "active" },
      ]);
      expect((await resolver(user.id)).map((row) => row.id).sort()).toEqual(practices.slice(0, 2).map((row) => row.id).sort());
      await tx.update(organizations).set({ isActive: false }).where(eq(organizations.id, practices[0].id));
      await tx.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, practices[1].id));
      expect(await resolver(user.id)).toEqual([]);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});