/**
 * Integration tests for the durable Messenger read contract:
 *   POST /api/messenger/conversations/:id/read
 *   GET  /api/messenger/conversations  (server-computed unreadCount)
 *
 * The unread badge is computed server-side from each viewer's
 * conversation_participants.last_read_at. These tests lock in the server-side
 * contract that the desktop client depends on:
 *
 *   1. After the read endpoint runs, a fresh conversations fetch reports
 *      unreadCount: 0 for that user.
 *   2. A message that arrives AFTER the read still counts as unread — the read
 *      watermark is bounded to the message the user actually saw (lastMessageId)
 *      and never advances past a newer, unseen message.
 *   3. Passing an older lastMessageId while a newer message exists keeps the
 *      newer message unread (matches the WebSocket mark_read semantics).
 *   4. A lastMessageId that does not belong to the conversation is rejected.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Messenger durable read contract (unread stays bounded to what was seen)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const meUserId = rid("ume");
  const otherUserId = rid("uot");
  const convId = rid("conv");
  const m1Id = rid("m1");
  const m2Id = rid("m2");

  // t1 < t2 so m2 is strictly newer than m1.
  const t1 = new Date("2024-01-01T00:00:00.000Z");
  const t2 = new Date("2024-01-02T00:00:00.000Z");

  let meToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function getUnreadCount(): Promise<number> {
    const res = await request(appMod.default)
      .get("/api/messenger/conversations")
      .set("Authorization", `Bearer ${meToken}`)
      .expect(200);
    const list: any[] = res.body.data ?? res.body;
    const conv = list.find((c) => c.id === convId);
    return conv ? Number(conv.unreadCount) : -1;
  }

  async function resetReadWatermark(lastReadAt: Date | null): Promise<void> {
    const { db, conversationParticipants } = dbMod as any;
    await db
      .update(conversationParticipants)
      .set({ lastReadAt })
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, meUserId)
        )
      );
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-messenger-read";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const {
      db,
      users,
      conversations,
      conversationParticipants,
      messages,
    } = dbMod as any;

    await db.insert(users).values([
      { id: meUserId, username: `me_${meUserId}`, password: "x" },
      { id: otherUserId, username: `ot_${otherUserId}`, password: "x" },
    ]);

    await db.insert(conversations).values({ id: convId });

    await db.insert(conversationParticipants).values([
      { conversationId: convId, userId: meUserId, lastReadAt: null },
      { conversationId: convId, userId: otherUserId, lastReadAt: null },
    ]);

    // Only m1 exists initially; m2 is inserted mid-suite to simulate a message
    // that arrives after the user's read.
    await db.insert(messages).values({
      id: m1Id,
      conversationId: convId,
      senderId: otherUserId,
      body: "first message",
      createdAt: t1,
    });

    meToken = await makeSession(meUserId);
  });

  // Refresh the session token before each test so a concurrent user_sessions
  // wipe from a sibling suite does not invalidate it mid-run.
  beforeEach(async () => {
    meToken = await makeSession(meUserId);
    // Start every test unread (last_read_at cleared) and with only m1 present is
    // guaranteed by test ordering; the newer-message test inserts m2 itself.
    await resetReadWatermark(null);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      conversations,
      conversationParticipants,
      messages,
      userSessions,
    } = dbMod as any;
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db
      .delete(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(userSessions).where(inArray(userSessions.userId, [meUserId, otherUserId]));
    await db.delete(users).where(inArray(users.id, [meUserId, otherUserId]));
  });

  it("reports unread before a read, and unreadCount 0 after reading the last message", async () => {
    expect(await getUnreadCount()).toBe(1);

    await request(appMod.default)
      .post(`/api/messenger/conversations/${convId}/read`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ lastMessageId: m1Id })
      .expect(200);

    expect(await getUnreadCount()).toBe(0);
  });

  it("keeps a message that arrives AFTER the read as unread", async () => {
    // Read up to m1.
    await request(appMod.default)
      .post(`/api/messenger/conversations/${convId}/read`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ lastMessageId: m1Id })
      .expect(200);
    expect(await getUnreadCount()).toBe(0);

    // A genuinely new message arrives after the read.
    const { db, messages } = dbMod as any;
    await db.insert(messages).values({
      id: m2Id,
      conversationId: convId,
      senderId: otherUserId,
      body: "arrived after read",
      createdAt: t2,
    });

    expect(await getUnreadCount()).toBe(1);

    // Cleanup m2 so other tests see a single-message conversation.
    await db.delete(messages).where(eq(messages.id, m2Id));
  });

  it("bounds last_read_at to the supplied older message, leaving newer messages unread", async () => {
    const { db, messages } = dbMod as any;
    // Two messages present: m1 (t1) and m2 (t2, newer).
    await db.insert(messages).values({
      id: m2Id,
      conversationId: convId,
      senderId: otherUserId,
      body: "newer message",
      createdAt: t2,
    });

    // Read but only up to the OLDER message m1 (the one actually seen).
    await request(appMod.default)
      .post(`/api/messenger/conversations/${convId}/read`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ lastMessageId: m1Id })
      .expect(200);

    // m2 must remain unread — the watermark did not jump to the latest message.
    expect(await getUnreadCount()).toBe(1);

    // Without lastMessageId, the fallback advances to the latest message (m2).
    await request(appMod.default)
      .post(`/api/messenger/conversations/${convId}/read`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({})
      .expect(200);
    expect(await getUnreadCount()).toBe(0);

    await db.delete(messages).where(eq(messages.id, m2Id));
  });

  it("rejects a lastMessageId that does not belong to the conversation", async () => {
    await request(appMod.default)
      .post(`/api/messenger/conversations/${convId}/read`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ lastMessageId: rid("bogus") })
      .expect(404);

    // A failed read must not advance the watermark.
    expect(await getUnreadCount()).toBe(1);
  });
});
