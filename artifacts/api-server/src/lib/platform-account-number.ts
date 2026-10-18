/**
 * Server adapter for the shared twelve-digit platform account-number format.
 * New issuance is transaction-bound and deliberately has no PII input.
 *
 * The name/legacy formatting helpers below remain only for old maintenance
 * tooling and grandfathered tests; they are not used for issuance.
 */
import { sql } from "drizzle-orm";
import {
  ACCOUNT_NUMBER_MODULUS,
  generateAccountNumberFromSequence,
} from "@workspace/account-number";

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
 * Format a legacy platform account number from its parts.
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
 * The transaction-bound global allocator is the only issuance API.
 */
const GLOBAL_SEQUENCE_YEAR = 0;
const GLOBAL_SEQUENCE_ENTITY_TYPE = "global";
// `next_seq` remains a PostgreSQL integer in existing installations. This
// explicit bound avoids unsafe JS arithmetic and leaves room below int max.
const MAX_GLOBAL_SEQUENCE = 2_147_483_646n;
const MAX_ALLOCATION_RETRIES = 100;

function resultRows(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows ?? [];
}

/**
 * Allocate from one global sequence. The caller must provide its transaction:
 * allocation and the row receiving the number then commit or roll back
 * together.
 */
export async function allocatePlatformAccountNumber(options: {
  tx: any;
}): Promise<string> {
  const runner = options?.tx;
  if (!runner || typeof runner.execute !== "function") {
    throw new Error(
      "allocatePlatformAccountNumber requires the caller's transaction (tx).",
    );
  }
  await runner.execute(sql`
    INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
    VALUES (${GLOBAL_SEQUENCE_YEAR}, ${GLOBAL_SEQUENCE_ENTITY_TYPE}, 1, now())
    ON CONFLICT (year, entity_type) DO NOTHING
  `);
  const locked = resultRows(await runner.execute(sql`
    SELECT next_seq
    FROM platform_account_sequences
    WHERE year = ${GLOBAL_SEQUENCE_YEAR}
      AND entity_type = ${GLOBAL_SEQUENCE_ENTITY_TYPE}
    FOR UPDATE
  `));
  if (!locked[0]?.next_seq && locked[0]?.next_seq !== 0) {
    throw new Error("Could not lock the global platform account sequence.");
  }

  let sequence = BigInt(String(locked[0].next_seq));
  for (let attempt = 0; attempt < MAX_ALLOCATION_RETRIES; attempt += 1) {
    if (
      sequence < 0n ||
      sequence >= ACCOUNT_NUMBER_MODULUS ||
      sequence > MAX_GLOBAL_SEQUENCE
    ) {
      throw new Error("The global platform account-number sequence is exhausted.");
    }
    const candidate = generateAccountNumberFromSequence(sequence);
    const collision = resultRows(await runner.execute(sql`
      SELECT 1
      FROM users
      WHERE platform_account_number = ${candidate}
      UNION ALL
      SELECT 1
      FROM organizations
      WHERE platform_account_number = ${candidate}
      LIMIT 1
    `));
    // Advance for every candidate, including occupied legacy values. This
    // update is in the caller transaction and therefore rolls back with it.
    await runner.execute(sql`
      UPDATE platform_account_sequences
      SET next_seq = next_seq + 1, updated_at = now()
      WHERE year = ${GLOBAL_SEQUENCE_YEAR}
        AND entity_type = ${GLOBAL_SEQUENCE_ENTITY_TYPE}
    `);
    sequence += 1n;
    if (collision.length === 0) return candidate;
  }
  throw new Error(
    `Could not allocate a unique platform account number after ${MAX_ALLOCATION_RETRIES} attempts.`,
  );
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
