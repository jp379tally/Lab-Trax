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

// ───────────────────────────────────────────────────────────────────────────
// Account epic Phase 2 — canonical account-number format
//
// Format: <TYPE>-<YEAR>-<SEQUENCE>-<PHONE>
//   - <TYPE>      "L" (lab) | "P" (provider)
//   - <YEAR>      four-digit calendar year of allocation (UTC)
//   - <SEQUENCE>  monotonically increasing per (year, TYPE), no padding
//   - <PHONE>     the account's normalized 10-digit phone (omitted when the
//                 phone is missing/invalid, producing a 3-segment number)
//
// Example: type=L, year=2026, seq=3, phone="(555) 123-4567"
//          -> "L-2026-3-5551234567"
//
// Allocation reuses `platform_account_sequences` keyed by TYPE ("L"/"P") and
// is serialized via `SELECT ... FOR UPDATE`, identical to the legacy allocator.
// ───────────────────────────────────────────────────────────────────────────

export type AccountType = "L" | "P";

/**
 * Map a user/org "lab" | "provider" type to the single-letter account TYPE.
 */
export function accountTypeFor(
  userOrOrgType: string | null | undefined
): AccountType {
  return userOrOrgType === "lab" ? "L" : "P";
}

/**
 * Normalize a free-form phone string to exactly 10 digits, or null when it
 * cannot be normalized. Strips all non-digits, drops a leading US country
 * code "1" from 11-digit numbers, and requires exactly 10 digits otherwise.
 */
export function normalizePhone10(
  phone: string | null | undefined
): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits.length === 10 ? digits : null;
}

/**
 * Format a canonical (Phase 2) account number from its parts. The phone
 * segment is omitted when `phone10` is null/invalid. Exported for the
 * backfill script (which supplies deterministic sequence numbers).
 */
export function formatAccountNumberV2(
  type: AccountType,
  year: number,
  seq: number,
  phone10: string | null
): string {
  const base = `${type}-${year}-${seq}`;
  return phone10 ? `${base}-${phone10}` : base;
}

/**
 * Reserve the next sequence number for (year, TYPE) atomically and return the
 * formatted canonical account number. Pass `tx` to participate in a caller's
 * transaction (recommended — the number must be allocated in the same
 * transaction as the row it belongs to so it is immutable and gap-free).
 */
export async function allocateAccountNumberV2(
  type: AccountType,
  phone: string | null | undefined,
  options: { year?: number; tx?: any } = {}
): Promise<string> {
  const year = options.year ?? new Date().getUTCFullYear();
  const phone10 = normalizePhone10(phone);
  const exec = async (runner: any): Promise<string> => {
    await runner.execute(sql`
      INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
      VALUES (${year}, ${type}, 1, now())
      ON CONFLICT DO NOTHING
    `);
    const lockedRaw: any = await runner.execute(sql`
      SELECT next_seq FROM platform_account_sequences
      WHERE year = ${year} AND entity_type = ${type}
      FOR UPDATE
    `);
    const lockedRows: any[] = Array.isArray(lockedRaw)
      ? lockedRaw
      : (lockedRaw?.rows ?? []);
    const seq = Number(lockedRows[0]?.next_seq ?? 1);
    await runner.execute(sql`
      UPDATE platform_account_sequences
      SET next_seq = next_seq + 1, updated_at = now()
      WHERE year = ${year} AND entity_type = ${type}
    `);
    return formatAccountNumberV2(type, year, seq, phone10);
  };

  if (options.tx) {
    return exec(options.tx);
  }
  return await db.transaction(async (tx: any) => exec(tx));
}
