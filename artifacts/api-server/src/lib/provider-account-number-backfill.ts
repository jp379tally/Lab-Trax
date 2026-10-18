import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { db, organizations } from "@workspace/db";
import {
  generateProviderAccountNumber,
  generateStandaloneProviderAccountNumber,
  withAccountNumberLock,
} from "./provider-account-number";

export type ProviderAccountNumberBackfillResult = {
  dryRun: boolean;
  reviewed: number;
  eligible: number;
  applied: number;
  assignments: Array<{ organizationId: string; accountNumber: string }>;
};

export function isProviderBackfillEligible(org: {
  type: string; isActive: boolean; deletedAt?: unknown;
  accountNumber?: string | null; addressLine1?: string | null;
  city?: string | null; state?: string | null; zip?: string | null;
}): boolean {
  return org.type === "provider" && org.isActive && !org.deletedAt &&
    !org.accountNumber && Boolean(org.addressLine1) &&
    Boolean(org.city || org.state || org.zip);
}

/** Review/apply the one-time provider number repair. Safe to run repeatedly. */
export async function backfillProviderAccountNumbers(options: {
  dryRun?: boolean;
  /** Test/maintenance seam; production uses the canonical database/functions. */
  database?: typeof db;
  generateLinked?: typeof generateProviderAccountNumber;
  generateStandalone?: typeof generateStandaloneProviderAccountNumber;
  lock?: typeof withAccountNumberLock;
} = {}): Promise<ProviderAccountNumberBackfillResult> {
  const dryRun = options.dryRun ?? true;
  const database = options.database ?? db;
  const linkedGenerator = options.generateLinked ?? generateProviderAccountNumber;
  const standaloneGenerator = options.generateStandalone ?? generateStandaloneProviderAccountNumber;
  const lock = options.lock ?? withAccountNumberLock;
  const candidates = await database.query.organizations.findMany({
    where: and(
      eq(organizations.type, "provider"),
      eq(organizations.isActive, true),
      isNull(organizations.deletedAt),
      isNull(organizations.accountNumber),
      isNotNull(organizations.addressLine1),
      or(isNotNull(organizations.city), isNotNull(organizations.state), isNotNull(organizations.zip)),
    ),
  });
  const result: ProviderAccountNumberBackfillResult = {
    dryRun, reviewed: candidates.length, eligible: candidates.length, applied: 0, assignments: [],
  };
  const reserved = new Set<string>();
  for (const org of candidates) {
    const assign = async (client: any) => org.parentLabOrganizationId
      ? linkedGenerator(org.parentLabOrganizationId, {
          addressLine1: org.addressLine1, practiceName: org.name,
        }, client, reserved)
      : standaloneGenerator({
          addressLine1: org.addressLine1, practiceName: org.name,
        }, client, reserved);
    const accountNumber = await lock(org.parentLabOrganizationId, async (client) => {
      const value = await assign(client);
      if (!dryRun) {
        const [updated] = await (client as any).update(organizations)
          .set({ accountNumber: value })
          .where(and(eq(organizations.id, org.id), isNull(organizations.accountNumber)))
          .returning({ id: organizations.id });
        return { value, updated: Boolean(updated) };
      }
      return { value, updated: true };
    });
    reserved.add(accountNumber.value);
    result.assignments.push({ organizationId: org.id, accountNumber: accountNumber.value });
    if (!dryRun && accountNumber.updated) result.applied++;
  }
  return result;
}