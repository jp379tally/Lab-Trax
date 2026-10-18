/**
 * Exception Cases — API lifecycle, RBAC and cross-identity coverage.
 *
 * Guards the acceptance criteria of the shared Exception Cases workflow:
 *   - any active lab member can flag a case; the case atomically lands
 *     On Hold (canonical status + location row + timeline event, or the
 *     legacy blob's ON_HOLD status + activity log entry);
 *   - a second active exception on the same case is rejected (409);
 *   - a provider member of the same case gets 403 from every endpoint and a
 *     member of a different lab cannot see the exception at all;
 *   - internal notes and attachments are visible to lab members and appear in
 *     the derived history for BOTH canonical and legacy cases;
 *   - only an owner/admin can resolve; a destination is optional, but when
 *     supplied it must belong to that lab and moves the case there.
 *
 * Skipped when DATABASE_URL is not configured; every row is removed in
 * afterAll so the suite is safe against the shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fsp from "node:fs/promises";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-exceptions"),
  extractMediaFileName: (storageKey: string) =>
    storageKey.split("/").filter(Boolean).at(-1) ?? null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe(
  "Case exceptions — lifecycle, RBAC and legacy parity (db integration)",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let authLib: typeof import("../lib/auth.js");

    const ownerId = rid("u_owner");
    const techId = rid("u_tech");
    const removedOwnerId = rid("u_removed_owner");
    const outsiderId = rid("u_outsider");
    const providerUserId = rid("u_provider");

    const labOrgId = rid("lab");
    const otherLabOrgId = rid("lab_other");
    const zeroLocationLabOrgId = rid("lab_empty");
    const providerOrgId = rid("prov");

    const holdLocationId = rid("loc_hold");
    const designLocationId = rid("loc_design");
    const foreignLocationId = rid("loc_foreign");
    const inactiveLocationId = rid("loc_inactive");

    const createdCaseIds: string[] = [];
    const createdLegacyIds: string[] = [];

    const tokens: Record<string, string> = {};

    async function makeSession(userId: string): Promise<string> {
      const { db, userSessions } = dbMod as any;
      const sessionId = rid("sess");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const refresh = authLib.signRefreshToken(userId, sessionId);
      const hash = createHash("sha256").update(refresh).digest("hex");
      await db
        .insert(userSessions)
        .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
      return authLib.signAccessToken(userId, sessionId);
    }

    /** Create a canonical case directly (bypasses the create route's pricing). */
    async function makeCanonicalCase(overrides: Record<string, unknown> = {}) {
      const { db, cases } = dbMod as any;
      const [row] = await db
        .insert(cases)
        .values({
          caseNumber: rid("EXC"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Exception",
          patientLastName: "Patient",
          doctorName: "Dr. Synthetic042",
          status: "in_design",
          createdByUserId: ownerId,
          labLocationId: designLocationId,
          ...overrides,
        })
        .returning();
      createdCaseIds.push(row.id);
      return row;
    }

    /** Create a legacy mobile-originated lab_cases row. */
    async function makeLegacyCase(blob: Record<string, unknown> = {}) {
      const { db, labCases } = dbMod as any;
      const id = rid("legacy");
      await db.insert(labCases).values({
        id,
        organizationId: labOrgId,
        ownerId,
        caseData: JSON.stringify({
          caseNumber: rid("MOB"),
          patientName: "Legacy Mobile",
          doctorName: "Dr. Mobile",
          status: "DESIGN",
          ...blob,
        }),
      });
      createdLegacyIds.push(id);
      return id;
    }

    beforeAll(async () => {
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-case-exceptions";
      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      authLib = await import("../lib/auth.js");

      const {
        db,
        users,
        organizations,
        organizationMemberships,
        labLocations,
      } = dbMod as any;

      await db.insert(users).values([
        {
          id: ownerId,
          username: `exc_owner_${ownerId}`,
          password: "x",
          firstName: "Olive",
          lastName: "Owner",
        },
        {
          id: techId,
          username: `exc_tech_${techId}`,
          password: "x",
          firstName: "Tina",
          lastName: "Tech",
        },
        {
          id: removedOwnerId,
          username: `exc_removed_owner_${removedOwnerId}`,
          password: "x",
          firstName: "Riley",
          lastName: "Removed",
        },
        { id: outsiderId, username: `exc_out_${outsiderId}`, password: "x" },
        {
          id: providerUserId,
          username: `exc_prov_${providerUserId}`,
          password: "x",
        },
      ]);

      await db.insert(organizations).values([
        { id: labOrgId, type: "lab", name: rid("ExceptionLab") },
        { id: otherLabOrgId, type: "lab", name: rid("OtherLab") },
        { id: zeroLocationLabOrgId, type: "lab", name: rid("EmptyLocationLab") },
        {
          id: providerOrgId,
          type: "provider",
          name: rid("ExceptionPractice"),
          parentLabOrganizationId: labOrgId,
        },
      ]);

      await db.insert(organizationMemberships).values([
        {
          id: rid("m"),
          labId: labOrgId,
          userId: ownerId,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        },
        {
          id: rid("m"),
          labId: labOrgId,
          userId: techId,
          role: "technician",
          status: "active",
          joinedAt: new Date(),
        },
        {
          id: rid("m"),
          labId: labOrgId,
          userId: removedOwnerId,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        },
        {
          id: rid("m"),
          labId: otherLabOrgId,
          userId: outsiderId,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        },
        {
          id: rid("m"),
          labId: zeroLocationLabOrgId,
          userId: ownerId,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        },
        {
          id: rid("m"),
          labId: providerOrgId,
          userId: providerUserId,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        },
      ]);

      await db.insert(labLocations).values([
        {
          id: holdLocationId,
          labOrganizationId: labOrgId,
          code: "ON_HOLD",
          name: "On Hold",
          status: "on_hold",
          isActive: true,
          sortOrder: 90,
        },
        {
          id: designLocationId,
          labOrganizationId: labOrgId,
          code: "DESIGN",
          name: "Design",
          status: "in_design",
          isActive: true,
          sortOrder: 10,
        },
        {
          id: foreignLocationId,
          labOrganizationId: otherLabOrgId,
          code: "DESIGN",
          name: "Other Lab Design",
          status: "in_design",
          isActive: true,
          sortOrder: 10,
        },
        {
          id: inactiveLocationId,
          labOrganizationId: labOrgId,
          code: "OLD_DESIGN",
          name: "Old Design",
          status: "in_design",
          isActive: false,
          sortOrder: 11,
        },
      ]);

    });

    beforeEach(async () => {
      if (!SHOULD_RUN) return;
      tokens["owner"] = await makeSession(ownerId);
      tokens["tech"] = await makeSession(techId);
      tokens["removedOwner"] = await makeSession(removedOwnerId);
      tokens["outsider"] = await makeSession(outsiderId);
      tokens["provider"] = await makeSession(providerUserId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        caseAttachments,
        caseEvents,
        caseExceptionNotes,
        caseExceptions,
        caseLocations,
        legacyCaseMedia,
        cases,
        invoices,
        labCases,
        labLocations,
        organizationMemberships,
        organizations,
        userSessions,
        users,
      } = dbMod as any;

      const labIds = [labOrgId, otherLabOrgId, zeroLocationLabOrgId];
      const userIds = [
        ownerId,
        techId,
        removedOwnerId,
        outsiderId,
        providerUserId,
      ];

      const exceptionRows = await db
        .select({ id: caseExceptions.id })
        .from(caseExceptions)
        .where(inArray(caseExceptions.labOrganizationId, labIds));
      const exceptionIds = exceptionRows.map((r: any) => r.id);
      if (exceptionIds.length) {
        await db
          .delete(caseExceptionNotes)
          .where(inArray(caseExceptionNotes.caseExceptionId, exceptionIds));
        await db
          .delete(caseAttachments)
          .where(inArray(caseAttachments.caseExceptionId, exceptionIds));
      }
      if (createdCaseIds.length) {
        await db
          .delete(caseEvents)
          .where(inArray(caseEvents.caseId, createdCaseIds));
        await db
          .delete(caseLocations)
          .where(inArray(caseLocations.caseId, createdCaseIds));
        await db
          .delete(caseAttachments)
          .where(inArray(caseAttachments.caseId, createdCaseIds));
        await db
          .delete(invoices)
          .where(inArray(invoices.caseId, createdCaseIds));
      }
      await db
        .delete(caseExceptions)
        .where(inArray(caseExceptions.labOrganizationId, labIds));
      if (createdCaseIds.length) {
        await db.delete(cases).where(inArray(cases.id, createdCaseIds));
      }
      if (createdLegacyIds.length) {
        await db
          .delete(legacyCaseMedia)
          .where(inArray(legacyCaseMedia.labCaseId, createdLegacyIds));
        await db.delete(labCases).where(inArray(labCases.id, createdLegacyIds));
      }
      await db
        .delete(labLocations)
        .where(inArray(labLocations.labOrganizationId, labIds));
      await db
        .delete(userSessions)
        .where(inArray(userSessions.userId, userIds));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, userIds));
      await db.delete(organizations).where(eq(organizations.id, providerOrgId));
      await db.delete(organizations).where(inArray(organizations.id, labIds));
      await db.delete(users).where(inArray(users.id, userIds));
    });

    function auth(role: keyof typeof tokens) {
      return `Bearer ${tokens[role]}`;
    }

    // ── Creation + atomic On Hold transition ─────────────────────────────────

    it("a non-admin lab member can flag a canonical case, which lands On Hold with a location row and a timeline event", async () => {
      const row = await makeCanonicalCase();

      const create = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("tech"))
        .send({ caseId: row.id, issueText: "Margin is short on #14" });

      expect(create.status).toBe(201);
      expect(create.body?.data?.status).toBe("active");
      expect(create.body?.data?.caseKind).toBe("canonical");
      expect(create.body?.data?.issueText).toBe("Margin is short on #14");
      expect(create.body?.data?.createdByName).toBe("Tina Tech");
      // The pre-exception location is captured so it can be reported, even
      // though resolution deliberately never auto-restores it.
      expect(create.body?.data?.previousStatus).toBe("in_design");

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${create.body.data.id}`)
        .set("Authorization", auth("tech"));
      expect(detail.status).toBe(200);
      expect(detail.body?.data?.currentLocationId).toBe(holdLocationId);
      expect(detail.body?.data?.currentLocationName).toBe("On Hold");
      expect(detail.body?.data?.currentLocationStatus).toBe("on_hold");

      const { db, caseLocations, caseEvents, notifications } = dbMod as any;
      const locs = await db
        .select()
        .from(caseLocations)
        .where(eq(caseLocations.caseId, row.id));
      expect(locs.some((l: any) => l.locationName === "On Hold")).toBe(true);

      const events = await db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, row.id));
      expect(
        events.some((e: any) => e.eventType === "case_exception_opened"),
      ).toBe(true);

      const exceptionNotifications = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, ownerId),
            eq(notifications.type, "case_exception_created"),
          ),
        );
      expect(
        exceptionNotifications.some(
          (notification: any) => notification.dataJson?.caseId === row.id,
        ),
      ).toBe(true);
    }, 30000);

    it("a legacy mobile case is flagged with the ON_HOLD blob status the read path understands", async () => {
      const legacyId = await makeLegacyCase();

      const create = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: "Wrong shade sent" });

      expect(create.status).toBe(201);
      expect(create.body?.data?.caseKind).toBe("legacy");
      expect(create.body?.data?.caseId).toBe(legacyId);

      const { db, labCases } = dbMod as any;
      const [row] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const blob = JSON.parse(row.caseData);
      // MUST be ON_HOLD: MOBILE_TO_DESKTOP_STATUS only maps that spelling back
      // to on_hold, so "HOLD" would silently project as `received`.
      expect(blob.status).toBe("ON_HOLD");
      expect(
        blob.activityLog.some((a: any) => a.type === "exception_opened"),
      ).toBe(true);

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${create.body.data.id}`)
        .set("Authorization", auth("owner"));
      expect(detail.status).toBe(200);
      expect(detail.body?.data?.currentLocationId).toBe(holdLocationId);
      expect(detail.body?.data?.currentLocationName).toBe("On Hold");
      expect(detail.body?.data?.currentLocationStatus).toBe("on_hold");
    }, 30000);

    it("lazily provisions every station for a zero-location lab before holding a legacy case", async () => {
      const { db, labCases, labLocations } = dbMod as any;
      const legacyId = rid("legacy_empty_locations");
      createdLegacyIds.push(legacyId);
      await db.insert(labCases).values({
        id: legacyId,
        organizationId: zeroLocationLabOrgId,
        ownerId,
        caseData: JSON.stringify({
          caseNumber: rid("MOB"),
          patientName: "No Stations Yet",
          status: "DESIGN",
        }),
      });

      // Omit putOnHold to cover the legacy request body's default hold path.
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId });
      expect(created.status).toBe(201);
      expect(created.body.data.currentLocationStatus).toBe("on_hold");

      const stations = await db
        .select()
        .from(labLocations)
        .where(eq(labLocations.labOrganizationId, zeroLocationLabOrgId));
      expect(stations).toHaveLength(14);
      const hold = stations.find((station: any) => station.status === "on_hold");
      expect(hold).toBeTruthy();
      const [legacy] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      expect(JSON.parse(legacy.caseData)).toMatchObject({
        status: "ON_HOLD",
        labLocationId: hold.id,
      });
    }, 30000);

    it("creates canonical and legacy exceptions at an explicitly selected active location", async () => {
      const canonical = await makeCanonicalCase();
      const canonicalCreate = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("tech"))
        .send({
          caseId: canonical.id,
          putOnHold: false,
          labLocationId: designLocationId,
        });
      expect(canonicalCreate.status).toBe(201);
      expect(canonicalCreate.body.data.caseStatus).toBe("in_design");
      expect(canonicalCreate.body.data.currentLocationId).toBe(
        designLocationId,
      );

      const legacyId = await makeLegacyCase();
      const legacyCreate = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({
          caseId: legacyId,
          putOnHold: false,
          labLocationId: designLocationId,
        });
      expect(legacyCreate.status).toBe(201);
      const { db, cases, labCases } = dbMod as any;
      const [canonicalRow] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, canonical.id));
      expect(canonicalRow.labLocationId).toBe(designLocationId);
      const [legacyRow] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      expect(JSON.parse(legacyRow.caseData)).toMatchObject({
        status: "DESIGN",
        labLocationId: designLocationId,
      });
    }, 30000);

    it("rejects missing, foreign, and inactive non-hold locations without creating or moving a case", async () => {
      const { db, caseExceptions, cases } = dbMod as any;
      for (const labLocationId of [
        undefined,
        foreignLocationId,
        inactiveLocationId,
      ]) {
        const row = await makeCanonicalCase();
        const result = await request(appMod.default)
          .post("/api/case-exceptions")
          .set("Authorization", auth("owner"))
          .send({
            caseId: row.id,
            putOnHold: false,
            ...(labLocationId ? { labLocationId } : {}),
          });
        expect(result.status).toBe(400);
        const exceptions = await db
          .select()
          .from(caseExceptions)
          .where(eq(caseExceptions.caseId, row.id));
        expect(exceptions).toHaveLength(0);
        const [unchanged] = await db
          .select()
          .from(cases)
          .where(eq(cases.id, row.id));
        expect(unchanged.status).toBe("in_design");
        expect(unchanged.labLocationId).toBe(designLocationId);
      }

    // Legacy rows use a whole JSON blob, so ensure validation inside the
    // transaction does not append an activity entry or rewrite its state.
    const legacyId = await makeLegacyCase();
    const [beforeLegacy] = await db
      .select()
      .from((dbMod as any).labCases)
      .where(eq((dbMod as any).labCases.id, legacyId));
    const legacyResult = await request(appMod.default)
      .post("/api/case-exceptions")
      .set("Authorization", auth("owner"))
      .send({ caseId: legacyId, putOnHold: false });
    expect(legacyResult.status).toBe(400);
    const legacyExceptions = await db
      .select()
      .from(caseExceptions)
      .where(eq(caseExceptions.labCaseId, legacyId));
    expect(legacyExceptions).toHaveLength(0);
    const [afterLegacy] = await db
      .select()
      .from((dbMod as any).labCases)
      .where(eq((dbMod as any).labCases.id, legacyId));
    expect(afterLegacy.caseData).toBe(beforeLegacy.caseData);
    }, 30000);

    it("returns the queue's live location after a case moves while its exception remains active", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({
          caseId: row.id,
          putOnHold: false,
          labLocationId: designLocationId,
        });
      expect(created.status).toBe(201);
      const { db, cases } = dbMod as any;
      await db
        .update(cases)
        .set({ status: "on_hold", labLocationId: holdLocationId })
        .where(eq(cases.id, row.id));
      const queue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("owner"));
      const item = queue.body.data.exceptions.find(
        (exception: any) => exception.id === created.body.data.id,
      );
      expect(item).toMatchObject({
        currentLocationId: holdLocationId,
        currentLocationName: "On Hold",
        currentLocationStatus: "on_hold",
      });

      const legacyId = await makeLegacyCase();
      const legacyCreated = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({
          caseId: legacyId,
          putOnHold: false,
          labLocationId: designLocationId,
        });
      const { labCases } = dbMod as any;
      const [legacy] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      await db
        .update(labCases)
        .set({
          caseData: JSON.stringify({
            ...JSON.parse(legacy.caseData),
            status: "ON_HOLD",
            labLocationId: holdLocationId,
          }),
        })
        .where(eq(labCases.id, legacyId));
      const refreshedQueue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("owner"));
      const legacyItem = refreshedQueue.body.data.exceptions.find(
        (exception: any) => exception.id === legacyCreated.body.data.id,
      );
      expect(legacyItem).toMatchObject({
        currentLocationId: holdLocationId,
        currentLocationName: "On Hold",
        currentLocationStatus: "on_hold",
      });
    }, 30000);

    it("rejects a second active exception on the same case", async () => {
      const row = await makeCanonicalCase();

      const first = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      expect(first.status).toBe(201);

      const second = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("tech"))
        .send({ caseId: row.id, issueText: "Same case again" });
      expect(second.status).toBe(409);
    }, 30000);

    // ── Access control ───────────────────────────────────────────────────────

    it("immediately rejects a soft-deleted active membership across shared, read, write, and admin checks", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("removedOwner"))
        .send({ caseId: row.id, issueText: "Access must end immediately" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      const { db, organizationMemberships } = dbMod as any;
      await db
        .update(organizationMemberships)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(organizationMemberships.userId, removedOwnerId),
            eq(organizationMemberships.labId, labOrgId),
          ),
        );

      const { getActiveMembership, requireAnyRole, requireMembership } =
        await import("../lib/rbac.js");
      await expect(
        getActiveMembership(removedOwnerId, labOrgId),
      ).resolves.toBeNull();
      await expect(
        requireMembership(removedOwnerId, labOrgId),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        requireAnyRole(removedOwnerId, labOrgId, ["owner", "admin"]),
      ).rejects.toMatchObject({ statusCode: 403 });

      const removedRead = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("removedOwner"));
      expect(removedRead.status).toBe(403);

      const removedWrite = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("removedOwner"))
        .send({ noteText: "This must not be saved" });
      expect(removedWrite.status).toBe(403);

      const removedAdminWrite = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("removedOwner"))
        .send({ resolutionNote: "This must not resolve" });
      expect(removedAdminWrite.status).toBe(403);

      const activeRead = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(activeRead.status).toBe(200);

      const activeWrite = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: "Active membership still works" });
      expect(activeWrite.status).toBe(201);
    }, 30000);

    it("rejects a provider member and a member of another lab", async () => {
      const row = await makeCanonicalCase();

      const asProvider = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("provider"))
        .send({ caseId: row.id });
      expect(asProvider.status).toBe(403);

      const asOutsider = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("outsider"))
        .send({ caseId: row.id });
      expect(asOutsider.status).toBe(403);

      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Internal only" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      // Detail and the queue stay inside the owning lab.
      const outsiderDetail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("outsider"));
      expect(outsiderDetail.status).toBe(403);

      const outsiderQueue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("outsider"));
      expect(outsiderQueue.status).toBe(200);
      expect(
        (outsiderQueue.body?.data?.exceptions ?? []).some(
          (e: any) => e.id === exceptionId,
        ),
      ).toBe(false);
    }, 30000);

    it("never leaks exception content into a provider's case list or case detail", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Confidential internal issue" });
      expect(created.status).toBe(201);

      // The provider is legitimately authorized for this case through its
      // provider organization, so it DOES see the row — the exception fields on
      // that row are what must be redacted.
      const providerList = await request(appMod.default)
        .get("/api/cases")
        .set("Authorization", auth("provider"));
      expect(providerList.status).toBe(200);
      const providerRow = (providerList.body?.data ?? []).find(
        (c: any) => c.id === row.id,
      );
      expect(
        providerRow,
        "provider should still see the case itself",
      ).toBeTruthy();
      expect(providerRow.activeException).toBeNull();
      expect(providerRow.hasActiveException).toBe(false);
      // Belt and braces: the issue text must not appear anywhere in the payload.
      expect(JSON.stringify(providerList.body)).not.toContain(
        "Confidential internal issue",
      );

      // Case detail redacts it too.
      const providerDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (providerDetail.status === 200) {
        expect(providerDetail.body?.data?.activeException ?? null).toBeNull();
        expect(JSON.stringify(providerDetail.body)).not.toContain(
          "Confidential internal issue",
        );
      } else {
        expect([403, 404]).toContain(providerDetail.status);
      }

      // A lab member on the same list DOES get the exception.
      const labList = await request(appMod.default)
        .get("/api/cases")
        .set("Authorization", auth("tech"));
      expect(labList.status).toBe(200);
      const labRow = (labList.body?.data ?? []).find(
        (c: any) => c.id === row.id,
      );
      expect(labRow?.hasActiveException).toBe(true);
      expect(labRow?.activeException?.issueText).toBe(
        "Confidential internal issue",
      );
    }, 30000);

    it("keeps exception attachment names and notes out of a provider's payload", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Confidential issue detail" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      const attach = await request(appMod.default)
        .post(`/api/cases/${row.id}/attachments`)
        .set("Authorization", auth("owner"))
        .send({
          storageKey: "/uploads/case-media/secret-evidence.jpg",
          fileName: "SecretEvidenceFileName.jpg",
          fileType: "image/jpeg",
          note: "SecretAttachmentNote",
          caseExceptionId: exceptionId,
        });
      expect(attach.status).toBe(201);

      // A provider must not learn the file name, the attachment note, or the
      // issue text through ANY part of the case payload — including the
      // timeline event metadata, which is not covered by field-level asserts.
      const providerDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (providerDetail.status === 200) {
        const serialized = JSON.stringify(providerDetail.body);
        expect(serialized).not.toContain("SecretEvidenceFileName");
        expect(serialized).not.toContain("SecretAttachmentNote");
        expect(serialized).not.toContain("Confidential issue detail");
        // The internal exception events are withheld wholesale.
        expect(serialized).not.toContain("case_exception_opened");
      } else {
        expect([403, 404]).toContain(providerDetail.status);
      }

      // The lab still sees everything it needs.
      const labDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("tech"));
      expect(labDetail.status).toBe(200);
      expect(
        (labDetail.body?.data?.attachments ?? []).some(
          (a: any) => a.fileName === "SecretEvidenceFileName.jpg",
        ),
      ).toBe(true);
    }, 30000);

    it("refuses to let a provider attach content to a lab exception", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Lab only" });
      const exceptionId = created.body.data.id;

      // The provider can reach the case's attachment endpoint through its
      // provider organization, so the exception link needs its own lab gate.
      const asProvider = await request(appMod.default)
        .post(`/api/cases/${row.id}/attachments`)
        .set("Authorization", auth("provider"))
        .send({
          storageKey: "/uploads/case-media/provider-injected.jpg",
          fileName: "provider-injected.jpg",
          fileType: "image/jpeg",
          caseExceptionId: exceptionId,
        });
      expect(asProvider.status).toBe(403);

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("owner"));
      expect(detail.body?.data?.attachments ?? []).toHaveLength(0);
    }, 30000);

    it("refuses to reshare an exception attachment and redacts its deletion event", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      const exceptionId = created.body.data.id;

      const attach = await request(appMod.default)
        .post(`/api/cases/${row.id}/attachments`)
        .set("Authorization", auth("owner"))
        .send({
          storageKey: "/uploads/case-media/reshare-attempt.jpg",
          fileName: "ResharedSecretName.jpg",
          fileType: "image/jpeg",
          note: "ResharedSecretNote",
          caseExceptionId: exceptionId,
        });
      expect(attach.status).toBe(201);
      const attachmentId = attach.body.data.id;

      // An admin must not be able to hand exception evidence to the provider by
      // flipping its visibility after the fact.
      const reshare = await request(appMod.default)
        .patch(`/api/cases/${row.id}/attachments/${attachmentId}`)
        .set("Authorization", auth("owner"))
        .send({ visibility: "shared_with_provider" });
      expect(reshare.status).toBe(400);

      const stillInternal = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("owner"));
      expect(stillInternal.body?.data?.attachments?.[0]?.visibility).toBe(
        "internal_lab_only",
      );

      // Exception evidence notes are immutable: editing must be rejected and
      // the original note must remain the source of truth.
      const renote = await request(appMod.default)
        .patch(`/api/cases/${row.id}/attachments/${attachmentId}`)
        .set("Authorization", auth("owner"))
        .send({ note: "EditedSecretNote" });
      expect(renote.status).toBe(400);

      const afterRejectedNoteEdit = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("owner"));
      expect(afterRejectedNoteEdit.body?.data?.attachments?.[0]?.note).toBe(
        "ResharedSecretNote",
      );

      const afterPatch = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (afterPatch.status === 200) {
        const serialized = JSON.stringify(afterPatch.body);
        expect(serialized).not.toContain("ResharedSecretName");
        expect(serialized).not.toContain("ResharedSecretNote");
        expect(serialized).not.toContain("EditedSecretNote");
      }

      // Deleting emits its own provider-visible timeline event, which must not
      // carry the file name either.
      const del = await request(appMod.default)
        .delete(`/api/cases/${row.id}/attachments/${attachmentId}`)
        .set("Authorization", auth("owner"));
      expect(del.status).toBe(200);

      const afterDelete = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (afterDelete.status === 200) {
        const serialized = JSON.stringify(afterDelete.body);
        expect(serialized).not.toContain("ResharedSecretName");
        expect(serialized).not.toContain("EditedSecretNote");
        expect(serialized).not.toContain("ResharedSecretNote");
      }

      // The lab's own timeline still records that a file was removed.
      const labAfterDelete = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("owner"));
      expect(
        (labAfterDelete.body?.data?.events ?? []).some(
          (e: any) => e.eventType === "case_attachment_deleted",
        ),
      ).toBe(true);
    }, 30000);

    it("a technician cannot resolve; an owner can", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("tech"))
        .send({ caseId: row.id, issueText: "Needs a second look" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      const techDetail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(techDetail.status).toBe(200);
      expect(techDetail.body?.data?.viewerCanResolve).toBe(false);

      const techResolve = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("tech"))
        .send({ labLocationId: designLocationId });
      expect(techResolve.status).toBe(403);

      const ownerDetail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("owner"));
      expect(ownerDetail.body?.data?.viewerCanResolve).toBe(true);
    }, 30000);

    it("resolution accepts no destination but still rejects a destination from another lab", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      const exceptionId = created.body.data.id;

      const missing = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "Resolved in place" });
      expect(missing.status).toBe(200);
      expect(missing.body?.data?.resolutionLabLocationId).toBeNull();
      expect(missing.body?.data?.resolutionStatus).toBe("on_hold");

      const foreignCase = await makeCanonicalCase();
      const foreignException = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: foreignCase.id });

      const foreign = await request(appMod.default)
        .post(`/api/case-exceptions/${foreignException.body.data.id}/resolve`)
        .set("Authorization", auth("owner"))
        .send({
          labLocationId: foreignLocationId,
          resolutionNote: "Tried a foreign destination",
        });
      expect(foreign.status).toBe(400);
      expect(foreign.body?.message).toContain("destination location");
    }, 30000);

    it("rejects a resolution with no note, or a blank one, with a clear message", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Needs a resolution note" });
      const exceptionId = created.body.data.id;

      // An older shipped client omits the field entirely.
      const omitted = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ labLocationId: designLocationId });
      expect(omitted.status).toBe(400);
      // Not the generic ZodError "Invalid request." — the user is told what to do.
      expect(omitted.body?.message).toBe(
        "A resolution note is required to resolve an exception.",
      );

      // Whitespace-only is the same as missing.
      const blank = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "   \n  " });
      expect(blank.status).toBe(400);
      expect(blank.body?.message).toBe(
        "A resolution note is required to resolve an exception.",
      );

      // Nothing was written: the exception is still active and resolvable.
      const stillActive = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("owner"));
      expect(stillActive.body?.data?.status).toBe("active");

      const resolved = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "  Margin corrected  " });
      expect(resolved.status).toBe(200);
      // The stored note is trimmed.
      expect(resolved.body?.data?.resolutionNote).toBe("Margin corrected");
    }, 30000);

    // ── Notes, media visibility and history ──────────────────────────────────

    it("the queue previews the newest internal note and preserves the no-note fallback", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Check the bite" });
      const exceptionId = created.body.data.id;

      const note = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: "Model re-poured, waiting on articulation" });
      expect(note.status).toBe(201);

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(detail.status).toBe(200);
      expect(detail.body?.data?.notes?.length).toBe(1);
      expect(detail.body?.data?.notes?.[0]?.authorName).toBe("Tina Tech");
      expect(detail.body?.data?.notes?.[0]?.noteText).toBe(
        "Model re-poured, waiting on articulation",
      );
      const types = (detail.body?.data?.history ?? []).map((h: any) => h.type);
      expect(types).toContain("opened");
      expect(types).toContain("note_added");

      const { db, caseExceptionNotes } = dbMod as any;
      const tiedAt = new Date(Date.now() + 1000);
      const tiedIdPrefix = rid("note_tie");
      await db.insert(caseExceptionNotes).values([
        {
          id: `${tiedIdPrefix}_a`,
          caseExceptionId: exceptionId,
          authorUserId: techId,
          authorName: "Tina Tech",
          noteText: "Older id at the same timestamp",
          createdAt: tiedAt,
        },
        {
          id: `${tiedIdPrefix}_z`,
          caseExceptionId: exceptionId,
          authorUserId: ownerId,
          authorName: "Olive Owner",
          noteText: "Newest follow-up after articulation",
          createdAt: tiedAt,
        },
      ]);

      const noNoteCase = await makeCanonicalCase();
      const noNoteCreated = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: noNoteCase.id, issueText: "Original issue fallback" });

      const legacyId = await makeLegacyCase();
      const legacyCreated = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: "Legacy original issue" });
      const legacyNoteAt = new Date(Date.now() + 2000);
      await db.insert(caseExceptionNotes).values({
        id: rid("legacy_note"),
        caseExceptionId: legacyCreated.body.data.id,
        authorUserId: techId,
        authorName: "Tina Tech",
        noteText: "Legacy follow-up preview",
        createdAt: legacyNoteAt,
      });

      const queue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("owner"));
      const entry = (queue.body?.data?.exceptions ?? []).find(
        (e: any) => e.id === exceptionId,
      );
      expect(entry?.noteCount).toBe(3);
      expect(entry?.latestNoteText).toBe("Newest follow-up after articulation");
      expect(entry?.latestNoteAuthorName).toBe("Olive Owner");
      expect(entry?.latestNoteCreatedAt).toBe(tiedAt.toISOString());
      expect(entry?.hasMedia).toBe(false);
      expect(entry?.patientFirstName).toBe("Exception");

      const noNoteEntry = (queue.body?.data?.exceptions ?? []).find(
        (e: any) => e.id === noNoteCreated.body.data.id,
      );
      expect(noNoteEntry).toMatchObject({
        issueText: "Original issue fallback",
        createdByName: "Olive Owner",
        noteCount: 0,
        latestNoteText: null,
        latestNoteAuthorName: null,
        latestNoteCreatedAt: null,
      });

      const legacyEntry = (queue.body?.data?.exceptions ?? []).find(
        (e: any) => e.id === legacyCreated.body.data.id,
      );
      expect(legacyEntry).toMatchObject({
        caseKind: "legacy",
        caseId: legacyId,
        noteCount: 1,
        latestNoteText: "Legacy follow-up preview",
        latestNoteAuthorName: "Tina Tech",
        latestNoteCreatedAt: legacyNoteAt.toISOString(),
      });
    }, 30000);

    it("rejects blank notes, notes after resolution, and notes from inactive memberships", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Check active-only notes" });
      const exceptionId = created.body.data.id;

      const blank = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: "   " });
      expect(blank.status).toBe(400);

      const { db, organizationMemberships } = dbMod as any;
      await db
        .update(organizationMemberships)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(organizationMemberships.userId, techId),
            eq(organizationMemberships.labId, labOrgId),
          ),
        );
      const inactive = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: "Should not be accepted" });
      expect(inactive.status).toBe(403);
      await db
        .update(organizationMemberships)
        .set({ deletedAt: null })
        .where(
          and(
            eq(organizationMemberships.userId, techId),
            eq(organizationMemberships.labId, labOrgId),
          ),
        );

      const resolved = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "Resolved before follow-up" });
      expect(resolved.status).toBe(200);
      const afterResolution = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: "Too late" });
      expect(afterResolution.status).toBe(409);
    }, 30000);

    it("mirrors exception issue, follow-up, and resolution text into canonical case history for lab members only", async () => {
      const row = await makeCanonicalCase();
      const issue = "Internal issue: margin needs review";
      const followUp = "Internal follow-up: technician checked the model";
      const resolution = "Internal resolution: margin corrected";

      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: issue });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      const note = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: followUp });
      expect(note.status).toBe(201);

      const resolve = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ labLocationId: designLocationId, resolutionNote: resolution });
      expect(resolve.status).toBe(200);

      const labDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("tech"));
      expect(labDetail.status).toBe(200);
      const history = labDetail.body?.data?.events ?? [];
      expect(history.map((event: any) => event.eventType)).toEqual(
        expect.arrayContaining([
          "internal_exception_opened_note",
          "internal_exception_note_added",
          "internal_exception_resolution_note_added",
        ]),
      );
      expect(JSON.stringify(history)).toContain(issue);
      expect(JSON.stringify(history)).toContain(followUp);
      expect(JSON.stringify(history)).toContain(resolution);
      expect(JSON.stringify(history)).toContain("Olive Owner");
      expect(JSON.stringify(history)).toContain("Tina Tech");

      const providerDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (providerDetail.status === 200) {
        const serialized = JSON.stringify(providerDetail.body);
        expect(serialized).not.toContain("internal_exception");
        expect(serialized).not.toContain(issue);
        expect(serialized).not.toContain(followUp);
        expect(serialized).not.toContain(resolution);
      } else {
        expect([403, 404]).toContain(providerDetail.status);
      }
    }, 30000);

    it("an exception-linked attachment is forced internal and counts as media on the queue", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      const exceptionId = created.body.data.id;

      const attach = await request(appMod.default)
        .post(`/api/cases/${row.id}/attachments`)
        .set("Authorization", auth("owner"))
        .send({
          storageKey: "/uploads/case-media/exception-photo.jpg",
          fileName: "exception-photo.jpg",
          fileType: "image/jpeg",
          // Deliberately request provider visibility — the server must override
          // it because exception content is lab-internal.
          visibility: "shared_with_provider",
          caseExceptionId: exceptionId,
        });
      expect(attach.status).toBe(201);
      expect(attach.body?.data?.visibility).toBe("internal_lab_only");

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(detail.body?.data?.attachments?.length).toBe(1);
      expect(
        (detail.body?.data?.history ?? []).some(
          (h: any) => h.type === "media_added",
        ),
      ).toBe(true);

      const queue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("owner"));
      const entry = (queue.body?.data?.exceptions ?? []).find(
        (e: any) => e.id === exceptionId,
      );
      expect(entry?.hasMedia).toBe(true);
      expect(entry?.mediaCount).toBe(1);
    }, 30000);

    it("saves follow-up attachments with their note and returns them inside the conversation", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      const exceptionId = created.body.data.id;
      const attachedFiles = [
        {
          storageKey: "/uploads/case-media/exception-follow-up.jpg",
          fileName: "follow-up.jpg",
          fileType: "image/jpeg",
        },
        {
          storageKey: "/uploads/case-media/exception-report.pdf",
          fileName: "report.pdf",
          fileType: "application/pdf",
        },
      ];

      const note = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({
          noteText: "Please review these measurements.",
          attachments: attachedFiles,
        });
      expect(note.status).toBe(201);
      expect(note.body?.data?.attachments).toHaveLength(2);

      const { db, caseAttachments } = dbMod as any;
      const rows = await db.query.caseAttachments.findMany({
        where: eq(caseAttachments.caseExceptionNoteId, note.body.data.id),
      });
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: row.id,
            caseExceptionId: exceptionId,
            caseExceptionNoteId: note.body.data.id,
            fileName: "follow-up.jpg",
            visibility: "internal_lab_only",
          }),
          expect.objectContaining({
            caseId: row.id,
            caseExceptionId: exceptionId,
            caseExceptionNoteId: note.body.data.id,
            fileName: "report.pdf",
            visibility: "internal_lab_only",
          }),
        ]),
      );

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(detail.status).toBe(200);
      expect(detail.body?.data?.notes?.[0]?.attachments).toHaveLength(2);
      expect(detail.body?.data?.attachments).toHaveLength(0);
      expect(
        detail.body?.data?.notes?.[0]?.attachments.map(
          (attachment: any) => attachment.fileName,
        ),
      ).toEqual(expect.arrayContaining(["follow-up.jpg", "report.pdf"]));

      const providerDetail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("provider"));
      if (providerDetail.status === 200) {
        expect(JSON.stringify(providerDetail.body)).not.toContain("follow-up.jpg");
        expect(JSON.stringify(providerDetail.body)).not.toContain("report.pdf");
      } else {
        expect([403, 404]).toContain(providerDetail.status);
      }
    }, 30000);

    it.each(["canonical", "legacy"] as const)(
      "keeps %s exception-note evidence private through the existing attachment file route",
      async (caseKind) => {
        const caseId = caseKind === "canonical"
          ? (await makeCanonicalCase()).id
          : await makeLegacyCase();
        const fileName = `${rid("exception_note_evidence")}.pdf`;
        const fileBytes = Buffer.from("%PDF-1.4\nPrivate exception-note evidence\n");
        const filePath = path.join(
          os.tmpdir(), "labtrax-test-media-exceptions", fileName,
        );
        await fsp.mkdir(path.dirname(filePath), { recursive: true });

        try {
          await fsp.writeFile(filePath, fileBytes);
          const created = await request(appMod.default)
            .post("/api/case-exceptions")
            .set("Authorization", auth("owner"))
            .send({ caseId });
          expect(created.status).toBe(201);
          const exceptionId = created.body.data.id;

          const note = await request(appMod.default)
            .post(`/api/case-exceptions/${exceptionId}/notes`)
            .set("Authorization", auth("owner"))
            .send({
              noteText: "Supporting evidence for this internal note.",
              attachments: [{
                storageKey: `/uploads/case-media/${fileName}`,
                fileName,
                fileType: "application/pdf",
              }],
            });
          expect(note.status).toBe(201);
          expect(note.body.data.attachments).toHaveLength(1);
          const attachmentId = note.body.data.attachments[0].id;

          // Prove this is a valid note association, not an unrelated file fixture.
          const { db, caseAttachments } = dbMod as any;
          const attachment = await db.query.caseAttachments.findFirst({
            where: eq(caseAttachments.id, attachmentId),
          });
          expect(attachment).toMatchObject({
            caseId: caseKind === "canonical" ? caseId : null,
            labCaseId: caseKind === "legacy" ? caseId : null,
            caseExceptionId: exceptionId,
            caseExceptionNoteId: note.body.data.id,
            visibility: "internal_lab_only",
          });
          const detail = await request(appMod.default)
            .get(`/api/case-exceptions/${exceptionId}`)
            .set("Authorization", auth("tech"));
          expect(detail.status).toBe(200);
          expect(detail.body.data.notes[0].attachments).toMatchObject([
            { id: attachmentId, fileName },
          ]);

          const fileUrl = `/api/cases/${caseId}/attachments/${attachmentId}/file`;
          // This technician is neither the case owner nor the note's author.
          const allowed = await request(appMod.default)
            .get(fileUrl)
            .set("Authorization", auth("tech"))
            .buffer(true)
            .parse((res, callback) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => callback(null, Buffer.concat(chunks)));
              res.on("error", callback);
            });
          expect(allowed.status).toBe(200);
          expect(allowed.body).toEqual(fileBytes);

          const unauthenticated = await request(appMod.default).get(fileUrl);
          expect(unauthenticated.status).toBe(401);
          const otherLab = await request(appMod.default)
            .get(fileUrl)
            .set("Authorization", auth("outsider"));
          expect(otherLab.status).toBe(403);
        } finally {
          // Remove only this test's bytes, even when an assertion fails.
          await fsp.rm(filePath, { force: true });
        }
      },
      30000,
    );

    it("registers legacy follow-up attachments in the legacy media access ledger", async () => {
      const legacyCaseId = await makeLegacyCase();
      const legacyFileName = `${rid("legacy_follow_up")}.pdf`;
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyCaseId });
      const exceptionId = created.body.data.id;
      const note = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({
          noteText: "Legacy case supporting document.",
          attachments: [
            {
              storageKey: `/uploads/case-media/${legacyFileName}`,
              fileName: legacyFileName,
              fileType: "application/pdf",
            },
          ],
        });
      expect(note.status).toBe(201);
      expect(note.body?.data?.attachments).toHaveLength(1);
      expect(note.body?.data?.attachments[0]).toMatchObject({
        fileName: legacyFileName,
        fileType: "application/pdf",
        visibility: "internal_lab_only",
      });

      const { db, caseAttachments, legacyCaseMedia } = dbMod as any;
      const attachment = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.caseExceptionNoteId, note.body.data.id),
      });
      expect(attachment).toMatchObject({
        labCaseId: legacyCaseId,
        caseExceptionId: exceptionId,
      });
      const ledgerRow = await db.query.legacyCaseMedia.findFirst({
        where: eq(legacyCaseMedia.fileName, legacyFileName),
      });
      expect(ledgerRow).toMatchObject({
        labCaseId: legacyCaseId,
        organizationId: labOrgId,
        ownerId,
      });

      const detail = await request(appMod.default)
        .get(`/api/case-exceptions/${exceptionId}`)
        .set("Authorization", auth("tech"));
      expect(detail.status).toBe(200);
      expect(detail.body?.data?.notes?.[0]?.attachments).toMatchObject([
        {
          fileName: legacyFileName,
          fileType: "application/pdf",
        },
      ]);
      expect(detail.body?.data?.attachments).toHaveLength(0);
    }, 30000);

    // ── Resolution ───────────────────────────────────────────────────────────

    it("resolves a canonical case in place without changing its current location or status", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Review complete" });

      const resolved = await request(appMod.default)
        .post(`/api/case-exceptions/${created.body.data.id}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "No move needed" });
      expect(resolved.status).toBe(200);
      expect(resolved.body?.data?.resolutionLabLocationId).toBeNull();
      expect(resolved.body?.data?.resolutionStatus).toBe("on_hold");
      expect(resolved.body?.data?.destinationLocationName).toBeNull();

      const { db, cases, caseLocations, caseEvents } = dbMod as any;
      const [savedCase] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, row.id));
      expect(savedCase.status).toBe("on_hold");
      expect(savedCase.labLocationId).toBe(holdLocationId);

      const locations = await db
        .select()
        .from(caseLocations)
        .where(eq(caseLocations.caseId, row.id));
      expect(locations).toHaveLength(1);

      const events = await db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, row.id));
      const resolutionEvent = events.find(
        (event: any) => event.eventType === "case_exception_resolved",
      );
      expect(resolutionEvent?.metadataJson).toEqual(
        expect.objectContaining({
          toStatus: "on_hold",
          locationName: "On Hold",
        }),
      );

      const exceptionDetail = await request(appMod.default)
        .get(`/api/case-exceptions/${created.body.data.id}`)
        .set("Authorization", auth("owner"));
      expect(exceptionDetail.body?.data?.resolvedByName).toBe("Olive Owner");
      expect(exceptionDetail.body?.data?.resolutionNote).toBe("No move needed");
      expect(
        exceptionDetail.body?.data?.history?.some(
          (entry: any) =>
            entry.type === "resolved" && entry.detail === "No move needed",
        ),
      ).toBe(true);
    }, 30000);

    it("resolving a canonical case moves it to the chosen location and clears it from the queue", async () => {
      const row = await makeCanonicalCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id, issueText: "Contact too tight" });
      const exceptionId = created.body.data.id;

      const resolve = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({
          labLocationId: designLocationId,
          resolutionNote: "Adjusted and re-polished",
        });

      expect(resolve.status).toBe(200);
      expect(resolve.body?.data?.status).toBe("resolved");
      expect(resolve.body?.data?.resolvedByName).toBe("Olive Owner");
      expect(resolve.body?.data?.resolutionLabLocationId).toBe(
        designLocationId,
      );
      expect(resolve.body?.data?.destinationStatus).toBe("in_design");

      const detail = await request(appMod.default)
        .get(`/api/cases/${row.id}`)
        .set("Authorization", auth("owner"));
      expect(detail.body?.data?.status).toBe("in_design");
      expect(detail.body?.data?.activeException ?? null).toBeNull();

      const { db, caseEvents } = dbMod as any;
      const events = await db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, row.id));
      expect(
        events.some((e: any) => e.eventType === "case_exception_resolved"),
      ).toBe(true);

      const queue = await request(appMod.default)
        .get("/api/case-exceptions/active")
        .set("Authorization", auth("owner"));
      expect(
        (queue.body?.data?.exceptions ?? []).some(
          (e: any) => e.id === exceptionId,
        ),
      ).toBe(false);

      // A resolved exception can't be resolved (or annotated) twice.
      const again = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ labLocationId: designLocationId });
      expect(again.status).toBe(409);

      // The case is now flaggable again — the duplicate guard is scoped to
      // ACTIVE exceptions only.
      const reflag = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: row.id });
      expect(reflag.status).toBe(201);
    }, 30000);

    it("serializes exception opening and resolution against station remaps", async () => {
      const { db, labLocations } = dbMod as any;
      const openingStationId = rid("exception_open_race");
      const resolutionStationId = rid("exception_resolve_race");
      await db.insert(labLocations).values([
        {
          id: openingStationId,
          labOrganizationId: labOrgId,
          name: "Opening Race",
          code: `OPEN_${openingStationId}`,
          status: "in_design",
          isActive: true,
        },
        {
          id: resolutionStationId,
          labOrganizationId: labOrgId,
          name: "Resolution Race",
          code: `RESOLVE_${resolutionStationId}`,
          status: "in_design",
          isActive: true,
        },
      ]);

      const openingCase = await makeCanonicalCase();
      const [opened, openingRemap] = await Promise.all([
        request(appMod.default)
          .post("/api/case-exceptions")
          .set("Authorization", auth("owner"))
          .send({
            caseId: openingCase.id,
            putOnHold: false,
            labLocationId: openingStationId,
          }),
        request(appMod.default)
          .patch(`/api/locations/${openingStationId}`)
          .set("Authorization", auth("owner"))
          .send({ status: "scan" }),
      ]);
      expect(opened.status).toBe(201);
      expect(openingRemap.status).toBe(200);
      const openedDetail = await request(appMod.default)
        .get(`/api/cases/${openingCase.id}`)
        .set("Authorization", auth("owner"));
      expect(openedDetail.body.data).toMatchObject({
        status: "scan",
        labLocationId: openingStationId,
      });

      const resolvingCase = await makeCanonicalCase();
      const flagged = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: resolvingCase.id });
      const [resolved, resolutionRemap] = await Promise.all([
        request(appMod.default)
          .post(`/api/case-exceptions/${flagged.body.data.id}/resolve`)
          .set("Authorization", auth("owner"))
          .send({
            labLocationId: resolutionStationId,
            resolutionNote: "Concurrent resolution",
          }),
        request(appMod.default)
          .patch(`/api/locations/${resolutionStationId}`)
          .set("Authorization", auth("owner"))
          .send({ status: "qc" }),
      ]);
      expect(resolved.status).toBe(200);
      expect(resolutionRemap.status).toBe(200);
      const resolvedDetail = await request(appMod.default)
        .get(`/api/cases/${resolvingCase.id}`)
        .set("Authorization", auth("owner"));
      expect(resolvedDetail.body.data).toMatchObject({
        status: "qc",
        labLocationId: resolutionStationId,
      });
    }, 30000);

    it("resolving a legacy case writes the destination status back into the blob", async () => {
      const legacyId = await makeLegacyCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId });
      const exceptionId = created.body.data.id;

      const resolve = await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({
          labLocationId: designLocationId,
          resolutionNote: "Re-scanned",
        });
      expect(resolve.status).toBe(200);

      const { db, labCases } = dbMod as any;
      const [row] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const blob = JSON.parse(row.caseData);
      expect(blob.status).toBe("DESIGN");
      expect(blob.labLocationId).toBe(designLocationId);
      expect(
        blob.activityLog.some((a: any) => a.type === "exception_resolved"),
      ).toBe(true);
    }, 30000);

    it("resolves a legacy case in place without rewriting its location or status representation", async () => {
      const legacyId = await makeLegacyCase({
        status: "QC_CHECK",
        labLocationId: designLocationId,
      });
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId });
      expect(created.status).toBe(201);

      const { db, labCases } = dbMod as any;
      const [heldRow] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const heldBlob = JSON.parse(heldRow.caseData);
      expect(heldBlob.status).toBe("ON_HOLD");
      expect(heldBlob.labLocationId).toBe(holdLocationId);

      const resolved = await request(appMod.default)
        .post(`/api/case-exceptions/${created.body.data.id}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ resolutionNote: "Leave at current station" });
      expect(resolved.status).toBe(200);
      expect(resolved.body?.data?.resolutionLabLocationId).toBeNull();
      expect(resolved.body?.data?.resolutionStatus).toBe("on_hold");

      const [savedRow] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const savedBlob = JSON.parse(savedRow.caseData);
      expect(savedBlob.status).toBe("ON_HOLD");
      expect(savedBlob.labLocationId).toBe(holdLocationId);
      expect(
        savedBlob.activityLog.some(
          (entry: any) =>
            entry.type === "exception_resolved" &&
            entry.note === "Exception resolved — case stayed at On Hold",
        ),
      ).toBe(true);
    }, 30000);

    it("keeps every exception destination token aligned with legacy list and detail statuses", async () => {
      const stages = [
        ["received", "INTAKE", "received"],
        ["in_design", "DESIGN", "in_design"],
        ["scan", "SCAN", "scan"],
        ["in_milling", "MILLING", "in_milling"],
        ["post_mill", "POST_MILL", "post_mill"],
        ["sintering_furnace", "SINTERING_FURNACE", "sintering_furnace"],
        ["model_room", "MODEL_ROOM", "model_room"],
        ["in_porcelain", "PORCELAIN", "in_porcelain"],
        ["qc", "QC", "qc"],
        ["complete", "COMPLETE", "complete"],
        ["shipped", "SHIP", "shipped"],
        // DELIVERED is distinct from historical DELIVERY (which still means
        // shipped) so every read surface can preserve the configured stage.
        ["delivered", "DELIVERED", "delivered"],
        ["on_hold", "ON_HOLD", "on_hold"],
        ["remake", "REMAKE", "remake"],
        ["cancelled", "CANCELLED", "cancelled"],
      ] as const;
      const { db, labCases, labLocations } = dbMod as any;
      const destinations = new Map<string, string>();
      const legacyCaseIds: string[] = [];

      for (const [index, [status]] of stages.entries()) {
        const locationId = rid(`loc_${status}`);
        await db.insert(labLocations).values({
          id: locationId,
          labOrganizationId: labOrgId,
          code: `EXC_${index}`,
          name: `Exception ${status}`,
          status,
          isActive: true,
          sortOrder: 100 + index,
        });
        destinations.set(status, locationId);
      }

      for (const [status, legacyToken, projectedStatus] of stages) {
        const legacyId = await makeLegacyCase();
        legacyCaseIds.push(legacyId);
        const created = await request(appMod.default)
          .post("/api/case-exceptions")
          .set("Authorization", auth("owner"))
          .send({ caseId: legacyId });
        expect(created.status).toBe(201);

        const resolved = await request(appMod.default)
          .post(`/api/case-exceptions/${created.body.data.id}/resolve`)
          .set("Authorization", auth("owner"))
          .send({
            labLocationId: destinations.get(status),
            resolutionNote: `Resolved to ${status}`,
          });
        expect(resolved.status).toBe(200);
        expect(resolved.body?.data?.destinationStatus).toBe(projectedStatus);

        const [legacyRow] = await db
          .select({ caseData: labCases.caseData })
          .from(labCases)
          .where(eq(labCases.id, legacyId));
        expect(JSON.parse(legacyRow.caseData).status).toBe(legacyToken);
      }

      const list = await request(appMod.default)
        .get("/api/cases")
        .set("Authorization", auth("owner"));
      expect(list.status).toBe(200);
      const listById = new Map<string, any>(
        (list.body?.data ?? []).map((row: any) => [row.id, row]),
      );

      for (const [index, [, , projectedStatus]] of stages.entries()) {
        const legacyId = legacyCaseIds[index];
        expect(listById.get(legacyId)?.status).toBe(projectedStatus);

        const detail = await request(appMod.default)
          .get(`/api/cases/${legacyId}`)
          .set("Authorization", auth("owner"));
        expect(detail.status).toBe(200);
        expect(detail.body?.data?.status).toBe(projectedStatus);
      }
    }, 60000);

    it("projects internal exception text into legacy case history and redacts it for providers", async () => {
      const legacyId = await makeLegacyCase();
      const issue = "Legacy internal issue";
      const followUp = "Legacy internal follow-up";
      const resolution = "Legacy internal resolution";

      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: issue });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;

      await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/notes`)
        .set("Authorization", auth("tech"))
        .send({ noteText: followUp })
        .expect(201);

      await request(appMod.default)
        .post(`/api/case-exceptions/${exceptionId}/resolve`)
        .set("Authorization", auth("owner"))
        .send({ labLocationId: designLocationId, resolutionNote: resolution })
        .expect(200);

      const labDetail = await request(appMod.default)
        .get(`/api/cases/${legacyId}`)
        .set("Authorization", auth("tech"));
      expect(labDetail.status).toBe(200);
      const history = labDetail.body?.data?.events ?? [];
      expect(history.map((event: any) => event.eventType)).toEqual(
        expect.arrayContaining([
          "internal_exception_opened_note",
          "internal_exception_note_added",
          "internal_exception_resolution_note_added",
        ]),
      );
      expect(JSON.stringify(history)).toContain(issue);
      expect(JSON.stringify(history)).toContain(followUp);
      expect(JSON.stringify(history)).toContain(resolution);

      const providerDetail = await request(appMod.default)
        .get(`/api/cases/${legacyId}`)
        .set("Authorization", auth("provider"));
      if (providerDetail.status === 200) {
        const serialized = JSON.stringify(providerDetail.body);
        expect(serialized).not.toContain("exception_opened");
        expect(serialized).not.toContain("internal_exception");
        expect(serialized).not.toContain(issue);
        expect(serialized).not.toContain(followUp);
        expect(serialized).not.toContain(resolution);
      } else {
        expect([403, 404]).toContain(providerDetail.status);
      }
    }, 30000);

    it("keeps concurrent legacy internal exception notes in the activity log", async () => {
      const legacyId = await makeLegacyCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: "Legacy issue" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;
      const notes = [
        "Concurrent internal exception note one",
        "Concurrent internal exception note two",
      ];

      const responses = await Promise.all(
        notes.map((noteText) =>
          request(appMod.default)
            .post(`/api/case-exceptions/${exceptionId}/notes`)
            .set("Authorization", auth("tech"))
            .send({ noteText }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201]);

      const { db, labCases } = dbMod as any;
      const [legacy] = await db
        .select({ caseData: labCases.caseData })
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const activityLog = JSON.parse(legacy.caseData).activityLog ?? [];
      expect(activityLog.map((event: any) => event.noteText)).toEqual(
        expect.arrayContaining(notes),
      );
    }, 30000);

    it("keeps a legacy exception note when an attachment history entry is added concurrently", async () => {
      const legacyId = await makeLegacyCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: "Legacy issue" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;
      const noteText = "Exception note must survive the attachment append";

      const [note, attachment] = await Promise.all([
        request(appMod.default)
          .post(`/api/case-exceptions/${exceptionId}/notes`)
          .set("Authorization", auth("tech"))
          .send({ noteText }),
        request(appMod.default)
          .post(`/api/cases/${legacyId}/attachments`)
          .set("Authorization", auth("owner"))
          .send({
            storageKey: "/uploads/case-media/concurrent-history.jpg",
            fileName: "concurrent-history.jpg",
            fileType: "image/jpeg",
          }),
      ]);
      expect(note.status).toBe(201);
      expect(attachment.status).toBe(201);

      const { db, labCases } = dbMod as any;
      const [legacy] = await db
        .select({ caseData: labCases.caseData })
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const activityLog = JSON.parse(legacy.caseData).activityLog ?? [];
      expect(activityLog.map((event: any) => event.noteText)).toContain(
        noteText,
      );
      expect(activityLog.map((event: any) => event.attachmentId)).toContain(
        attachment.body.data.id,
      );
    }, 30000);

    it("keeps a legacy exception note when the case is patched concurrently", async () => {
      const legacyId = await makeLegacyCase();
      const created = await request(appMod.default)
        .post("/api/case-exceptions")
        .set("Authorization", auth("owner"))
        .send({ caseId: legacyId, issueText: "Legacy issue" });
      expect(created.status).toBe(201);
      const exceptionId = created.body.data.id;
      const noteText = "Exception note must survive the legacy case patch";

      const [note, patch] = await Promise.all([
        request(appMod.default)
          .post(`/api/case-exceptions/${exceptionId}/notes`)
          .set("Authorization", auth("tech"))
          .send({ noteText }),
        request(appMod.default)
          .patch(`/api/cases/${legacyId}`)
          .set("Authorization", auth("owner"))
          .send({ status: "in_design" }),
      ]);
      expect(note.status).toBe(201);
      expect(patch.status).toBe(200);

      const { db, labCases } = dbMod as any;
      const [legacy] = await db
        .select({ caseData: labCases.caseData })
        .from(labCases)
        .where(eq(labCases.id, legacyId));
      const blob = JSON.parse(legacy.caseData);
      expect(blob.status).toBe("DESIGN");
      expect(blob.activityLog.map((event: any) => event.noteText)).toContain(
        noteText,
      );
    }, 30000);
  },
);
