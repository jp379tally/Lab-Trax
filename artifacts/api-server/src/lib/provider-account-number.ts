import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { organizations } from "@workspace/db";
import { HttpError } from "./http";
import { notDeleted } from "./soft-delete";

// Shared type for either the top-level db client or a Drizzle transaction,
// which share the same query/insert/update interface. The same pattern is used
// in lib/default-categories.ts.
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Split a raw semicolon-separated account number string into individual
 * segments. Trims each segment and filters out blanks. Returns an empty array
 * when `raw` is null/undefined/empty.
 *
 * Example: "LAB-EXAMPLE-1280-BG-1; EXAMPLE-2603-BC-1" → ["LAB-EXAMPLE-1280-BG-1", "EXAMPLE-2603-BC-1"]
 */
export function parseAccountNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Derive a short uppercase acronym from a lab name to prefix new provider
 * account numbers (e.g. "Summit Dental Research" → "SDR", "Acme Lab 1" →
 * "AL1"). Takes the first letter of each whitespace-separated token, up to
 * 4 characters, upper-cased. Falls back to the first 4 letters of the name
 * when the name is a single token. Returns "" when the name is empty so
 * callers can skip the prefix safely.
 */
export function deriveLabAcronym(labName: string): string {
  const cleaned = labName.trim();
  if (!cleaned) return "";
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 4).toUpperCase();
  }
  return tokens
    .slice(0, 4)
    .map((t) => t[0]!)
    .join("")
    .toUpperCase();
}

// Strip non-numeric characters from a free-form street address. Returns the
// first run of digits found (typically the house/street number); empty string
// if none.
function extractAddressNumerics(address: string | null | undefined): string {
  if (!address) return "";
  const match = String(address).match(/\d+/);
  return match?.[0] ?? "";
}

// Derive 1-3 character initials from a doctor name. Falls back to "DR" when
// the name is empty/unusable so we never produce an empty token.
export function deriveDoctorInitials(doctorName: string | null | undefined): string {
  const cleaned = String(doctorName ?? "")
    .replace(/dr\.?\s*/i, "")
    .trim();
  if (!cleaned) return "DR";
  const parts = cleaned
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return "DR";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface AccountNumberInput {
  addressLine1?: string | null;
  doctorName?: string | null;
  practiceName?: string | null;
}

// Build the base "address-numerics + initials" portion of an account number.
// The tiebreaker is appended separately so callers can iterate it for
// uniqueness collisions.
function buildAccountNumberBase(input: AccountNumberInput): string {
  const numerics = extractAddressNumerics(input.addressLine1);
  const initials = deriveDoctorInitials(
    input.doctorName || input.practiceName || ""
  );
  if (numerics) return `${numerics}-${initials}`;
  return `${initials}`;
}

/** Deterministic standalone prefix, exported for maintenance tooling/tests. */
export function standaloneAccountNumberBase(input: AccountNumberInput): string {
  return `P-${buildAccountNumberBase(input)}`;
}

// Returns true if no other **active (non-deleted)** org under
// `parentLabOrganizationId` already uses `accountNumber` as any of its
// semicolon-separated segments.
//
// Excludes `excludeOrgId` from the check so PATCH callers can re-save without
// colliding with themselves.
//
// `client` may be a transaction (tx) so this check can be made atomic with
// the subsequent insert/update.
async function isAccountNumberAvailable(
  parentLabOrganizationId: string,
  accountNumber: string,
  excludeOrgId: string | null,
  client: DbOrTx = db
): Promise<boolean> {
  const conditions = [
    eq(organizations.parentLabOrganizationId, parentLabOrganizationId),
    notDeleted(organizations),
  ];
  if (excludeOrgId) {
    conditions.push(ne(organizations.id, excludeOrgId));
  }
  const existingOrgs = await (client as typeof db).query.organizations.findMany({
    where: and(...conditions),
    columns: { id: true, accountNumber: true },
  });
  const usedSegments = new Set<string>();
  for (const org of existingOrgs) {
    for (const seg of parseAccountNumbers(org.accountNumber)) {
      usedSegments.add(seg);
    }
  }
  return !usedSegments.has(accountNumber);
}

// Returns true if no other org (including soft-deleted) under
// `parentLabOrganizationId` already uses `accountNumber` as any segment.
//
// Used by the fallback generator: when the primary generator (which excludes
// deleted rows) picks a reclaimed number, the retry must skip ALL occupied
// numbers including soft-deleted ones.
async function isAccountNumberAvailableAllRows(
  parentLabOrganizationId: string,
  accountNumber: string,
  excludeOrgId: string | null,
  client: DbOrTx = db
): Promise<boolean> {
  const conditions = [
    eq(organizations.parentLabOrganizationId, parentLabOrganizationId),
  ];
  if (excludeOrgId) {
    conditions.push(ne(organizations.id, excludeOrgId));
  }
  const existingOrgs = await (client as typeof db).query.organizations.findMany({
    where: and(...conditions),
    columns: { id: true, accountNumber: true },
  });
  const usedSegments = new Set<string>();
  for (const org of existingOrgs) {
    for (const seg of parseAccountNumbers(org.accountNumber)) {
      usedSegments.add(seg);
    }
  }
  return !usedSegments.has(accountNumber);
}

// Generate a unique-within-the-lab account number from the practice info,
// prepending the lab's acronym and appending an integer tiebreaker until a
// free slot is found. Format: <ACRONYM>-<address-numerics>-<initials>-<n>
// (e.g. "LAB-EXAMPLE-2603-BC-1"). When the lab name cannot be resolved or produces
// an empty acronym, the legacy format (<address-numerics>-<initials>-<n>) is
// used so callers always get a valid account number.
//
// Pass `client` (a Drizzle transaction) to make the availability check part of
// an atomic check+write protected by an advisory lock.
export async function generateProviderAccountNumber(
  parentLabOrganizationId: string,
  input: AccountNumberInput,
  client: DbOrTx = db,
  reservedAccountNumbers?: Set<string>,
): Promise<string> {
  // Look up the parent lab to derive its acronym. Uses the top-level db
  // (read-only, no need to run inside the caller's transaction).
  const labOrg = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, parentLabOrganizationId),
      eq(organizations.type, "lab")
    ),
    columns: { name: true, displayName: true },
  });
  const labName = (labOrg as any)?.displayName || (labOrg as any)?.name || "";
  const acronym = deriveLabAcronym(labName);

  const base = buildAccountNumberBase(input);
  for (let i = 1; i <= 9999; i++) {
    const rawCandidate = `${base}-${i}`;
    const candidate = acronym ? `${acronym}-${rawCandidate}` : rawCandidate;
    if (
      !reservedAccountNumbers?.has(candidate) &&
      await isAccountNumberAvailable(parentLabOrganizationId, candidate, null, client)
    ) {
      return candidate;
    }
  }
  throw new HttpError(
    500,
    "Could not allocate an account number; please supply one manually."
  );
}

/** Allocate a canonical number for a standalone provider.  Lab-linked
 * practices deliberately continue to use the lab-scoped generator above. */
export async function generateStandaloneProviderAccountNumber(
  input: AccountNumberInput,
  client: DbOrTx = db,
  reservedAccountNumbers?: Set<string>,
): Promise<string> {
  const rows = await (client as typeof db).query.organizations.findMany({
    where: and(eq(organizations.type, "provider")),
    columns: { accountNumber: true },
  });
  const used = new Set(rows.flatMap((r) => parseAccountNumbers(r.accountNumber)));
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${standaloneAccountNumberBase(input)}-${i}`;
    if (!used.has(candidate) && !reservedAccountNumbers?.has(candidate)) return candidate;
  }
  throw new HttpError(500, "Could not allocate an account number; please supply one manually.");
}

// Fallback generator used when the primary generator's candidate collided
// with a soft-deleted row. This variant includes ALL rows — including
// soft-deleted — so it skips both active and deleted orgs' account number
// segments, guaranteeing the candidate is truly free in the database.
export async function generateProviderAccountNumberFallback(
  parentLabOrganizationId: string,
  input: AccountNumberInput,
  client: DbOrTx = db
): Promise<string> {
  const base = buildAccountNumberBase(input);
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${base}-${i}`;
    if (
      await isAccountNumberAvailableAllRows(
        parentLabOrganizationId,
        candidate,
        null,
        client
      )
    ) {
      return candidate;
    }
  }
  throw new HttpError(
    500,
    "Could not allocate an account number; please supply one manually."
  );
}

/**
 * Run `fn` inside a PostgreSQL transaction that first acquires a
 * transaction-level advisory lock scoped to `labOrgId`. The lock is
 * automatically released when the transaction commits or rolls back,
 * ensuring that concurrent account-number checks + writes for the same lab
 * are serialized rather than racing.
 *
 * Lock key: namespace=1 (our fixed app namespace), key2=hashtext(labOrgId).
 * Uses the two-integer form of pg_advisory_xact_lock so it occupies a
 * distinct keyspace from single-bigint advisory locks.
 *
 * When `labOrgId` is null (e.g. lab orgs being created), no lock is needed
 * and `fn` runs against the bare `db` client without a wrapping transaction.
 */
export async function withAccountNumberLock<T>(
  labOrgId: string | null,
  fn: (client: DbOrTx) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx: any) => {
    // A fixed key serializes standalone provider allocation (where there is
    // no parent lab); lab keys remain independently concurrent.
    await tx.execute(
      labOrgId
        ? sql`SELECT pg_advisory_xact_lock(1, hashtext(${labOrgId}))`
        : sql`SELECT pg_advisory_xact_lock(1, hashtext('standalone-provider-account-number'))`,
    );
    return fn(tx);
  });
}

// Validate a caller-supplied account number: format and lab-scoped
// uniqueness. Accepts a semicolon-separated list of segments; each segment is
// validated individually for format, and each must be unique across all active
// practices in the lab. Throws HttpError on failure; returns the trimmed raw
// value (preserving the semicolons) on success.
//
// Pass `client` (a Drizzle transaction) so the uniqueness check is part of an
// atomic check+write protected by withAccountNumberLock.
export async function assertCustomAccountNumberAvailable(
  parentLabOrganizationId: string,
  accountNumber: string,
  excludeOrgId: string | null,
  client: DbOrTx = db
): Promise<string> {
  const trimmed = accountNumber.trim();
  if (!trimmed) {
    throw new HttpError(400, "Account number cannot be empty.");
  }

  const segments = parseAccountNumbers(trimmed);
  if (segments.length === 0) {
    throw new HttpError(400, "Account number cannot be empty.");
  }

  // Reject duplicate segments within the submitted list (e.g. "A; A").
  const segmentSet = new Set(segments);
  if (segmentSet.size !== segments.length) {
    throw new HttpError(
      400,
      "Account number contains duplicate segments."
    );
  }

  // Validate each segment's format independently.
  for (const segment of segments) {
    if (segment.length > 64) {
      throw new HttpError(
        400,
        `Account number segment "${segment}" is too long.`
      );
    }
    if (!/^[A-Za-z0-9._\- ]+$/.test(segment)) {
      throw new HttpError(
        400,
        "Account number can only contain letters, numbers, spaces, dots, dashes, and underscores."
      );
    }
  }

  // Fetch all active practices under this lab (excluding the org being edited)
  // and collect the full set of segments already in use.
  const conditions = [
    eq(organizations.parentLabOrganizationId, parentLabOrganizationId),
    notDeleted(organizations),
  ];
  if (excludeOrgId) {
    conditions.push(ne(organizations.id, excludeOrgId));
  }
  const existingOrgs = await (client as typeof db).query.organizations.findMany({
    where: and(...conditions),
    columns: { id: true, accountNumber: true },
  });

  const usedSegments = new Set<string>();
  for (const org of existingOrgs) {
    for (const seg of parseAccountNumbers(org.accountNumber)) {
      usedSegments.add(seg);
    }
  }

  // Check each incoming segment against the in-use set.
  for (const segment of segments) {
    if (usedSegments.has(segment)) {
      throw new HttpError(
        409,
        `Account number '${segment}' already belongs to another customer. Semicolon-separated values are aliases for the same practice; use Provider Portal Access on the customer profile to grant access to an existing account.`,
      );
    }
  }

  return trimmed;
}
