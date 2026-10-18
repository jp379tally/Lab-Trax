import { type User, type InsertUser, users, labCases } from "@workspace/db";
import { db } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  updateUser(id: string, data: Partial<User>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  upsertCase(id: string, ownerId: string, caseData: string): Promise<void>;
  getCasesByOwnerIds(ownerIds: string[]): Promise<{ id: string; ownerId: string; caseData: string }[]>;
  deleteCase(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1);
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(trim(${users.email})) = ${email.trim().toLowerCase()}`)
      .limit(1);
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async updateUser(id: string, data: Partial<User>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return updated;
  }

  async deleteUser(id: string): Promise<boolean> {
    // Soft-delete: users is a protected table. See lib/soft-delete.ts.
    const result = await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return result.length > 0;
  }

  async upsertCase(id: string, ownerId: string, caseData: string): Promise<void> {
    await db.insert(labCases).values({ id, ownerId, caseData, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: labCases.id,
        set: { ownerId, caseData, updatedAt: new Date() },
      });
  }

  async getCasesByOwnerIds(ownerIds: string[]): Promise<{ id: string; ownerId: string; caseData: string }[]> {
    if (ownerIds.length === 0) return [];
    const rows = await db.select().from(labCases).where(inArray(labCases.ownerId, ownerIds));
    return rows.map(r => ({ id: r.id, ownerId: r.ownerId, caseData: r.caseData }));
  }

  async deleteCase(id: string): Promise<void> {
    // Soft-delete only: never physically remove a case row. Hard delete was
    // the root cause of the Apr 27 2026 mass-wipe incident; soft delete keeps
    // data recoverable from the admin trash even if the caller is buggy.
    await db
      .update(labCases)
      .set({ deletedAt: new Date(), deletedBy: "system" })
      .where(eq(labCases.id, id));
  }
}

export const storage = new DatabaseStorage();
