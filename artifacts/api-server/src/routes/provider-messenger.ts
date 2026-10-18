/**
 * Provider-Lab Messenger REST API
 *
 * Mounted at /provider-messenger.
 *
 * Endpoints:
 *   GET  /thread?labOrganizationId=          provider: get-or-create thread
 *   GET  /threads                             list threads for caller (with unread + preview)
 *   GET  /thread/:threadId/messages           paginated message list (newest-first)
 *   POST /thread/:threadId/messages           send a message (text + optional file)
 *   POST /thread/:threadId/read               advance read watermark
 *   GET  /thread/:threadId/read-watermark     the OTHER side's furthest read watermark
 *   GET  /unread-count                        total unread threads for caller
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import multer from "multer";
import { db } from "@workspace/db";
import {
  notifications,
  organizationMemberships,
  organizations,
  providerMessengerMessages,
  providerMessengerReadWatermarks,
  providerMessengerThreads,
  users,
} from "@workspace/db";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { notDeleted } from "../lib/soft-delete";
import {
  caseMediaObjectStorageAvailable,
  caseMediaObjectStorageKeyExists,
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";
import { deliverInAppNotification } from "../lib/in-app-notifications";
import {
  assertProviderOrganizationCapability,
  requireProviderCapability,
} from "../lib/provider-capabilities";
import { requireSelectedProviderOrganization } from "../lib/provider-selection";

const router = Router();
router.use(requireAuth);
// Messenger content can include patient information (attachments, case context).
// Require a verified account (email or phone confirmed) before any access,
// matching the gate applied to PHI routes such as cases and invoices.
router.use(requireVerifiedAccount);
// This router is also used by lab staff. The shared gate is a no-op for lab
// subjects, while provider accounts need Premium communication capability.
router.use(asyncHandler(async (req, _res, next) => {
  if ((req as any).user?.userType === "provider") {
    const org = await requireSelectedProviderOrganization(
      (req as any).auth.userId as string,
      req.header("x-provider-organization-id"),
    );
    (req as any).providerOrganizationId = org.id;
    await assertProviderOrganizationCapability(org.id, "communication");
  } else {
    await requireProviderCapability("communication")(
      req,
      _res,
      next,
    );
    return;
  }
  next();
}));

// ─── Messenger attachment MIME policy ─────────────────────────────────────────
//
// Allowlist maps canonical MIME type → safe file extension.
// HTML, SVG, JS and every other executable type are intentionally absent.
// The stored mimeType column always contains a value from this map, never the
// raw client-supplied header, so the download path cannot serve script content.

const MESSENGER_ALLOWED_MIMES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi",
};

// Only images may be served inline; videos and everything else get
// Content-Disposition: attachment so browsers never execute them.
const MESSENGER_INLINE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// ─── Multer setup (messenger attachments, ≤50 MB) ────────────────────────────

const messengerMediaDir = path.resolve(
  process.cwd(),
  "uploads",
  "messenger-media"
);

const messengerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(messengerMediaDir, { recursive: true });
    cb(null, messengerMediaDir);
  },
  filename: (_req, file, cb) => {
    // Derive extension from the allowlisted MIME type, NOT the client filename.
    const canonicalMime = (file.mimetype ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const ext = MESSENGER_ALLOWED_MIMES[canonicalMime] ?? ".bin";
    cb(
      null,
      `msg-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`
    );
  },
});

const messengerUpload = multer({
  storage: messengerStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const declared = (file.mimetype ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (MESSENGER_ALLOWED_MIMES[declared]) {
      cb(null, true);
    } else {
      cb(
        new HttpError(
          415,
          `File type "${declared}" is not allowed. Supported: images (JPEG, PNG, GIF, WebP, HEIC) and videos (MP4, MOV, WebM, AVI).`
        )
      );
    }
  },
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the provider organization IDs the calling user belongs to,
 * filtered to those whose parentLabOrganizationId = labOrganizationId.
 * Returns the first matching provider org id (providers typically belong to
 * one provider org per lab).
 */
async function getProviderOrgForLab(
  userId: string,
  labOrganizationId: string,
  selectedProviderOrganizationId?: string,
): Promise<string | null> {
  const memberships = await db
    .select({ orgId: organizationMemberships.labId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      )
    );

  const orgIds = memberships
    .map((m) => m.orgId)
    .filter((x): x is string => !!x);
  if (orgIds.length === 0) return null;

  const linked = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        inArray(organizations.id, selectedProviderOrganizationId ? [selectedProviderOrganizationId] : orgIds),
        eq(organizations.type, "provider"),
        eq(organizations.parentLabOrganizationId, labOrganizationId),
        notDeleted(organizations)
      )
    );

  return linked[0]?.id ?? null;
}

/**
 * Assert the calling user is a provider linked to the given lab.
 * Returns the caller's provider org id.
 */
async function requireProviderLabLink(
  userId: string,
  labOrganizationId: string,
  selectedProviderOrganizationId?: string,
): Promise<string> {
  const labOrg = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, labOrganizationId),
      eq(organizations.type, "lab"),
      notDeleted(organizations)
    ),
  });
  if (!labOrg) throw new HttpError(404, "Lab not found.");

  const providerOrgId = await getProviderOrgForLab(userId, labOrganizationId, selectedProviderOrganizationId);
  if (!providerOrgId) {
    throw new HttpError(403, "You are not linked to this lab.");
  }
  return providerOrgId;
}

/**
 * Assert the calling user is an active member of the given lab org.
 */
async function requireLabMembership(
  userId: string,
  labOrganizationId: string
): Promise<void> {
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, labOrganizationId),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt)
    ),
  });
  if (!membership) throw new HttpError(403, "You do not belong to this lab.");
}

/**
 * Filter a list of threads to only those whose provider org is non-deleted
 * and still linked (parentLabOrganizationId) to the thread's lab org, AND
 * whose lab org is non-deleted. Batches a single org query per call so it
 * scales across multiple threads without N+1 queries.
 */
async function filterEligibleThreads<
  T extends { providerOrganizationId: string; labOrganizationId: string },
>(threads: T[]): Promise<T[]> {
  if (threads.length === 0) return [];

  const providerOrgIds = [...new Set(threads.map((t) => t.providerOrganizationId))];
  const labOrgIds = [...new Set(threads.map((t) => t.labOrganizationId))];
  const allOrgIds = [...new Set([...providerOrgIds, ...labOrgIds])];

  const orgRows = await db
    .select({
      id: organizations.id,
      type: organizations.type,
      parentLabOrganizationId: organizations.parentLabOrganizationId,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(inArray(organizations.id, allOrgIds));

  // Index by id for O(1) lookup
  const orgMap = new Map(orgRows.map((o) => [o.id, o]));

  return threads.filter((t) => {
    const labOrg = orgMap.get(t.labOrganizationId);
    const providerOrg = orgMap.get(t.providerOrganizationId);
    // Both orgs must be non-deleted and the provider must still link to the lab
    return (
      labOrg && !labOrg.deletedAt &&
      providerOrg && !providerOrg.deletedAt &&
      providerOrg.parentLabOrganizationId === t.labOrganizationId
    );
  });
}

async function assertMessengerThreadCapabilities(
  userOrgIds: string[],
  threads: Array<{
    id: string;
    providerOrganizationId: string;
    labOrganizationId: string;
  }>,
): Promise<void> {
  const providerSide = new Set(
    threads
      .filter((thread) => userOrgIds.includes(thread.providerOrganizationId))
      .map((thread) => thread.id),
  );
  const providerOrgIds = [
    ...new Set(
      threads
        // A shared messenger route uses the lab-side authorization whenever
        // the caller has it; mixed memberships must not be treated as a
        // provider-only request.
        .filter(
          (thread) =>
            providerSide.has(thread.id) &&
            !userOrgIds.includes(thread.labOrganizationId),
        )
        .map((thread) => thread.providerOrganizationId),
    ),
  ];
  await Promise.all(
    providerOrgIds.map((id) =>
      assertProviderOrganizationCapability(id, "communication"),
    ),
  );
}

/**
 * Verify that both organizations referenced by a thread are still active:
 *  - Lab org: exists and is not soft-deleted.
 *  - Provider org: exists, is not soft-deleted, and is still linked to the
 *    correct lab via parentLabOrganizationId.
 *
 * Throws 403 if either org is gone or the provider↔lab linkage has been
 * removed (even if the user's own membership rows are still active).
 */
async function requireThreadOrgsEligible(
  thread: typeof providerMessengerThreads.$inferSelect
): Promise<void> {
  const [labOrg, providerOrg] = await Promise.all([
    db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, thread.labOrganizationId),
        notDeleted(organizations)
      ),
    }),
    db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, thread.providerOrganizationId),
        notDeleted(organizations),
        eq(
          organizations.parentLabOrganizationId,
          thread.labOrganizationId
        )
      ),
    }),
  ]);
  if (!labOrg || !providerOrg) {
    throw new HttpError(403, "Access denied.");
  }
}

/**
 * Ensure the thread belongs to the calling user's org (provider or lab)
 * AND that both organizations are still active and properly linked.
 * Returns the thread row.
 */
async function requireThreadAccess(
  userId: string,
  threadId: string,
  selectedProviderOrganizationId?: string,
): Promise<typeof providerMessengerThreads.$inferSelect> {
  const thread = await db.query.providerMessengerThreads.findFirst({
    where: eq(providerMessengerThreads.id, threadId),
  });
  if (!thread) throw new HttpError(404, "Thread not found.");
  if (selectedProviderOrganizationId &&
      thread.providerOrganizationId !== selectedProviderOrganizationId) {
    throw new HttpError(403, "Access denied.");
  }

  // Verify both orgs are still active and the provider↔lab link is intact.
  // This catches org soft-deletion and de-linking independently of membership.
  await requireThreadOrgsEligible(thread);

  // Check if user is an active, non-deleted member of either the provider org or the lab org.
  // Soft-deleted memberships (deletedAt IS NOT NULL) must be treated as revoked even when
  // status still reads "active" — a common state during async removal flows.
  const [providerMembership, labMembership] = await Promise.all([
    db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.labId, thread.providerOrganizationId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
      ),
    }),
    db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.labId, thread.labOrganizationId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
      ),
    }),
  ]);
  if (!providerMembership && !labMembership) {
    throw new HttpError(403, "Access denied.");
  }
  if (providerMembership && !labMembership) {
    await assertProviderOrganizationCapability(
      thread.providerOrganizationId,
      "communication",
    );
  }
  return thread;
}

// ─── Pre-multer auth gate for message uploads ─────────────────────────────────

/**
 * Validates thread access BEFORE Multer writes any bytes to disk. Unauthorized
 * or invalid-thread requests are rejected before a file lands on disk, preventing
 * disk-exhaustion from unauthenticated uploads.
 */
async function requireThreadAccessGate(
  req: Request,
  res: Response,
  next: Function
): Promise<void> {
  try {
    const userId = (req as any).auth?.userId as string | undefined;
    if (!userId) {
      res.status(401).json({ ok: false, error: "Unauthorized." });
      return;
    }
    const threadId = String(req.params.threadId ?? "");
    if (!threadId) {
      res.status(400).json({ ok: false, error: "threadId is required." });
      return;
    }
    // requireThreadAccess throws HttpError on failure
    await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);
    next();
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message });
      return;
    }
    next(err);
  }
}

// ─── Notification fan-out ─────────────────────────────────────────────────────

/**
 * After a message is saved, insert `provider_message` notification rows for
 * the OTHER side's active members. Non-fatal — errors are logged but not thrown.
 *
 * Provider → Lab: notify all active lab members.
 * Lab → Provider: notify the most recent provider-side sender by iterating
 * recent messages and checking their sender's org membership — avoids unreliable
 * UUID lexicographic comparison.
 */
async function fanOutNotifications(
  req: Request,
  thread: typeof providerMessengerThreads.$inferSelect,
  message: typeof providerMessengerMessages.$inferSelect,
  senderOrgId: string
): Promise<void> {
  try {
    // Target org = the org that did NOT send the message
    const targetOrgId =
      senderOrgId === thread.providerOrganizationId
        ? thread.labOrganizationId
        : thread.providerOrganizationId;

    let recipientUserIds: string[];

    if (senderOrgId === thread.providerOrganizationId) {
      // Provider → Lab: notify all active lab members
      const members = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, targetOrgId),
            eq(organizationMemberships.status, "active"),
            isNull(organizationMemberships.deletedAt)
          )
        );
      recipientUserIds = members
        .map((m) => m.userId)
        .filter((x): x is string => !!x);
    } else {
      // Lab → Provider: find the most recent provider-side sender by examining
      // recent messages and checking each sender's org membership. This avoids
      // the unreliable UUID lexicographic ordering used previously.
      const recentMsgs = await db.query.providerMessengerMessages.findMany({
        where: and(
          eq(providerMessengerMessages.threadId, thread.id),
          ne(providerMessengerMessages.id, message.id)
        ),
        orderBy: [desc(providerMessengerMessages.createdAt)],
        limit: 20,
      });

      let lastProviderSenderId: string | null = null;
      for (const msg of recentMsgs) {
        const membership = await db.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.userId, msg.senderUserId),
            eq(organizationMemberships.labId, targetOrgId),
            eq(organizationMemberships.status, "active"),
            isNull(organizationMemberships.deletedAt)
          ),
        });
        if (membership) {
          lastProviderSenderId = msg.senderUserId;
          break;
        }
      }

      if (lastProviderSenderId) {
        recipientUserIds = [lastProviderSenderId];
      } else {
        // No prior provider messages — notify all active provider org members
        const members = await db
          .select({ userId: organizationMemberships.userId })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.labId, targetOrgId),
              eq(organizationMemberships.status, "active"),
              isNull(organizationMemberships.deletedAt)
            )
          );
        recipientUserIds = members
          .map((m) => m.userId)
          .filter((x): x is string => !!x);
      }
    }

    // Exclude the sender themselves
    recipientUserIds = recipientUserIds.filter(
      (id) => id !== message.senderUserId
    );
    if (recipientUserIds.length === 0) return;

    const preview = message.body.slice(0, 200);
    if (senderOrgId === thread.providerOrganizationId) {
      await deliverInAppNotification({
        labOrganizationId: thread.labOrganizationId,
        recipientUserIds,
        category: "doctor_practice_message",
        type: "provider_message",
        title: "New messenger message",
        body: preview,
        dataJson: { threadId: thread.id, messageId: message.id },
      });
    } else {
      await db.insert(notifications).values(
        recipientUserIds.map((uid) => ({
          userId: uid,
          type: "provider_message",
          title: "New messenger message",
          body: preview,
          dataJson: {
            threadId: thread.id,
            messageId: message.id,
          },
        }))
      );
    }
  } catch (err: any) {
    (req as any).log?.warn?.(
      { err: err?.message },
      "provider-messenger: notification fan-out failed (non-fatal)"
    );
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /thread?labOrganizationId=<id>
 * Provider: get-or-create the thread for calling provider ↔ that lab.
 */
router.get(
  "/thread",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId =
      typeof req.query.labOrganizationId === "string"
        ? req.query.labOrganizationId.trim()
        : "";
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId query param is required.");
    }

    const providerOrgId = await requireProviderLabLink(
      userId,
      labOrganizationId,
      (req as any).providerOrganizationId,
    );
    await assertProviderOrganizationCapability(providerOrgId, "communication");

    // Upsert the thread
    const existing = await db.query.providerMessengerThreads.findFirst({
      where: and(
        eq(providerMessengerThreads.providerOrganizationId, providerOrgId),
        eq(providerMessengerThreads.labOrganizationId, labOrganizationId)
      ),
    });

    if (existing) {
      return ok(res, existing);
    }

    const [created] = await db
      .insert(providerMessengerThreads)
      .values({ providerOrganizationId: providerOrgId, labOrganizationId })
      .onConflictDoNothing()
      .returning()
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to create thread." })
      );

    // Race: another request may have inserted first; re-fetch if upsert returned nothing
    const thread =
      created ??
      (await db.query.providerMessengerThreads.findFirst({
        where: and(
          eq(providerMessengerThreads.providerOrganizationId, providerOrgId),
          eq(providerMessengerThreads.labOrganizationId, labOrganizationId)
        ),
      }));

    if (!thread) throw new HttpError(500, "Failed to get or create thread.");
    return ok(res, thread);
  })
);

/**
 * GET /threads
 * List all threads for the caller, with unread count and latest message preview.
 * - Providers: threads for their provider org(s)
 * - Lab users: threads for their lab org
 */
router.get(
  "/threads",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;

    // Get all orgs the user belongs to
    const memberships = await db
      .select({ orgId: organizationMemberships.labId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        )
      );

    const orgIds = (req as any).providerOrganizationId
      ? [(req as any).providerOrganizationId as string]
      : memberships.map((m) => m.orgId).filter((x): x is string => !!x);

    // Find threads where the user's org appears on either side
    const threads = await db
      .select()
      .from(providerMessengerThreads)
      .where(
        or(
          inArray(providerMessengerThreads.providerOrganizationId, orgIds),
          inArray(providerMessengerThreads.labOrganizationId, orgIds)
        )
      )
      .orderBy(desc(providerMessengerThreads.lastMessageAt));

    // Drop threads where either org has been soft-deleted or the provider's
    // parentLabOrganizationId no longer matches — org-level revocation.
    const eligibleThreads = await filterEligibleThreads(threads);
    await assertMessengerThreadCapabilities(orgIds, eligibleThreads);

    // Batch-fetch org names for all threads so the client can display provider
    // and lab names without a separate (often admin-gated) organizations call.
    const allThreadOrgIds = [
      ...new Set(
        eligibleThreads.flatMap((t) => [
          t.providerOrganizationId,
          t.labOrganizationId,
        ])
      ),
    ];
    const threadOrgRows =
      allThreadOrgIds.length > 0
        ? await db
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(inArray(organizations.id, allThreadOrgIds))
        : [];
    const threadOrgNameMap = new Map(
      threadOrgRows.map((o) => [o.id, o.name ?? null])
    );

    // Build unread counts and latest message previews
    const enriched = await Promise.all(
      eligibleThreads.map(async (thread) => {
        // Get the user's read watermark for this thread
        const watermark =
          await db.query.providerMessengerReadWatermarks.findFirst({
            where: and(
              eq(providerMessengerReadWatermarks.threadId, thread.id),
              eq(providerMessengerReadWatermarks.userId, userId)
            ),
          });

        // Count unread messages — exclude caller's own messages and use SQL
        // subquery for timestamp comparison to avoid JS Date truncation issues.
        let unreadCount = 0;
        if (watermark?.lastReadMessageId) {
          const lastReadMsgId = watermark.lastReadMessageId;
          const [countRow] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(providerMessengerMessages)
            .where(
              and(
                eq(providerMessengerMessages.threadId, thread.id),
                ne(providerMessengerMessages.senderUserId, userId),
                sql`${providerMessengerMessages.createdAt} > (
                  SELECT created_at FROM provider_messenger_messages
                  WHERE id = ${lastReadMsgId}
                )`
              )
            );
          unreadCount = countRow?.count ?? 0;
        } else {
          // No watermark — all messages from others are unread
          const [countRow] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(providerMessengerMessages)
            .where(
              and(
                eq(providerMessengerMessages.threadId, thread.id),
                ne(providerMessengerMessages.senderUserId, userId)
              )
            );
          unreadCount = countRow?.count ?? 0;
        }

        // Latest message preview
        const latestMsg =
          await db.query.providerMessengerMessages.findFirst({
            where: eq(providerMessengerMessages.threadId, thread.id),
            orderBy: [desc(providerMessengerMessages.createdAt)],
          });

        return {
          ...thread,
          providerOrganizationName:
            threadOrgNameMap.get(thread.providerOrganizationId) ?? null,
          labOrganizationName:
            threadOrgNameMap.get(thread.labOrganizationId) ?? null,
          unreadCount,
          latestMessagePreview: latestMsg
            ? {
                id: latestMsg.id,
                body: latestMsg.body.slice(0, 100),
                senderUserId: latestMsg.senderUserId,
                createdAt: latestMsg.createdAt,
              }
            : null,
        };
      })
    );

    return ok(res, enriched);
  })
);

/**
 * Escape LIKE/ILIKE special characters (\, %, _) in user-supplied search text
 * so a query containing them is matched literally instead of as a wildcard.
 */
function escapeLikeSpecialChars(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * GET /thread/:threadId/messages?before=<messageId>&limit=<n>&q=<search text>
 * Paginated message list, newest-first cursor pagination.
 *
 * When `q` is provided, results are filtered to messages whose body contains
 * the search text (case-insensitive) so the client can search further back
 * than whatever page of history it currently has loaded. Searches use a
 * higher result cap than plain pagination since they may need to surface
 * matches scattered across a long thread.
 */
router.get(
  "/thread/:threadId/messages",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const threadId = req.params.threadId as string;

    await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const isSearch = q.length > 0;
    const maxLimit = isSearch ? 200 : 100;
    const defaultLimit = isSearch ? 100 : 50;

    const limitRaw = parseInt(String(req.query.limit ?? String(defaultLimit)), 10);
    const limit = isNaN(limitRaw) || limitRaw < 1 ? defaultLimit : Math.min(limitRaw, maxLimit);

    const beforeId =
      typeof req.query.before === "string" ? req.query.before.trim() : null;

    let beforeCursor: Date | null = null;
    if (beforeId) {
      const cursorMsg = await db.query.providerMessengerMessages.findFirst({
        where: eq(providerMessengerMessages.id, beforeId),
      });
      if (!cursorMsg) throw new HttpError(400, "Invalid cursor: message not found.");
      beforeCursor = cursorMsg.createdAt;
    }

    const conditions = [eq(providerMessengerMessages.threadId, threadId)];
    if (beforeCursor) {
      conditions.push(lt(providerMessengerMessages.createdAt, beforeCursor));
    }
    if (isSearch) {
      conditions.push(
        ilike(providerMessengerMessages.body, `%${escapeLikeSpecialChars(q)}%`)
      );
    }

    const rows = await db.query.providerMessengerMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(providerMessengerMessages.createdAt)],
      limit,
    });

    return ok(res, rows);
  })
);

/**
 * POST /thread/:threadId/messages
 * Send a message. Body is multipart/form-data with:
 *   - text: string (required)
 *   - formattingJson: optional JSON string
 *   - file: optional image/video attachment (≤50 MB)
 */
router.post(
  "/thread/:threadId/messages",
  // Auth gate runs BEFORE Multer: unauthorized requests are rejected before
  // any file bytes are written to disk, preventing disk-exhaustion attacks.
  requireThreadAccessGate as any,
  messengerUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const threadId = req.params.threadId as string;

    // Thread access was already validated in the gate; re-fetch for the row.
    const thread = await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);

    // Capture disk path early so all failure paths can clean up.
    const diskPath = req.file
      ? path.resolve(messengerMediaDir, req.file.filename)
      : null;

    // Helper: remove the uploaded file on any validation/DB failure.
    function cleanupFile() {
      if (diskPath) fs.unlink(diskPath, () => {});
    }

    // Determine which org the sender belongs to (provider or lab side).
    // Soft-deleted memberships are excluded to prevent removed members from sending.
    const providerMembership = await db.query.organizationMemberships.findFirst(
      {
        where: and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.labId, thread.providerOrganizationId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        ),
      }
    );
    const senderOrgId = providerMembership
      ? thread.providerOrganizationId
      : thread.labOrganizationId;

    // Validate text
    const bodyText =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!bodyText && !req.file) {
      cleanupFile();
      throw new HttpError(400, "Please provide a message text or attach a file.");
    }

    // Validate formattingJson (optional)
    let formattingJson: object | null = null;
    if (
      typeof req.body?.formattingJson === "string" &&
      req.body.formattingJson.trim()
    ) {
      try {
        formattingJson = JSON.parse(req.body.formattingJson);
      } catch {
        cleanupFile();
        throw new HttpError(400, "formattingJson must be valid JSON.");
      }
    }

    // Handle optional file attachment
    let mediaKey: string | null = null;
    let mimeType: string | null = null;

    if (req.file) {
      mimeType = req.file.mimetype || "application/octet-stream";

      // Mirror to object storage
      if (caseMediaObjectStorageAvailable()) {
        try {
          const buffer = await readFile(diskPath!);
          const written = await writeCaseMediaToObjectStorage(
            req.file.filename,
            buffer,
            mimeType
          );
          if (written) mediaKey = req.file.filename;
        } catch (err: any) {
          (req as any).log?.warn?.(
            { err: err?.message },
            "provider-messenger: object storage mirror failed; disk-only"
          );
          // Fall back to disk key so the row still references the file
          mediaKey = req.file.filename;
        }
      } else {
        // No object storage — store the disk filename as the key
        mediaKey = req.file.filename;
      }
    }

    // Insert message
    let savedMessage: typeof providerMessengerMessages.$inferSelect;
    try {
      const [inserted] = await db
        .insert(providerMessengerMessages)
        .values({
          threadId: threadId as string,
          senderUserId: userId,
          body: bodyText || (req.file ? req.file.originalname || "" : ""),
          formattingJson: formattingJson as any,
          mediaKey,
          mimeType,
        })
        .returning()
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to save message." })
        );
      savedMessage = inserted;
    } catch (err) {
      cleanupFile();
      throw err;
    }

    // Update thread lastMessageAt
    await db
      .update(providerMessengerThreads)
      .set({ lastMessageAt: savedMessage.createdAt as Date })
      .where(eq(providerMessengerThreads.id, threadId as string))
      .catch(() => {});

    // Fan-out notifications (non-fatal)
    // NOTE: we intentionally do NOT advance the sender's read watermark here.
    // Own messages are excluded from unread-count queries via a senderUserId !=
    // userId filter, so the sender will never see their own outbound messages as
    // unread. Auto-advancing the watermark would silently clear already-received
    // inbound messages that the sender hasn't explicitly read yet.
    await fanOutNotifications(req, thread, savedMessage, senderOrgId);

    return ok(res, savedMessage, 201);
  })
);

/**
 * POST /thread/:threadId/read
 * Advance the calling user's read watermark to the latest message.
 */
router.post(
  "/thread/:threadId/read",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const threadId = req.params.threadId as string;

    await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);

    // Find the latest message in this thread
    const latestMsg = await db.query.providerMessengerMessages.findFirst({
      where: eq(providerMessengerMessages.threadId, threadId),
      orderBy: [desc(providerMessengerMessages.createdAt)],
    });

    if (!latestMsg) {
      // Thread has no messages; nothing to mark
      return ok(res, { threadId, lastReadMessageId: null });
    }

    // Upsert the watermark
    await db
      .insert(providerMessengerReadWatermarks)
      .values({
        threadId: threadId as string,
        userId: userId as string,
        lastReadMessageId: latestMsg.id,
      })
      .onConflictDoUpdate({
        target: [
          providerMessengerReadWatermarks.threadId,
          providerMessengerReadWatermarks.userId,
        ],
        set: {
          lastReadMessageId: latestMsg.id,
          updatedAt: new Date(),
        },
      })
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to update read watermark." })
      );

    return ok(res, { threadId, lastReadMessageId: latestMsg.id });
  })
);

/**
 * GET /unread-count
 * Returns { total: number } summing unread message count across all threads
 * for the current user.
 */
router.get(
  "/unread-count",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;

    // Get all orgs the user belongs to
    const memberships = await db
      .select({ orgId: organizationMemberships.labId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        )
      );

    const orgIds = (req as any).providerOrganizationId
      ? [(req as any).providerOrganizationId as string]
      : memberships.map((m) => m.orgId).filter((x): x is string => !!x);
    if (orgIds.length === 0) {
      return ok(res, { total: 0 });
    }

    // Find all threads the user participates in
    const rawThreads = await db
      .select({
        id: providerMessengerThreads.id,
        providerOrganizationId: providerMessengerThreads.providerOrganizationId,
        labOrganizationId: providerMessengerThreads.labOrganizationId,
      })
      .from(providerMessengerThreads)
      .where(
        or(
          inArray(providerMessengerThreads.providerOrganizationId, orgIds),
          inArray(providerMessengerThreads.labOrganizationId, orgIds)
        )
      );

    // Drop threads where either org has been soft-deleted or the provider's
    // parentLabOrganizationId no longer matches — org-level revocation.
    const allThreads = await filterEligibleThreads(rawThreads);
    await assertMessengerThreadCapabilities(orgIds, allThreads);

    if (allThreads.length === 0) {
      return ok(res, { total: 0 });
    }

    const threadIds = allThreads.map((t) => t.id);

    // Get all watermarks for this user across these threads
    const watermarks = await db
      .select()
      .from(providerMessengerReadWatermarks)
      .where(
        and(
          eq(providerMessengerReadWatermarks.userId, userId),
          inArray(providerMessengerReadWatermarks.threadId, threadIds)
        )
      );

    const watermarkByThread = new Map(
      watermarks.map((w) => [w.threadId, w.lastReadMessageId])
    );

    // For each thread, count unread messages from others (exclude own),
    // using SQL subqueries to avoid JS Date millisecond-truncation issues.
    let total = 0;
    await Promise.all(
      threadIds.map(async (tid) => {
        const lastReadMsgId = watermarkByThread.get(tid) ?? null;
        if (lastReadMsgId) {
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(providerMessengerMessages)
            .where(
              and(
                eq(providerMessengerMessages.threadId, tid),
                ne(providerMessengerMessages.senderUserId, userId),
                sql`${providerMessengerMessages.createdAt} > (
                  SELECT created_at FROM provider_messenger_messages
                  WHERE id = ${lastReadMsgId}
                )`
              )
            );
          total += row?.count ?? 0;
          return;
        }
        // No watermark — all messages from others are unread
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(providerMessengerMessages)
          .where(
            and(
              eq(providerMessengerMessages.threadId, tid),
              ne(providerMessengerMessages.senderUserId, userId)
            )
          );
        total += row?.count ?? 0;
      })
    );

    return ok(res, { total });
  })
);

/**
 * GET /thread/:threadId/messages/:messageId/media
 * Stream the attachment for a message. Requires thread membership.
 * Tries object storage first, falls back to local disk.
 */
router.get(
  "/thread/:threadId/messages/:messageId/media",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const threadId = req.params.threadId as string;
    const messageId = req.params.messageId as string;

    await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);

    // Fetch the message and verify it belongs to this thread
    const message = await db.query.providerMessengerMessages.findFirst({
      where: and(
        eq(providerMessengerMessages.id, messageId),
        eq(providerMessengerMessages.threadId, threadId)
      ),
    });
    if (!message) throw new HttpError(404, "Message not found.");
    if (!message.mediaKey) throw new HttpError(404, "No attachment on this message.");

    // Use only the allowlisted canonical MIME, never the raw client-supplied value.
    // Fall back to octet-stream for any legacy rows that pre-date the allowlist.
    const storedMime = message.mimeType ?? "";
    const safeMime = MESSENGER_ALLOWED_MIMES[storedMime]
      ? storedMime
      : "application/octet-stream";

    // Only allowlisted image types may be served inline — everything else
    // (videos, legacy rows) must be downloaded so browsers never execute them.
    const isInlineSafe = MESSENGER_INLINE_MIMES.has(safeMime);
    const safeFilename = path.basename(message.mediaKey);
    const disposition = isInlineSafe
      ? `inline; filename="${safeFilename}"`
      : `attachment; filename="${safeFilename}"`;
    // Videos are served with their real MIME type so that browsers can decode
    // the fetched blob as playable video inside an authed object URL. The
    // Content-Disposition: attachment header above already prevents inline
    // execution; script/HTML types are blocked by the MESSENGER_ALLOWED_MIMES
    // allowlist above, so there is no XSS risk from allowing video/* here.
    const isVideoSafe = safeMime.startsWith("video/");
    const servedMime =
      isInlineSafe || isVideoSafe ? safeMime : "application/octet-stream";

    // Security headers applied to every media response
    function applyMediaHeaders() {
      res.setHeader("Content-Type", servedMime);
      res.setHeader("Content-Disposition", disposition);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=300");
    }

    // Try object storage first
    if (caseMediaObjectStorageAvailable()) {
      const objStream = await openCaseMediaObjectStream(
        message.mediaKey,
        safeMime
      );
      if (objStream) {
        applyMediaHeaders();
        objStream.stream.on("error", () => {
          if (!res.headersSent) {
            res.status(404).json({ ok: false, error: "File not found." });
          }
        });
        objStream.stream.pipe(res);
        return;
      }
    }

    // Fall back to local disk
    const diskPath = path.resolve(messengerMediaDir, message.mediaKey);
    if (!fs.existsSync(diskPath)) {
      throw new HttpError(404, "Attachment file not found.");
    }
    applyMediaHeaders();
    fs.createReadStream(diskPath).pipe(res);
  })
);

/**
 * GET /thread/:threadId/read-watermark
 *
 * Returns how far the OPPOSITE org (relative to the caller) has read this
 * thread, aggregated across all of that org's active members — the furthest
 * (most recent) watermark wins. Powers the "Seen" indicator under the
 * caller's own most recent message: the caller compares this timestamp
 * against their last-sent message's createdAt.
 *
 * Symmetric: a provider caller gets the lab side's watermark; a lab caller
 * gets the provider side's watermark.
 */
router.get(
  "/thread/:threadId/read-watermark",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const threadId = String(req.params.threadId ?? "");

    // Throws 404 (unknown thread) / 403 (non-member or revoked org link).
    const thread = await requireThreadAccess(userId, threadId, (req as any).providerOrganizationId);

    // Which side is the caller on? Membership in the provider org means the
    // opposite side is the lab, and vice versa.
    const callerProviderMembership =
      await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.labId, thread.providerOrganizationId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        ),
      });

    const otherOrgId = callerProviderMembership
      ? thread.labOrganizationId
      : thread.providerOrganizationId;

    const otherMembers = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, otherOrgId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        )
      );

    const otherUserIds = otherMembers
      .map((m) => m.userId)
      .filter((x): x is string => !!x);

    if (otherUserIds.length === 0) {
      return ok(res, { lastReadMessageId: null, lastReadMessageCreatedAt: null });
    }

    const watermarks = await db
      .select({ lastReadMessageId: providerMessengerReadWatermarks.lastReadMessageId })
      .from(providerMessengerReadWatermarks)
      .where(
        and(
          eq(providerMessengerReadWatermarks.threadId, threadId),
          inArray(providerMessengerReadWatermarks.userId, otherUserIds)
        )
      );

    const watermarkMessageIds = watermarks
      .map((w) => w.lastReadMessageId)
      .filter((x): x is string => !!x);

    if (watermarkMessageIds.length === 0) {
      return ok(res, { lastReadMessageId: null, lastReadMessageCreatedAt: null });
    }

    // Order by the messages' own createdAt so the furthest-advanced member
    // wins, rather than whichever watermark row happens to be returned first.
    const [furthest] = await db
      .select({
        id: providerMessengerMessages.id,
        createdAt: providerMessengerMessages.createdAt,
      })
      .from(providerMessengerMessages)
      .where(inArray(providerMessengerMessages.id, watermarkMessageIds))
      .orderBy(desc(providerMessengerMessages.createdAt))
      .limit(1);

    return ok(res, {
      lastReadMessageId: furthest?.id ?? null,
      lastReadMessageCreatedAt: furthest?.createdAt ?? null,
    });
  })
);

export default router;
