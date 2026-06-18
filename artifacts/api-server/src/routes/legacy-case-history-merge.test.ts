/**
 * Regression test for the mobile (lab_cases) case-history / media data-loss bug.
 *
 * The mobile app builds its in-memory case list from GET /legacy/cases, which
 * strips activityLog/photos/videos to keep the payload lean. When the client
 * then appends a single note/photo entry and PUTs the WHOLE case back via
 * POST /legacy/cases, its arrays contain only that one new item. Before the
 * fix, the upsert blindly replaced case_data, so every sync wiped the case's
 * entire history and all previously-uploaded media down to a single entry —
 * exactly the "history only keeps one event / my photo disappeared" report.
 *
 * The fix unions the incoming activityLog/photos/videos with what is already
 * stored (append-only). These tests assert a stale client can never shrink a
 * case's history or media.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/legacy/cases — append-only history/media merge", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const ownerUserId = rid("uowner");
  const caseId = `${Date.now()}${randomBytes(4).toString("hex")}`;
  let token = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return t;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-history-merge";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values([
      { id: ownerUserId, username: `own_${ownerUserId}`, password: "x" },
    ]);
    token = await makeSession(ownerUserId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(ownerUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, labCases, userSessions } = dbMod as any;
    await db.delete(labCases).where(eq(labCases.id, caseId));
    await db.delete(userSessions).where(eq(userSessions.userId, ownerUserId));
    await db.delete(users).where(inArray(users.id, [ownerUserId]));
  });

  it("preserves prior history + photos when a stale client syncs one new entry", async () => {
    const app = appMod.default;

    // 1. Initial save: a rich case with full history and two photos, exactly
    //    as a freshly-created case would look on the server.
    const initialCaseData = {
      id: caseId,
      ownerId: ownerUserId,
      caseNumber: "26-TEST",
      patientName: "Merge Test",
      status: "INTAKE",
      photos: ["https://media.example/p1.jpg", "https://media.example/p2.jpg"],
      videos: ["https://media.example/v1.mp4"],
      activityLog: [
        { id: "evt-created", type: "created", timestamp: 1000, description: "Case created" },
        { id: "evt-photo-1", type: "photo", timestamp: 2000, description: "Photo added", imageUri: "https://media.example/p1.jpg" },
        { id: "evt-status", type: "station_change", timestamp: 3000, description: "Moved to DESIGN" },
      ],
    };

    const createRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: ownerUserId, caseData: initialCaseData });
    expect(createRes.status).toBe(200);

    // 2. Stale client sync: mimics the mobile app after loading the case from
    //    the stripped list endpoint, adding ONE note, and syncing the whole
    //    blob back. activityLog has only the new entry; photos/videos absent.
    const staleCaseData = {
      id: caseId,
      ownerId: ownerUserId,
      caseNumber: "26-TEST",
      patientName: "Merge Test",
      status: "DESIGN",
      activityLog: [
        { id: "evt-note-1", type: "note", timestamp: 4000, description: "Ok now" },
      ],
    };

    const syncRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: ownerUserId, caseData: staleCaseData });
    expect(syncRes.status).toBe(200);

    // 3. Fetch full case: history must contain ALL four events in chronological
    //    order, and both photos + the video must survive.
    const getRes = await request(app)
      .get(`/api/legacy/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);

    const fetched = getRes.body.case;
    const logTypes = (fetched.activityLog as any[]).map((e) => e.type);
    expect(logTypes).toEqual(["created", "photo", "station_change", "note"]);

    expect(fetched.photos).toEqual([
      "https://media.example/p1.jpg",
      "https://media.example/p2.jpg",
    ]);
    expect(fetched.videos).toEqual(["https://media.example/v1.mp4"]);
  });

  it("does not duplicate entries when the same activity is synced twice", async () => {
    const app = appMod.default;

    const resync = {
      id: caseId,
      ownerId: ownerUserId,
      caseNumber: "26-TEST",
      activityLog: [
        // Same note as before (same id) plus a brand-new photo entry.
        { id: "evt-note-1", type: "note", timestamp: 4000, description: "Ok now" },
        { id: "evt-photo-2", type: "photo", timestamp: 5000, description: "Photo added", imageUri: "https://media.example/p3.jpg" },
      ],
      photos: ["https://media.example/p3.jpg"],
    };

    const res = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: ownerUserId, caseData: resync });
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/legacy/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);

    const fetched = getRes.body.case;
    const ids = (fetched.activityLog as any[]).map((e) => e.id);
    // evt-note-1 appears exactly once; new photo appended.
    expect(ids.filter((x) => x === "evt-note-1")).toHaveLength(1);
    expect(ids).toEqual([
      "evt-created",
      "evt-photo-1",
      "evt-status",
      "evt-note-1",
      "evt-photo-2",
    ]);
    // photos union: original two + new one, no dupes.
    expect(fetched.photos).toEqual([
      "https://media.example/p1.jpg",
      "https://media.example/p2.jpg",
      "https://media.example/p3.jpg",
    ]);
  });
});
