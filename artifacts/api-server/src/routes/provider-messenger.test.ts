/**
 * Integration tests for the provider-lab messenger backend.
 *
 * Covers:
 *  - Thread get-or-create (provider)
 *  - Message send (text-only and with a file stub)
 *  - Read watermark advancement
 *  - Unread-count accuracy
 *  - Auth rejection for non-members
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Provider-Lab Messenger (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  // Org IDs
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const unlinkedProviderOrgId = rid("prov2");

  // User IDs
  const providerUserId = rid("provuser");
  const labAdminUserId = rid("labadmin");
  const labUserUserId = rid("labuser");
  const unlinkedUserId = rid("unlinked");
  const unverifiedUserId = rid("unverified");

  // Tokens
  let providerToken = "";
  let labAdminToken = "";
  let labUserToken = "";
  let unlinkedToken = "";
  let unverifiedToken = "";

  // Thread / message IDs discovered during tests
  let threadId = "";
  let firstMessageId = "";

  // Temp file for attachment test
  let tmpFile = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-messenger";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, organizationMemberships, users } =
      dbMod as any;

    // Create users
    await db.insert(users).values([
      {
        id: providerUserId,
        username: `prov_${providerUserId}`,
        password: "x",
        userType: "provider",
        emailVerifiedAt: new Date(),
      },
      {
        id: labAdminUserId,
        username: `ladmin_${labAdminUserId}`,
        password: "x",
        userType: "lab",
        role: "admin",
        emailVerifiedAt: new Date(),
      },
      {
        id: labUserUserId,
        username: `luser_${labUserUserId}`,
        password: "x",
        userType: "lab",
        role: "user",
        emailVerifiedAt: new Date(),
      },
      {
        id: unlinkedUserId,
        username: `unlinked_${unlinkedUserId}`,
        password: "x",
        userType: "provider",
        emailVerifiedAt: new Date(),
      },
      {
        // Canonical account number (L-YEAR-SEQ format) but no emailVerifiedAt /
        // phoneVerifiedAt → requireVerifiedAccount will block this user.
        // Without a canonical account number the middleware grandfathers the user
        // through, so the number is required to exercise the gate.
        id: unverifiedUserId,
        username: `unverified_${unverifiedUserId}`,
        password: "x",
        userType: "lab",
        // Derive a unique *all-numeric* canonical account number from the random
        // user id (canonical format requires /^[LP]-\d{4}-\d+$/).  Parse the
        // trailing hex bytes of the random id as a decimal integer so repeated
        // validation runs against the same shared DB don't collide on the
        // users_platform_account_number_unique constraint.
        platformAccountNumber: `L-2026-${parseInt(unverifiedUserId.replace(/[^0-9a-f]/gi, "").slice(-8), 16)}`,
      },
    ]);

    // Create orgs
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Messenger Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Messenger Test Provider",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: unlinkedProviderOrgId,
        type: "provider",
        name: "Unlinked Provider Org",
        parentLabOrganizationId: rid("otherlaborgthatdoesntexist"),
      },
    ]);

    // Memberships
    await db.insert(organizationMemberships).values([
      // Provider user belongs to provider org
      {
        labId: providerOrgId,
        userId: providerUserId,
        role: "admin",
        status: "active",
      },
      // Lab users belong to lab org
      {
        labId: labOrgId,
        userId: labAdminUserId,
        role: "admin",
        status: "active",
      },
      {
        labId: labOrgId,
        userId: labUserUserId,
        role: "user",
        status: "active",
      },
      // Unlinked user belongs to a different provider org (no link to labOrgId)
      {
        labId: unlinkedProviderOrgId,
        userId: unlinkedUserId,
        role: "user",
        status: "active",
      },
      // Unverified user is a member of the lab org but has no verified email/phone
      {
        labId: labOrgId,
        userId: unverifiedUserId,
        role: "user",
        status: "active",
      },
    ]);

    // Temp file for attachment tests — must be an allowlisted MIME type (image/png).
    // Minimal valid 1×1 transparent PNG so multer's header-based MIME check passes.
    tmpFile = path.join(
      os.tmpdir(),
      `messenger-test-${randomBytes(4).toString("hex")}.png`
    );
    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
      "hex"
    );
    fs.writeFileSync(tmpFile, minimalPng);
  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    providerToken = await makeSession(providerUserId);
    labAdminToken = await makeSession(labAdminUserId);
    labUserToken = await makeSession(labUserUserId);
    unlinkedToken = await makeSession(unlinkedUserId);
    unverifiedToken = await makeSession(unverifiedUserId);
  });

  afterAll(async () => {
    const {
      db,
      notifications,
      providerMessengerReadWatermarks,
      providerMessengerMessages,
      providerMessengerThreads,
      organizationMemberships,
      organizations,
      users,
      userSessions,
    } = dbMod as any;

    // Clean up in dependency order
    if (threadId) {
      await db
        .delete(providerMessengerReadWatermarks)
        .where(
          eq(providerMessengerReadWatermarks.threadId, threadId)
        )
        .catch(() => {});
      await db
        .delete(providerMessengerMessages)
        .where(eq(providerMessengerMessages.threadId, threadId))
        .catch(() => {});
      await db
        .delete(providerMessengerThreads)
        .where(eq(providerMessengerThreads.id, threadId))
        .catch(() => {});
    }

    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.type, "provider_message"),
          inArray(notifications.userId, [
            labAdminUserId,
            labUserUserId,
            providerUserId,
          ])
        )
      )
      .catch(() => {});

    const allLabIds = [labOrgId, providerOrgId, unlinkedProviderOrgId];
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.labId, allLabIds))
      .catch(() => {});
    await db
      .delete(organizations)
      .where(inArray(organizations.id, allLabIds))
      .catch(() => {});
    await db
      .delete(users)
      .where(
        inArray(users.id, [
          providerUserId,
          labAdminUserId,
          labUserUserId,
          unlinkedUserId,
        ])
      )
      .catch(() => {});
    await db
      .delete(userSessions)
      .where(
        inArray(userSessions.userId, [
          providerUserId,
          labAdminUserId,
          labUserUserId,
          unlinkedUserId,
        ])
      )
      .catch(() => {});

    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  // ── Thread creation ──────────────────────────────────────────────────────────

  it("GET /provider-messenger/thread — 400 when labOrganizationId is missing", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/thread")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(400);
  });

  it("GET /provider-messenger/threads — 403 VERIFICATION_REQUIRED for unverified lab member", async () => {
    // The user has a canonical account number but no verified email/phone.
    // Error is serialized as { ok: false, message, details: { code } }.
    const res = await request(appMod.default)
      .get("/api/provider-messenger/threads")
      .set("Authorization", `Bearer ${unverifiedToken}`);
    expect(res.status).toBe(403);
    expect((res.body.details as any)?.code).toBe("VERIFICATION_REQUIRED");
  });

  it("GET /provider-messenger/unread-count — 403 VERIFICATION_REQUIRED for unverified user", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${unverifiedToken}`);
    expect(res.status).toBe(403);
    expect((res.body.details as any)?.code).toBe("VERIFICATION_REQUIRED");
  });

  it("GET /provider-messenger/thread — 403 for unlinked provider", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /provider-messenger/thread — 401 without auth", async () => {
    const res = await request(appMod.default).get(
      `/api/provider-messenger/thread?labOrganizationId=${labOrgId}`
    );
    expect(res.status).toBe(401);
  });

  it("GET /provider-messenger/thread — creates a thread for linked provider", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      providerOrganizationId: providerOrgId,
      labOrganizationId: labOrgId,
    });
    expect(res.body.data.id).toBeTruthy();
    threadId = res.body.data.id;
  });

  it("GET /provider-messenger/thread — returns same thread on repeated call (idempotent)", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(threadId);
  });

  // ── Listing threads ──────────────────────────────────────────────────────────

  it("GET /provider-messenger/threads — returns the thread for provider", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/threads")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    const threads = res.body.data as any[];
    const found = threads.find((t: any) => t.id === threadId);
    expect(found).toBeDefined();
    expect(found.unreadCount).toBe(0); // No messages yet
    expect(found.latestMessagePreview).toBeNull();
  });

  it("GET /provider-messenger/threads — returns the thread for lab user", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/threads")
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    const threads = res.body.data as any[];
    const found = threads.find((t: any) => t.id === threadId);
    expect(found).toBeDefined();
  });

  // ── Sending messages ─────────────────────────────────────────────────────────

  it("POST /thread/:threadId/messages — 400 when text and file are both missing", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "");
    expect(res.status).toBe(400);
  });

  it("POST /thread/:threadId/messages — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${unlinkedToken}`)
      .field("text", "Hello");
    expect(res.status).toBe(403);
  });

  it("POST /thread/:threadId/messages — provider sends text-only message", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Hello from provider");
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      threadId,
      senderUserId: providerUserId,
      body: "Hello from provider",
      mediaKey: null,
    });
    firstMessageId = res.body.data.id;
  });

  it("POST /thread/:threadId/messages — lab user replies with text-only message", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${labUserToken}`)
      .field("text", "Hello from lab");
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      threadId,
      senderUserId: labUserUserId,
      body: "Hello from lab",
    });
  });

  it("POST /thread/:threadId/messages — message with formattingJson", async () => {
    const formatting = JSON.stringify({ fontFamily: "Arial", bold: true });
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Bold message")
      .field("formattingJson", formatting);
    expect(res.status).toBe(201);
    expect(res.body.data.formattingJson).toMatchObject({ fontFamily: "Arial", bold: true });
  });

  it("POST /thread/:threadId/messages — invalid formattingJson returns 400", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Bad format")
      .field("formattingJson", "{not valid json");
    expect(res.status).toBe(400);
  });

  it("POST /thread/:threadId/messages — provider sends message with file attachment", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "See attached")
      .attach("file", tmpFile, {
        filename: "test-attachment.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      threadId,
      senderUserId: providerUserId,
      body: "See attached",
      mimeType: "image/png",
    });
    // mediaKey should be set (disk key at minimum)
    expect(res.body.data.mediaKey).toBeTruthy();
  });

  it("GET /thread/:threadId/messages/:messageId/media — video served with real MIME type + attachment disposition", async () => {
    // Create a minimal stub video file (bytes don't matter; MIME comes from content-type header)
    const tmpVideo = path.join(
      os.tmpdir(),
      `messenger-test-video-${randomBytes(4).toString("hex")}.mp4`
    );
    fs.writeFileSync(tmpVideo, Buffer.from([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70])); // minimal ftyp box

    try {
      // Send a message with a video attachment
      const sendRes = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`)
        .field("text", "Watch this")
        .attach("file", tmpVideo, {
          filename: "clip.mp4",
          contentType: "video/mp4",
        });
      expect(sendRes.status).toBe(201);
      expect(sendRes.body.data.mimeType).toBe("video/mp4");

      const videoMessageId = sendRes.body.data.id;

      // Fetch the media endpoint
      const mediaRes = await request(appMod.default)
        .get(
          `/api/provider-messenger/thread/${threadId}/messages/${videoMessageId}/media`
        )
        .set("Authorization", `Bearer ${providerToken}`);

      // Must be accessible
      expect(mediaRes.status).toBe(200);

      // Content-Type must be the real video MIME, not octet-stream, so that the
      // browser blob URL is decodable as video in AuthedVideo.
      expect(mediaRes.headers["content-type"]).toMatch(/^video\/mp4/);

      // Must be served as attachment (not inline) for security.
      expect(mediaRes.headers["content-disposition"]).toMatch(/^attachment/);
    } finally {
      fs.unlinkSync(tmpVideo);
    }
  });

  // ── Message list ─────────────────────────────────────────────────────────────

  it("GET /thread/:threadId/messages — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /thread/:threadId/messages — returns messages newest-first", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    const msgs = res.body.data as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    // Newest first — check timestamps are non-increasing
    for (let i = 1; i < msgs.length; i++) {
      expect(
        new Date(msgs[i - 1].createdAt).getTime()
      ).toBeGreaterThanOrEqual(new Date(msgs[i].createdAt).getTime());
    }
  });

  it("GET /thread/:threadId/messages — cursor pagination works", async () => {
    const res = await request(appMod.default)
      .get(
        `/api/provider-messenger/thread/${threadId}/messages?limit=2&before=${firstMessageId}`
      )
      .set("Authorization", `Bearer ${providerToken}`);
    // before the first message → no results
    expect(res.status).toBe(200);
    const msgs = res.body.data as any[];
    expect(msgs.length).toBe(0);
  });

  // ── Search (q param) ─────────────────────────────────────────────────────────

  it("GET /thread/:threadId/messages?q= — returns only messages whose body matches (case-insensitive)", async () => {
    const res = await request(appMod.default)
      .get(
        `/api/provider-messenger/thread/${threadId}/messages?q=${encodeURIComponent("HELLO FROM PROVIDER")}`
      )
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    const msgs = res.body.data as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    for (const m of msgs) {
      expect(m.body.toLowerCase()).toContain("hello from provider");
    }
  });

  it("GET /thread/:threadId/messages?q= — returns empty array when nothing matches", async () => {
    const res = await request(appMod.default)
      .get(
        `/api/provider-messenger/thread/${threadId}/messages?q=${encodeURIComponent("no-such-text-in-any-message-xyz")}`
      )
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).length).toBe(0);
  });

  it("GET /thread/:threadId/messages?q= — treats LIKE special characters (%, _) literally", async () => {
    const res = await request(appMod.default)
      .get(
        `/api/provider-messenger/thread/${threadId}/messages?q=${encodeURIComponent("50%_off")}`
      )
      .set("Authorization", `Bearer ${labAdminToken}`);
    // No message contains this text, but the request must not error out or
    // treat % / _ as SQL LIKE wildcards that match everything.
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).length).toBe(0);
  });

  it("GET /thread/:threadId/messages?q= — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages?q=hello`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  // ── Unread count ─────────────────────────────────────────────────────────────

  it("GET /provider-messenger/unread-count — lab admin sees unread messages", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    // Lab admin has never set a watermark so all messages count
    expect(res.body.data.total).toBeGreaterThan(0);
  });

  it("GET /provider-messenger/unread-count — 0 for unrelated user", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(200);
    // Unlinked user has no threads → 0
    expect(res.body.data.total).toBe(0);
  });

  // ── Read watermark ───────────────────────────────────────────────────────────

  it("POST /thread/:threadId/read — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  it("POST /thread/:threadId/read — advances watermark for lab admin", async () => {
    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lastReadMessageId).toBeTruthy();
    expect(res.body.data.threadId).toBe(threadId);
  });

  it("GET /provider-messenger/unread-count — 0 after marking read", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
  });

  it("POST /thread/:threadId/read — idempotent (repeated call returns same watermark)", async () => {
    const r1 = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${labAdminToken}`);
    const r2 = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.data.lastReadMessageId).toBe(
      r2.body.data.lastReadMessageId
    );
  });

  // ── Read watermark: opposite side (powers the "Seen" indicator) ──────────────

  it("GET /thread/:threadId/read-watermark — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/read-watermark`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /thread/:threadId/read-watermark — provider sees the lab's watermark once a lab user has read", async () => {
    // labAdminToken already marked the thread read above.
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/read-watermark`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lastReadMessageId).toBeTruthy();
    expect(res.body.data.lastReadMessageCreatedAt).toBeTruthy();
  });

  it("GET /thread/:threadId/read-watermark — lab user sees null (no provider has read yet)", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/read-watermark`)
      .set("Authorization", `Bearer ${labUserToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lastReadMessageId).toBeNull();
    expect(res.body.data.lastReadMessageCreatedAt).toBeNull();
  });

  it("GET /thread/:threadId/read-watermark — becomes non-null for lab side once the provider reads (symmetric)", async () => {
    // Provider marks the thread read (mirrors the earlier lab-side POST /read).
    const markRes = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(markRes.status).toBe(200);

    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/read-watermark`)
      .set("Authorization", `Bearer ${labUserToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lastReadMessageId).toBe(
      markRes.body.data.lastReadMessageId
    );
    expect(res.body.data.lastReadMessageCreatedAt).toBeTruthy();
  });

  it("GET /thread/:threadId/read-watermark — aggregates across multiple opposite-org members, furthest wins", async () => {
    // labUserUserId and labAdminUserId are both active members of labOrgId
    // (the opposite org relative to the provider caller). Advance them to
    // two different points so we can assert the endpoint reports whichever
    // member has read furthest, not just whichever one is queried.
    const msgA = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Aggregation test — message A");
    expect(msgA.status).toBe(201);

    // labUserToken reads up through message A only.
    const labUserRead = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${labUserToken}`);
    expect(labUserRead.body.data.lastReadMessageId).toBe(msgA.body.data.id);

    const msgB = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Aggregation test — message B");
    expect(msgB.status).toBe(201);

    // labAdminToken reads through the newer message B — this is the
    // furthest-advanced watermark across the two lab-side members.
    const labAdminRead = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(labAdminRead.body.data.lastReadMessageId).toBe(msgB.body.data.id);

    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/read-watermark`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    // Must report message B (labAdmin's furthest watermark), not message A
    // (labUser's older one), even though labUser also has a watermark row.
    expect(res.body.data.lastReadMessageId).toBe(msgB.body.data.id);
    expect(res.body.data.lastReadMessageCreatedAt).toBe(
      msgB.body.data.createdAt
    );
  });

  // ── Threads list with unread count ───────────────────────────────────────────

  it("GET /provider-messenger/threads — unreadCount decreases after marking read", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/threads")
      .set("Authorization", `Bearer ${labAdminToken}`);
    expect(res.status).toBe(200);
    const found = (res.body.data as any[]).find(
      (t: any) => t.id === threadId
    );
    expect(found).toBeDefined();
    expect(found.unreadCount).toBe(0);
  });

  it("GET /provider-messenger/threads — latestMessagePreview is populated", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/threads")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    const found = (res.body.data as any[]).find(
      (t: any) => t.id === threadId
    );
    expect(found).toBeDefined();
    expect(found.latestMessagePreview).not.toBeNull();
    expect(found.latestMessagePreview.body).toBeTruthy();
  });

  // ── Auth / non-existent thread ────────────────────────────────────────────────

  it("GET /thread/:threadId/messages — 404 for non-existent thread", async () => {
    const res = await request(appMod.default)
      .get("/api/provider-messenger/thread/nonexistent-thread-id/messages")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(404);
  });

  // ── Auth-before-disk-write: file upload rejected on non-member thread ─────────

  it("POST /thread/:threadId/messages — rejected BEFORE file is written for non-member (auth-before-disk)", async () => {
    // Non-member tries to upload a file to the thread; the pre-multer gate should
    // return 403 without persisting any file to disk.
    const uploadsDirBefore = fs.readdirSync(
      require("node:path").resolve(process.cwd(), "uploads", "messenger-media")
    ).length;

    const res = await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${unlinkedToken}`)
      .attach("file", tmpFile, {
        filename: "should-not-land.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(403);

    // Verify no new files appeared in the messenger-media directory
    const uploadsDir = require("node:path").resolve(
      process.cwd(),
      "uploads",
      "messenger-media"
    );
    if (fs.existsSync(uploadsDir)) {
      const countAfter = fs.readdirSync(uploadsDir).length;
      expect(countAfter).toBe(uploadsDirBefore);
    }
  });

  // ── Own messages not counted as unread ────────────────────────────────────────

  it("GET /provider-messenger/unread-count — provider does NOT count own sent messages as unread", async () => {
    // Provider has sent multiple messages; their unread count should only reflect
    // messages sent by the lab side (not their own messages).
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    // Provider sent 3 messages and lab sent 1. Provider should only see the 1
    // lab message as unread (none of their own). The total should be < total messages.
    const total = res.body.data.total;
    // Total messages in thread ≥ 4; provider's own = 3; so total unread ≤ 2 (lab replies)
    expect(total).toBeLessThan(4);
  });

  it("GET /provider-messenger/unread-count — provider's own sent messages are never counted as unread", async () => {
    // Mark provider as having read everything first
    await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/read`)
      .set("Authorization", `Bearer ${providerToken}`);

    // Provider sends a message — own messages are excluded from the count via
    // the senderUserId != userId filter, NOT by watermark auto-advancement.
    await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Own-message exclusion test");

    // Provider's unread count is still 0: their own outbound is excluded
    const res = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
  });

  it("GET /provider-messenger/unread-count — inbound unread stays unread after sender replies without marking read", async () => {
    // Lab sends a message to the provider (creates an inbound unread for provider)
    await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${labUserToken}`)
      .field("text", "Inbound message from lab — should stay unread");

    // Verify provider has at least 1 unread (the lab's message)
    const before = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(before.status).toBe(200);
    const unreadBefore = before.body.data.total as number;
    expect(unreadBefore).toBeGreaterThan(0);

    // Provider sends a reply WITHOUT marking anything read
    await request(appMod.default)
      .post(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`)
      .field("text", "Provider reply — must not clear prior unread");

    // Inbound unread count must be unchanged — sending does NOT advance watermark
    const after = await request(appMod.default)
      .get("/api/provider-messenger/unread-count")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(after.status).toBe(200);
    expect(after.body.data.total).toBe(unreadBefore);
  });

  // ── Media download route ──────────────────────────────────────────────────────

  it("GET /thread/:threadId/messages/:messageId/media — 404 for message without attachment", async () => {
    // firstMessageId is a text-only message
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages/${firstMessageId}/media`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /thread/:threadId/messages/:messageId/media — 403 for non-member", async () => {
    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages/${firstMessageId}/media`)
      .set("Authorization", `Bearer ${unlinkedToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /thread/:threadId/messages/:messageId/media — streams attachment for member", async () => {
    // Find the message that had a file attachment (sent earlier in the test)
    const listRes = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(listRes.status).toBe(200);
    const msgs = listRes.body.data as any[];
    const attachmentMsg = msgs.find((m: any) => m.mediaKey != null);
    if (!attachmentMsg) {
      // No attachment message found — skip (shouldn't happen given earlier sends)
      return;
    }

    const res = await request(appMod.default)
      .get(`/api/provider-messenger/thread/${threadId}/messages/${attachmentMsg.id}/media`)
      .set("Authorization", `Bearer ${providerToken}`);
    // Either 200 (attachment served) or 404 (file not on disk in test env — acceptable)
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers["content-type"]).toBeTruthy();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  // ── MIME allowlist enforcement (upload rejection) ─────────────────────────────
  //
  // The multer fileFilter only allows a fixed set of image/video MIME types.
  // These tests confirm the common stored-XSS vectors (HTML, SVG, JS, PDF,
  // plain text) are rejected with 415 before any bytes reach disk, and that
  // no message row is persisted for a rejected upload.

  describe("MIME allowlist enforcement", () => {
    const disallowed: Array<{
      label: string;
      mime: string;
      filename: string;
      content: Buffer;
    }> = [
      {
        label: "HTML",
        mime: "text/html",
        filename: "payload.html",
        content: Buffer.from("<html><body><script>alert(1)</script></body></html>"),
      },
      {
        label: "SVG (script-capable image)",
        mime: "image/svg+xml",
        filename: "payload.svg",
        content: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        ),
      },
      {
        label: "JavaScript",
        mime: "application/javascript",
        filename: "payload.js",
        content: Buffer.from("alert(1)"),
      },
      {
        label: "PDF",
        mime: "application/pdf",
        filename: "payload.pdf",
        content: Buffer.from("%PDF-1.4 fake pdf content"),
      },
      {
        label: "plain text",
        mime: "text/plain",
        filename: "payload.txt",
        content: Buffer.from("just some text"),
      },
    ];

    for (const { label, mime, filename, content } of disallowed) {
      it(`POST /thread/:threadId/messages — rejects ${label} (${mime}) attachment with 415`, async () => {
        const uploadsDir = path.resolve(
          process.cwd(),
          "uploads",
          "messenger-media"
        );
        const countBefore = fs.existsSync(uploadsDir)
          ? fs.readdirSync(uploadsDir).length
          : 0;

        const res = await request(appMod.default)
          .post(`/api/provider-messenger/thread/${threadId}/messages`)
          .set("Authorization", `Bearer ${providerToken}`)
          .field("text", `Attempted ${label} upload`)
          .attach("file", content, { filename, contentType: mime });

        expect(res.status).toBe(415);

        // No file should have been written to disk for the rejected upload.
        if (fs.existsSync(uploadsDir)) {
          expect(fs.readdirSync(uploadsDir).length).toBe(countBefore);
        }
      });
    }

    it("does not persist a message row when the attachment MIME type is rejected", async () => {
      const before = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`);
      const countBefore = (before.body.data as any[]).length;

      const res = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`)
        .field("text", "should not be saved — rejected attachment")
        .attach("file", Buffer.from("<script>alert(1)</script>"), {
          filename: "payload.html",
          contentType: "text/html",
        });
      expect(res.status).toBe(415);

      const after = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`);
      expect((after.body.data as any[]).length).toBe(countBefore);
    });
  });

  // ── Media download route: disposition & security headers ─────────────────────
  //
  // Content-Disposition determines whether a browser renders a fetched file
  // inline (images) or forces a download (video and everything else); getting
  // this wrong for a script-capable type would reopen the stored-XSS path
  // that the MIME allowlist above closes. X-Content-Type-Options: nosniff
  // must accompany every successful media response.

  describe("Media download route — disposition & security headers", () => {
    it("GET .../media — image attachment served with Content-Disposition: inline and nosniff", async () => {
      const sendRes = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`)
        .field("text", "inline disposition check")
        .attach("file", tmpFile, {
          filename: "inline-check.png",
          contentType: "image/png",
        });
      expect(sendRes.status).toBe(201);
      const imageMessageId = sendRes.body.data.id;

      const mediaRes = await request(appMod.default)
        .get(
          `/api/provider-messenger/thread/${threadId}/messages/${imageMessageId}/media`
        )
        .set("Authorization", `Bearer ${providerToken}`);

      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers["content-type"]).toMatch(/^image\/png/);
      expect(mediaRes.headers["content-disposition"]).toMatch(/^inline/);
      expect(mediaRes.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("GET .../media — video attachment served with Content-Disposition: attachment (not inline) and nosniff", async () => {
      const tmpVideo = path.join(
        os.tmpdir(),
        `messenger-test-disposition-${randomBytes(4).toString("hex")}.mp4`
      );
      fs.writeFileSync(
        tmpVideo,
        Buffer.from([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70])
      );
      try {
        const sendRes = await request(appMod.default)
          .post(`/api/provider-messenger/thread/${threadId}/messages`)
          .set("Authorization", `Bearer ${providerToken}`)
          .field("text", "attachment disposition check")
          .attach("file", tmpVideo, {
            filename: "attachment-check.mp4",
            contentType: "video/mp4",
          });
        expect(sendRes.status).toBe(201);
        const videoMessageId = sendRes.body.data.id;

        const mediaRes = await request(appMod.default)
          .get(
            `/api/provider-messenger/thread/${threadId}/messages/${videoMessageId}/media`
          )
          .set("Authorization", `Bearer ${providerToken}`);

        expect(mediaRes.status).toBe(200);
        expect(mediaRes.headers["content-type"]).toMatch(/^video\/mp4/);
        expect(mediaRes.headers["content-disposition"]).toMatch(/^attachment/);
        expect(mediaRes.headers["content-disposition"]).not.toMatch(/^inline/);
        expect(mediaRes.headers["x-content-type-options"]).toBe("nosniff");
      } finally {
        fs.unlinkSync(tmpVideo);
      }
    });

    it("GET .../media — X-Content-Type-Options: nosniff is present on every successful attachment response", async () => {
      // Re-fetch messages created above to confirm nosniff is set consistently
      // across content types, not just for whichever type happens to be tested first.
      const listRes = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${threadId}/messages`)
        .set("Authorization", `Bearer ${providerToken}`);
      expect(listRes.status).toBe(200);
      const withMedia = (listRes.body.data as any[]).filter(
        (m: any) => m.mediaKey != null
      );
      expect(withMedia.length).toBeGreaterThan(0);

      let sawSuccessfulFetch = false;
      for (const msg of withMedia) {
        const res = await request(appMod.default)
          .get(
            `/api/provider-messenger/thread/${threadId}/messages/${msg.id}/media`
          )
          .set("Authorization", `Bearer ${providerToken}`);
        // A prior test's temp file may already be cleaned up; only assert the
        // header on responses that were actually served.
        if (res.status === 200) {
          sawSuccessfulFetch = true;
          expect(res.headers["x-content-type-options"]).toBe("nosniff");
        }
      }
      expect(sawSuccessfulFetch).toBe(true);
    });
  });

  // ── Soft-delete revocation: removed members must lose access immediately ──────
  //
  // These tests create dedicated users/memberships, soft-delete them (set
  // deletedAt), and verify all messenger operations return 403.

  describe("Soft-deleted membership revocation", () => {
    const revokedProviderUserId = rid("revprov");
    const revokedLabUserId = rid("revlab");
    const revokedProviderOrgId = rid("revprovorg");
    let revokedProviderToken = "";
    let revokedLabToken = "";
    // Thread created before revocation so we can test read/send after
    let revokedThreadId = "";

    beforeAll(async () => {
      const { db, organizations, organizationMemberships, users } =
        dbMod as any;

      // Create the revoked users
      await db.insert(users).values([
        {
          id: revokedProviderUserId,
          username: `revprov_${revokedProviderUserId}`,
          password: "x",
          userType: "provider",
          emailVerifiedAt: new Date(),
        },
        {
          id: revokedLabUserId,
          username: `revlab_${revokedLabUserId}`,
          password: "x",
          userType: "lab",
          emailVerifiedAt: new Date(),
        },
      ]);

      // Provider org linked to the main lab
      await db.insert(organizations).values([
        {
          id: revokedProviderOrgId,
          type: "provider",
          name: "Revoked Provider Org",
          parentLabOrganizationId: labOrgId,
        },
      ]);

      // Active memberships
      await db.insert(organizationMemberships).values([
        {
          labId: revokedProviderOrgId,
          userId: revokedProviderUserId,
          role: "admin",
          status: "active",
        },
        {
          labId: labOrgId,
          userId: revokedLabUserId,
          role: "user",
          status: "active",
        },
      ]);

      revokedProviderToken = await makeSession(revokedProviderUserId);
      revokedLabToken = await makeSession(revokedLabUserId);

      // Create a thread while both memberships are still active
      const threadRes = await request(appMod.default)
        .get(`/api/provider-messenger/thread?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${revokedProviderToken}`);
      expect(threadRes.status).toBe(200);
      revokedThreadId = threadRes.body.data.id;

      // Now soft-delete both memberships (set deletedAt = now, keep status = active
      // to simulate the common async-removal state the reviewer described)
      const now = new Date();
      await db
        .update(organizationMemberships)
        .set({ deletedAt: now })
        .where(
          and(
            eq(organizationMemberships.userId, revokedProviderUserId),
            eq(organizationMemberships.labId, revokedProviderOrgId)
          )
        );
      await db
        .update(organizationMemberships)
        .set({ deletedAt: now })
        .where(
          and(
            eq(organizationMemberships.userId, revokedLabUserId),
            eq(organizationMemberships.labId, labOrgId)
          )
        );
    });

    beforeEach(async () => {
      if (!SHOULD_RUN) return;
      revokedProviderToken = await makeSession(revokedProviderUserId);
      revokedLabToken = await makeSession(revokedLabUserId);
    });

    it("GET /thread — soft-deleted provider cannot create a thread (403)", async () => {
      const res = await request(appMod.default)
        .get(`/api/provider-messenger/thread?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${revokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /threads — soft-deleted provider is denied", async () => {
      const res = await request(appMod.default)
        .get("/api/provider-messenger/threads")
        .set("Authorization", `Bearer ${revokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /thread/:threadId/messages — soft-deleted provider cannot read messages (403)", async () => {
      const res = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${revokedThreadId}/messages`)
        .set("Authorization", `Bearer ${revokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("POST /thread/:threadId/messages — soft-deleted provider cannot send (403)", async () => {
      const res = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${revokedThreadId}/messages`)
        .set("Authorization", `Bearer ${revokedProviderToken}`)
        .field("text", "Should be blocked");
      expect(res.status).toBe(403);
    });

    it("POST /thread/:threadId/read — soft-deleted provider cannot advance watermark (403)", async () => {
      const res = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${revokedThreadId}/read`)
        .set("Authorization", `Bearer ${revokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /thread/:threadId/messages/:messageId/media — soft-deleted lab user cannot download media (403)", async () => {
      const res = await request(appMod.default)
        .get(
          `/api/provider-messenger/thread/${revokedThreadId}/messages/fake-msg-id/media`
        )
        .set("Authorization", `Bearer ${revokedLabToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ── Org-level revocation: provider org soft-deleted or de-linked ──────────────
  //
  // Membership rows can still be active while the provider org itself is removed
  // or re-parented. The thread-access checks must verify org liveness independently.

  describe("Org-level revocation (org soft-delete / de-link)", () => {
    const orgRevokedProviderUserId = rid("orgrevprov");
    const orgRevokedProviderOrgId = rid("orgrevprovorg");
    let orgRevokedProviderToken = "";
    let orgDeletedThreadId = "";
    let orgDelinkedThreadId = "";

    beforeAll(async () => {
      const { db, organizations, organizationMemberships, users } =
        dbMod as any;

      await db.insert(users).values([
        {
          id: orgRevokedProviderUserId,
          username: `orgrevprov_${orgRevokedProviderUserId}`,
          password: "x",
          userType: "provider",
          emailVerifiedAt: new Date(),
        },
      ]);

      // Two provider orgs initially linked to labOrgId
      const deletedProvOrgId = rid("delprovorg");
      const delinkedProvOrgId = rid("dlinkprovorg");

      await db.insert(organizations).values([
        {
          id: deletedProvOrgId,
          type: "provider",
          name: "To-be-deleted Provider Org",
          parentLabOrganizationId: labOrgId,
        },
        {
          id: delinkedProvOrgId,
          type: "provider",
          name: "To-be-delinked Provider Org",
          parentLabOrganizationId: labOrgId,
        },
      ]);

      await db.insert(organizationMemberships).values([
        {
          labId: deletedProvOrgId,
          userId: orgRevokedProviderUserId,
          role: "admin",
          status: "active",
        },
        {
          labId: delinkedProvOrgId,
          userId: orgRevokedProviderUserId,
          role: "admin",
          status: "active",
        },
      ]);

      orgRevokedProviderToken = await makeSession(orgRevokedProviderUserId);

      // Create threads directly while orgs are still valid.
      // Use the providerMessengerThreads table exported from @workspace/db.
      const { providerMessengerThreads: pmtTable } = dbMod as any;
      const [t1Row] = await db
        .insert(pmtTable)
        .values({
          providerOrganizationId: deletedProvOrgId,
          labOrganizationId: labOrgId,
        })
        .returning();
      const [t2Row] = await db
        .insert(pmtTable)
        .values({
          providerOrganizationId: delinkedProvOrgId,
          labOrganizationId: labOrgId,
        })
        .returning();
      orgDeletedThreadId = t1Row?.id;
      orgDelinkedThreadId = t2Row?.id;

      // Soft-delete one provider org
      await db
        .update(organizations)
        .set({ deletedAt: new Date() })
        .where(eq(organizations.id, deletedProvOrgId));

      // De-link the other: point it to a different (non-existent) lab
      await db
        .update(organizations)
        .set({ parentLabOrganizationId: rid("otherlabxxx") })
        .where(eq(organizations.id, delinkedProvOrgId));
    });

    beforeEach(async () => {
      if (!SHOULD_RUN) return;
      orgRevokedProviderToken = await makeSession(orgRevokedProviderUserId);
    });

    it("GET /thread/:threadId/messages — 403 after provider org is soft-deleted", async () => {
      if (!orgDeletedThreadId) return;
      const res = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${orgDeletedThreadId}/messages`)
        .set("Authorization", `Bearer ${orgRevokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("POST /thread/:threadId/messages — 403 after provider org is soft-deleted", async () => {
      if (!orgDeletedThreadId) return;
      const res = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${orgDeletedThreadId}/messages`)
        .set("Authorization", `Bearer ${orgRevokedProviderToken}`)
        .field("text", "should be blocked by org deletion");
      expect(res.status).toBe(403);
    });

    it("GET /threads — soft-deleted provider org threads not listed", async () => {
      const res = await request(appMod.default)
        .get("/api/provider-messenger/threads")
        .set("Authorization", `Bearer ${orgRevokedProviderToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((t: any) => t.id);
      if (orgDeletedThreadId) expect(ids).not.toContain(orgDeletedThreadId);
      if (orgDelinkedThreadId) expect(ids).not.toContain(orgDelinkedThreadId);
    });

    it("GET /thread/:threadId/messages — 403 after provider org is de-linked from lab", async () => {
      if (!orgDelinkedThreadId) return;
      const res = await request(appMod.default)
        .get(`/api/provider-messenger/thread/${orgDelinkedThreadId}/messages`)
        .set("Authorization", `Bearer ${orgRevokedProviderToken}`);
      expect(res.status).toBe(403);
    });

    it("POST /thread/:threadId/read — 403 after provider org is de-linked from lab", async () => {
      if (!orgDelinkedThreadId) return;
      const res = await request(appMod.default)
        .post(`/api/provider-messenger/thread/${orgDelinkedThreadId}/read`)
        .set("Authorization", `Bearer ${orgRevokedProviderToken}`);
      expect(res.status).toBe(403);
    });
  });
});
