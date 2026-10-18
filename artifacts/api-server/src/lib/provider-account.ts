/**
 * Provider-account creation gate + shared "does this doctor already have an
 * account?" resolver (Task #4372).
 *
 * An account number may only be issued when a provider signs up on the
 * provider portal, someone signs up on the lab side, or a lab deliberately
 * creates an account for a provider. Every other path that used to mint a
 * provider user — adding a doctor without an email, adopting a case-history
 * doctor whose name is spelled slightly differently, removing a name-only
 * doctor — must reuse the account the doctor already has instead of allocating
 * a second one.
 *
 * Two pieces live here:
 *
 *   1. `resolveExistingProviderAccount` — the single matcher every lab-side
 *      path uses. It reuses the shared `doctor-similarity` normalization and
 *      the lab's configured threshold, so the pre-create duplicate gate, the
 *      duplicate-clusters panel, and this resolver never disagree.
 *
 *   2. `insertProviderAccountRow` — the one place a provider user row is
 *      inserted. It refuses any trigger outside the sanctioned set and stamps
 *      the trigger, actor, and practice onto the new row so an unexpected
 *      account can be traced back to its origin.
 *
 * `createProviderAccountThroughGate` combines the two for the lab-side flows:
 * resolve first, return the existing account when one matches, and only run
 * the account-number allocator when a genuinely new account is approved.
 */

import crypto from "node:crypto";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  organizations,
  users,
} from "@workspace/db";
import {
  doctorNameSimilarity,
  normalizeDoctorForCompare,
  resolveLabDupThreshold,
} from "./doctor-similarity";
import {
  allocatePlatformAccountNumber,
  normalizePhone10,
} from "./platform-account-number";
import { hashPassword } from "./crypto";
import { splitDisplayName } from "./patient-similarity";
import { notDeleted } from "./soft-delete";
import { HttpError } from "./http";

// Drizzle transaction or the root db handle. The routes already pass `tx: any`
// around; keep the same shape rather than inventing a second convention.
type DbRunner = any;

/**
 * The only triggers allowed to create a provider account (and therefore an
 * account number).
 */
export const SANCTIONED_PROVIDER_ACCOUNT_TRIGGERS = [
  // A provider signed themselves up on the provider portal.
  "provider_portal_signup",
  // Someone signed up on the lab side.
  "lab_side_signup",
  // A lab admin deliberately created an account for a provider.
  "lab_created_account",
] as const;

export type ProviderAccountTrigger =
  (typeof SANCTIONED_PROVIDER_ACCOUNT_TRIGGERS)[number];

export interface ProviderAccountProvenance {
  trigger: ProviderAccountTrigger;
  actorUserId: string | null;
  // Practice the account was created for, when there is one.
  organizationId: string | null;
}

export interface DoctorIdentityInput {
  firstName?: string | null;
  lastName?: string | null;
  doctorName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ProviderAccountRow {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  doctorName: string | null;
  email: string | null;
  phone: string | null;
  platformAccountNumber: string | null;
}

export type ProviderAccountMatchReason = "email" | "phone" | "name";

export interface ResolvedProviderAccount {
  user: ProviderAccountRow;
  matchedOn: ProviderAccountMatchReason;
  similarity: number;
}

/**
 * A phone number is a weaker identity signal than an email: a practice's main
 * number is routinely shared by every doctor who works there. A phone match
 * therefore only counts when the names are at least loosely compatible, so two
 * genuinely different doctors reachable on the same line can still both be
 * added.
 */
const PHONE_MATCH_NAME_FLOOR = 0.35;

function identityName(identity: DoctorIdentityInput): string {
  const explicit = (identity.doctorName ?? "").trim();
  if (explicit) return explicit;
  return `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim();
}

function candidateNames(row: {
  firstName: string | null;
  lastName: string | null;
  doctorName: string | null;
}): string[] {
  const out: string[] = [];
  const dn = (row.doctorName ?? "").trim();
  if (dn) out.push(dn);
  const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  if (full) out.push(full);
  return out;
}

function bestNameSimilarity(incoming: string, row: ProviderAccountRow): number {
  let best = 0;
  for (const name of candidateNames(row)) {
    const sim = doctorNameSimilarity(incoming, name);
    if (sim > best) best = sim;
  }
  return best;
}

const PROVIDER_ACCOUNT_COLUMNS = {
  id: users.id,
  username: users.username,
  firstName: users.firstName,
  lastName: users.lastName,
  doctorName: users.doctorName,
  email: users.email,
  phone: users.phone,
  platformAccountNumber: users.platformAccountNumber,
} as const;

/**
 * Provider accounts AFFILIATED WITH THIS LAB: a live membership in the lab or
 * in one of its practices, or an entry in the lab's Unassigned holding area.
 *
 * This is the predicate for any surface that LISTS provider accounts to a lab
 * — pickers, directories, customer views. Nothing else belongs in such a
 * list: the database is shared by every tenant, so an unscoped list shows a
 * lab other tenants' doctors, and since the 2026-10-06 merge it also shows
 * thousands of imported automated-test accounts (Task #4849).
 *
 * Note what this deliberately does NOT include: accounts with no lab
 * affiliation at all. Those are in scope for duplicate DETECTION (see
 * labMatchableProviderAccountCondition) but must never be offered in a list,
 * because "belongs to nobody" is not "belongs to this lab" — and the bulk of
 * the imported fixtures are exactly that.
 */
export function labAffiliatedProviderAccountCondition(
  labOrganizationId: string
) {
  const activeMembership = sql`
    EXISTS (
      SELECT 1
      FROM lab_memberships AS membership
      INNER JOIN organizations AS membership_org
        ON membership_org.id = membership.lab_id
      WHERE membership.user_id = ${users.id}
        AND membership.deleted_at IS NULL
        AND (
          membership_org.id = ${labOrganizationId}
          OR membership_org.parent_lab_organization_id = ${labOrganizationId}
        )
    )
  `;
  const activeUnassigned = sql`
    EXISTS (
      SELECT 1
      FROM lab_unassigned_doctors AS unassigned
      WHERE unassigned.user_id = ${users.id}
        AND unassigned.lab_organization_id = ${labOrganizationId}
        AND unassigned.deleted_at IS NULL
    )
  `;

  return sql`(${activeMembership} OR ${activeUnassigned})`;
}

/**
 * Duplicate-MATCHING scope: lab-affiliated accounts (above) plus accounts
 * with no lab affiliation anywhere, which is exactly what the old
 * duplicate-minting paths produced. Letting PostgreSQL discard everything
 * else keeps the similarity pass off unrelated tenants' rows.
 *
 * Matching may be wider than listing because its output is a warning about
 * one typed identity, not a browsable roster.
 */
export function labMatchableProviderAccountCondition(
  labOrganizationId: string
) {
  const anyMembership = sql`
    EXISTS (
      SELECT 1
      FROM lab_memberships AS membership
      INNER JOIN organizations AS membership_org
        ON membership_org.id = membership.lab_id
      WHERE membership.user_id = ${users.id}
        AND membership.deleted_at IS NULL
        AND (
          membership_org.id IS NOT NULL
          AND (
            membership_org.type = 'lab'
            OR membership_org.parent_lab_organization_id IS NOT NULL
          )
        )
    )
  `;
  const anyUnassigned = sql`
    EXISTS (
      SELECT 1
      FROM lab_unassigned_doctors AS unassigned
      WHERE unassigned.user_id = ${users.id}
        AND unassigned.deleted_at IS NULL
    )
  `;

  return sql`(
    ${labAffiliatedProviderAccountCondition(labOrganizationId)}
    OR NOT (${anyMembership} OR ${anyUnassigned})
  )`;
}

function normalizedPhoneSql() {
  const digits = sql`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g')`;
  return sql`CASE
    WHEN length(${digits}) = 11 AND left(${digits}, 1) = '1'
      THEN right(${digits}, 10)
    ELSE ${digits}
  END`;
}

async function labThreshold(
  runner: DbRunner,
  labOrganizationId: string
): Promise<number> {
  const [lab] = await runner
    .select({ threshold: organizations.duplicateSuggestionThreshold })
    .from(organizations)
    .where(eq(organizations.id, labOrganizationId))
    .limit(1);
  return resolveLabDupThreshold(lab?.threshold ?? null);
}

/**
 * Does this doctor already have a provider account?
 *
 * Matches an incoming doctor against existing non-deleted provider accounts by
 * normalized name (so a "Dr." prefix, a middle initial, and punctuation
 * variants all match) using the lab's configured similarity threshold, and by
 * exact email or phone.
 *
 * Scope: accounts affiliated with this lab (through a membership under it or
 * its Unassigned holding area) plus accounts with no lab affiliation at all —
 * which is exactly what the duplicate-minting paths produced. Accounts that
 * belong only to a different lab are never returned; linking a doctor's
 * accounts across labs is a separate concern.
 */
export async function resolveExistingProviderAccount(
  runner: DbRunner,
  identity: DoctorIdentityInput,
  options: { labOrganizationId: string; excludeUserIds?: string[] }
): Promise<ResolvedProviderAccount | null> {
  const incomingName = identityName(identity);
  const normalizedIncoming = normalizeDoctorForCompare(incomingName);
  const email = (identity.email ?? "").trim().toLowerCase() || null;
  const phone = normalizePhone10(identity.phone ?? null);
  if (!normalizedIncoming && !email && !phone) return null;

  const exclude = new Set(options.excludeUserIds ?? []);
  const scopeConditions = [
    eq(users.userType, "provider"),
    notDeleted(users),
    labMatchableProviderAccountCondition(options.labOrganizationId),
    exclude.size > 0 ? notInArray(users.id, [...exclude]) : undefined,
  ];

  const findContactMatch = (candidates: ProviderAccountRow[]) => {
    if (email) {
      const byEmail = candidates.find(
        (r) => (r.email ?? "").trim().toLowerCase() === email
      );
      if (byEmail) {
        return { user: byEmail, matchedOn: "email" as const, similarity: 1 };
      }
    }

    if (phone) {
      const byPhone = candidates.find((r) => {
        if (normalizePhone10(r.phone) !== phone) return false;
        if (!normalizedIncoming) return true;
        const candidateHasName = candidateNames(r).length > 0;
        if (!candidateHasName) return true;
        return bestNameSimilarity(incomingName, r) >= PHONE_MATCH_NAME_FLOOR;
      });
      if (byPhone) {
        return { user: byPhone, matchedOn: "phone" as const, similarity: 1 };
      }
    }
    return null;
  };

  const exactContactCondition = or(
    email
      ? sql`lower(trim(${users.email})) = ${email}`
      : undefined,
    phone ? sql`${normalizedPhoneSql()} = ${phone}` : undefined,
  );
  if (exactContactCondition) {
    const exactRows: ProviderAccountRow[] = await runner
      .select(PROVIDER_ACCOUNT_COLUMNS)
      .from(users)
      .where(and(...scopeConditions, exactContactCondition));
    const exactMatch = findContactMatch(exactRows);
    if (exactMatch) return exactMatch;
  }

  const rows: ProviderAccountRow[] = await runner
    .select(PROVIDER_ACCOUNT_COLUMNS)
    .from(users)
    .where(and(...scopeConditions));

  const pool = rows.filter((r) => !exclude.has(r.id));
  if (pool.length === 0) return null;

  const candidates = pool;

  if (!normalizedIncoming) return null;

  // 3. Normalized name — exact first, then the lab's similarity threshold.
  const exact = candidates.find((r) =>
    candidateNames(r).some(
      (n) => normalizeDoctorForCompare(n) === normalizedIncoming
    )
  );
  if (exact) return { user: exact, matchedOn: "name", similarity: 1 };

  const threshold = await labThreshold(runner, options.labOrganizationId);
  let best: ResolvedProviderAccount | null = null;
  for (const r of candidates) {
    const sim = bestNameSimilarity(incomingName, r);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { user: r, matchedOn: "name", similarity: sim };
    }
  }
  return best;
}

/** Any non-deleted account (of any type) already using this email address. */
export async function findUserByEmail(
  runner: DbRunner,
  email: string
): Promise<{ id: string } | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const [row] = await runner
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        notDeleted(users),
        sql`lower(trim(${users.email})) = ${wanted}`,
      )
    )
    .limit(1);
  return row ?? null;
}

function slugifyForUsername(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "doctor"
  );
}

export async function generateUniqueDoctorUsername(
  firstName: string,
  lastName: string
): Promise<string> {
  const base = slugifyForUsername(`${firstName}-${lastName}`);
  for (let i = 0; i < 8; i++) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `${base}-${suffix}`;
    const existing = await db.query.users.findFirst({
      where: eq(users.username, candidate),
    });
    if (!existing) return candidate;
  }
  throw new HttpError(500, "Could not allocate a unique username for doctor.");
}

function assertSanctionedTrigger(trigger: ProviderAccountTrigger): void {
  if (
    !(SANCTIONED_PROVIDER_ACCOUNT_TRIGGERS as readonly string[]).includes(
      trigger
    )
  ) {
    throw new HttpError(
      500,
      `Provider accounts may only be created by a sanctioned trigger (got "${trigger}").`
    );
  }
}

/**
 * The single insert point for a user account. Refuses an unsanctioned trigger
 * and stamps the creation provenance onto the row.
 */
export async function insertProviderAccountRow<T = any>(
  runner: DbRunner,
  values: Record<string, unknown>,
  provenance: ProviderAccountProvenance
): Promise<T> {
  assertSanctionedTrigger(provenance.trigger);
  const [row] = await runner
    .insert(users)
    .values({
      ...values,
      accountCreationTrigger: provenance.trigger,
      accountCreatedByUserId: provenance.actorUserId ?? null,
      accountCreatedForOrganizationId: provenance.organizationId ?? null,
    })
    .returning();
  return row as T;
}

export type ProviderAccountGateResult =
  | {
      outcome: "reused";
      user: ProviderAccountRow;
      matchedOn: ProviderAccountMatchReason;
      similarity: number;
    }
  | { outcome: "created"; user: ProviderAccountRow };

/**
 * Lab-side provider-account creation. Resolves first and returns the doctor's
 * existing account when one matches; only allocates an account number and
 * inserts a row when the gate approves a genuinely new account.
 */
export async function createProviderAccountThroughGate(input: {
  runner: DbRunner;
  trigger: Extract<ProviderAccountTrigger, "lab_created_account">;
  actorUserId: string;
  labOrganizationId: string;
  organizationId: string | null;
  identity: DoctorIdentityInput;
  practice: { name: string; displayName: string | null };
  /**
   * Accounts a lab admin has explicitly declared to be a *different* person
   * after being shown the match (Task #4398). Two real doctors can share a
   * name, and only a human can tell them apart — so the admin's decision
   * removes those specific accounts from the candidate pool.
   *
   * This is deliberately a narrow, per-account opt-out rather than a "skip
   * the resolver" flag: the resolver still runs over everyone else, so a
   * dismissed match cannot open the door to reusing nothing at all. An email
   * that already belongs to some account is still refused below, because a
   * shared inbox is the one signal a human cannot override.
   */
  excludeUserIds?: string[];
  onAllocationError?: (err: unknown) => void;
}): Promise<ProviderAccountGateResult> {
  const {
    runner,
    trigger,
    actorUserId,
    labOrganizationId,
    organizationId,
    identity,
    practice,
    excludeUserIds,
  } = input;
  assertSanctionedTrigger(trigger);

  // Who, if anyone, already owns the incoming email — checked platform-wide
  // and BEFORE the resolver's answer is accepted. The email owner may sit
  // outside the resolver's candidate pool entirely (a lab user, a provider
  // under another lab) or may have been excluded as "a different person", and
  // in either case a lower-priority name/phone candidate must not be attached
  // in their place: that would silently bind the typed address to the wrong
  // person. A shared mailbox is the one signal a human may not override.
  const emailIn = (identity.email ?? "").trim().toLowerCase();
  const emailOwner = emailIn ? await findUserByEmail(runner, emailIn) : null;

  const existing = await resolveExistingProviderAccount(runner, identity, {
    labOrganizationId,
    excludeUserIds,
  });

  if (emailOwner && emailOwner.id !== existing?.user.id) {
    throw new HttpError(409, "An account with this email already exists.");
  }

  if (existing) {
    return {
      outcome: "reused",
      user: existing.user,
      matchedOn: existing.matchedOn,
      similarity: existing.similarity,
    };
  }

  const display = identityName(identity);
  const split = splitDisplayName(display);
  const firstName = (identity.firstName ?? "").trim() || split.first;
  const lastName = (identity.lastName ?? "").trim() || split.last;
  const email = (identity.email ?? "").trim().toLowerCase() || null;
  const phone = (identity.phone ?? "").trim() || null;

  const username = await generateUniqueDoctorUsername(
    firstName || display,
    lastName
  );
  const hashed = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
  const initials =
    ((firstName.trim()[0] ?? "") + (lastName.trim()[0] ?? "")).toUpperCase() ||
    "DR";

  // The resolver has approved creation, so allocate on the supplied runner
  // before inserting the user. This keeps the number and row atomic and makes
  // allocation failures explicit instead of creating an unnumbered account.
  const platformAccountNumber = await allocatePlatformAccountNumber({
    tx: runner,
  });

  const user = await insertProviderAccountRow<ProviderAccountRow>(
    runner,
    {
      username,
      password: hashed,
      email,
      phone,
      firstName: firstName || null,
      lastName: lastName || null,
      initials,
      userType: "provider",
      doctorName: display || null,
      role: "user",
      platformAccountNumber,
    },
    { trigger, actorUserId, organizationId }
  );

  return { outcome: "created", user };
}
