/**
 * Cross-lab doctor account linking routes (Task #320).
 *
 * The authenticated router is mounted at /api/account-links. Account links
 * are created only after the invited account accepts through /respond.
 */
import { Router } from "express";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  classifyAccountNumber,
  normalizeAccountNumberInput,
  ACCOUNT_NUMBER_NEW_INVALID,
  ACCOUNT_NUMBER_NEW_VALID,
} from "@workspace/account-number";
import {
  accountLinkInvites,
  doctorAccountLinks,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { writeAuditLog } from "../lib/audit";
import { HttpError, ok } from "../lib/http";
import { canonicalLinkPair } from "../lib/cross-lab-doctor";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

/**
 * Insert a (low, high) link row idempotently. Returns true when a new row
 * was inserted, false when the pair was already linked.
 */
async function insertLinkIfMissing(
  userIdA: string,
  userIdB: string,
  linkedVia: "manual" | "admin_backfill"
): Promise<boolean> {
  const pair = canonicalLinkPair(userIdA, userIdB);
  if (!pair) return false;
  const existing = await db.query.doctorAccountLinks.findFirst({
    where: and(
      eq(doctorAccountLinks.userIdLow, pair.low),
      eq(doctorAccountLinks.userIdHigh, pair.high)
    ),
  });
  if (existing) return false;
  await db
    .insert(doctorAccountLinks)
    .values({
      userIdLow: pair.low,
      userIdHigh: pair.high,
      linkedVia,
    })
    .onConflictDoNothing();
  return true;
}

/**
 * Hydrate a list of user ids into safe-to-return profile cards. Used by the
 * "Link Labs" screen so the doctor can see which other-lab copy of
 * themselves they are linked to.
 */
async function hydrateLinkedUserCards(userIds: string[]) {
  if (userIds.length === 0) return [];
  const userRows = await db
    .select()
    .from(users)
    // Accounts retired by a duplicate consolidation (Task #4373) are
    // soft-deleted; never surface them as a linked account.
    .where(and(inArray(users.id, userIds), isNull(users.deletedAt)));
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      inArray(organizationMemberships.userId, userIds),
      eq(organizationMemberships.status, "active")
    ),
  });
  const orgIds = Array.from(new Set(memberships.map((m: any) => m.labId)));
  const orgRows = orgIds.length
    ? await db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, orgIds))
    : [];
  const orgsById = new Map(orgRows.map((o: any) => [o.id, o]));
  const labsByUser = new Map<string, string[]>();
  for (const m of memberships) {
    const org: any = orgsById.get((m as any).labId);
    if (!org || org.type !== "lab") continue;
    const labels = labsByUser.get((m as any).userId) ?? [];
    labels.push(org.displayName || org.name);
    labsByUser.set((m as any).userId, labels);
  }
  return userRows.map((u: any) => ({
    userId: u.id,
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    platformAccountNumber: u.platformAccountNumber,
    labs: labsByUser.get(u.id) ?? [],
  }));
}

export type LinkedLabInfo = {
  labId: string;
  labName: string;
  status: "active" | "pending";
  linkedUserId: string;
  linkedUsername: string;
};

/**
 * Resolve every OTHER lab a given user's doctor identity is connected to —
 * via a confirmed doctor_account_links row ("active") or an outstanding
 * account_link_invites row in either direction ("pending"). Used by the
 * platform-admin Accounts directory (UserDetailDrawer) so an admin can see
 * cross-lab relationships for a specific provider account without exposing
 * the full mobile "Link Labs" self-service surface.
 */
export async function getLinkedLabsForUser(userId: string): Promise<LinkedLabInfo[]> {
  const links = await db
    .select()
    .from(doctorAccountLinks)
    .where(
      or(
        eq(doctorAccountLinks.userIdLow, userId),
        eq(doctorAccountLinks.userIdHigh, userId)
      )
    );
  const activeOtherUserIds = new Set(
    links.map((l: any) => (l.userIdLow === userId ? l.userIdHigh : l.userIdLow))
  );

  const [pendingSent, pendingReceived] = await Promise.all([
    db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.newUserId, userId),
          eq(accountLinkInvites.status, "pending")
        )
      ),
    db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.existingUserId, userId),
          eq(accountLinkInvites.status, "pending")
        )
      ),
  ]);
  const pendingOtherUserIds = new Set([
    ...pendingSent.map((i: any) => i.existingUserId),
    ...pendingReceived.map((i: any) => i.newUserId),
  ]);

  const allOtherUserIds = Array.from(
    new Set([...activeOtherUserIds, ...pendingOtherUserIds])
  );
  if (allOtherUserIds.length === 0) return [];

  const [otherUsers, memberships] = await Promise.all([
    db.select().from(users).where(inArray(users.id, allOtherUserIds)),
    db.query.organizationMemberships.findMany({
      where: and(
        inArray(organizationMemberships.userId, allOtherUserIds),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      ),
    }),
  ]);
  const usersById = new Map(otherUsers.map((u: any) => [u.id, u]));
  const orgIds = Array.from(new Set(memberships.map((m: any) => m.labId)));
  const orgRows = orgIds.length
    ? await db.select().from(organizations).where(inArray(organizations.id, orgIds))
    : [];
  const orgsById = new Map(orgRows.map((o: any) => [o.id, o]));

  const rows: LinkedLabInfo[] = [];
  const seen = new Set<string>();
  for (const m of memberships) {
    const org: any = orgsById.get((m as any).labId);
    if (!org || org.type !== "lab") continue;
    const otherUser: any = usersById.get((m as any).userId);
    if (!otherUser) continue;
    const key = `${(m as any).labId}|${otherUser.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      labId: (m as any).labId,
      labName: org.displayName || org.name,
      status: activeOtherUserIds.has(otherUser.id) ? "active" : "pending",
      linkedUserId: otherUser.id,
      linkedUsername: otherUser.username,
    });
  }
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.labName.localeCompare(b.labName);
  });
  return rows;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const links = await db
      .select()
      .from(doctorAccountLinks)
      .where(
        and(
          ne(doctorAccountLinks.userIdLow, doctorAccountLinks.userIdHigh)
        )
      );
    const linkedUserIds = links
      .filter(
        (l: any) => l.userIdLow === userId || l.userIdHigh === userId
      )
      .map((l: any) =>
        l.userIdLow === userId ? l.userIdHigh : l.userIdLow
      );

    const pendingInvites = await db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.newUserId, userId),
          eq(accountLinkInvites.status, "pending")
        )
      );
    const pendingInvitesForMe = await db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.existingUserId, userId),
          eq(accountLinkInvites.status, "pending")
        )
      );

    const otherUserIds = Array.from(
      new Set([
        ...pendingInvites.map((i: any) => i.existingUserId),
        ...pendingInvitesForMe.map((i: any) => i.newUserId),
      ])
    );
    const [linkedCards, otherCards] = await Promise.all([
      hydrateLinkedUserCards(linkedUserIds),
      hydrateLinkedUserCards(otherUserIds),
    ]);
    const cardsById = new Map(otherCards.map((c) => [c.userId, c]));

    return ok(res, {
      linked: linkedCards,
      pendingInvitesSent: pendingInvites.map((i: any) => ({
        inviteId: i.id,
        toUser: cardsById.get(i.existingUserId) ?? null,
        sentAt: i.sentAt,
        status: i.status,
      })),
      pendingInvitesReceived: pendingInvitesForMe.map((i: any) => ({
        inviteId: i.id,
        fromUser: cardsById.get(i.newUserId) ?? null,
        sentAt: i.sentAt,
        status: i.status,
      })),
    });
  })
);

const respondSchema = z.object({
  inviteId: z.string().min(1),
  accept: z.boolean(),
});

router.post(
  "/respond",
  asyncHandler(async (req, res) => {
    const input = respondSchema.parse(req.body);
    const userId = (req as any).auth.userId;
    const invite = await db.query.accountLinkInvites.findFirst({
      where: eq(accountLinkInvites.id, input.inviteId),
    });
    if (!invite) throw new HttpError(404, "Invite not found.");
    // Only the account being invited may accept. The initiating account may
    // still withdraw its request, but cannot accept on the target's behalf.
    const isInviteParticipant =
      invite.newUserId === userId || invite.existingUserId === userId;
    if (
      (input.accept && invite.existingUserId !== userId) ||
      (!input.accept && !isInviteParticipant)
    ) {
      throw new HttpError(403, "You cannot respond to this invite.");
    }
    if (invite.status !== "pending") {
      throw new HttpError(409, "Invite already resolved.");
    }
    const now = new Date();
    if (input.accept) {
      await insertLinkIfMissing(invite.newUserId, invite.existingUserId, "manual");
    }
    await db
      .update(accountLinkInvites)
      .set({
        status: input.accept ? "accepted" : "declined",
        respondedAt: now,
      })
      .where(eq(accountLinkInvites.id, invite.id));
    await writeAuditLog({
      req,
      userId,
      action: input.accept ? "account_link_accepted" : "account_link_declined",
      entityType: "account_link_invite",
      entityId: invite.id,
    });
    return ok(res, { ok: true, accepted: input.accept });
  })
);

const manualLinkSchema = z.object({
  otherPlatformAccountNumber: z.string().min(1),
});

router.post(
  "/manual",
  asyncHandler(async (req, res) => {
    const input = manualLinkSchema.parse(req.body);
    const userId = (req as any).auth.userId;
    const trimmedInput = input.otherPlatformAccountNumber.trim();
    const classification = classifyAccountNumber(trimmedInput);
    if (classification === ACCOUNT_NUMBER_NEW_INVALID) {
      throw new HttpError(400, "That account number doesn't look right.");
    }
    const trimmed =
      classification === ACCOUNT_NUMBER_NEW_VALID
        ? normalizeAccountNumberInput(trimmedInput)
        : trimmedInput.toUpperCase();
    if (!trimmed) throw new HttpError(400, "Account number is required.");
    const target = await db.query.users.findFirst({
      where: eq(users.platformAccountNumber, trimmed),
    });
    if (!target) {
      throw new HttpError(
        404,
        "We couldn't find a doctor with that account number."
      );
    }
    if (target.id === userId) {
      throw new HttpError(400, "That is your own account number.");
    }
    const pair = canonicalLinkPair(userId, target.id)!;
    const existingLink = await db.query.doctorAccountLinks.findFirst({
      where: and(
        eq(doctorAccountLinks.userIdLow, pair.low),
        eq(doctorAccountLinks.userIdHigh, pair.high)
      ),
    });
    if (existingLink) {
      return ok(res, { ok: true, alreadyLinked: true, invitePending: false });
    }

    const existingInvite = await db.query.accountLinkInvites.findFirst({
      where: and(
        eq(accountLinkInvites.newUserId, userId),
        eq(accountLinkInvites.existingUserId, target.id)
      ),
    });
    if (existingInvite?.status === "pending") {
      return ok(res, { ok: true, alreadyLinked: false, invitePending: true });
    }
    if (existingInvite) {
      throw new HttpError(409, "This account link invitation has already been resolved.");
    }

    const [invite] = await db
      .insert(accountLinkInvites)
      .values({
        newUserId: userId,
        existingUserId: target.id,
        matchedOn: "account_number",
        sentToPhone: null,
        sentAt: null,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();
    if (!invite) {
      // A concurrent request may have created the same invite.
      return ok(res, { ok: true, alreadyLinked: false, invitePending: true });
    }
    await writeAuditLog({
      req,
      userId,
      action: "account_link_invite_created",
      entityType: "user",
      entityId: target.id,
      metadataJson: { inviteId: invite.id },
    });
    return ok(res, { ok: true, alreadyLinked: false, invitePending: true });
  })
);

router.delete(
  "/:otherUserId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const otherUserId = String(req.params["otherUserId"] ?? "");
    const pair = canonicalLinkPair(userId, otherUserId);
    if (!pair) throw new HttpError(400, "Invalid user.");
    await db
      .delete(doctorAccountLinks)
      .where(
        and(
          eq(doctorAccountLinks.userIdLow, pair.low),
          eq(doctorAccountLinks.userIdHigh, pair.high)
        )
      );
    await writeAuditLog({
      req,
      userId,
      action: "account_link_removed",
      entityType: "user",
      entityId: otherUserId,
    });
    return ok(res, { ok: true });
  })
);

export default router;
