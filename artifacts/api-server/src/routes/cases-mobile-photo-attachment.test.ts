/**
 * Regression suite: Mobile photo attachments must render on web/desktop.
 *
 * Protected workflow: "Mobile Photo Attachment Rendering"
 *
 * Root causes (fixed):
 *   (A) uploadPhotoAndCreateAttachment stores an id-based URL
 *       (/api/cases/:id/attachments/:uuid/file) in caseData.photos.
 *       The synthetic legacy-photo-<id>-<n> serving route called
 *       extractMediaFileName on that URL, which extracted "file" (the last
 *       path segment) — a non-existent filename — causing a 404 for every
 *       mobile-uploaded photo on a legacy case.
 *   (B) After a case is promoted from lab_cases → cases (by saving a
 *       restoration from desktop), the /:caseId/attachments/:id/file route
 *       found the canonical case but only queried caseAttachments.caseId.
 *       Mobile attachments have caseId=null and labCaseId=caseId, so the
 *       lookup returned null → 404.
 *   (C) GET /:caseId/attachments after promotion only returned rows with
 *       caseId=id, making pre-promotion attachments invisible in the Files tab.
 *
 * Fixes verified:
 *   (A) Synthetic route: if the URL in caseData.photos is id-based, resolve
 *       the UUID → real attachment row → storageKey → serve.
 *   (B) File serving route: after canonical lookup finds nothing, retry with
 *       labCaseId = caseId.
 *   (C) GET attachments: for a promoted case, union caseId + labCaseId rows.
 *
 * Additional guards:
 *   (D) file:// URIs and empty storageKeys are rejected (404).
 *   (E) Unauthenticated requests are rejected (401).
 *
 * Response envelope: all routes return { ok: true, data: T } via ok().
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
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

const tmpDir = path.join(os.tmpdir(), `labtrax-mobile-photo-${randomBytes(4).toString("hex")}`);

vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return {
    ...actual,
    startDailyOrphanedMediaCleanup: vi.fn(),
    caseMediaDir: tmpDir,
    caseMediaObjectStorageAvailable: vi.fn(() => false),
    writeCaseMediaToObjectStorage: vi.fn(async () => true),
    openCaseMediaObjectStream: vi.fn(async () => null),
  };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Mobile photo attachment rendering — regression", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const orgId = rid("org");
  const userId = rid("u");
  let token = "";

  // IDs created during tests, for cleanup.
  const labCaseIds: string[] = [];
  const canonicalCaseIds: string[] = [];

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-mobile-photos";
    fs.mkdirSync(tmpDir, { recursive: true });

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([{ id: userId, username: `u_${userId}`, password: "x" }]);
    await db.insert(organizations).values([{ id: orgId, type: "lab", name: "Photo Test Lab" }]);
    await db.insert(organizationMemberships).values([{
      id: rid("mbr"),
      labId: orgId,
      userId,
      role: "admin",
      status: "active",
    }]);

    token = await makeSession(userId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    const { db, caseAttachments, legacyCaseMedia, labCases, cases, caseRestorations } = dbMod as any;
    for (const id of labCaseIds) {
      await db.delete(legacyCaseMedia).where(eq(legacyCaseMedia.labCaseId, id)).catch(() => {});
      await db.delete(caseAttachments).where(eq(caseAttachments.labCaseId, id)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.id, id)).catch(() => {});
    }
    for (const id of canonicalCaseIds) {
      await db.delete(caseRestorations).where(eq(caseRestorations.caseId, id)).catch(() => {});
      await db.delete(caseAttachments).where(eq(caseAttachments.caseId, id)).catch(() => {});
      await db.delete(cases).where(eq(cases.id, id)).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function seedLegacyCase(photos: string[] = [], extra: Record<string, any> = {}) {
    const { db, labCases } = dbMod as any;
    const caseId = rid("lc");
    labCaseIds.push(caseId);
    await db.insert(labCases).values({
      id: caseId,
      ownerId: userId,
      organizationId: orgId,
      caseData: JSON.stringify({ photos, ...extra }),
    });
    return caseId;
  }

  async function seedAttachment(
    opts: { caseId?: string; labCaseId?: string; storageKey: string; fileName?: string },
  ) {
    const { db, caseAttachments } = dbMod as any;
    // Must be a real UUID so the regex /[0-9a-f-]{36}/ in the synthetic route
    // can extract the attachment ID from the id-based URL stored in caseData.photos.
    const attId = randomUUID();
    await db.insert(caseAttachments).values({
      id: attId,
      caseId: opts.caseId ?? null,
      labCaseId: opts.labCaseId ?? null,
      uploadedByUserId: userId,
      uploadedByOrganizationId: orgId,
      fileName: opts.fileName ?? "photo.jpg",
      storageKey: opts.storageKey,
      fileType: "image/jpeg",
      visibility: "shared_with_provider",
    });
    return attId;
  }

  async function seedLegacyMediaLedger(fileName: string, labCaseId: string) {
    const { db, legacyCaseMedia } = dbMod as any;
    await db.insert(legacyCaseMedia).values({
      fileName,
      labCaseId,
      organizationId: orgId,
      ownerId: userId,
    }).onConflictDoNothing();
  }

  async function seedCanonicalCase(labCaseId: string) {
    const { db, cases } = dbMod as any;
    canonicalCaseIds.push(labCaseId);
    await db.insert(cases).values({
      id: labCaseId,
      caseNumber: `CN-${labCaseId.slice(-8)}`,
      labOrganizationId: orgId,
      providerOrganizationId: orgId,
      patientFirstName: "Test",
      patientLastName: "Patient",
      doctorName: "Dr. Test",
      createdByUserId: userId,
      status: "received",
    });
  }

  function writeFakeImageToDisk(filename: string): string {
    const filePath = path.join(tmpDir, filename);
    // Minimal JPEG header so Content-Type detection works.
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    return filePath;
  }

  // ── (A) Synthetic legacy-photo route: id-based URL in caseData.photos ──────

  describe("(A) Synthetic legacy-photo route resolves id-based storageKey URLs", () => {
    it("serves the image when caseData.photos contains an id-based attachment URL", async () => {
      const app = appMod.default;
      const fileName = `case-media-${Date.now()}-a.jpg`;
      const storageKey = `https://host/api/cases/attachment-file/${fileName}`;

      // Seed legacy case (no photos in blob yet — we'll add the id-based URL below)
      const caseId = await seedLegacyCase([]);
      // Seed real attachment row (labCaseId FK, storageKey = old-style URL)
      const attId = await seedAttachment({ labCaseId: caseId, storageKey, fileName });
      // Register in legacy media ledger so serveLegacyCaseMediaFile can authorize
      await seedLegacyMediaLedger(fileName, caseId);
      // Write fake image bytes to the tmp disk dir so the serve path finds it
      writeFakeImageToDisk(fileName);

      // Update caseData.photos with the id-based URL (as uploadPhotoAndCreateAttachment does)
      const { db, labCases } = dbMod as any;
      const idBasedUrl = `https://host/api/cases/${caseId}/attachments/${attId}/file`;
      await db.update(labCases)
        .set({ caseData: JSON.stringify({ photos: [idBasedUrl] }) })
        .where(eq(labCases.id, caseId));

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(200);
    });

    it("returns 404 for a data: URI in caseData.photos (inline, not proxied here)", async () => {
      const app = appMod.default;
      const caseId = await seedLegacyCase(["data:image/jpeg;base64,/9j/abc"]);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("returns 404 for a file:// URI in caseData.photos (device-local, not on server)", async () => {
      const app = appMod.default;
      const caseId = await seedLegacyCase(["file:///var/mobile/Containers/Data/photo.jpg"]);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const app = appMod.default;
      const caseId = await seedLegacyCase(["file:///whatever"]);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`);

      expect(res.status).toBe(401);
    });
  });

  // ── (B) File serving falls back to labCaseId after case promotion ──────────

  describe("(B) Attachment file route falls back to labCaseId after case promotion", () => {
    it("serves a pre-promotion attachment after the case is promoted to canonical", async () => {
      const app = appMod.default;
      const fileName = `case-media-${Date.now()}-b.jpg`;
      const storageKey = `https://host/api/cases/attachment-file/${fileName}`;

      // Seed legacy lab_cases row
      const caseId = await seedLegacyCase([]);
      // Seed real attachment with labCaseId (as uploadPhotoAndCreateAttachment creates)
      const attId = await seedAttachment({ labCaseId: caseId, storageKey, fileName });
      await seedLegacyMediaLedger(fileName, caseId);
      writeFakeImageToDisk(fileName);

      // Promote the case (insert canonical cases row with same id)
      await seedCanonicalCase(caseId);

      // After promotion the canonical lookup succeeds, but the attachment has
      // labCaseId = caseId, not caseId = caseId. The fix must fall back.
      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/${attId}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status, `Expected 200 after promotion, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(200);
    });

    it("returns 403 when outsider requests a promoted-case attachment", async () => {
      const outsiderId = rid("uout");
      const { db, users } = dbMod as any;
      await db.insert(users).values([{ id: outsiderId, username: `out_${outsiderId}`, password: "x" }]);
      const outsiderToken = await makeSession(outsiderId);

      const app = appMod.default;
      const fileName = `case-media-${Date.now()}-b2.jpg`;
      const storageKey = `https://host/api/cases/attachment-file/${fileName}`;

      const caseId = await seedLegacyCase([]);
      const attId = await seedAttachment({ labCaseId: caseId, storageKey, fileName });
      await seedLegacyMediaLedger(fileName, caseId);
      writeFakeImageToDisk(fileName);
      await seedCanonicalCase(caseId);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/${attId}/file`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(403);
    });
  });

  // ── (C) GET /attachments for a promoted case includes labCaseId rows ───────

  describe("(C) GET /attachments returns pre-promotion labCaseId rows after promotion", () => {
    it("includes labCaseId attachments in GET /api/cases/:id/attachments after promotion", async () => {
      const app = appMod.default;
      const fileName = `case-media-${Date.now()}-c.jpg`;
      const storageKey = `https://host/api/cases/attachment-file/${fileName}`;

      const caseId = await seedLegacyCase([]);
      const attId = await seedAttachment({ labCaseId: caseId, storageKey, fileName });

      // Promote
      await seedCanonicalCase(caseId);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const list = res.body?.data ?? res.body;
      expect(Array.isArray(list)).toBe(true);
      const found = list.find((a: any) => a.id === attId);
      expect(found, `Expected attachment ${attId} in list, got: ${JSON.stringify(list)}`).toBeTruthy();
    });

    it("deduplicates if same attachment somehow appears in both caseId and labCaseId", async () => {
      const app = appMod.default;
      const caseId = await seedLegacyCase([]);

      // Promote FIRST so the cases FK exists before inserting an attachment with caseId set.
      await seedCanonicalCase(caseId);

      // Seed one attachment with BOTH caseId and labCaseId set
      const { db, caseAttachments } = dbMod as any;
      const attId = randomUUID();
      await db.insert(caseAttachments).values({
        id: attId,
        caseId,
        labCaseId: caseId,
        uploadedByUserId: userId,
        uploadedByOrganizationId: orgId,
        fileName: "dup.jpg",
        storageKey: `https://host/api/cases/attachment-file/dup-${attId}.jpg`,
        fileType: "image/jpeg",
        visibility: "shared_with_provider",
      });

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const list = res.body?.data ?? res.body;
      const matching = list.filter((a: any) => a.id === attId);
      expect(matching.length, "Duplicate attachment should appear only once").toBe(1);
    });
  });

  // ── (D) Reject broken local paths ─────────────────────────────────────────

  describe("(D) Broken / empty attachment storageKeys are rejected at the serving route", () => {
    it("returns 404 when the attachment storageKey is empty after promotion", async () => {
      const app = appMod.default;
      const caseId = await seedLegacyCase([]);
      // Seed attachment with blank storageKey
      const attId = await seedAttachment({ labCaseId: caseId, storageKey: "", fileName: "empty.jpg" });
      await seedCanonicalCase(caseId);

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/${attId}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("returns 404 when attachment row exists but no file on disk/storage", async () => {
      const app = appMod.default;
      const missing = `case-media-missing-${Date.now()}.jpg`;
      const storageKey = `https://host/api/cases/attachment-file/${missing}`;

      const caseId = await seedLegacyCase([]);
      const attId = await seedAttachment({ labCaseId: caseId, storageKey, fileName: missing });
      await seedLegacyMediaLedger(missing, caseId);
      // NOTE: do NOT write the file to disk — it should 404.

      const res = await request(app)
        .get(`/api/cases/${caseId}/attachments/${attId}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
