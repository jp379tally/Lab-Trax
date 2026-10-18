/**
 * Regression test for the blank legacy-mobile-case photo bug.
 *
 * Legacy mobile cases live in `lab_cases` and CANNOT have a `case_attachments`
 * row (its caseId FKs canonical `cases.id`). The media-upload endpoint still
 * hands back an `/api/cases/attachment-file/<f>` URL, but the serving route
 * historically 404'd anything without a `case_attachments` row — so every
 * photo on a legacy case rendered as a blank gray thumbnail. The nightly
 * orphan cleanup also trashed these files (no attachment reference).
 *
 * The fix binds each legacy file to its case in the `legacy_case_media` ledger
 * (first-writer-wins) on POST /legacy/cases, authorizes the serving route
 * against that ledger, and teaches the cleanup to treat ledger + live
 * lab_cases files as in-use. These tests assert:
 *   1. An owner can fetch a legacy case's media (200 + bytes).
 *   2. A cross-tenant user cannot (403).
 *   3. The orphan cleanup never trashes a ledger-bound file.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import request from "supertest";
import {
  buildMigratedLegacyPhotoContract,
  buildMigratedLegacyVideoContract,
} from "@workspace/legacy-case-media-contract";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});

// Match the global hookTimeout so the orphan-cleanup test doesn't time out
// when api-server-tests and regression-tests run concurrently at merge time.
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /api/cases/attachment-file/:filename — legacy case media", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let caseMediaMod: typeof import("../lib/case-media.js");

  const ownerUserId = rid("uowner");
  const strangerUserId = rid("ustranger");
  const labOrgId = rid("lab");
  const caseId = `${Date.now()}${randomBytes(4).toString("hex")}`;
  const crafterCaseId = `${Date.now()}${randomBytes(4).toString("hex")}c`;
  const fileFixtures = [
    {
      eventId: "evt-photo-space",
      fileName: `${rid("legacy photo")}.jpg`,
      fileBytes: randomBytes(2048),
      occurredAt: "2024-01-12T12:00:00.000Z",
    },
    {
      eventId: "evt-photo-unicode",
      fileName: `${rid("legacy-фото-雪")}.jpg`,
      fileBytes: randomBytes(2048),
      occurredAt: "2024-01-12T12:01:00.000Z",
    },
    {
      eventId: "evt-photo-reserved",
      fileName: `${rid("legacy#photo?100%")}.jpg`,
      fileBytes: randomBytes(2048),
      occurredAt: "2024-01-12T12:02:00.000Z",
    },
  ];
  const videoFixtures = [
    {
      eventId: "evt-video-space",
      fileName: `${rid("legacy video")}.mp4`,
      fileBytes: randomBytes(2048),
      occurredAt: "2024-01-12T12:03:00.000Z",
    },
    {
      eventId: "evt-video-reserved",
      fileName: `${rid("legacy#video?100%")}.mp4`,
      fileBytes: randomBytes(2048),
      occurredAt: "2024-01-12T12:04:00.000Z",
    },
  ];
  const mediaFixtures = [...fileFixtures, ...videoFixtures];
  const [primaryFile] = fileFixtures;
  const encodedFileUrl = (fileName: string) =>
    `/api/cases/attachment-file/${encodeURIComponent(fileName)}`;
  let ownerToken = "";
  let strangerToken = "";

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-media-serving";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    caseMediaMod = await import("../lib/case-media.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;
    await db.insert(users).values([
      { id: ownerUserId, username: `own_${ownerUserId}`, password: "x" },
      { id: strangerUserId, username: `str_${strangerUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values({
      id: labOrgId,
      type: "lab",
      name: "Legacy media contract lab",
    });
    await db.insert(organizationMemberships).values({
      id: rid("mbr"),
      labId: labOrgId,
      userId: ownerUserId,
      role: "admin",
      status: "active",
    });
    ownerToken = await makeSession(ownerUserId);
    strangerToken = await makeSession(strangerUserId);

    // Place a real file on disk where the upload endpoint would have stored it.
    await fsp.mkdir(caseMediaMod.caseMediaDir, { recursive: true });
    await Promise.all(
      mediaFixtures.map(({ fileName, fileBytes }) =>
        fsp.writeFile(path.join(caseMediaMod.caseMediaDir, fileName), fileBytes),
      ),
    );
  });

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    ownerToken = await makeSession(ownerUserId);
    strangerToken = await makeSession(strangerUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      labCases,
      userSessions,
      legacyCaseMedia,
    } = dbMod as any;
    await db
      .delete(legacyCaseMedia)
      .where(inArray(legacyCaseMedia.fileName, mediaFixtures.map(({ fileName }) => fileName)));
    await db.delete(labCases).where(inArray(labCases.id, [caseId, crafterCaseId]));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.labId, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerUserId, strangerUserId]));
    await db.delete(users).where(inArray(users.id, [ownerUserId, strangerUserId]));
    try {
      await Promise.all(
        mediaFixtures.map(({ fileName }) =>
          fsp.rm(path.join(caseMediaMod.caseMediaDir, fileName), { force: true }),
        ),
      );
    } catch {
      // ignore
    }
  });

  it("binds the file and serves it to the case owner (200 + bytes)", async () => {
    const app = appMod.default;

    // Create a legacy case whose caseData references the file via the
    // attachment-file URL form the upload endpoint returns.
    const caseData = {
      id: caseId,
      ownerId: ownerUserId,
      organizationId: labOrgId,
      affiliationKey: `org:${labOrgId}`,
      caseNumber: "26-MEDIA",
      patientName: "Media Test",
      status: "INTAKE",
      photos: fileFixtures.map(({ fileName }) => encodedFileUrl(fileName)),
      videos: videoFixtures.map(({ fileName }) => encodedFileUrl(fileName)),
      activityLog: [
        ...fileFixtures.map(({ eventId, fileName, occurredAt }) => ({
          id: eventId,
          type: "photo",
          timestamp: Date.parse(occurredAt),
          description: "Photo added",
          imageUri: encodedFileUrl(fileName),
          fileName,
        })),
        ...videoFixtures.map(({ eventId, fileName, occurredAt }) => ({
          id: eventId,
          type: "video",
          timestamp: Date.parse(occurredAt),
          description: "Video added",
          imageUri: encodedFileUrl(fileName),
          fileName,
        })),
      ],
    };

    const createRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ id: caseId, ownerId: ownerUserId, caseData });
    expect(createRes.status).toBe(200);

    // Ledger binding must exist (first-writer-wins).
    const { db, legacyCaseMedia } = dbMod as any;
    const bindings = await db
      .select()
      .from(legacyCaseMedia)
      .where(inArray(legacyCaseMedia.fileName, mediaFixtures.map(({ fileName }) => fileName)));
    expect(bindings).toHaveLength(mediaFixtures.length);
    expect(bindings.every((row: { ownerId: string }) => row.ownerId === ownerUserId)).toBe(true);

    // Owner can fetch every filename after exactly one URL-decoding pass.
    for (const { fileName, fileBytes } of mediaFixtures) {
      const getRes = await request(app)
        .get(encodedFileUrl(fileName))
        .set("Authorization", `Bearer ${ownerToken}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(getRes.status, fileName).toBe(200);
      expect(Buffer.isBuffer(getRes.body), fileName).toBe(true);
      expect((getRes.body as Buffer).equals(fileBytes), fileName).toBe(true);
      expect(getRes.headers["content-type"], fileName).toMatch(/^application\/octet-stream/);
      expect(getRes.headers["content-disposition"], fileName).toMatch(/^attachment;/);
      expect(getRes.headers["x-content-type-options"], fileName).toBe("nosniff");
    }
  });

  it("rejects forged attachment rows that point to another lab's legacy media", async () => {
    const app = appMod.default;
    const { db, organizations, organizationMemberships, labCases, caseAttachments } =
      dbMod as any;
    const attackerOrgId = rid("attacker-lab");
    const attackerCaseId = `${Date.now()}${randomBytes(4).toString("hex")}a`;
    const attachmentId = rid("attacker-attachment");
    const victimFile = fileFixtures[0]!;

    try {
      await db.insert(organizations).values({
        id: attackerOrgId,
        type: "lab",
        name: `Attacker lab ${attackerOrgId}`,
      });
      await db.insert(organizationMemberships).values({
        id: rid("attacker-membership"),
        labId: attackerOrgId,
        userId: strangerUserId,
        role: "user",
        status: "active",
      });
      await db.insert(labCases).values({
        id: attackerCaseId,
        ownerId: strangerUserId,
        organizationId: attackerOrgId,
        caseData: JSON.stringify({
          id: attackerCaseId,
          ownerId: strangerUserId,
          organizationId: attackerOrgId,
        }),
      });
      await db.insert(caseAttachments).values({
        id: attachmentId,
        labCaseId: attackerCaseId,
        uploadedByUserId: strangerUserId,
        uploadedByOrganizationId: attackerOrgId,
        fileName: victimFile.fileName,
        storageKey: `/uploads/case-media/${victimFile.fileName}`,
        fileType: "image/jpeg",
        visibility: "internal_lab_only",
      });

      const compatibilityDownload = await request(app)
        .get(encodedFileUrl(victimFile.fileName))
        .set("Authorization", `Bearer ${strangerToken}`);
      expect(compatibilityDownload.status).toBe(403);

      const attachmentIdDownload = await request(app)
        .get(`/api/cases/${attackerCaseId}/attachments/${attachmentId}/file`)
        .set("Authorization", `Bearer ${strangerToken}`);
      expect(attachmentIdDownload.status).toBe(403);
    } finally {
      await db.delete(caseAttachments).where(eq(caseAttachments.id, attachmentId));
      await db.delete(labCases).where(eq(labCases.id, attackerCaseId));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.labId, attackerOrgId));
      await db.delete(organizations).where(eq(organizations.id, attackerOrgId));
    }
  });

  it("keeps migrated photo and video projections aligned with the shared client contracts", async () => {
    const expectedPhotos = buildMigratedLegacyPhotoContract(
      caseId,
      fileFixtures.map(({ eventId, fileName, occurredAt }) => ({
        eventId,
        fileName,
        occurredAt,
      })),
    );
    const expectedVideos = buildMigratedLegacyVideoContract(
      caseId,
      videoFixtures.map(({ eventId, fileName, occurredAt }) => ({
        eventId,
        fileName,
        occurredAt,
      })),
    );

    const response = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(response.status).toBe(200);

    const projectedAttachments = response.body.data.attachments.map(
      (attachment: Record<string, unknown>) => ({
        id: attachment.id,
        caseId: attachment.caseId,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        storageKey: attachment.storageKey,
        url: attachment.url,
      }),
    );
    const expectedEventIds = new Set(
      [...expectedPhotos.events, ...expectedVideos.events].map((event) => event.id),
    );
    const projectedEvents = response.body.data.events
      .filter((event: { id: string }) => expectedEventIds.has(event.id))
      .map((event: Record<string, unknown>) => ({
        id: event.id,
        eventType: event.eventType,
        metadataJson: event.metadataJson,
        occurredAt: event.occurredAt,
      }))
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));

    expect(projectedAttachments).toEqual([
      ...expectedPhotos.attachments,
      ...expectedVideos.attachments,
    ]);
    expect(projectedEvents).toEqual(
      [...expectedPhotos.events, ...expectedVideos.events].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("denies a cross-tenant user (403)", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(encodedFileUrl(primaryFile.fileName))
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(getRes.status).toBe(403);
  });

  // Desktop renders legacy photos via the synthetic attachment ids projected
  // by case detail. Exercise every filename class using the ids it actually
  // returns, rather than constructing an id independent of that projection.
  it("serves every projected legacy photo to the owner and denies other tenants", async () => {
    const app = appMod.default;
    const detail = await request(app)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    const attachments = detail.body.data.attachments as Array<{
      id: string;
      storageKey: string;
    }>;

    for (const { fileName, fileBytes } of fileFixtures) {
      const matches = attachments.filter(
        (attachment) => attachment.storageKey === encodedFileUrl(fileName),
      );
      expect(matches, fileName).toHaveLength(1);
      const attachmentId = matches[0]!.id;
      expect(attachmentId, fileName).toMatch(/^legacy-photo-/);
      const url = `/api/cases/${caseId}/attachments/${encodeURIComponent(attachmentId)}/file`;
      const getRes = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${ownerToken}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(getRes.status, fileName).toBe(200);
      expect(Buffer.isBuffer(getRes.body), fileName).toBe(true);
      expect((getRes.body as Buffer).equals(fileBytes), fileName).toBe(true);

      const denied = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${strangerToken}`);
      expect(denied.status, fileName).toBe(403);
    }
  });

  it("404s a synthetic id whose index is out of range", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-9/file`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);
  });

  // Confused-deputy guard: a stranger crafts THEIR OWN legacy case whose
  // photos[] references another tenant's filename, then requests it via the
  // synthetic id route. Case-level auth passes (they own the crafted case), so
  // the serving path MUST additionally enforce the legacy_case_media ledger
  // (which bound the file to the original owner) and deny — never serve.
  it("denies a crafted caseData referencing another tenant's files (403)", async () => {
    const app = appMod.default;
    const craftedData = {
      id: crafterCaseId,
      ownerId: strangerUserId,
      caseNumber: "26-CRAFT",
      patientName: "Crafted",
      status: "INTAKE",
      photos: fileFixtures.map(({ fileName }) => encodedFileUrl(fileName)),
    };
    const createRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ id: crafterCaseId, ownerId: strangerUserId, caseData: craftedData });
    expect(createRes.status).toBe(200);

    for (const [index, { fileName }] of fileFixtures.entries()) {
      const getRes = await request(app)
        .get(`/api/cases/${crafterCaseId}/attachments/legacy-photo-${crafterCaseId}-${index}/file`)
        .set("Authorization", `Bearer ${strangerToken}`);
      expect(getRes.status, fileName).toBe(403);
    }
  });

  it("orphan cleanup never trashes a ledger-bound legacy file", async () => {
    // Re-write the file before running cleanup. When both the standalone
    // api-server-tests and the regression-tests workflows run concurrently
    // they share the same uploads/case-media directory — one suite's
    // cleanupOrphanedCaseMedia call can delete the other suite's file
    // before the ledger binding is persisted, so we can't rely on beforeAll
    // alone. Re-writing here is safe: the ledger row is already in the DB
    // (committed by the previous test in this suite).
    await fsp.mkdir(caseMediaMod.caseMediaDir, { recursive: true });
    await Promise.all(
      fileFixtures.map(({ fileName, fileBytes }) =>
        fsp.writeFile(path.join(caseMediaMod.caseMediaDir, fileName), fileBytes),
      ),
    );

    const report = await caseMediaMod.cleanupOrphanedCaseMedia({ dryRun: false });
    expect(report.mediaDirExists).toBe(true);

    // File must still be present (protected by the ledger reference).
    for (const { fileName } of fileFixtures) {
      await expect(
        fsp.access(path.join(caseMediaMod.caseMediaDir, fileName)),
      ).resolves.toBeUndefined();
    }
  });

  it("fail-safe: skips deletion when a reference scan errors", async () => {
    // Root cause of the cross-suite flake: when a reference-gathering query
    // throws (e.g. transient DB pressure while two full-suite workflows hit
    // the same DB + uploads/case-media dir), the cleanup must NOT trash on an
    // incomplete reference set — doing so removed ledger-bound legacy media.
    // Force the first reference query to throw and assert the cleanup skips
    // the deletion phase entirely instead of trashing.
    const { db } = dbMod as any;
    const spy = vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("simulated reference scan failure");
    });
    try {
      const report = await caseMediaMod.cleanupOrphanedCaseMedia({
        dryRun: false,
      });
      expect(report.removedCount).toBe(0);
      expect(report.orphanCount).toBe(0);
      expect(
        report.errors.some((e: { error: string }) =>
          /reference scan incomplete/i.test(e.error),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
