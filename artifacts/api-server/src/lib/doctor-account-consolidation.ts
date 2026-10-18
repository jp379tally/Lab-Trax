/**
 * Provider-account consolidation (Task #4373).
 *
 * Practices accumulated several provider *user accounts* for the same person —
 * four "Synthetic Provider Alpha" rows, two "Synthetic Provider Beta" rows — each with its own
 * platform account number. The doctor-name merge tooling in `routes/doctors.ts`
 * deliberately rewrites only case/pricing **names**, so merging never collapsed
 * those accounts, and the duplicate-suspects panel could not see them at all
 * because it clusters names found on *cases* and these accounts have none.
 *
 * This module owns the account-level half of that problem:
 *
 *   1. detection  — cluster provider accounts inside one lab *and* practice
 *                   with the shared doctor-similarity matcher + the lab's
 *                   configured threshold, including caseless accounts;
 *   2. triage     — unambiguous (one email, one phone at most) vs conflicting
 *                   (two different emails or phones) clusters;
 *   3. survivor   — the oldest account number wins (earliest allocation,
 *                   falling back to earliest creation);
 *   4. moves      — every reference is repointed at the survivor in one
 *                   transaction, collapsing rows that would collide with the
 *                   survivor's own unique keys;
 *   5. retirement — the extras are deactivated + soft-deleted while KEEPING
 *                   their account numbers so those numbers stay reserved;
 *   6. audit/undo — one audit row per consolidation carrying the complete move
 *                   log, reversible within the doctor-merge undo window.
 *
 * Conflicting clusters are never consolidated automatically — they are surfaced
 * to admins through the existing duplicate-suspects panel instead.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  users,
  organizations,
  organizationMemberships,
  labUnassignedDoctors,
  doctorAccountLinks,
  accountLinkInvites,
  doctorProfiles,
  doctorPhoneEntries,
  doctorEmailEntries,
  pricingOverrides,
  rxDoctorPracticeMemory,
  cases,
  invoices,
  auditLogs,
} from "@workspace/db";
import {
  bigramJaccard,
  doctorNameBigrams,
  normalizeDoctorForCompare,
  resolveLabDupThreshold,
} from "./doctor-similarity.js";
import {
  migrateDoctorPracticeMemory,
  type DoctorPracticeMemoryChange,
} from "./doctor-practice-memory.js";
import { notDeleted } from "./soft-delete.js";
import { logger } from "./logger";

export const CONSOLIDATION_AUDIT_ACTION = "provider_accounts_consolidated";
export const CONSOLIDATION_UNDO_AUDIT_ACTION =
  "provider_accounts_consolidation_undone";
export const CONSOLIDATION_AUDIT_ENTITY = "provider_account_consolidation";

// ---------------------------------------------------------------------------
// Account-number seniority
// ---------------------------------------------------------------------------

/**
 * Legacy platform account numbers are `<seq><YY><F><L>` (e.g. "1526BK" =
 * sequence 15, year 2026, initials BK) and Phase-2 numbers are
 * `<L|P>-<YEAR>-<SEQUENCE>[-<PHONE>]` (e.g. "P-2026-3-5551234567").
 * Both encode when the number was allocated, which is what "oldest account
 * number" means. Anything we cannot parse has no allocation order and sorts
 * after every parseable number — which is also the right answer for the
 * current twelve-digit Luhn-checked numbers: their sequence is deliberately
 * permuted (no allocation order is readable from the digits), and every one of
 * them was issued after the last legacy number, so they lose to a legacy
 * number and fall back to creation time among themselves.
 */
export function parseAccountNumberSeniority(
  raw: string | null | undefined
): { year: number; seq: number } | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const v2 = value.match(/^[LP]-(\d{4})-(\d+)(?:-\d{10})?$/i);
  if (v2) return { year: Number(v2[1]), seq: Number(v2[2]) };

  // Greedy `\d+` backtracks so the final two digits are always the year.
  const legacy = value.match(/^(\d+)(\d{2})([A-Za-z]+)$/);
  if (legacy) return { year: 2000 + Number(legacy[2]), seq: Number(legacy[1]) };

  return null;
}

export interface ProviderAccountNode {
  userId: string;
  labOrganizationId: string;
  /** Practice this account is bucketed under; null = unassigned holding area. */
  providerOrganizationId: string | null;
  displayName: string;
  platformAccountNumber: string | null;
  email: string | null;
  phone: string | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  doctorName: string | null;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Order provider accounts oldest-account-number first. Numbers we can parse
 * always beat numbers we cannot (and any account with no number at all);
 * creation time then id break every remaining tie so the survivor choice is
 * fully deterministic across dry-run and apply.
 */
export function compareAccountSeniority(
  a: ProviderAccountNode,
  b: ProviderAccountNode
): number {
  const sa = parseAccountNumberSeniority(a.platformAccountNumber);
  const sb = parseAccountNumberSeniority(b.platformAccountNumber);
  if (sa && sb) {
    if (sa.year !== sb.year) return sa.year - sb.year;
    if (sa.seq !== sb.seq) return sa.seq - sb.seq;
  } else if (sa) {
    return -1;
  } else if (sb) {
    return 1;
  }
  const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
  const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
  if (ta !== tb) return ta - tb;
  return a.userId.localeCompare(b.userId);
}

// ---------------------------------------------------------------------------
// Identity-signal conflicts
// ---------------------------------------------------------------------------

function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  // US numbers show up both with and without the country code.
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
}

export type ClusterClassification = "unambiguous" | "conflicting";

export interface ClusterTriage {
  classification: ClusterClassification;
  /** Human-readable reason shown in the duplicate-suspects panel. */
  conflictReason: string | null;
}

/**
 * A cluster is only safe to consolidate without an admin when its members do
 * not disagree about who the person is. Two different emails (or two different
 * phones) means the matcher may have folded two real people together, so the
 * cluster is routed to the suspects panel instead.
 */
export function triageAccountCluster(
  members: ProviderAccountNode[]
): ClusterTriage {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const m of members) {
    const e = normalizeEmail(m.email);
    if (e) emails.add(e);
    const p = normalizePhone(m.phone);
    if (p) phones.add(p);
  }
  const reasons: string[] = [];
  if (emails.size > 1) reasons.push(`${emails.size} different email addresses`);
  if (phones.size > 1) reasons.push(`${phones.size} different phone numbers`);
  if (reasons.length === 0) {
    return { classification: "unambiguous", conflictReason: null };
  }
  return {
    classification: "conflicting",
    conflictReason: `These accounts carry ${reasons.join(" and ")} — confirm they are the same person before consolidating.`,
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface ProviderAccountCluster {
  labOrganizationId: string;
  providerOrganizationId: string | null;
  /** Survivor first, then the accounts that would be retired. */
  members: ProviderAccountNode[];
  survivor: ProviderAccountNode;
  retired: ProviderAccountNode[];
  topScore: number;
  classification: ClusterClassification;
  conflictReason: string | null;
}

function displayNameOf(u: {
  doctorName: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}): string {
  const explicit = (u.doctorName ?? "").trim();
  if (explicit) return explicit;
  const composed = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  if (composed) return composed;
  return (u.username ?? "").trim();
}

/**
 * Load every live provider account that belongs to one of `labIds`, bucketed
 * by the practice it primarily sits in.
 *
 * An account reaches a lab either through an active membership at one of the
 * lab's practices, or through the lab's unassigned-doctor holding area. When it
 * has several memberships under the same lab, the earliest one decides the
 * bucket so an account is considered exactly once per lab.
 */
export async function loadProviderAccountNodes(
  executor: any,
  labIds: string[]
): Promise<ProviderAccountNode[]> {
  if (labIds.length === 0) return [];

  const membershipRows = await executor
    .select({
      userId: users.id,
      username: users.username,
      doctorName: users.doctorName,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
      emailVerifiedAt: users.emailVerifiedAt,
      phoneVerifiedAt: users.phoneVerifiedAt,
      platformAccountNumber: users.platformAccountNumber,
      isActive: users.isActive,
      createdAt: users.createdAt,
      labOrganizationId: organizations.parentLabOrganizationId,
      providerOrganizationId: organizationMemberships.labId,
      joinedAt: organizationMemberships.joinedAt,
      membershipCreatedAt: organizationMemberships.createdAt,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMemberships.labId)
    )
    .where(
      and(
        eq(organizationMemberships.status, "active"),
        notDeleted(organizationMemberships),
        eq(organizations.type, "provider"),
        notDeleted(organizations),
        inArray(organizations.parentLabOrganizationId, labIds),
        eq(users.userType, "provider"),
        eq(users.isActive, true),
        notDeleted(users)
      )
    );

  const unassignedRows = await executor
    .select({
      userId: users.id,
      username: users.username,
      doctorName: users.doctorName,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
      emailVerifiedAt: users.emailVerifiedAt,
      phoneVerifiedAt: users.phoneVerifiedAt,
      platformAccountNumber: users.platformAccountNumber,
      isActive: users.isActive,
      createdAt: users.createdAt,
      labOrganizationId: labUnassignedDoctors.labOrganizationId,
    })
    .from(labUnassignedDoctors)
    .innerJoin(users, eq(users.id, labUnassignedDoctors.userId))
    .where(
      and(
        inArray(labUnassignedDoctors.labOrganizationId, labIds),
        isNull(labUnassignedDoctors.deletedAt),
        eq(users.userType, "provider"),
        eq(users.isActive, true),
        notDeleted(users)
      )
    );

  // One bucket per (user, lab): the earliest active membership wins, and the
  // unassigned holding area is only used when there is no membership at all.
  const byUserLab = new Map<
    string,
    { node: ProviderAccountNode; rank: number }
  >();

  const put = (
    row: any,
    providerOrganizationId: string | null,
    rank: number
  ) => {
    const labOrganizationId: string | null = row.labOrganizationId ?? null;
    if (!labOrganizationId) return;
    const key = `${row.userId}::${labOrganizationId}`;
    const existing = byUserLab.get(key);
    if (existing && existing.rank <= rank) return;
    byUserLab.set(key, {
      rank,
      node: {
        userId: row.userId,
        labOrganizationId,
        providerOrganizationId,
        displayName: displayNameOf(row),
        platformAccountNumber: row.platformAccountNumber ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        emailVerifiedAt: row.emailVerifiedAt ?? null,
        phoneVerifiedAt: row.phoneVerifiedAt ?? null,
        doctorName: row.doctorName ?? null,
        firstName: row.firstName ?? null,
        lastName: row.lastName ?? null,
        isActive: row.isActive !== false,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt ?? 0),
      },
    });
  };

  // Rank memberships by join time so "primary practice" is stable.
  const membershipSorted = [...membershipRows].sort((a: any, b: any) => {
    const ta = new Date(a.joinedAt ?? a.membershipCreatedAt ?? 0).getTime();
    const tb = new Date(b.joinedAt ?? b.membershipCreatedAt ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.providerOrganizationId).localeCompare(
      String(b.providerOrganizationId)
    );
  });
  membershipSorted.forEach((row: any, index: number) => {
    put(row, row.providerOrganizationId ?? null, index);
  });
  for (const row of unassignedRows as any[]) {
    put(row, null, Number.MAX_SAFE_INTEGER);
  }

  return Array.from(byUserLab.values()).map((v) => v.node);
}

/**
 * Union-find clustering over accounts inside one lab+practice bucket, using the
 * same normalization / bigram scoring as the duplicate-clusters panel and the
 * merge tooling. Identical names always score 1 and therefore always cluster,
 * which is what makes a four-way same-name duplicate detectable.
 */
export function buildProviderAccountClusters(
  nodes: ProviderAccountNode[],
  thresholdForLab: (labId: string) => number
): ProviderAccountCluster[] {
  const buckets = new Map<string, ProviderAccountNode[]>();
  for (const n of nodes) {
    if (!normalizeDoctorForCompare(n.displayName)) continue;
    const key = `${n.labOrganizationId}::${n.providerOrganizationId ?? ""}`;
    const arr = buckets.get(key) ?? [];
    arr.push(n);
    buckets.set(key, arr);
  }

  const out: ProviderAccountCluster[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const labId = bucket[0]!.labOrganizationId;
    const threshold = thresholdForLab(labId);

    const parent = bucket.map((_, i) => i);
    const find = (i: number): number => {
      let cur = i;
      while (parent[cur] !== cur) {
        parent[cur] = parent[parent[cur]!]!;
        cur = parent[cur]!;
      }
      return cur;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    const norm = bucket.map((n) => normalizeDoctorForCompare(n.displayName));
    const grams = norm.map((s) => doctorNameBigrams(s));
    const pairScores = new Map<string, number>();
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const s = bigramJaccard(norm[i]!, grams[i]!, norm[j]!, grams[j]!);
        if (s >= threshold) {
          union(i, j);
          pairScores.set(`${i}|${j}`, s);
        }
      }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < bucket.length; i++) {
      const root = find(i);
      const arr = groups.get(root) ?? [];
      arr.push(i);
      groups.set(root, arr);
    }

    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      let topScore = 0;
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const lo = Math.min(idxs[a]!, idxs[b]!);
          const hi = Math.max(idxs[a]!, idxs[b]!);
          const sc = pairScores.get(`${lo}|${hi}`) ?? 0;
          if (sc > topScore) topScore = sc;
        }
      }
      const members = idxs
        .map((i) => bucket[i]!)
        .sort(compareAccountSeniority);
      const triage = triageAccountCluster(members);
      out.push({
        labOrganizationId: labId,
        providerOrganizationId: members[0]!.providerOrganizationId,
        members,
        survivor: members[0]!,
        retired: members.slice(1),
        topScore,
        classification: triage.classification,
        conflictReason: triage.conflictReason,
      });
    }
  }

  out.sort(
    (a, b) =>
      b.topScore - a.topScore ||
      a.labOrganizationId.localeCompare(b.labOrganizationId) ||
      a.survivor.userId.localeCompare(b.survivor.userId)
  );
  return out;
}

/** Detect account-duplicate clusters across the given labs. */
export async function detectProviderAccountClusters(
  labIds: string[],
  executor: any = db
): Promise<ProviderAccountCluster[]> {
  if (labIds.length === 0) return [];
  const labRows = await executor
    .select({
      id: organizations.id,
      threshold: organizations.duplicateSuggestionThreshold,
    })
    .from(organizations)
    .where(inArray(organizations.id, labIds));
  const thresholds = new Map<string, number>(
    (labRows as any[]).map((l) => [l.id, resolveLabDupThreshold(l.threshold)])
  );
  const nodes = await loadProviderAccountNodes(executor, labIds);
  return buildProviderAccountClusters(nodes, (labId) =>
    resolveLabDupThreshold(thresholds.get(labId) ?? null)
  );
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

type RowSnapshot = Record<string, unknown>;

export interface ConsolidationMoveLog {
  memberships: Array<{
    id: string;
    fromUserId: string;
    action: "moved" | "collapsed";
  }>;
  unassigned: Array<{
    id: string;
    fromUserId: string;
    action: "moved" | "collapsed";
  }>;
  accountLinks: Array<{
    action: "moved" | "removed";
    id: string;
    row: RowSnapshot;
  }>;
  linkInvites: Array<{
    action: "moved" | "removed";
    id: string;
    row: RowSnapshot;
  }>;
  doctorProfiles: Array<{
    action: "renamed" | "collapsed";
    id: string;
    fromDoctorName: string;
    intoProfileId: string | null;
    row: RowSnapshot | null;
  }>;
  contactEntries: Array<{
    kind: "phone" | "email";
    action: "moved" | "removed";
    id: string;
    fromProfileId: string;
    row: RowSnapshot;
  }>;
  invoiceIdentities: Array<{
    invoiceId: string;
    fromProfileId: string;
    toProfileId: string;
  }>;
  pricingOverrides: Array<{
    action: "renamed" | "collapsed";
    id: string;
    fromDoctorName: string;
  }>;
  practiceMemory: DoctorPracticeMemoryChange[];
  caseNames: Array<{ id: string; fromDoctorName: string }>;
  survivorBefore: RowSnapshot | null;
  retired: Array<{
    userId: string;
    isActiveBefore: boolean;
    platformAccountNumber: string | null;
    displayName: string;
  }>;
}

function emptyMoveLog(): ConsolidationMoveLog {
  return {
    memberships: [],
    unassigned: [],
    accountLinks: [],
    linkInvites: [],
    doctorProfiles: [],
    contactEntries: [],
    invoiceIdentities: [],
    pricingOverrides: [],
    practiceMemory: [],
    caseNames: [],
    survivorBefore: null,
    retired: [],
  };
}

export interface ConsolidationResult {
  labOrganizationId: string;
  providerOrganizationId: string | null;
  survivorUserId: string;
  survivorAccountNumber: string | null;
  survivorName: string;
  retiredUserIds: string[];
  retiredAccountNumbers: string[];
  auditLogId: string | null;
  referencesMoved: number;
  moves: ConsolidationMoveLog;
}

function countMoves(moves: ConsolidationMoveLog): number {
  return (
    moves.memberships.length +
    moves.unassigned.length +
    moves.accountLinks.length +
    moves.linkInvites.length +
    moves.doctorProfiles.length +
    moves.contactEntries.length +
    moves.invoiceIdentities.length +
    moves.pricingOverrides.length +
    moves.practiceMemory.length +
    moves.caseNames.length
  );
}

/** Fold a retired account's contact details onto a survivor that lacks them. */
function pickContactFolding(
  survivor: ProviderAccountNode,
  retired: ProviderAccountNode[]
): {
  email?: string;
  emailVerifiedAt?: Date | null;
  phone?: string;
  phoneVerifiedAt?: Date | null;
  doctorName?: string;
  firstName?: string;
  lastName?: string;
} {
  const patch: Record<string, unknown> = {};
  // Verified contacts win, then account seniority (the list is already sorted).
  const byVerifiedEmail = [...retired].sort(
    (a, b) =>
      Number(Boolean(b.emailVerifiedAt)) - Number(Boolean(a.emailVerifiedAt))
  );
  const byVerifiedPhone = [...retired].sort(
    (a, b) =>
      Number(Boolean(b.phoneVerifiedAt)) - Number(Boolean(a.phoneVerifiedAt))
  );

  if (!normalizeEmail(survivor.email)) {
    const donor = byVerifiedEmail.find((r) => normalizeEmail(r.email));
    if (donor) {
      patch["email"] = donor.email;
      patch["emailVerifiedAt"] = donor.emailVerifiedAt ?? null;
    }
  }
  if (!normalizePhone(survivor.phone)) {
    const donor = byVerifiedPhone.find((r) => normalizePhone(r.phone));
    if (donor) {
      patch["phone"] = donor.phone;
      patch["phoneVerifiedAt"] = donor.phoneVerifiedAt ?? null;
    }
  }
  if (!(survivor.doctorName ?? "").trim()) {
    const donor = retired.find((r) => (r.doctorName ?? "").trim());
    if (donor) patch["doctorName"] = donor.doctorName;
  }
  if (!(survivor.firstName ?? "").trim()) {
    const donor = retired.find((r) => (r.firstName ?? "").trim());
    if (donor) patch["firstName"] = donor.firstName;
  }
  if (!(survivor.lastName ?? "").trim()) {
    const donor = retired.find((r) => (r.lastName ?? "").trim());
    if (donor) patch["lastName"] = donor.lastName;
  }
  return patch;
}

async function moveMemberships(
  tx: any,
  survivorId: string,
  retiredId: string,
  actorUserId: string | null,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select({
      id: organizationMemberships.id,
      labId: organizationMemberships.labId,
    })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, retiredId),
        notDeleted(organizationMemberships)
      )
    );

  for (const row of rows as any[]) {
    const [clash] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, row.labId),
          eq(organizationMemberships.userId, survivorId),
          notDeleted(organizationMemberships)
        )
      )
      .limit(1);

    if (clash) {
      // The survivor already belongs here — retire the duplicate membership
      // (protected table: soft-delete only).
      await tx
        .update(organizationMemberships)
        .set({ deletedAt: new Date(), deletedByUserId: actorUserId ?? null })
        .where(eq(organizationMemberships.id, row.id));
      moves.memberships.push({
        id: row.id,
        fromUserId: retiredId,
        action: "collapsed",
      });
    } else {
      await tx
        .update(organizationMemberships)
        .set({ userId: survivorId, updatedAt: new Date() })
        .where(eq(organizationMemberships.id, row.id));
      moves.memberships.push({
        id: row.id,
        fromUserId: retiredId,
        action: "moved",
      });
    }
  }
}

async function moveUnassignedEntries(
  tx: any,
  survivorId: string,
  retiredId: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select({
      id: labUnassignedDoctors.id,
      labOrganizationId: labUnassignedDoctors.labOrganizationId,
    })
    .from(labUnassignedDoctors)
    .where(
      and(
        eq(labUnassignedDoctors.userId, retiredId),
        isNull(labUnassignedDoctors.deletedAt)
      )
    );

  for (const row of rows as any[]) {
    const [clash] = await tx
      .select({ id: labUnassignedDoctors.id })
      .from(labUnassignedDoctors)
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, row.labOrganizationId),
          eq(labUnassignedDoctors.userId, survivorId),
          isNull(labUnassignedDoctors.deletedAt)
        )
      )
      .limit(1);

    if (clash) {
      await tx
        .update(labUnassignedDoctors)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(labUnassignedDoctors.id, row.id));
      moves.unassigned.push({
        id: row.id,
        fromUserId: retiredId,
        action: "collapsed",
      });
    } else {
      await tx
        .update(labUnassignedDoctors)
        .set({ userId: survivorId, updatedAt: new Date() })
        .where(eq(labUnassignedDoctors.id, row.id));
      moves.unassigned.push({
        id: row.id,
        fromUserId: retiredId,
        action: "moved",
      });
    }
  }
}

async function moveAccountLinks(
  tx: any,
  survivorId: string,
  retiredId: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select()
    .from(doctorAccountLinks)
    .where(
      sql`${doctorAccountLinks.userIdLow} = ${retiredId} or ${doctorAccountLinks.userIdHigh} = ${retiredId}`
    );

  for (const row of rows as any[]) {
    const other = row.userIdLow === retiredId ? row.userIdHigh : row.userIdLow;
    const snapshot: RowSnapshot = {
      id: row.id,
      userIdLow: row.userIdLow,
      userIdHigh: row.userIdHigh,
      linkedVia: row.linkedVia,
      linkedAt:
        row.linkedAt instanceof Date
          ? row.linkedAt.toISOString()
          : row.linkedAt ?? null,
    };

    // A link between the retired account and the survivor collapses to
    // nothing; so does a pair the survivor already has.
    let drop = other === survivorId;
    if (!drop) {
      const low = survivorId < other ? survivorId : other;
      const high = survivorId < other ? other : survivorId;
      const [clash] = await tx
        .select({ id: doctorAccountLinks.id })
        .from(doctorAccountLinks)
        .where(
          and(
            eq(doctorAccountLinks.userIdLow, low),
            eq(doctorAccountLinks.userIdHigh, high)
          )
        )
        .limit(1);
      if (clash) drop = true;
      else {
        await tx
          .update(doctorAccountLinks)
          .set({ userIdLow: low, userIdHigh: high })
          .where(eq(doctorAccountLinks.id, row.id));
        moves.accountLinks.push({ action: "moved", id: row.id, row: snapshot });
      }
    }

    if (drop) {
      await tx
        .delete(doctorAccountLinks)
        .where(eq(doctorAccountLinks.id, row.id));
      moves.accountLinks.push({ action: "removed", id: row.id, row: snapshot });
    }
  }
}

async function moveLinkInvites(
  tx: any,
  survivorId: string,
  retiredId: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select()
    .from(accountLinkInvites)
    .where(
      sql`${accountLinkInvites.newUserId} = ${retiredId} or ${accountLinkInvites.existingUserId} = ${retiredId}`
    );

  for (const row of rows as any[]) {
    const snapshot: RowSnapshot = {
      id: row.id,
      newUserId: row.newUserId,
      existingUserId: row.existingUserId,
      matchedOn: row.matchedOn,
      sentToPhone: row.sentToPhone ?? null,
      sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : null,
      status: row.status,
      respondedAt:
        row.respondedAt instanceof Date ? row.respondedAt.toISOString() : null,
      providerMessageId: row.providerMessageId ?? null,
      providerErrorCode: row.providerErrorCode ?? null,
      providerErrorMessage: row.providerErrorMessage ?? null,
    };

    const newUserId = row.newUserId === retiredId ? survivorId : row.newUserId;
    const existingUserId =
      row.existingUserId === retiredId ? survivorId : row.existingUserId;

    let drop = newUserId === existingUserId;
    if (!drop) {
      const [clash] = await tx
        .select({ id: accountLinkInvites.id })
        .from(accountLinkInvites)
        .where(
          and(
            eq(accountLinkInvites.newUserId, newUserId),
            eq(accountLinkInvites.existingUserId, existingUserId)
          )
        )
        .limit(1);
      if (clash) drop = true;
      else {
        await tx
          .update(accountLinkInvites)
          .set({ newUserId, existingUserId, updatedAt: new Date() })
          .where(eq(accountLinkInvites.id, row.id));
        moves.linkInvites.push({ action: "moved", id: row.id, row: snapshot });
      }
    }

    if (drop) {
      await tx
        .delete(accountLinkInvites)
        .where(eq(accountLinkInvites.id, row.id));
      moves.linkInvites.push({ action: "removed", id: row.id, row: snapshot });
    }
  }
}

async function moveContactEntries(
  tx: any,
  fromProfileId: string,
  toProfileId: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const phones = await tx
    .select()
    .from(doctorPhoneEntries)
    .where(eq(doctorPhoneEntries.doctorProfileId, fromProfileId));
  for (const row of phones as any[]) {
    const snapshot: RowSnapshot = {
      id: row.id,
      doctorProfileId: row.doctorProfileId,
      phoneNumber: row.phoneNumber,
      label: row.label,
      isPrimary: row.isPrimary,
    };
    const [clash] = await tx
      .select({ id: doctorPhoneEntries.id })
      .from(doctorPhoneEntries)
      .where(
        and(
          eq(doctorPhoneEntries.doctorProfileId, toProfileId),
          sql`regexp_replace(${doctorPhoneEntries.phoneNumber}, '\\D', '', 'g') = regexp_replace(${row.phoneNumber}, '\\D', '', 'g')`
        )
      )
      .limit(1);
    if (clash) {
      await tx
        .delete(doctorPhoneEntries)
        .where(eq(doctorPhoneEntries.id, row.id));
      moves.contactEntries.push({
        kind: "phone",
        action: "removed",
        id: row.id,
        fromProfileId,
        row: snapshot,
      });
    } else {
      await tx
        .update(doctorPhoneEntries)
        .set({ doctorProfileId: toProfileId, isPrimary: false, updatedAt: new Date() })
        .where(eq(doctorPhoneEntries.id, row.id));
      moves.contactEntries.push({
        kind: "phone",
        action: "moved",
        id: row.id,
        fromProfileId,
        row: snapshot,
      });
    }
  }

  const emails = await tx
    .select()
    .from(doctorEmailEntries)
    .where(eq(doctorEmailEntries.doctorProfileId, fromProfileId));
  for (const row of emails as any[]) {
    const snapshot: RowSnapshot = {
      id: row.id,
      doctorProfileId: row.doctorProfileId,
      email: row.email,
      label: row.label,
      isPrimary: row.isPrimary,
    };
    const [clash] = await tx
      .select({ id: doctorEmailEntries.id })
      .from(doctorEmailEntries)
      .where(
        and(
          eq(doctorEmailEntries.doctorProfileId, toProfileId),
          sql`lower(${doctorEmailEntries.email}) = lower(${row.email})`
        )
      )
      .limit(1);
    if (clash) {
      await tx
        .delete(doctorEmailEntries)
        .where(eq(doctorEmailEntries.id, row.id));
      moves.contactEntries.push({
        kind: "email",
        action: "removed",
        id: row.id,
        fromProfileId,
        row: snapshot,
      });
    } else {
      await tx
        .update(doctorEmailEntries)
        .set({ doctorProfileId: toProfileId, isPrimary: false, updatedAt: new Date() })
        .where(eq(doctorEmailEntries.id, row.id));
      moves.contactEntries.push({
        kind: "email",
        action: "moved",
        id: row.id,
        fromProfileId,
        row: snapshot,
      });
    }
  }
}

async function moveDoctorProfiles(
  tx: any,
  labId: string,
  fromName: string,
  toName: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select()
    .from(doctorProfiles)
    .where(
      and(
        eq(doctorProfiles.labOrganizationId, labId),
        sql`lower(${doctorProfiles.doctorName}) = lower(${fromName})`
      )
    );

  for (const row of rows as any[]) {
    const providerClause =
      row.providerOrganizationId === null
        ? isNull(doctorProfiles.providerOrganizationId)
        : eq(doctorProfiles.providerOrganizationId, row.providerOrganizationId);
    const [survivorProfile] = await tx
      .select({ id: doctorProfiles.id })
      .from(doctorProfiles)
      .where(
        and(
          eq(doctorProfiles.labOrganizationId, labId),
          sql`lower(${doctorProfiles.doctorName}) = lower(${toName})`,
          providerClause,
          ne(doctorProfiles.id, row.id)
        )
      )
      .limit(1);

    if (!survivorProfile) {
      await tx
        .update(doctorProfiles)
        .set({ doctorName: toName, updatedAt: new Date() })
        .where(eq(doctorProfiles.id, row.id));
      moves.doctorProfiles.push({
        action: "renamed",
        id: row.id,
        fromDoctorName: row.doctorName,
        intoProfileId: null,
        row: null,
      });
      continue;
    }

    // Collapse: children and invoice identities follow the survivor profile.
    await moveContactEntries(tx, row.id, survivorProfile.id, moves);

    const invoiceRows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.doctorIdentity, row.id));
    for (const inv of invoiceRows as any[]) {
      await tx
        .update(invoices)
        .set({ doctorIdentity: survivorProfile.id })
        .where(eq(invoices.id, inv.id));
      moves.invoiceIdentities.push({
        invoiceId: inv.id,
        fromProfileId: row.id,
        toProfileId: survivorProfile.id,
      });
    }

    const snapshot: RowSnapshot = {
      id: row.id,
      labOrganizationId: row.labOrganizationId,
      doctorName: row.doctorName,
      providerOrganizationId: row.providerOrganizationId ?? null,
      displayName: row.displayName ?? null,
      preferences: row.preferences ?? null,
    };
    await tx.delete(doctorProfiles).where(eq(doctorProfiles.id, row.id));
    moves.doctorProfiles.push({
      action: "collapsed",
      id: row.id,
      fromDoctorName: row.doctorName,
      intoProfileId: survivorProfile.id,
      row: snapshot,
    });
  }
}

async function movePricingOverrides(
  tx: any,
  labId: string,
  fromName: string,
  toName: string,
  actorUserId: string | null,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select({
      id: pricingOverrides.id,
      doctorName: pricingOverrides.doctorName,
      providerOrganizationId: pricingOverrides.providerOrganizationId,
    })
    .from(pricingOverrides)
    .where(
      and(
        eq(pricingOverrides.labOrganizationId, labId),
        sql`lower(${pricingOverrides.doctorName}) = lower(${fromName})`,
        notDeleted(pricingOverrides)
      )
    );

  for (const row of rows as any[]) {
    const providerClause =
      row.providerOrganizationId === null
        ? isNull(pricingOverrides.providerOrganizationId)
        : eq(
            pricingOverrides.providerOrganizationId,
            row.providerOrganizationId
          );
    const [clash] = await tx
      .select({ id: pricingOverrides.id })
      .from(pricingOverrides)
      .where(
        and(
          eq(pricingOverrides.labOrganizationId, labId),
          sql`lower(${pricingOverrides.doctorName}) = lower(${toName})`,
          providerClause,
          notDeleted(pricingOverrides),
          ne(pricingOverrides.id, row.id)
        )
      )
      .limit(1);

    if (clash) {
      // Protected table — collapse by soft-deleting the duplicate override.
      await tx
        .update(pricingOverrides)
        .set({ deletedAt: new Date(), deletedByUserId: actorUserId ?? null })
        .where(eq(pricingOverrides.id, row.id));
      moves.pricingOverrides.push({
        action: "collapsed",
        id: row.id,
        fromDoctorName: row.doctorName,
      });
    } else {
      await tx
        .update(pricingOverrides)
        .set({ doctorName: toName, updatedAt: new Date() })
        .where(eq(pricingOverrides.id, row.id));
      moves.pricingOverrides.push({
        action: "renamed",
        id: row.id,
        fromDoctorName: row.doctorName,
      });
    }
  }
}

async function moveCaseNames(
  tx: any,
  labId: string,
  fromName: string,
  toName: string,
  moves: ConsolidationMoveLog
): Promise<void> {
  const rows = await tx
    .select({ id: cases.id, doctorName: cases.doctorName })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, labId),
        sql`lower(trim(${cases.doctorName})) = lower(${fromName})`
      )
    );
  if (rows.length === 0) return;
  await tx
    .update(cases)
    .set({ doctorName: toName, updatedAt: new Date() })
    .where(
      and(
        eq(cases.labOrganizationId, labId),
        sql`lower(trim(${cases.doctorName})) = lower(${fromName})`
      )
    );
  for (const row of rows as any[]) {
    moves.caseNames.push({ id: row.id, fromDoctorName: row.doctorName });
  }
}

export interface ConsolidateOptions {
  labOrganizationId: string;
  providerOrganizationId: string | null;
  survivorUserId: string;
  retiredUserIds: string[];
  actorUserId: string | null;
  /** Free-text note recorded on the audit row (e.g. "automatic sweep"). */
  trigger: string;
}

/**
 * Consolidate one cluster inside a single transaction. Every reference is moved
 * before the extras are retired, so a crash can never leave a half-consolidated
 * doctor behind.
 */
export async function consolidateProviderAccounts(
  options: ConsolidateOptions,
  executor: any = db
): Promise<ConsolidationResult> {
  const {
    labOrganizationId,
    providerOrganizationId,
    survivorUserId,
    retiredUserIds,
    actorUserId,
    trigger,
  } = options;

  const run = async (tx: any): Promise<ConsolidationResult> => {
    const moves = emptyMoveLog();
    const allIds = [survivorUserId, ...retiredUserIds];

    // Lock every account in a stable order so two concurrent consolidations
    // (sweep + admin click) cannot interleave on the same people.
    await tx.execute(
      sql`select id from users where id in (${sql.join(
        [...allIds].sort().map((id) => sql`${id}`),
        sql`, `
      )}) order by id for update`
    );

    const rows = await tx
      .select()
      .from(users)
      .where(inArray(users.id, allIds));
    const byId = new Map<string, any>((rows as any[]).map((r) => [r.id, r]));

    const survivorRow = byId.get(survivorUserId);
    if (!survivorRow) {
      throw new Error(`Survivor account ${survivorUserId} not found.`);
    }
    if (survivorRow.deletedAt) {
      throw new Error(`Survivor account ${survivorUserId} is deleted.`);
    }

    const toNode = (r: any): ProviderAccountNode => ({
      userId: r.id,
      labOrganizationId,
      providerOrganizationId,
      displayName: displayNameOf(r),
      platformAccountNumber: r.platformAccountNumber ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      emailVerifiedAt: r.emailVerifiedAt ?? null,
      phoneVerifiedAt: r.phoneVerifiedAt ?? null,
      doctorName: r.doctorName ?? null,
      firstName: r.firstName ?? null,
      lastName: r.lastName ?? null,
      isActive: r.isActive !== false,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(0),
    });

    const survivor = toNode(survivorRow);
    const retiredNodes: ProviderAccountNode[] = [];
    for (const id of retiredUserIds) {
      const row = byId.get(id);
      // Idempotency: an account already retired by an earlier run is skipped
      // rather than treated as an error, so re-running changes nothing.
      if (!row || row.deletedAt) continue;
      retiredNodes.push(toNode(row));
    }

    if (retiredNodes.length === 0) {
      return {
        labOrganizationId,
        providerOrganizationId,
        survivorUserId,
        survivorAccountNumber: survivor.platformAccountNumber,
        survivorName: survivor.displayName,
        retiredUserIds: [],
        retiredAccountNumbers: [],
        auditLogId: null,
        referencesMoved: 0,
        moves,
      };
    }

    moves.survivorBefore = {
      id: survivorRow.id,
      email: survivorRow.email ?? null,
      emailVerifiedAt:
        survivorRow.emailVerifiedAt instanceof Date
          ? survivorRow.emailVerifiedAt.toISOString()
          : null,
      phone: survivorRow.phone ?? null,
      phoneVerifiedAt:
        survivorRow.phoneVerifiedAt instanceof Date
          ? survivorRow.phoneVerifiedAt.toISOString()
          : null,
      doctorName: survivorRow.doctorName ?? null,
      firstName: survivorRow.firstName ?? null,
      lastName: survivorRow.lastName ?? null,
    };

    for (const retired of retiredNodes) {
      await moveMemberships(
        tx,
        survivorUserId,
        retired.userId,
        actorUserId,
        moves
      );
      await moveUnassignedEntries(tx, survivorUserId, retired.userId, moves);
      await moveAccountLinks(tx, survivorUserId, retired.userId, moves);
      await moveLinkInvites(tx, survivorUserId, retired.userId, moves);

      const fromName = retired.displayName.trim();
      const toName = survivor.displayName.trim();
      if (fromName && toName && fromName.toLowerCase() !== toName.toLowerCase()) {
        await moveDoctorProfiles(tx, labOrganizationId, fromName, toName, moves);
        await movePricingOverrides(
          tx,
          labOrganizationId,
          fromName,
          toName,
          actorUserId,
          moves
        );
        const memoryChange = await migrateDoctorPracticeMemory(
          tx,
          labOrganizationId,
          fromName,
          toName
        );
        if (memoryChange) moves.practiceMemory.push(memoryChange);
        await moveCaseNames(tx, labOrganizationId, fromName, toName, moves);
      }

      moves.retired.push({
        userId: retired.userId,
        isActiveBefore: retired.isActive,
        platformAccountNumber: retired.platformAccountNumber,
        displayName: retired.displayName,
      });
    }

    // Fold contact details the survivor is missing so a verified email or
    // phone is never silently discarded with the retired account.
    const patch = pickContactFolding(survivor, retiredNodes);
    if (Object.keys(patch).length > 0) {
      await tx
        .update(users)
        .set(patch)
        .where(eq(users.id, survivorUserId));
    }

    // Retire the extras: deactivated + soft-deleted, but their account numbers
    // stay on the row so the partial unique index keeps them reserved forever.
    const retiredIds = retiredNodes.map((r) => r.userId);
    await tx
      .update(users)
      .set({
        isActive: false,
        deletedAt: new Date(),
        deletedByUserId: actorUserId ?? null,
      })
      .where(inArray(users.id, retiredIds));

    const [auditRow] = await tx
      .insert(auditLogs)
      .values({
        userId: actorUserId,
        organizationId: labOrganizationId,
        action: CONSOLIDATION_AUDIT_ACTION,
        entityType: CONSOLIDATION_AUDIT_ENTITY,
        entityId: survivorUserId,
        beforeJson: {
          survivor: moves.survivorBefore,
          retired: moves.retired,
        },
        afterJson: {
          survivorUserId,
          survivorAccountNumber: survivor.platformAccountNumber,
          survivorName: survivor.displayName,
          contactFolded: Object.keys(patch),
        },
        metadataJson: {
          trigger,
          labOrganizationId,
          providerOrganizationId,
          retiredUserIds: retiredIds,
          referencesMoved: countMoves(moves),
          moves,
        },
      })
      .returning({ id: auditLogs.id });

    return {
      labOrganizationId,
      providerOrganizationId,
      survivorUserId,
      survivorAccountNumber: survivor.platformAccountNumber,
      survivorName: survivor.displayName,
      retiredUserIds: retiredIds,
      retiredAccountNumbers: retiredNodes.map(
        (r) => r.platformAccountNumber ?? ""
      ),
      auditLogId: auditRow?.id ?? null,
      referencesMoved: countMoves(moves),
      moves,
    };
  };

  // `executor` is already a transaction when the caller owns one.
  if (typeof executor.transaction === "function") {
    return executor.transaction(run);
  }
  return run(executor);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Reverse a consolidation from its audit record. Restores the retired accounts
 * first (so foreign keys resolve), then walks the move log backwards.
 */
export async function undoProviderAccountConsolidation(
  moves: ConsolidationMoveLog,
  context: { labOrganizationId: string; survivorUserId: string },
  executor: any = db
): Promise<void> {
  const run = async (tx: any) => {
    // 1. Bring the retired accounts back.
    for (const r of moves.retired) {
      await tx
        .update(users)
        .set({
          isActive: r.isActiveBefore,
          deletedAt: null,
          deletedByUserId: null,
        })
        .where(eq(users.id, r.userId));
    }

    // 2. Restore the survivor's own contact fields.
    if (moves.survivorBefore) {
      const before = moves.survivorBefore as Record<string, any>;
      await tx
        .update(users)
        .set({
          email: before["email"] ?? null,
          emailVerifiedAt: before["emailVerifiedAt"]
            ? new Date(before["emailVerifiedAt"])
            : null,
          phone: before["phone"] ?? null,
          phoneVerifiedAt: before["phoneVerifiedAt"]
            ? new Date(before["phoneVerifiedAt"])
            : null,
          doctorName: before["doctorName"] ?? null,
          firstName: before["firstName"] ?? null,
          lastName: before["lastName"] ?? null,
        })
        .where(eq(users.id, context.survivorUserId));
    }

    // 3. Case names.
    for (const c of moves.caseNames) {
      await tx
        .update(cases)
        .set({ doctorName: c.fromDoctorName, updatedAt: new Date() })
        .where(eq(cases.id, c.id));
    }

    // 4. Remembered practices.
    for (const change of moves.practiceMemory) {
      if (change.action === "moved") {
        await tx
          .update(rxDoctorPracticeMemory)
          .set({
            doctorName: change.sourceDoctorKey,
            updatedAt: new Date(),
          })
          .where(eq(rxDoctorPracticeMemory.id, change.targetMemoryId));
      } else {
        await tx
          .insert(rxDoctorPracticeMemory)
          .values({
            labOrganizationId: context.labOrganizationId,
            doctorName: change.sourceDoctorKey,
            providerOrganizationId: change.sourceProviderOrganizationId,
            createdByUserId: change.sourceCreatedByUserId,
          })
          .onConflictDoNothing();
      }
    }

    // 5. Pricing overrides.
    for (const o of moves.pricingOverrides) {
      if (o.action === "collapsed") {
        await tx
          .update(pricingOverrides)
          .set({ deletedAt: null, deletedByUserId: null })
          .where(eq(pricingOverrides.id, o.id));
      } else {
        await tx
          .update(pricingOverrides)
          .set({ doctorName: o.fromDoctorName, updatedAt: new Date() })
          .where(eq(pricingOverrides.id, o.id));
      }
    }

    // 6. Doctor profiles — recreate collapsed rows before their children.
    for (const p of moves.doctorProfiles) {
      if (p.action === "collapsed" && p.row) {
        await tx
          .insert(doctorProfiles)
          .values({
            id: p.row["id"] as string,
            labOrganizationId: p.row["labOrganizationId"] as string,
            doctorName: p.row["doctorName"] as string,
            providerOrganizationId:
              (p.row["providerOrganizationId"] as string | null) ?? null,
            displayName: (p.row["displayName"] as string | null) ?? null,
            preferences: (p.row["preferences"] as string | null) ?? null,
          })
          .onConflictDoNothing();
      } else {
        await tx
          .update(doctorProfiles)
          .set({ doctorName: p.fromDoctorName, updatedAt: new Date() })
          .where(eq(doctorProfiles.id, p.id));
      }
    }

    // 7. Invoice doctor identities.
    for (const inv of moves.invoiceIdentities) {
      await tx
        .update(invoices)
        .set({ doctorIdentity: inv.fromProfileId })
        .where(eq(invoices.id, inv.invoiceId));
    }

    // 8. Doctor phone/email entries.
    for (const entry of moves.contactEntries) {
      const table =
        entry.kind === "phone" ? doctorPhoneEntries : doctorEmailEntries;
      if (entry.action === "moved") {
        await tx
          .update(table as any)
          .set({
            doctorProfileId: entry.fromProfileId,
            isPrimary: Boolean(entry.row["isPrimary"]),
            updatedAt: new Date(),
          })
          .where(eq((table as any).id, entry.id));
      } else {
        await tx
          .insert(table as any)
          .values(
            entry.kind === "phone"
              ? {
                  id: entry.row["id"] as string,
                  doctorProfileId: entry.fromProfileId,
                  phoneNumber: entry.row["phoneNumber"] as string,
                  label: entry.row["label"] as string,
                  isPrimary: Boolean(entry.row["isPrimary"]),
                }
              : {
                  id: entry.row["id"] as string,
                  doctorProfileId: entry.fromProfileId,
                  email: entry.row["email"] as string,
                  label: entry.row["label"] as string,
                  isPrimary: Boolean(entry.row["isPrimary"]),
                }
          )
          .onConflictDoNothing();
      }
    }

    // 9. Account links + invites.
    for (const link of moves.accountLinks) {
      if (link.action === "moved") {
        await tx
          .update(doctorAccountLinks)
          .set({
            userIdLow: link.row["userIdLow"] as string,
            userIdHigh: link.row["userIdHigh"] as string,
          })
          .where(eq(doctorAccountLinks.id, link.id));
      } else {
        await tx
          .insert(doctorAccountLinks)
          .values({
            id: link.row["id"] as string,
            userIdLow: link.row["userIdLow"] as string,
            userIdHigh: link.row["userIdHigh"] as string,
            linkedVia: link.row["linkedVia"] as string,
            ...(link.row["linkedAt"]
              ? { linkedAt: new Date(link.row["linkedAt"] as string) }
              : {}),
          })
          .onConflictDoNothing();
      }
    }
    for (const invite of moves.linkInvites) {
      if (invite.action === "moved") {
        await tx
          .update(accountLinkInvites)
          .set({
            newUserId: invite.row["newUserId"] as string,
            existingUserId: invite.row["existingUserId"] as string,
            updatedAt: new Date(),
          })
          .where(eq(accountLinkInvites.id, invite.id));
      } else {
        await tx
          .insert(accountLinkInvites)
          .values({
            id: invite.row["id"] as string,
            newUserId: invite.row["newUserId"] as string,
            existingUserId: invite.row["existingUserId"] as string,
            matchedOn: invite.row["matchedOn"] as string,
            sentToPhone: (invite.row["sentToPhone"] as string | null) ?? null,
            sentAt: invite.row["sentAt"]
              ? new Date(invite.row["sentAt"] as string)
              : null,
            status: (invite.row["status"] as string) ?? "pending",
            respondedAt: invite.row["respondedAt"]
              ? new Date(invite.row["respondedAt"] as string)
              : null,
            providerMessageId:
              (invite.row["providerMessageId"] as string | null) ?? null,
            providerErrorCode:
              (invite.row["providerErrorCode"] as string | null) ?? null,
            providerErrorMessage:
              (invite.row["providerErrorMessage"] as string | null) ?? null,
          })
          .onConflictDoNothing();
      }
    }

    // 10. Unassigned-holding rows and memberships.
    for (const u of moves.unassigned) {
      if (u.action === "collapsed") {
        await tx
          .update(labUnassignedDoctors)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(labUnassignedDoctors.id, u.id));
      } else {
        await tx
          .update(labUnassignedDoctors)
          .set({ userId: u.fromUserId, updatedAt: new Date() })
          .where(eq(labUnassignedDoctors.id, u.id));
      }
    }
    for (const m of moves.memberships) {
      if (m.action === "collapsed") {
        await tx
          .update(organizationMemberships)
          .set({ deletedAt: null, deletedByUserId: null, updatedAt: new Date() })
          .where(eq(organizationMemberships.id, m.id));
      } else {
        await tx
          .update(organizationMemberships)
          .set({ userId: m.fromUserId, updatedAt: new Date() })
          .where(eq(organizationMemberships.id, m.id));
      }
    }
  };

  if (typeof executor.transaction === "function") {
    return executor.transaction(run);
  }
  return run(executor);
}

// ---------------------------------------------------------------------------
// Sweep (maintenance command + automatic job)
// ---------------------------------------------------------------------------

export interface SweepClusterReport {
  labOrganizationId: string;
  providerOrganizationId: string | null;
  doctorNames: string[];
  accountNumbers: string[];
  topScore: number;
  classification: ClusterClassification;
  conflictReason: string | null;
  survivorUserId: string;
  survivorAccountNumber: string | null;
  retiredUserIds: string[];
  outcome: "consolidated" | "would-consolidate" | "skipped-conflicting";
  referencesMoved: number;
  auditLogId: string | null;
}

export interface SweepReport {
  dryRun: boolean;
  labsScanned: number;
  clustersFound: number;
  clustersConsolidated: number;
  clustersSkippedConflicting: number;
  accountsRetired: number;
  clusters: SweepClusterReport[];
}

export interface SweepOptions {
  /** Restrict to these lab ids. Defaults to every lab organization. */
  labIds?: string[];
  dryRun: boolean;
  actorUserId?: string | null;
  trigger?: string;
}

/**
 * Consolidate every unambiguous account-duplicate cluster. Conflicting clusters
 * are reported and left alone so they surface in the duplicate-suspects panel.
 *
 * Idempotent: a second run finds no clusters because the extras are now
 * soft-deleted and detection only ever loads live accounts.
 */
export async function sweepDuplicateProviderAccounts(
  options: SweepOptions
): Promise<SweepReport> {
  const labIds =
    options.labIds && options.labIds.length > 0
      ? options.labIds
      : (
          await db
            .select({ id: organizations.id })
            .from(organizations)
            .where(and(eq(organizations.type, "lab"), notDeleted(organizations)))
        ).map((l) => l.id);

  const report: SweepReport = {
    dryRun: options.dryRun,
    labsScanned: labIds.length,
    clustersFound: 0,
    clustersConsolidated: 0,
    clustersSkippedConflicting: 0,
    accountsRetired: 0,
    clusters: [],
  };
  if (labIds.length === 0) return report;

  const clusters = await detectProviderAccountClusters(labIds);
  report.clustersFound = clusters.length;

  for (const cluster of clusters) {
    const base = {
      labOrganizationId: cluster.labOrganizationId,
      providerOrganizationId: cluster.providerOrganizationId,
      doctorNames: cluster.members.map((m) => m.displayName),
      accountNumbers: cluster.members.map(
        (m) => m.platformAccountNumber ?? "(none)"
      ),
      topScore: cluster.topScore,
      classification: cluster.classification,
      conflictReason: cluster.conflictReason,
      survivorUserId: cluster.survivor.userId,
      survivorAccountNumber: cluster.survivor.platformAccountNumber,
      retiredUserIds: cluster.retired.map((r) => r.userId),
    };

    if (cluster.classification === "conflicting") {
      report.clustersSkippedConflicting += 1;
      report.clusters.push({
        ...base,
        outcome: "skipped-conflicting",
        referencesMoved: 0,
        auditLogId: null,
      });
      continue;
    }

    if (options.dryRun) {
      report.clusters.push({
        ...base,
        outcome: "would-consolidate",
        referencesMoved: 0,
        auditLogId: null,
      });
      report.clustersConsolidated += 1;
      report.accountsRetired += cluster.retired.length;
      continue;
    }

    const result = await consolidateProviderAccounts({
      labOrganizationId: cluster.labOrganizationId,
      providerOrganizationId: cluster.providerOrganizationId,
      survivorUserId: cluster.survivor.userId,
      retiredUserIds: cluster.retired.map((r) => r.userId),
      actorUserId: options.actorUserId ?? null,
      trigger: options.trigger ?? "sweep",
    });
    report.clustersConsolidated += 1;
    report.accountsRetired += result.retiredUserIds.length;
    report.clusters.push({
      ...base,
      outcome: "consolidated",
      referencesMoved: result.referencesMoved,
      auditLogId: result.auditLogId,
    });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Automatic sweep job
// ---------------------------------------------------------------------------

let _consolidationJobTimer: ReturnType<typeof setTimeout> | null = null;

function consolidationJobEnabled(): boolean {
  if (process.env["VITEST"]) return false;
  // This job makes inferred duplicate-account changes without an operator.
  // It is permitted only in an explicit development process; missing or
  // production NODE_ENV must never enable it after a release restart.
  return (
    process.env.NODE_ENV === "development" &&
    process.env["DOCTOR_ACCOUNT_CONSOLIDATION_ENABLED"] !== "0"
  );
}

export async function runProviderAccountConsolidationSweepOnce(): Promise<void> {
  if (!consolidationJobEnabled()) return;
  try {
    const report = await sweepDuplicateProviderAccounts({
      dryRun: false,
      actorUserId: null,
      trigger: "automatic-sweep",
    });
    if (report.clustersFound > 0) {
      logger.info(
        {
          clustersFound: report.clustersFound,
          consolidated: report.clustersConsolidated,
          conflicting: report.clustersSkippedConflicting,
          accountsRetired: report.accountsRetired,
        },
        "[doctor-accounts] Duplicate provider-account sweep finished"
      );
    }
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      "[doctor-accounts] Duplicate provider-account sweep failed"
    );
  }
}

/**
 * Consolidate unambiguous duplicates without an admin having to act: first run
 * 10 minutes after startup, then daily. Conflicting clusters keep flowing to
 * the duplicate-suspects panel instead.
 */
export function startProviderAccountConsolidationJob(): void {
  if (_consolidationJobTimer !== null) return;
  if (!consolidationJobEnabled()) return;

  const MS_10MIN = 10 * 60 * 1000;
  const MS_24H = 24 * 60 * 60 * 1000;
  _consolidationJobTimer = setTimeout(async () => {
    await runProviderAccountConsolidationSweepOnce();
    setInterval(runProviderAccountConsolidationSweepOnce, MS_24H);
  }, MS_10MIN);

  logger.info(
    "[doctor-accounts] Duplicate provider-account consolidation scheduled (first run in 10 min)"
  );
}

/** Test-only: clear the singleton timer guard. */
export function _resetProviderAccountConsolidationJob(): void {
  if (_consolidationJobTimer !== null) clearTimeout(_consolidationJobTimer);
  _consolidationJobTimer = null;
}
