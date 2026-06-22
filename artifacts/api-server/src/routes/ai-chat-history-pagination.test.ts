/**
 * Integration tests: AI chat-history cursor pagination (real DB).
 *
 * `loadAiChatHistory(userId, { limit, before })` is the single reader behind the
 * "Load earlier messages" affordance on both clients. The persistence round-trip
 * is covered by `ai-agent-history-persist.test.ts`; this suite locks the
 * *paging contract* instead:
 *
 *  - Without a cursor it returns the most recent page, oldest-first.
 *  - Paging backwards with a real `before` cursor returns the page of messages
 *    immediately older than that row.
 *  - `hasMore` is true while still-older rows remain and false at the start of
 *    the conversation.
 *  - An unknown / foreign `before` id is inert: it must NOT silently fall back to
 *    returning the latest page again (the known cursor pitfall) — a foreign id is
 *    scoped out by userId, so it behaves like "no cursor" only because there is
 *    no matching row, and crucially it never returns rows belonging to another
 *    user.
 *  - The route `GET /ai-chat/history` forwards `before` + `limit` and surfaces
 *    `hasMore` over the wire.
 *
 * Rows are inserted directly with controlled `createdAt` values so ordering is
 * deterministic (no fire-and-forget AI write timing). Everything is removed in
 * afterAll so the suite is safe against a shared dev DB. Gated on DATABASE_URL,
 * same as the other route integration suites.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

// ── Standard background-job mocks (same pattern as other route tests) ────────
vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-chat-pagination"),
  extractMediaFileName: () => null,
}));

// ── Gate ─────────────────────────────────────────────────────────────────────
const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("AI chat-history cursor pagination (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let historyLib: typeof import("../lib/ai-chat-history.js");

  const labOrgId = rid("lab");
  const labUserId = rid("ulab");
  // A second user to prove cross-user isolation of the `before` cursor.
  const otherUserId = rid("uother");
  let labToken: string;

  // Deterministic message ids in chronological order: m0 (oldest) … m11 (newest).
  // 12 rows so a 5-per-page walk crosses three pages with a clean boundary.
  const TOTAL = 12;
  const ids: string[] = Array.from({ length: TOTAL }, (_, i) => `msg_${i}`);

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

  async function seedHistory(): Promise<void> {
    const { db, aiChatHistory } = dbMod as any;
    const base = Date.now();
    const rows = ids.map((id, i) => ({
      id,
      userId: labUserId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}`,
      // 1s apart so createdAt ordering is unambiguous and matches id order.
      createdAt: new Date(base + i * 1000),
    }));
    await db.insert(aiChatHistory).values(rows);
    // One row for the other user, so a foreign-cursor test can prove isolation.
    await db.insert(aiChatHistory).values({
      id: "other_msg_0",
      userId: otherUserId,
      role: "user",
      content: "other-user-message",
      createdAt: new Date(base + 100 * 1000),
    });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-chat-pagination";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    historyLib = await import("../lib/ai-chat-history.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labUserId, username: `lab_${labUserId}`, password: "testpass", userType: "lab" },
      { id: otherUserId, username: `oth_${otherUserId}`, password: "testpass", userType: "lab" },
    ]);

    await db
      .insert(organizations)
      .values([{ id: labOrgId, type: "lab", name: "AI Chat Pagination Test Lab" }]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: labUserId, role: "admin", status: "active" },
    ]);

    labToken = await makeSession(labUserId);
    await seedHistory();
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      aiChatHistory,
    } = dbMod as any;

    await db
      .delete(aiChatHistory)
      .where(inArray(aiChatHistory.userId, [labUserId, otherUserId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labUserId, otherUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [labUserId, otherUserId]));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labUserId, otherUserId]));
  });

  // ── loadAiChatHistory (lib) ────────────────────────────────────────────────

  it("returns the most recent page oldest-first when no cursor is given", async () => {
    const { messages, hasMore } = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
    });
    // Newest 5 (m7..m11) returned oldest-first.
    expect(messages.map((m) => m.id)).toEqual(["msg_7", "msg_8", "msg_9", "msg_10", "msg_11"]);
    // Older rows (m0..m6) still remain.
    expect(hasMore).toBe(true);
  });

  it("pages strictly backwards from a real `before` cursor", async () => {
    // First page: newest 5 → oldest held is msg_7.
    const page1 = await historyLib.loadAiChatHistory(labUserId, { limit: 5 });
    const cursor1 = page1.messages[0]!.id;
    expect(cursor1).toBe("msg_7");

    // Second page: the 5 immediately older than msg_7.
    const page2 = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: cursor1,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([
      "msg_2",
      "msg_3",
      "msg_4",
      "msg_5",
      "msg_6",
    ]);
    expect(page2.hasMore).toBe(true);

    // Third page: the remaining oldest 2 (m0, m1); no more after that.
    const cursor2 = page2.messages[0]!.id;
    expect(cursor2).toBe("msg_2");
    const page3 = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: cursor2,
    });
    expect(page3.messages.map((m) => m.id)).toEqual(["msg_0", "msg_1"]);
    expect(page3.hasMore).toBe(false);
  });

  it("reports hasMore=false when the page exactly drains the remaining rows", async () => {
    // Cursor at msg_5 leaves exactly m0..m4 (5 rows). A limit of 5 returns all
    // of them and must report no more remain (the +1 lookahead finds nothing).
    const { messages, hasMore } = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: "msg_5",
    });
    expect(messages.map((m) => m.id)).toEqual([
      "msg_0",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
    ]);
    expect(hasMore).toBe(false);
  });

  it("returns an empty page with hasMore=false when paging before the oldest row", async () => {
    const { messages, hasMore } = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: "msg_0",
    });
    expect(messages).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("does NOT silently return the latest page for an unknown `before` id", async () => {
    // The known pitfall: when a `before` cursor id does not resolve to a stored
    // row for this user (a stale client-local id, an already-trimmed row, etc.),
    // the server must NOT fall through to returning the most-recent page again —
    // the client would render those rows as a duplicate "older" page and "load
    // earlier" would loop forever. The contract: an unresolved cursor yields an
    // empty page with hasMore=false ("no older messages remain").
    const unknown = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: "this-id-does-not-exist",
    });
    expect(unknown.messages).toEqual([]);
    expect(unknown.hasMore).toBe(false);

    // Guard the specific regression: it must never echo the latest page.
    const latest = await historyLib.loadAiChatHistory(labUserId, { limit: 5 });
    expect(latest.messages.length).toBeGreaterThan(0);
    expect(unknown.messages.map((m) => m.id)).not.toEqual(
      latest.messages.map((m) => m.id),
    );
  });

  it("scopes the `before` cursor by user — another user's id is inert", async () => {
    // other_msg_0 belongs to otherUserId and is newer than all of labUser's rows.
    // If the cursor were resolved without the userId scope, it would page from
    // that timestamp and leak/return labUser rows as if older. Because it is
    // scoped, no matching row is found for labUser, so — like any unresolved
    // cursor — it must return an empty page, NOT labUser's latest page.
    const res = await historyLib.loadAiChatHistory(labUserId, {
      limit: 5,
      before: "other_msg_0",
    });
    expect(res.messages).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  // ── GET /ai-chat/history (route wire contract) ─────────────────────────────

  it("GET /ai-chat/history forwards `before` + `limit` and surfaces hasMore", async () => {
    // Page 1 over the wire.
    const r1 = await request(appMod.default)
      .get("/api/ai-chat/history?limit=5")
      .set("Authorization", `Bearer ${labToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.hasMore).toBe(true);
    const msgs1 = r1.body.messages as Array<{ id: string }>;
    expect(msgs1.map((m) => m.id)).toEqual([
      "msg_7",
      "msg_8",
      "msg_9",
      "msg_10",
      "msg_11",
    ]);

    // Page 2 via the oldest id of page 1 as the `before` cursor.
    const cursor = msgs1[0]!.id;
    const r2 = await request(appMod.default)
      .get(`/api/ai-chat/history?limit=5&before=${encodeURIComponent(cursor)}`)
      .set("Authorization", `Bearer ${labToken}`);
    expect(r2.status).toBe(200);
    const msgs2 = r2.body.messages as Array<{ id: string }>;
    expect(msgs2.map((m) => m.id)).toEqual([
      "msg_2",
      "msg_3",
      "msg_4",
      "msg_5",
      "msg_6",
    ]);
    expect(r2.body.hasMore).toBe(true);

    // The two pages must not overlap (no duplicate ids across the boundary).
    const overlap = msgs2.filter((m) => msgs1.some((a) => a.id === m.id));
    expect(overlap).toEqual([]);
  });
});
