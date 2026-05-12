/**
 * Platform-wide account-number allocator (Task #320).
 *
 * Format: <seq><YY><F><L>
 *   - <seq>   monotonically increasing per (year, entityType), no padding
 *   - <YY>    two-digit calendar year of the row's createdAt (UTC)
 *   - <F>     first letter of the doctor/practice "first" name (uppercase)
 *   - <L>     first letter of the "last" name (uppercase)
 *
 * Example: seq=29, year=2026, name="John Watson" -> "2926JW".
 *
 * Allocation is serialized via Postgres row-level lock
 * (`SELECT ... FOR UPDATE`) on `platform_account_sequences` so concurrent
 * registrations under the same (year, entityType) get strictly increasing
 * sequence numbers without race conditions.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type PlatformAccountEntityType = "user" | "org";

export interface NameParts {
  first: string;
  last: string;
}

/**
 * Best-effort split of a free-form display name into (first, last) initials.
 * Falls back to "X" for any token we cannot infer so the resulting account
 * number is still well-formed and unique-by-sequence.
 */
export function deriveAccountNameParts(input: {
  firstName?: string | null;
  lastName?: string | null;
  doctorName?: string | null;
  practiceName?: string | null;
  fullName?: string | null;
}): NameParts {
  const cleanInitial = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const ch = s
      .replace(/dr\.?\s*/i, "")
      .trim()
      .replace(/[^A-Za-z]/g, "")[0];
    return ch ? ch.toUpperCase() : null;
  };

  if (input.firstName || input.lastName) {
    return {
      first: cleanInitial(input.firstName) ?? "X",
      last: cleanInitial(input.lastName) ?? "X",
    };
  }

  const blob = (input.doctorName || input.practiceName || input.fullName || "")
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

/**
 * Format a platform account number from its parts. Exported for use by the
 * backfill script (which assigns deterministic sequence numbers).
 */
export function formatPlatformAccountNumber(
  seq: number,
  year: number,
  parts: NameParts
): string {
  const yy = String(year).slice(-2).padStart(2, "0");
  return `${seq}${yy}${parts.first}${parts.last}`;
}

/**
 * Reserve the next sequence number for (year, entityType) atomically and
 * return the formatted account number. Must be called outside any other
 * transaction since it opens its own.
 *
 * `tx` may be passed in if the caller is already inside a transaction —
 * the lock is taken on the same connection so the allocation participates
 * in the caller's atomicity.
 */
export async function allocatePlatformAccountNumber(
  entityType: PlatformAccountEntityType,
  parts: NameParts,
  options: { year?: number; tx?: any } = {}
): Promise<string> {
  const year =
    options.year ?? new Date().getUTCFullYear();
  const exec = async (runner: any): Promise<string> => {
    // Insert sequence row if missing. ON CONFLICT DO NOTHING is fine because
    // the immediately-following SELECT ... FOR UPDATE will block on the
    // existing row's lock if a concurrent caller just inserted it.
    await runner.execute(sql`
      INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
      VALUES (${year}, ${entityType}, 1, now())
      ON CONFLICT DO NOTHING
    `);
    const lockedRaw: any = await runner.execute(sql`
      SELECT next_seq FROM platform_account_sequences
      WHERE year = ${year} AND entity_type = ${entityType}
      FOR UPDATE
    `);
    // Drizzle's execute returns either { rows } (node-postgres) or an array
    // depending on the driver. Normalize.
    const lockedRows: any[] = Array.isArray(lockedRaw)
      ? lockedRaw
      : (lockedRaw?.rows ?? []);
    const seq = Number(lockedRows[0]?.next_seq ?? 1);
    await runner.execute(sql`
      UPDATE platform_account_sequences
      SET next_seq = next_seq + 1, updated_at = now()
      WHERE year = ${year} AND entity_type = ${entityType}
    `);
    return formatPlatformAccountNumber(seq, year, parts);
  };

  if (options.tx) {
    return exec(options.tx);
  }
  return await db.transaction(async (tx: any) => exec(tx));
}
