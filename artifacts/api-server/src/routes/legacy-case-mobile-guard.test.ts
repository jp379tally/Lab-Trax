/**
 * Guard tests: POST /api/legacy/cases — mobile client UUID routing guard.
 *
 * The new mobile client (X-LabTrax-Client: mobile/2) must use
 * PATCH /api/cases/:id for status updates on canonical UUID cases.
 * If it mistakenly POSTs a UUID-format ID to the legacy endpoint, the
 * server returns 410 Gone so the mistake surfaces loudly.
 *
 * Non-UUID (client-generated) IDs must still pass through — mobile still
 * creates lab_cases records via this endpoint while case creation hasn't
 * yet been migrated to the canonical POST /api/cases path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-guard"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN_DB = !!process.env["DATABASE_URL"];
const maybeDb = SHOULD_RUN_DB ? describe : describe.skip;

maybeDb(
  "Legacy cases mobile guard — UUID routing guard (DB suite)",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let auth: typeof import("../lib/auth.js");

    const labOrgId = rid("lab");
    const userId = rid("umob");
    let token = "";
    const createdCaseIds: string[] = [];

    async function makeSession(uid: string): Promise<string> {
      const { db, userSessions } = dbMod as any;
      const sessionId = rid("sess");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const t = auth.signAccessToken(uid, sessionId);
      const hash = createHash("sha256").update(t).digest("hex");
      await db
        .insert(userSessions)
        .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
      return t;
    }

    beforeAll(async () => {
      fs.mkdirSync(
        path.join(os.tmpdir(), "labtrax-test-media-guard"),
        { recursive: true }
      );
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-guard";

      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      auth = await import("../lib/auth.js");

      const { db, organizations, users, organizationMemberships } =
        dbMod as any;

      await db.insert(users).values([
        { id: userId, username: rid("user"), password: "testpass" },
      ]);
      await db.insert(organizations).values([
        { id: labOrgId, type: "lab", name: "Guard Test Lab" },
      ]);
      await db.insert(organizationMemberships).values([
        {
          id: rid("m"),
          labId: labOrgId,
          userId,
          role: "admin",
          status: "active",
        },
      ]);

      token = await makeSession(userId);
    });

    // Refresh session token before every test so a concurrent user_sessions
    // wipe does not invalidate the shared token mid-suite.
    beforeEach(async () => {
      token = await makeSession(userId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN_DB) return;
      const {
        db,
        organizations,
        users,
        organizationMemberships,
        userSessions,
        labCases,
      } = dbMod as any;
      if (createdCaseIds.length > 0) {
        await db.delete(labCases).where(inArray(labCases.id, createdCaseIds));
      }
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.userId, userId));
      await db.delete(userSessions).where(eq(userSessions.userId, userId));
      await db.delete(organizations).where(eq(organizations.id, labOrgId));
      await db.delete(users).where(eq(users.id, userId));
    });

    it("returns 410 when mobile/2 POSTs a canonical UUID case ID to legacy endpoint", async () => {
      const uuidId = "550e8400-e29b-41d4-a716-446655440000";
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .set("x-labtrax-client", "mobile/2")
        .send({
          id: uuidId,
          ownerId: userId,
          caseData: { id: uuidId, ownerId: userId, status: "INTAKE" },
        });
      expect(res.status).toBe(410);
      expect(res.body.error).toMatch(/canonical.*UUID|PATCH.*api\/cases/i);
    });

    it("does NOT return 410 for mobile/2 posting a non-UUID (legacy) case ID", async () => {
      const legacyId = rid("case");
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .set("x-labtrax-client", "mobile/2")
        .send({
          id: legacyId,
          ownerId: userId,
          caseData: { id: legacyId, ownerId: userId, status: "INTAKE" },
        });
      expect(res.status).not.toBe(410);
      expect([200, 201]).toContain(res.status);
    });

    it("proceeds to the upsert (200/201) when no mobile client header is present (desktop/web), even for a UUID", async () => {
      const uuidId = randomUUID();
      createdCaseIds.push(uuidId);
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({
          id: uuidId,
          ownerId: userId,
          caseData: { id: uuidId, ownerId: userId, status: "INTAKE" },
        });
      expect(res.status).not.toBe(410);
      expect([200, 201]).toContain(res.status);
    });

    it("proceeds to the upsert (200/201) for a non-matching client header (e.g. desktop) posting a UUID", async () => {
      const uuidId = randomUUID();
      createdCaseIds.push(uuidId);
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .set("x-labtrax-client", "desktop/1")
        .send({
          id: uuidId,
          ownerId: userId,
          caseData: { id: uuidId, ownerId: userId, status: "INTAKE" },
        });
      expect(res.status).not.toBe(410);
      expect([200, 201]).toContain(res.status);
    });

    it("proceeds to body validation (400) for a non-matching header with an invalid body", async () => {
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .set("x-labtrax-client", "desktop/1")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it("proceeds to body validation (400) when no header is present and required fields are missing", async () => {
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it("requires authentication regardless of the guard", async () => {
      const uuidId = "880e8400-e29b-41d4-a716-446655440003";
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("x-labtrax-client", "mobile/2")
        .send({
          id: uuidId,
          ownerId: userId,
          caseData: { id: uuidId, ownerId: userId, status: "INTAKE" },
        });
      expect(res.status).toBe(401);
    });
  }
);
