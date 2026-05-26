import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  conversations,
  conversationParticipants,
  messages,
  users,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { fanOutMessage } from "../lib/messenger-ws";

const router = Router();
router.use(requireAuth);

const messengerMediaDir = path.resolve(process.cwd(), "uploads", "messenger-media");

const messengerMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(messengerMediaDir, { recursive: true });
    cb(null, messengerMediaDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".bin";
    const safeBase = path
      .basename(file.originalname || "file", ext)
      .replace(/[^a-zA-Z0-9\-_]+/g, "-")
      .slice(0, 60) || "file";
    cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`);
  },
});

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
  "image/bmp", "image/tiff", "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const messengerMediaUpload = multer({
  storage: messengerMediaStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      ALLOWED_MIME_TYPES.has(file.mimetype) ||
      file.mimetype.startsWith("image/")
    ) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" is not allowed. Accepted types: images, PDF, Word documents, and plain text.`));
    }
  },
});

function getInitials(firstName?: string | null, lastName?: string | null, username?: string | null) {
  const f = firstName?.[0] ?? username?.[0] ?? "?";
  const l = lastName?.[0] ?? "";
  return (f + l).toUpperCase();
}

function getUserDisplayName(u: {
  firstName?: string | null;
  lastName?: string | null;
  username: string;
}): string {
  const parts = [u.firstName, u.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : u.username;
}

router.get(
  "/users/search",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const q = String(req.query.q ?? "").trim();
    if (!q) return ok(res, []);

    const like = `%${q}%`;
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        initials: users.initials,
        platformAccountNumber: users.platformAccountNumber,
        userType: users.userType,
        role: users.role,
        workStatus: users.workStatus,
      })
      .from(users)
      .where(
        and(
          ne(users.id, myUserId),
          isNull(users.deletedAt),
          or(
            sql`lower(${users.username}) like ${like.toLowerCase()}`,
            sql`lower(${users.firstName}) like ${like.toLowerCase()}`,
            sql`lower(${users.lastName}) like ${like.toLowerCase()}`,
            sql`lower(${users.platformAccountNumber}) like ${like.toLowerCase()}`
          )
        )
      )
      .limit(20);

    return ok(
      res,
      rows.map((u) => ({
        ...u,
        displayName: getUserDisplayName(u),
        initials: u.initials ?? getInitials(u.firstName, u.lastName, u.username),
      }))
    );
  })
);

router.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;

    const participations = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, myUserId));

    const convIds = participations.map((p) => p.conversationId);
    if (convIds.length === 0) return ok(res, []);

    const result = await Promise.all(
      convIds.map(async (cid) => {
        const [lastMsg] = await db
          .select({
            id: messages.id,
            body: messages.body,
            senderId: messages.senderId,
            createdAt: messages.createdAt,
            attachmentName: messages.attachmentName,
          })
          .from(messages)
          .where(
            and(eq(messages.conversationId, cid), isNull(messages.deletedAt))
          )
          .orderBy(desc(messages.createdAt))
          .limit(1);

        const myParticipation = await db
          .select({ lastReadAt: conversationParticipants.lastReadAt })
          .from(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.conversationId, cid),
              eq(conversationParticipants.userId, myUserId)
            )
          )
          .limit(1);

        const unreadCount = await db
          .select({ count: sql<string>`count(*)` })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, cid),
              isNull(messages.deletedAt),
              ne(messages.senderId, myUserId),
              myParticipation[0]?.lastReadAt
                ? sql`${messages.createdAt} > ${myParticipation[0].lastReadAt}`
                : sql`true`
            )
          );

        const otherParticipant = await db
          .select({
            userId: conversationParticipants.userId,
            username: users.username,
            firstName: users.firstName,
            lastName: users.lastName,
            initials: users.initials,
            workStatus: users.workStatus,
          })
          .from(conversationParticipants)
          .innerJoin(users, eq(users.id, conversationParticipants.userId))
          .where(
            and(
              eq(conversationParticipants.conversationId, cid),
              ne(conversationParticipants.userId, myUserId)
            )
          )
          .limit(1);

        const other = otherParticipant[0];
        const conv = await db
          .select({ updatedAt: conversations.updatedAt })
          .from(conversations)
          .where(eq(conversations.id, cid))
          .limit(1);

        return {
          id: cid,
          updatedAt: conv[0]?.updatedAt,
          lastMessage: lastMsg
            ? {
                id: lastMsg.id,
                body: lastMsg.body || (lastMsg.attachmentName ? `📎 ${lastMsg.attachmentName}` : ""),
                senderId: lastMsg.senderId,
                createdAt: lastMsg.createdAt,
              }
            : null,
          unreadCount: Number(unreadCount[0]?.count ?? 0),
          otherUser: other
            ? {
                id: other.userId,
                username: other.username,
                firstName: other.firstName,
                lastName: other.lastName,
                initials:
                  other.initials ??
                  getInitials(other.firstName, other.lastName, other.username),
                displayName: getUserDisplayName(other),
                workStatus: other.workStatus,
              }
            : null,
        };
      })
    );

    result.sort((a, b) => {
      const ta = a.lastMessage?.createdAt
        ? new Date(a.lastMessage.createdAt).getTime()
        : 0;
      const tb = b.lastMessage?.createdAt
        ? new Date(b.lastMessage.createdAt).getTime()
        : 0;
      return tb - ta;
    });

    return ok(res, result);
  })
);

const findOrCreateSchema = z.object({ otherUserId: z.string().min(1) });

router.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const { otherUserId } = findOrCreateSchema.parse(req.body);

    if (otherUserId === myUserId) {
      throw new HttpError(400, "Cannot start a conversation with yourself.");
    }

    const otherUser = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, otherUserId), isNull(users.deletedAt)))
      .limit(1);
    if (!otherUser[0]) throw new HttpError(404, "User not found.");

    const existing = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, myUserId));

    for (const { conversationId } of existing) {
      const others = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, otherUserId)
          )
        )
        .limit(1);
      if (others.length > 0) {
        return ok(res, { conversationId });
      }
    }

    const [conv] = await db
      .insert(conversations)
      .values({})
      .returning({ id: conversations.id });

    await db.insert(conversationParticipants).values([
      { conversationId: conv.id, userId: myUserId },
      { conversationId: conv.id, userId: otherUserId },
    ]);

    return ok(res, { conversationId: conv.id }, 201);
  })
);

const messagePageSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

router.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const convId = req.params.id;

    const participation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, myUserId)
        )
      )
      .limit(1);
    if (!participation[0]) throw new HttpError(403, "Not a participant.");

    const { before, limit } = messagePageSchema.parse(req.query);

    const rows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        body: messages.body,
        attachmentUrl: messages.attachmentUrl,
        attachmentName: messages.attachmentName,
        attachmentMimeType: messages.attachmentMimeType,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
        senderUsername: users.username,
        senderFirstName: users.firstName,
        senderLastName: users.lastName,
        senderInitials: users.initials,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, convId),
          isNull(messages.deletedAt),
          before
            ? sql`${messages.createdAt} < (select created_at from messages where id = ${before})`
            : undefined
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    const sorted = rows.reverse();

    return ok(
      res,
      sorted.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        senderId: r.senderId,
        body: r.body,
        attachmentUrl: r.attachmentUrl ?? undefined,
        attachmentName: r.attachmentName ?? undefined,
        attachmentMimeType: r.attachmentMimeType ?? undefined,
        createdAt: r.createdAt,
        sender: {
          id: r.senderId,
          username: r.senderUsername,
          firstName: r.senderFirstName,
          lastName: r.senderLastName,
          initials:
            r.senderInitials ??
            getInitials(r.senderFirstName, r.senderLastName, r.senderUsername),
          displayName: getUserDisplayName({
            firstName: r.senderFirstName,
            lastName: r.senderLastName,
            username: r.senderUsername,
          }),
        },
      }))
    );
  })
);

router.post(
  "/conversations/:id/read",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const convId = req.params.id;

    const participation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, myUserId)
        )
      )
      .limit(1);
    if (!participation[0]) throw new HttpError(403, "Not a participant.");

    const [lastMsg] = await db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(eq(messages.conversationId, convId), isNull(messages.deletedAt))
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (lastMsg) {
      await db
        .update(conversationParticipants)
        .set({ lastReadAt: lastMsg.createdAt })
        .where(
          and(
            eq(conversationParticipants.conversationId, convId),
            eq(conversationParticipants.userId, myUserId)
          )
        );
    }

    return ok(res, { ok: true });
  })
);

const sendMessageSchema = z.object({ body: z.string().max(4000) });

router.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const convId = req.params.id;

    const participation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, myUserId)
        )
      )
      .limit(1);
    if (!participation[0]) throw new HttpError(403, "Not a participant.");

    const { body } = sendMessageSchema.parse(req.body);
    if (!body.trim()) throw new HttpError(400, "Message body cannot be empty.");

    const [msg] = await db
      .insert(messages)
      .values({ conversationId: convId, senderId: myUserId, body })
      .returning();

    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, convId));

    const sender = await db
      .select({
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        initials: users.initials,
      })
      .from(users)
      .where(eq(users.id, myUserId))
      .limit(1);

    const participantIds = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, convId));

    const s = sender[0];
    const senderName = s
      ? getUserDisplayName({
          firstName: s.firstName,
          lastName: s.lastName,
          username: s.username,
        })
      : "Unknown";

    fanOutMessage(
      participantIds.map((p) => p.userId),
      {
        id: msg.id,
        conversationId: convId,
        senderId: myUserId,
        senderName,
        body: msg.body,
        createdAt: msg.createdAt.toISOString(),
      }
    );

    return ok(
      res,
      {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        body: msg.body,
        createdAt: msg.createdAt,
        sender: {
          id: myUserId,
          username: s?.username ?? "",
          firstName: s?.firstName,
          lastName: s?.lastName,
          initials:
            s?.initials ??
            getInitials(s?.firstName, s?.lastName, s?.username ?? ""),
          displayName: senderName,
        },
      },
      201
    );
  })
);

router.post(
  "/conversations/:id/attachments",
  messengerMediaUpload.single("file"),
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const convId = req.params.id;

    const participation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, myUserId)
        )
      )
      .limit(1);
    if (!participation[0]) throw new HttpError(403, "Not a participant.");

    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded.");

    const attachmentUrl = `/api/messenger/media/${encodeURIComponent(file.filename)}`;
    const attachmentName = file.originalname || file.filename;
    const attachmentMimeType = file.mimetype;
    const caption = typeof req.body?.caption === "string" ? req.body.caption.trim().slice(0, 500) : "";

    const [msg] = await db
      .insert(messages)
      .values({
        conversationId: convId,
        senderId: myUserId,
        body: caption,
        attachmentUrl,
        attachmentName,
        attachmentMimeType,
      })
      .returning();

    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, convId));

    const sender = await db
      .select({
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        initials: users.initials,
      })
      .from(users)
      .where(eq(users.id, myUserId))
      .limit(1);

    const participantIds = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, convId));

    const s = sender[0];
    const senderName = s
      ? getUserDisplayName({
          firstName: s.firstName,
          lastName: s.lastName,
          username: s.username,
        })
      : "Unknown";

    fanOutMessage(
      participantIds.map((p) => p.userId),
      {
        id: msg.id,
        conversationId: convId,
        senderId: myUserId,
        senderName,
        body: msg.body,
        attachmentUrl,
        attachmentName,
        attachmentMimeType,
        createdAt: msg.createdAt.toISOString(),
      }
    );

    return ok(
      res,
      {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        body: msg.body,
        attachmentUrl,
        attachmentName,
        attachmentMimeType,
        createdAt: msg.createdAt,
        sender: {
          id: myUserId,
          username: s?.username ?? "",
          firstName: s?.firstName,
          lastName: s?.lastName,
          initials:
            s?.initials ??
            getInitials(s?.firstName, s?.lastName, s?.username ?? ""),
          displayName: senderName,
        },
      },
      201
    );
  })
);

router.get(
  "/media/:filename",
  asyncHandler(async (req, res) => {
    const myUserId = (req as any).auth.userId as string;
    const filename = req.params.filename;

    if (!filename || filename.includes("..") || filename.includes("/")) {
      throw new HttpError(400, "Invalid filename.");
    }

    const attachmentUrl = `/api/messenger/media/${encodeURIComponent(filename)}`;

    const [msgRow] = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.attachmentUrl, attachmentUrl))
      .limit(1);

    if (!msgRow) {
      throw new HttpError(404, "File not found.");
    }

    const [participant] = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, msgRow.conversationId),
          eq(conversationParticipants.userId, myUserId)
        )
      )
      .limit(1);

    if (!participant) {
      throw new HttpError(403, "Access denied.");
    }

    const filePath = path.join(messengerMediaDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new HttpError(404, "File not found.");
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.sendFile(filePath);
  })
);

export default router;
