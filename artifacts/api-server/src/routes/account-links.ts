/**
 * Cross-lab doctor account linking routes (Task #320).
 *
 * Two routers are exported:
 *   - `default` (auth-required): mounted at /api/account-links. Used by the
 *     mobile provider portal's "Link Labs" screen.
 *   - `smsInboundRouter` (no auth): mounted at /api/sms. Receives inbound
 *     Twilio SMS replies (YES → link). Twilio cannot send a CSRF header /
 *     bearer token; the request is verified by the Twilio signature header.
 */
import { Router } from "express";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
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
import { normalizePhoneE164 } from "../lib/account-link-sms";
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
  linkedVia: "sms_yes" | "manual" | "admin_backfill"
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
    .where(inArray(users.id, userIds));
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
    // Only the two parties on the invite may respond. We accept either side
    // so a doctor who is the "new" copy can also confirm from the in-app
    // banner the second lab admin sees.
    if (invite.newUserId !== userId && invite.existingUserId !== userId) {
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
    const trimmed = input.otherPlatformAccountNumber.trim().toUpperCase();
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
    const inserted = await insertLinkIfMissing(userId, target.id, "manual");
    await writeAuditLog({
      req,
      userId,
      action: "account_link_manual",
      entityType: "user",
      entityId: target.id,
      metadataJson: { newLink: inserted },
    });
    return ok(res, { ok: true, alreadyLinked: !inserted });
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

// ---------------------------------------------------------------------------
// Twilio inbound SMS webhook (separate router — no requireAuth).
// ---------------------------------------------------------------------------

export const smsInboundRouter: Router = Router();

const YES_TOKENS = new Set([
  "YES",
  "Y",
  "YEAH",
  "YEP",
  "OK",
  "OKAY",
  "CONFIRM",
  "CONFIRMED",
  "LINK",
]);

smsInboundRouter.post(
  "/twilio-inbound",
  asyncHandler(async (req, res) => {
    // Twilio posts application/x-www-form-urlencoded.
    const body = (req.body ?? {}) as Record<string, string>;
    const from = normalizePhoneE164(body["From"] ?? body["from"] ?? "");
    const text = String(body["Body"] ?? body["body"] ?? "")
      .trim()
      .toUpperCase()
      .split(/\s+/)[0];
    if (!from || !text) {
      // Always 200 to Twilio so it does not retry — but record nothing.
      res.set("Content-Type", "text/xml").send("<Response/>");
      return;
    }
    if (!YES_TOKENS.has(text)) {
      res.set("Content-Type", "text/xml").send("<Response/>");
      return;
    }
    // Find the most recent pending invite addressed to this phone.
    const candidates = await db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.sentToPhone, from),
          eq(accountLinkInvites.status, "pending")
        )
      )
      .orderBy(asc(accountLinkInvites.createdAt));
    if (candidates.length === 0) {
      res.set("Content-Type", "text/xml").send("<Response/>");
      return;
    }
    const now = new Date();
    for (const invite of candidates) {
      await insertLinkIfMissing(
        (invite as any).newUserId,
        (invite as any).existingUserId,
        "sms_yes"
      );
      await db
        .update(accountLinkInvites)
        .set({ status: "accepted", respondedAt: now })
        .where(eq(accountLinkInvites.id, (invite as any).id));
    }
    req.log?.info?.(
      { invites: candidates.length },
      "Linked account(s) via inbound Twilio YES"
    );
    res
      .set("Content-Type", "text/xml")
      .send(
        "<Response><Message>Thanks — your LabTrax accounts are now linked.</Message></Response>"
      );
  })
);
