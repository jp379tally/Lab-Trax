import { and, eq, ne } from "drizzle-orm";
import { db } from "@workspace/db";
import { organizations } from "@workspace/db";
import { HttpError } from "./http";

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
function deriveDoctorInitials(doctorName: string | null | undefined): string {
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

// Returns true if no other org under `parentLabOrganizationId` already uses
// `accountNumber`. Excludes `excludeOrgId` from the check so PATCH callers can
// re-save without colliding with themselves.
async function isAccountNumberAvailable(
  parentLabOrganizationId: string,
  accountNumber: string,
  excludeOrgId: string | null
): Promise<boolean> {
  const conditions = [
    eq(organizations.parentLabOrganizationId, parentLabOrganizationId),
    eq(organizations.accountNumber, accountNumber),
  ];
  if (excludeOrgId) {
    conditions.push(ne(organizations.id, excludeOrgId));
  }
  const existing = await db.query.organizations.findFirst({
    where: and(...conditions),
  });
  return !existing;
}

// Generate a unique-within-the-lab account number from the practice info,
// appending an integer tiebreaker until we find a free slot.
export async function generateProviderAccountNumber(
  parentLabOrganizationId: string,
  input: AccountNumberInput
): Promise<string> {
  const base = buildAccountNumberBase(input);
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${base}-${i}`;
    if (
      await isAccountNumberAvailable(parentLabOrganizationId, candidate, null)
    ) {
      return candidate;
    }
  }
  throw new HttpError(
    500,
    "Could not allocate an account number; please supply one manually."
  );
}

// Validate a caller-supplied account number: format and lab-scoped
// uniqueness. Throws HttpError on failure; returns the trimmed value on
// success.
export async function assertCustomAccountNumberAvailable(
  parentLabOrganizationId: string,
  accountNumber: string,
  excludeOrgId: string | null
): Promise<string> {
  const trimmed = accountNumber.trim();
  if (!trimmed) {
    throw new HttpError(400, "Account number cannot be empty.");
  }
  if (trimmed.length > 64) {
    throw new HttpError(400, "Account number is too long.");
  }
  if (!/^[A-Za-z0-9._\- ]+$/.test(trimmed)) {
    throw new HttpError(
      400,
      "Account number can only contain letters, numbers, spaces, dots, dashes, and underscores."
    );
  }
  const available = await isAccountNumberAvailable(
    parentLabOrganizationId,
    trimmed,
    excludeOrgId
  );
  if (!available) {
    throw new HttpError(409, "That account number is already in use.");
  }
  return trimmed;
}
