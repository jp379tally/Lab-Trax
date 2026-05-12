/**
 * One-shot backfill: assigns a platform-wide account number to every
 * provider user and provider organization that does not already have one.
 *
 * Ordering is deterministic — rows are processed by (createdAt ASC, id ASC)
 * so re-runs produce identical sequence numbers, and so historical rows get
 * lower sequence numbers than newly-registered ones.
 *
 * The allocator logic is duplicated here intentionally: the script is its
 * own pnpm workspace package and cannot reach into the api-server package's
 * rootDir. The duplicated copy is a few dozen lines and the format spec is
 * also covered by unit tests in `platform-account-number.test.ts`.
 *
 * Usage (dev):
 *   pnpm --filter @workspace/scripts run backfill-platform-account-numbers
 *
 * Re-runs are safe — already-allocated rows are skipped.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  organizations,
  platformAccountSequences,
  users,
} from "@workspace/db";

interface NameParts {
  first: string;
  last: string;
}

function deriveAccountNameParts(input: {
  firstName?: string | null;
  lastName?: string | null;
  doctorName?: string | null;
  practiceName?: string | null;
}): NameParts {
  const cleanInitial = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const ch = s.replace(/dr\.?\s*/i, "").trim().replace(/[^A-Za-z]/g, "")[0];
    return ch ? ch.toUpperCase() : null;
  };
  if (input.firstName || input.lastName) {
    return {
      first: cleanInitial(input.firstName) ?? "X",
      last: cleanInitial(input.lastName) ?? "X",
    };
  }
  const blob = (input.doctorName || input.practiceName || "")
    .replace(/dr\.?\s*/i, "")
    .trim();
  if (!blob) return { first: "X", last: "X" };
  const tokens = blob
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return { first: "X", last: "X" };
  if (tokens.length === 1) {
    const t = tokens[0]!.toUpperCase();
    return { first: t[0]!, last: t[1] ?? t[0]! };
  }
  return {
    first: tokens[0]![0]!.toUpperCase(),
    last: tokens[tokens.length - 1]![0]!.toUpperCase(),
  };
}

function format(seq: number, year: number, parts: NameParts): string {
  const yy = String(year).slice(-2).padStart(2, "0");
  return `${seq}${yy}${parts.first}${parts.last}`;
}

async function allocate(
  entityType: "user" | "org",
  parts: NameParts,
  year: number
): Promise<string> {
  return await db.transaction(async (tx: any) => {
    await tx.execute(sql`
      INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
      VALUES (${year}, ${entityType}, 1, now())
      ON CONFLICT DO NOTHING
    `);
    const lockedRaw: any = await tx.execute(sql`
      SELECT next_seq FROM platform_account_sequences
      WHERE year = ${year} AND entity_type = ${entityType}
      FOR UPDATE
    `);
    const lockedRows: any[] = Array.isArray(lockedRaw)
      ? lockedRaw
      : (lockedRaw?.rows ?? []);
    const seq = Number(lockedRows[0]?.next_seq ?? 1);
    await tx.execute(sql`
      UPDATE platform_account_sequences
      SET next_seq = next_seq + 1, updated_at = now()
      WHERE year = ${year} AND entity_type = ${entityType}
    `);
    // Reference to silence unused-import warning when only used in raw SQL.
    void platformAccountSequences;
    return format(seq, year, parts);
  });
}

async function backfillUsers(): Promise<number> {
  const candidates = await db
    .select()
    .from(users)
    .where(
      and(eq(users.userType, "provider"), isNull(users.platformAccountNumber))
    )
    .orderBy(asc(users.createdAt), asc(users.id));
  let count = 0;
  for (const u of candidates) {
    const yearOfRow =
      (u as any).createdAt instanceof Date
        ? (u as any).createdAt.getUTCFullYear()
        : new Date().getUTCFullYear();
    const acct = await allocate(
      "user",
      deriveAccountNameParts({
        firstName: (u as any).firstName,
        lastName: (u as any).lastName,
        doctorName: (u as any).doctorName,
        practiceName: (u as any).practiceName,
      }),
      yearOfRow
    );
    await db
      .update(users)
      .set({ platformAccountNumber: acct })
      .where(eq(users.id, (u as any).id));
    count++;
    process.stdout.write(`user ${(u as any).id} -> ${acct}\n`);
  }
  return count;
}

async function backfillOrgs(): Promise<number> {
  const candidates = await db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.type, "provider"),
        isNull(organizations.platformAccountNumber)
      )
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id));
  let count = 0;
  for (const o of candidates) {
    const yearOfRow =
      (o as any).createdAt instanceof Date
        ? (o as any).createdAt.getUTCFullYear()
        : new Date().getUTCFullYear();
    const acct = await allocate(
      "org",
      deriveAccountNameParts({
        practiceName: (o as any).displayName || (o as any).name,
      }),
      yearOfRow
    );
    await db
      .update(organizations)
      .set({ platformAccountNumber: acct })
      .where(eq(organizations.id, (o as any).id));
    count++;
    process.stdout.write(`org ${(o as any).id} -> ${acct}\n`);
  }
  return count;
}

async function main() {
  const userCount = await backfillUsers();
  const orgCount = await backfillOrgs();
  process.stdout.write(
    `Backfill complete: ${userCount} users, ${orgCount} orgs.\n`
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Backfill failed:", err);
  process.exit(1);
});
