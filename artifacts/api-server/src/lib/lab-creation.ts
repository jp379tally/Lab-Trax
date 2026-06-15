import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { organizations } from "@workspace/db";
import { HttpError } from "./http";
import { notDeleted } from "./soft-delete";

/**
 * Account epic Phase 3 — fields required to stand up a lab environment.
 * These mirror the "Done looks like" contract: a lab cannot be created
 * without a name, a physical address, a license number, a phone number,
 * and a contact/billing email.
 */
export interface LabCreationFields {
  name?: string | null;
  addressLine1?: string | null;
  licenseNumber?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
}

const REQUIRED_LAB_FIELDS: {
  key: keyof LabCreationFields;
  label: string;
}[] = [
  { key: "name", label: "Lab name" },
  { key: "addressLine1", label: "Lab address" },
  { key: "licenseNumber", label: "Lab license number" },
  { key: "phone", label: "Lab phone number" },
  { key: "billingEmail", label: "Lab email address" },
];

/**
 * Validate that every field required to create a lab environment is present
 * and non-blank. Throws a 400 with a clear, user-facing message naming the
 * first missing field.
 */
export function assertLabCreationFields(input: LabCreationFields): void {
  const missing = REQUIRED_LAB_FIELDS.filter(
    ({ key }) => !String(input[key] ?? "").trim()
  );
  if (missing.length > 0) {
    const labels = missing.map((m) => m.label);
    throw new HttpError(
      400,
      `Missing required lab ${
        labels.length === 1 ? "field" : "fields"
      }: ${labels.join(", ")}.`,
      { code: "LAB_FIELDS_REQUIRED", fields: missing.map((m) => m.key) }
    );
  }
}

/**
 * Enforce that lab names are unique (case-insensitive) across all non-deleted
 * lab organizations. Throws 409 on collision. Pass `excludeId` to allow a lab
 * to keep its own name on update.
 */
export async function assertLabNameAvailable(
  name: string,
  opts: { excludeId?: string } = {}
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const conditions = [
    eq(organizations.type, "lab"),
    notDeleted(organizations),
    sql`lower(${organizations.name}) = lower(${trimmed})`,
  ];
  if (opts.excludeId) {
    conditions.push(ne(organizations.id, opts.excludeId));
  }
  const existing = await db.query.organizations.findFirst({
    where: and(...conditions),
  });
  if (existing) {
    throw new HttpError(
      409,
      `A lab named "${trimmed}" already exists. Please choose a different name.`,
      { code: "LAB_NAME_TAKEN" }
    );
  }
}
