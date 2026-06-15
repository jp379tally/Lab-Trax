/**
 * One-shot, opt-in backfill: assigns a canonical (Account epic Phase 2)
 * platform account number to every user and organization that does not
 * already have one in the new format.
 *
 * Canonical format: `<TYPE>-<YEAR>-<SEQUENCE>-<PHONE>`
 *   - <TYPE>      "L" for lab, "P" for provider
 *   - <YEAR>      four-digit calendar year of the row's createdAt (UTC)
 *   - <SEQUENCE>  monotonically increasing per (year, TYPE), no padding
 *   - <PHONE>     the row's phone normalized to 10 digits; omitted when absent
 *
 * Example: type="L", year=2026, seq=3, phone="(555) 123-4567"
 *   -> "L-2026-3-5551234567"
 *
 * Ordering is deterministic — rows are processed by (createdAt ASC, id ASC)
 * so re-runs produce identical sequence numbers and historical rows get
 * lower sequence numbers than newly-registered ones.
 *
 * NOTE: Verification enforcement (`requireVerifiedAccount`) only applies to
 * accounts whose platformAccountNumber is in the canonical format. Running
 * this backfill therefore subjects previously-grandfathered accounts to the
 * verification gate — which is why it is opt-in and must be run deliberately.
 *
 * The allocator logic is duplicated here intentionally: this script is its
 * own pnpm workspace package and cannot reach into the api-server package's
 * rootDir. The format spec is also covered by unit tests in
 * `platform-account-number.test.ts`.
 *
 * Usage (dev):
 *   pnpm --filter @workspace/scripts run backfill-account-numbers-v2
 *
 * Re-runs are safe — rows that already have a canonical number are skipped.
 */
import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, organizations, users } from "@workspace/db";

type AccountType = "L" | "P";

const CANONICAL_ACCOUNT_NUMBER = /^[LP]-\d{4}-\d+(-\d{10})?$/;

function accountTypeFor(userOrOrgType: string | null | undefined): AccountType {
  return userOrOrgType === "lab" ? "L" : "P";
}

function normalizePhone10(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits.length === 10 ? digits : null;
}

function format(
  type: AccountType,
  year: number,
  seq: number,
  phone10: string | null
): string {
  const base = `${type}-${year}-${seq}`;
  return phone10 ? `${base}-${phone10}` : base;
}

async function allocate(
  type: AccountType,
  phone: string | null | undefined,
  year: number
): Promise<string> {
  const phone10 = normalizePhone10(phone);
  return await db.transaction(async (tx: any) => {
    await tx.execute(sql`
      INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
      VALUES (${year}, ${type}, 1, now())
      ON CONFLICT DO NOTHING
    `);
    const lockedRaw: any = await tx.execute(sql`
      SELECT next_seq FROM platform_account_sequences
      WHERE year = ${year} AND entity_type = ${type}
      FOR UPDATE
    `);
    const lockedRows: any[] = Array.isArray(lockedRaw)
      ? lockedRaw
      : (lockedRaw?.rows ?? []);
    const seq = Number(lockedRows[0]?.next_seq ?? 1);
    await tx.execute(sql`
      UPDATE platform_account_sequences
      SET next_seq = next_seq + 1, updated_at = now()
      WHERE year = ${year} AND entity_type = ${type}
    `);
    return format(type, year, seq, phone10);
  });
}

function yearOf(row: any): number {
  return row?.createdAt instanceof Date
    ? row.createdAt.getUTCFullYear()
    : new Date().getUTCFullYear();
}

function isCanonical(value: string | null | undefined): boolean {
  return CANONICAL_ACCOUNT_NUMBER.test(value ?? "");
}

async function backfillUsers(): Promise<number> {
  const candidates = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));
  let count = 0;
  for (const u of candidates) {
    if (isCanonical((u as any).platformAccountNumber)) continue;
    const acct = await allocate(
      accountTypeFor((u as any).userType),
      (u as any).phone,
      yearOf(u)
    );
    await db
      .update(users)
      .set({ platformAccountNumber: acct })
      .where(eq(users.id, (u as any).id));
    count++;
    process.stdout.write(
      `user ${(u as any).id} (${(u as any).userType ?? "lab"}) -> ${acct}\n`
    );
  }
  return count;
}

async function backfillOrgs(): Promise<number> {
  const candidates = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id));
  let count = 0;
  for (const o of candidates) {
    if (isCanonical((o as any).platformAccountNumber)) continue;
    const acct = await allocate(
      accountTypeFor((o as any).type),
      (o as any).phone,
      yearOf(o)
    );
    await db
      .update(organizations)
      .set({ platformAccountNumber: acct })
      .where(eq(organizations.id, (o as any).id));
    count++;
    process.stdout.write(
      `org ${(o as any).id} (${(o as any).type}) -> ${acct}\n`
    );
  }
  return count;
}

async function main() {
  const userCount = await backfillUsers();
  const orgCount = await backfillOrgs();
  process.stdout.write(
    `Canonical backfill complete: ${userCount} users, ${orgCount} orgs.\n`
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Canonical backfill failed:", err);
  process.exit(1);
});
