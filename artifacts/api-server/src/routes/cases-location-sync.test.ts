/**
 * Regression suite: Mobile case location changes must sync to web and desktop.
 *
 * Protected workflow: "Mobile Case Location Cross-Platform Sync"
 *
 * Root cause (fixed): batchLocateCases() only wrote to AsyncStorage; it never
 * called syncCaseToServer(), so batch location changes were invisible to
 * web/desktop. Single-case updateCaseStatus() already called syncCaseToServer()
 * correctly — this suite guards both paths at the API level.
 *
 * A second bug (fixed alongside): the GET /api/cases list endpoint had a local
 * MOBILE_TO_DESKTOP_STATUS that was missing SCAN, POST_MILL, SINTERING_FURNACE,
 * MODEL_ROOM, and mapped COMPLETE to "delivered" instead of "complete". This
 * caused the web/desktop list view to show the wrong location even when the
 * mobile client had correctly synced the new status to the server. The detail
 * endpoint (tryProjectLegacyCaseForDesktop) had the correct mapping; the list
 * endpoint was out of sync with it.
 *
 * The server-side sync path for both single and batch locate is identical:
 *   1. Mobile calls POST /api/legacy/cases with the full case blob
 *      (caseData includes the new `status` field).
 *   2. Server stores it in lab_cases.caseData (blob-replace / append-only merge
 *      for arrays; scalar fields like `status` come from the new payload).
 *   3. GET /api/cases bridges lab_cases → canonical shape, reading
 *      parsed.status from the blob and mapping it via MOBILE_TO_DESKTOP_STATUS.
 *   4. Web/desktop GET /api/cases and GET /api/cases/:id both return the
 *      updated location.
 *
 * Response envelope: all API routes return { ok: true, data: T } via ok().
 *
 * Test coverage:
 *   (1) Single locate  — POST with updated status stores new location; GET
 *                        /api/cases returns the mapped desktop status.
 *   (2) Location overwrite — a third POST replaces the previous status; no
 *                        stale location leaks through.
 *   (3) Batch locate   — two cases synced independently; GET /api/cases
 *                        shows updated status for both (guards batchLocateCases).
 *   (4) Case detail    — GET /api/cases/:id returns the updated location
 *                        (the endpoint desktop uses for case detail view).
 *   (5) Cross-workflow — case creation + multiple location changes stay
 *                        consistent across list and detail views.
 *   (6) Auth guard     — unauthenticated client cannot read location.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";
import { vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-location-sync"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("Mobile case location sync — cross-platform regression", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let casesRouteMod: typeof import("./cases.js");

  const labOrgId = rid("lab");

  const providerOrgId = rid("provider");
  const userId = rid("uloc");
  let token = "";

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

  /** Simulate mobile client syncing a case to the server. */
  async function syncCase(
    caseId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) {
    const caseBlob = {
      id: caseId,
      caseNumber: `26-LOC-${caseId.slice(-4)}`,
      patientName: "Test Patient",
      doctorName: "Dr. Test",
      toothIndices: "#8",
      material: "Zirconia",
      status,
      affiliationKey: `org:${labOrgId}`,
      ...extra,
    };
    return request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: userId, caseData: JSON.stringify(caseBlob) });
  }

  /** Fetch the case list and find a specific case by ID. */
  async function fetchCaseFromList(caseId: string) {
    const res = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // ok() wraps as { ok: true, data: T }
    const list: any[] = res.body.data ?? [];
    return list.find((c: any) => c.id === caseId) ?? null;
  }

  beforeAll(async () => {
    fs.mkdirSync(
      path.join(os.tmpdir(), "labtrax-test-location-sync"),
      { recursive: true }
    );
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-locsync";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    casesRouteMod = await import("./cases.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `loc_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Location Sync Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Location Sync Test Practice",
        parentLabOrganizationId: labOrgId,
      },
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
    casesRouteMod._testHooks.locationHistoryWriteHook = undefined;
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    casesRouteMod._testHooks.locationHistoryWriteHook = undefined;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      labCases,
      cases: casesTable,
      labLocations,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db.delete(casesTable).where(eq(casesTable.labOrganizationId, labOrgId));
    await db.delete(labLocations).where(eq(labLocations.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── (1) Single locate — server stores new location ────────────────────────
  it("(1a) POST /api/legacy/cases with updated status stores new location in lab_cases", async () => {
    token = await makeSession(userId);
    const caseId = rid("c1a");

    const create = await syncCase(caseId, "INTAKE");
    expect(create.status).toBe(200);

    const move = await syncCase(caseId, "DESIGN");
    expect(move.status).toBe(200);

    const { db, labCases } = dbMod as any;
      const row = await db.query.labCases.findFirst({
        where: eq(labCases.id, caseId),
      });
    expect(row, "lab_cases row must exist").toBeDefined();
    const parsed = JSON.parse(row.caseData as string);
    expect(parsed.status).toBe("DESIGN");
  });

  it("(1b) GET /api/cases returns the updated location mapped to desktop format", async () => {
    token = await makeSession(userId);
    const caseId = rid("c1b");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "SCAN");

    const found = await fetchCaseFromList(caseId);
    expect(found, "updated case must appear in GET /api/cases").not.toBeNull();
    // Mobile "SCAN" → desktop "scan"
    expect(found.status).toBe("scan");
    expect(found._source).toBe("mobile");
    expect(found.labOrganizationId).toBe(labOrgId);
  });

  it("(1c) GET /api/cases maps MODEL_ROOM and MILLING statuses correctly", async () => {
    token = await makeSession(userId);
    const millId = rid("c1c_mill");
    const modelId = rid("c1c_model");

    await syncCase(millId, "INTAKE");
    await syncCase(millId, "MILLING");
    await syncCase(modelId, "INTAKE");
    await syncCase(modelId, "MODEL_ROOM");

    const mill = await fetchCaseFromList(millId);
    const model = await fetchCaseFromList(modelId);

    expect(mill?.status).toBe("in_milling");
    expect(model?.status).toBe("model_room");
  });

  // ── (2) Location overwrite — old status replaced, not retained ────────────
  it("(2) A later sync with a different status replaces the old location", async () => {
    token = await makeSession(userId);
    const caseId = rid("c4");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "MILLING");
    await syncCase(caseId, "QC_CHECK"); // third state — must win

    const found = await fetchCaseFromList(caseId);
    expect(found, "case must appear after multiple status syncs").not.toBeNull();
    // Should show the LAST synced status, not any earlier one
    expect(found.status).toBe("qc");
  });

  // ── (3) Batch locate — multiple cases all sync ────────────────────────────
  it("(3) Batch: two cases synced with new status both appear updated on web/desktop", async () => {
    token = await makeSession(userId);
      const caseIdA = rid("c9a");
      const caseIdB = rid("c9b");

    await syncCase(caseIdA, "INTAKE");
    await syncCase(caseIdB, "INTAKE");

    // Simulate batch locate: syncCaseToServer fires for each case in the batch.
    await syncCase(caseIdA, "PORCELAIN");
    await syncCase(caseIdB, "PORCELAIN");

    const foundA = await fetchCaseFromList(caseIdA);
    const foundB = await fetchCaseFromList(caseIdB);

    expect(foundA, "case A must appear after batch sync").not.toBeNull();
    expect(foundB, "case B must appear after batch sync").not.toBeNull();

    // "PORCELAIN" → "in_porcelain" on desktop
    expect(foundA.status).toBe("in_porcelain");
    expect(foundB.status).toBe("in_porcelain");
  });

  // ── (4) Case detail view — GET /api/cases/:id returns updated location ────
  it("(4) GET /api/cases/:id returns the updated location (desktop case detail bridge)", async () => {
    token = await makeSession(userId);
    const caseId = rid("c4detail");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "MODEL_ROOM");

    const res = await request(appMod.default)
      .get(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);

    // tryProjectLegacyCaseForDesktop bridges a lab_cases row into the
    // canonical DetailedCase shape when the id isn't in the cases table.
    // ok() wraps as { ok: true, data: T }.
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("model_room");
    expect(res.body.data?._source).toBe("mobile");
  });

  // ── (5) Cross-workflow — list and detail agree after multiple moves ────────
  it("(5) List and detail views agree on location after several syncs", async () => {
    token = await makeSession(userId);
    const caseId = rid("c5");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "SCAN");
    await syncCase(caseId, "MILLING");
    await syncCase(caseId, "COMPLETE");

    // List view
    const fromList = await fetchCaseFromList(caseId);
    expect(fromList, "case must appear in list after location changes").not.toBeNull();
    // "COMPLETE" → "complete" (fixed from erroneously mapping to "delivered")
    expect(fromList.status).toBe("complete");

    // Detail view — must agree
      const detail = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data?.status).toBe("complete");
  });

  // ── (6) Auth guard — unauthenticated client cannot read location ──────────
  it("(6) GET /api/cases requires authentication (returns 401 without token)", async () => {
    const res = await request(appMod.default).get("/api/cases");
    expect(res.status).toBe(401);
  });

  // ── (7) Same-status locate — desktop picker regression ───────────────────
  //
  // Root cause (fixed): the desktop CaseDrawer's locate picker only disabled
  // the one station matching the current status IF it was the sole match. When
  // two custom stations both mapped to the same status (e.g. "Received" and
  // "Denture Room" both → `received`), neither was disabled and neither was
  // labelled "(current)". A user could click Locate on "Denture Room" while the
  // case was already at `received`; the API accepted the no-op PATCH, showed
  // "Case located successfully", but the badge stayed "RECEIVED" — indistinguishable
  // from a real move. The fix uses a Set of all station IDs whose `status` equals
  // the current case status, disabling every member of that set.
  //
  // This suite tests the API surface the UI fix relies on:
  //   (7a) Two custom locations both mapping to `received` are both returned by
  //        GET /api/locations with `status: "received"`.
  //   (7b) A PATCH /api/cases/:id with the same status as the case's current
  //        status is still accepted by the server (the guard lives in the UI;
  //        the API must not 4xx it so that legitimate single-station reassigns
  //        still work).
  //   (7c) Single-station: when exactly one active location maps to `received`,
  //        GET /api/locations returns it as the sole entry with that status —
  //        confirming the data shape the UI uses for unambiguous station-name
  //        resolution in the drawer header.

  it("(7a) Two custom stations with the same mapped status both appear in GET /api/locations", async () => {
    token = await makeSession(userId);

    // Create a dedicated org so this test's stations don't bleed into others.
    const { db, organizations, organizationMemberships, labLocations } = dbMod as any;
    const dualLabId = rid("lab7a");
    const dualUserId = rid("u7a");
    const { users, userSessions, auditLogs, invoices, labCases } = dbMod as any;
    await db.insert(users).values([{ id: dualUserId, username: `u7a_${dualUserId}`, password: "x" }]);
    await db.insert(organizations).values([{ id: dualLabId, type: "lab", name: "Dual-Station Lab" }]);
    await db.insert(organizationMemberships).values([
      { id: rid("m7a"), labId: dualLabId, userId: dualUserId, role: "admin", status: "active" },
    ]);
    const dualToken = await makeSession(dualUserId);

    try {
      // POST two custom stations that both map to `received`.
      const r1 = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${dualToken}`)
        .send({ organizationId: dualLabId, name: "Front Desk", status: "received" });
      expect(r1.status).toBe(201);

      const r2 = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${dualToken}`)
        .send({ organizationId: dualLabId, name: "Denture Room", status: "received" });
      expect(r2.status).toBe(201);

      // Both stations must be returned and both must carry status `received`.
      const list = await request(appMod.default)
        .get(`/api/locations?organizationId=${dualLabId}&activeOnly=true`)
        .set("Authorization", `Bearer ${dualToken}`);
      expect(list.status).toBe(200);
      const rows: any[] = list.body.data ?? [];
      const receivedStations = rows.filter((r) => r.status === "received");
      expect(receivedStations.length, "both same-status stations must appear").toBeGreaterThanOrEqual(2);
      const names = receivedStations.map((r) => r.name);
      expect(names).toContain("Front Desk");
      expect(names).toContain("Denture Room");
      // Each row must have a distinct `id` so the desktop picker can key them
      // independently (the Set-of-ids guard requires unique IDs per station).
      const ids = receivedStations.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, dualLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, dualLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, dualLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, dualLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, dualUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, dualUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, dualLabId)).catch(() => {});
      await db.delete(users).where(eq(users.id, dualUserId)).catch(() => {});
    }
  });

  it("(7b) PATCH /api/cases/:id with the same status the case already has is accepted (204/200)", async () => {
    // The API must not reject a same-status PATCH — the guard lives in the UI.
    // This test confirms the server stays permissive so that the UI fix is the
    // sole enforcement layer and no existing callers break.
    token = await makeSession(userId);
    const caseId = rid("c7b");

    // Create the case at `received` via the legacy sync path.
    await syncCase(caseId, "INTAKE"); // INTAKE maps to `received`

    // Confirm the case is at `received` on the desktop list view.
    const before = await fetchCaseFromList(caseId);
    expect(before?.status).toBe("received");

    // Re-locate to `received` (same status — the no-op the UI now prevents).
    const patch = await request(appMod.default)
      .post("/api/cases/bulk-status")
      .set("Authorization", `Bearer ${token}`)
      .send({ caseIds: [caseId], status: "received" });
    // Server must accept it (200) — the UI is responsible for preventing it.
    expect(patch.status).toBe(200);
    expect(patch.body.data?.updatedIds ?? patch.body.data?.updatedCount).toBeTruthy();
  });

  it("(7c) Single custom station mapping to a status: GET /api/locations returns exactly one with that status", async () => {
    // When exactly one station maps to the current case status, the desktop
    // `resolvedStationLabel` computation finds it unambiguously and shows the
    // station name ("Denture Room") in the drawer header instead of the generic
    // status label ("RECEIVED").
    token = await makeSession(userId);

    const { db, organizations, organizationMemberships, labLocations } = dbMod as any;
    const singleLabId = rid("lab7c");
    const singleUserId = rid("u7c");
    const { users, userSessions, auditLogs, invoices, labCases } = dbMod as any;
    await db.insert(users).values([{ id: singleUserId, username: `u7c_${singleUserId}`, password: "x" }]);
    await db.insert(organizations).values([{ id: singleLabId, type: "lab", name: "Single-Station Lab" }]);
    await db.insert(organizationMemberships).values([
      { id: rid("m7c"), labId: singleLabId, userId: singleUserId, role: "admin", status: "active" },
    ]);
    const singleToken = await makeSession(singleUserId);

    try {
      // Create one custom station mapping to `received` (the "Denture Room" scenario).
      const cr = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${singleToken}`)
        .send({ organizationId: singleLabId, name: "Denture Room", status: "received" });
      expect(cr.status).toBe(201);

      const list = await request(appMod.default)
        .get(`/api/locations?organizationId=${singleLabId}&activeOnly=true`)
        .set("Authorization", `Bearer ${singleToken}`);
      expect(list.status).toBe(200);
      const rows: any[] = list.body.data ?? [];

      // Among the returned stations, exactly one should map to `received`.
      // (The lab was freshly created; the seed path won't run because we just
      // inserted one row, which makes allRows.length non-zero.)
      const receivedStations = rows.filter((r) => r.status === "received");
      expect(receivedStations.length).toBe(1);
      expect(receivedStations[0].name).toBe("Denture Room");
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, singleLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, singleLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, singleLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, singleLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, singleUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, singleUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, singleLabId)).catch(() => {});
      await db.delete(users).where(eq(users.id, singleUserId)).catch(() => {});
    }
  });

  // ── (8) PATCH labLocationId persists — canonical case ────────────────────
  //
  // Regression guard: if the Drizzle update set in PATCH /:caseId ever drops
  // `labLocationId` (e.g. via a merge conflict), the station id silently reverts
  // to null and station tracking falls back to heuristics with no visible error.
  // This test pins the full round-trip: locate → GET list → GET detail.

  it("(8) PATCH /api/cases/:id with labLocationId: GET /api/cases and GET /api/cases/:id both return correct labLocationId and labLocationName", async () => {
    const {
      db, organizations, organizationMemberships, labLocations, cases: casesTable,
      users: usersTable, userSessions, auditLogs, invoices, labCases,
    } = dbMod as any;

    const patchLabId    = rid("lab8");
    const patchProvId   = rid("prov8");
    const patchUserId   = rid("u8");

    await db.insert(usersTable).values([{ id: patchUserId, username: `u8_${patchUserId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: patchLabId, type: "lab", name: "Patch-Locate Lab" },
      { id: patchProvId, type: "provider", name: "Patch-Locate Practice", parentLabOrganizationId: patchLabId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m8"), labId: patchLabId, userId: patchUserId, role: "admin", status: "active" },
    ]);
    const patchToken = await makeSession(patchUserId);

    try {
      // Create a custom station for this lab.
      const locRes = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${patchToken}`)
        .send({ organizationId: patchLabId, name: "Wax Room", status: "in_design" });
      expect(locRes.status).toBe(201);
      const stationId: string = locRes.body.data.id;
      expect(stationId).toBeTruthy();

      // Create a canonical case via direct DB insert (avoids the invoice-creation
      // side-effects of POST /api/cases while keeping the test focused on locate).
      const caseId = rid("c8");
      await db.insert(casesTable).values({
        id: caseId,
        caseNumber: `26-PATCH-${caseId.slice(-6)}`,
        labOrganizationId: patchLabId,
        providerOrganizationId: patchProvId,
        doctorName: "Dr. Patch",
        patientFirstName: "Pat",
        patientLastName: "Eight",
        status: "received",
        createdByUserId: patchUserId,
      });

      // Locate the case to the station via PATCH.
      const patchRes = await request(appMod.default)
        .patch(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${patchToken}`)
        .send({ status: "in_design", labLocationId: stationId });
      expect(patchRes.status).toBe(200);

      // ── GET /api/cases list ──
      const listRes = await request(appMod.default)
        .get("/api/cases")
        .set("Authorization", `Bearer ${patchToken}`);
      expect(listRes.status).toBe(200);
      const listItem = (listRes.body.data ?? []).find((c: any) => c.id === caseId);
      expect(listItem, "case must appear in GET /api/cases").toBeDefined();
      expect(listItem.labLocationId).toBe(stationId);
      expect(listItem.labLocationName).toBe("Wax Room");

      // ── GET /api/cases/:id detail ──
      const detailRes = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${patchToken}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data?.labLocationId).toBe(stationId);
      expect(detailRes.body.data?.labLocationName).toBe("Wax Room");
      const locationEvents = (detailRes.body.data?.events ?? []).filter(
        (event: any) => event.eventType === "location_changed",
      );
      expect(locationEvents).toHaveLength(1);
      expect(locationEvents[0].metadataJson).toMatchObject({
        labLocationId: stationId,
        locationName: "Wax Room",
        previousLabLocationId: null,
        previousLocationName: null,
      });

      // A rejected cross-lab destination must not change either side of the
      // current-location/history pair.
      const foreignLabId = rid("foreign8");
      const foreignLocationId = rid("foreignloc8");
      await db.insert(organizations).values({
        id: foreignLabId,
        type: "lab",
        name: "Foreign Location Lab",
      });
      await db.insert(labLocations).values({
        id: foreignLocationId,
        labOrganizationId: foreignLabId,
        name: "Foreign Bench",
        code: `foreign-${foreignLocationId}`,
        status: "qc",
      });
      const rejected = await request(appMod.default)
        .patch(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${patchToken}`)
        .send({ status: "qc", labLocationId: foreignLocationId });
      expect(rejected.status).toBe(400);

      const afterRejected = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${patchToken}`);
      expect(afterRejected.body.data?.labLocationId).toBe(stationId);
      expect(
        (afterRejected.body.data?.events ?? []).filter(
          (event: any) => event.eventType === "location_changed",
        ),
      ).toHaveLength(1);
      await db.delete(labLocations).where(eq(labLocations.id, foreignLocationId));
      await db.delete(organizations).where(eq(organizations.id, foreignLabId));
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, patchLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, patchLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, patchLabId)).catch(() => {});
      await db.delete(casesTable).where(eq(casesTable.labOrganizationId, patchLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, patchLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, patchUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, patchUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, patchProvId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, patchLabId)).catch(() => {});
      await db.delete(usersTable).where(eq(usersTable.id, patchUserId)).catch(() => {});
    }
  });

  // ── (9) bulk-status with labLocationId persists for both canonical cases ──
  //
  // Regression guard: if POST /api/cases/bulk-status drops `labLocationId` from
  // its canonicalSet (e.g. the `!== undefined` guard is accidentally removed), the
  // station id is silently discarded for every case in the batch. This test pins
  // both canonical rows in the same bulk call.

  it("(9) POST /api/cases/bulk-status with labLocationId sets the station id on both canonical cases", async () => {
    const {
      db, organizations, organizationMemberships, labLocations, cases: casesTable,
      users: usersTable, userSessions, auditLogs, invoices, labCases,
    } = dbMod as any;

    const bulkLabId  = rid("lab9");
    const bulkProvId = rid("prov9");
    const bulkUserId = rid("u9");

    await db.insert(usersTable).values([{ id: bulkUserId, username: `u9_${bulkUserId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: bulkLabId, type: "lab", name: "Bulk-Locate Lab" },
      { id: bulkProvId, type: "provider", name: "Bulk-Locate Practice", parentLabOrganizationId: bulkLabId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m9"), labId: bulkLabId, userId: bulkUserId, role: "admin", status: "active" },
    ]);
    const bulkToken = await makeSession(bulkUserId);

    try {
      // Create a custom station.
      const locRes = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${bulkToken}`)
        .send({ organizationId: bulkLabId, name: "QC Bench", status: "qc" });
      expect(locRes.status).toBe(201);
      const stationId: string = locRes.body.data.id;

      // Create two canonical cases.
      const caseIdA = rid("c9a");
      const caseIdB = rid("c9b");
      for (const [id, suffix] of [[caseIdA, "A"], [caseIdB, "B"]] as [string, string][]) {
        await db.insert(casesTable).values({
          id,
          caseNumber: `26-BULK-${suffix}-${id.slice(-4)}`,
          labOrganizationId: bulkLabId,
          providerOrganizationId: bulkProvId,
          doctorName: "Dr. Bulk",
          patientFirstName: "Pat",
          patientLastName: `Bulk${suffix}`,
          status: "received",
          createdByUserId: bulkUserId,
        });
      }

      // Bulk-locate both cases to the station.
      const bulkRes = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${bulkToken}`)
        .send({ caseIds: [caseIdA, caseIdB], status: "qc", labLocationId: stationId });
      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.data?.updatedIds ?? bulkRes.body.data?.updatedCount).toBeTruthy();

      // Both cases must have the station id persisted.
      for (const caseId of [caseIdA, caseIdB]) {
        const detailRes = await request(appMod.default)
          .get(`/api/cases/${encodeURIComponent(caseId)}`)
          .set("Authorization", `Bearer ${bulkToken}`);
        expect(detailRes.status).toBe(200);
        expect(detailRes.body.data?.labLocationId).toBe(stationId);
        expect(detailRes.body.data?.labLocationName).toBe("QC Bench");
        const locationEvents = (detailRes.body.data?.events ?? []).filter(
          (event: any) => event.eventType === "location_changed",
        );
        expect(locationEvents).toHaveLength(1);
        expect(locationEvents[0].metadataJson).toMatchObject({
          labLocationId: stationId,
          locationName: "QC Bench",
          previousLabLocationId: null,
        });
      }

      // A promoted case can have both canonical and legacy representations.
      // Force the history write to fail and verify the outer mixed-batch
      // transaction rolls back both representations.
      const secondLocRes = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${bulkToken}`)
        .send({
          organizationId: bulkLabId,
          name: "Porcelain Bench",
          status: "in_porcelain",
        });
      expect(secondLocRes.status).toBe(201);
      const secondStationId: string = secondLocRes.body.data.id;
      await db.insert(labCases).values({
        id: caseIdA,
        ownerId: bulkUserId,
        organizationId: bulkLabId,
        caseData: JSON.stringify({
          id: caseIdA,
          status: "QC_CHECK",
          labLocationId: stationId,
        }),
      });

      casesRouteMod._testHooks.locationHistoryWriteHook = async () => {
        throw new Error("forced location history failure");
      };
      const failedMixedMove = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${bulkToken}`)
        .send({
          caseIds: [caseIdA],
          status: "in_porcelain",
          labLocationId: secondStationId,
        });
      expect(failedMixedMove.status).toBe(500);
      casesRouteMod._testHooks.locationHistoryWriteHook = undefined;

      const canonicalAfterFailure = await db.query.cases.findFirst({
        where: eq(casesTable.id, caseIdA),
      });
      const legacyAfterFailure = await db.query.labCases.findFirst({
        where: eq(labCases.id, caseIdA),
      });
      expect(canonicalAfterFailure?.labLocationId).toBe(stationId);
      expect(JSON.parse(legacyAfterFailure.caseData).labLocationId).toBe(stationId);
      const detailAfterFailure = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseIdA)}`)
        .set("Authorization", `Bearer ${bulkToken}`);
      expect(
        (detailAfterFailure.body.data?.events ?? []).filter(
          (event: any) => event.eventType === "location_changed",
        ),
      ).toHaveLength(1);

      // Retrying succeeds once and reports the logical case once even though
      // both storage representations were updated.
      const retryMixedMove = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${bulkToken}`)
        .send({
          caseIds: [caseIdA],
          status: "in_porcelain",
          labLocationId: secondStationId,
        });
      expect(retryMixedMove.status).toBe(200);
      expect(retryMixedMove.body.data?.updatedIds).toEqual([caseIdA]);
      expect(retryMixedMove.body.data?.updatedCount).toBe(1);
    } finally {
      casesRouteMod._testHooks.locationHistoryWriteHook = undefined;
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, bulkLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, bulkLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, bulkLabId)).catch(() => {});
      await db.delete(casesTable).where(eq(casesTable.labOrganizationId, bulkLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, bulkLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, bulkUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, bulkUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, bulkProvId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, bulkLabId)).catch(() => {});
      await db.delete(usersTable).where(eq(usersTable.id, bulkUserId)).catch(() => {});
    }
  });

  // ── (10) Same status, two different stations — each case stores its own id ─
  //
  // Edge case: two canonical cases are each located to stations that share the
  // same `status` value (e.g. both "QC Bench A" and "QC Bench B" map to `qc`).
  // The labLocationId must differ per case; neither should silently adopt the
  // other's station or be collapsed to a status-level heuristic.

  it("(10) Two cases located to different stations sharing the same status each store their own labLocationId", async () => {
    const {
      db, organizations, organizationMemberships, labLocations, cases: casesTable,
      users: usersTable, userSessions, auditLogs, invoices, labCases,
    } = dbMod as any;

    const dualStationLabId  = rid("lab10");
    const dualStationProvId = rid("prov10");
    const dualStationUserId = rid("u10");

    await db.insert(usersTable).values([{ id: dualStationUserId, username: `u10_${dualStationUserId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: dualStationLabId, type: "lab", name: "Dual-Station-Same-Status Lab" },
      { id: dualStationProvId, type: "provider", name: "Dual-Station Practice", parentLabOrganizationId: dualStationLabId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m10"), labId: dualStationLabId, userId: dualStationUserId, role: "admin", status: "active" },
    ]);
    const dualStationToken = await makeSession(dualStationUserId);

    try {
      // Create two stations both mapping to `scan` (same status, different names).
      const locResA = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({ organizationId: dualStationLabId, name: "Scanner Alpha", status: "scan" });
      expect(locResA.status).toBe(201);
      const stationAlphaId: string = locResA.body.data.id;

      const locResB = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({ organizationId: dualStationLabId, name: "Scanner Beta", status: "scan" });
      expect(locResB.status).toBe(201);
      const stationBetaId: string = locResB.body.data.id;

      expect(stationAlphaId).not.toBe(stationBetaId);

      // Create two canonical cases.
      const caseAlphaId = rid("c10a");
      const caseBetaId  = rid("c10b");
      for (const [id, suffix] of [[caseAlphaId, "Alpha"], [caseBetaId, "Beta"]] as [string, string][]) {
        await db.insert(casesTable).values({
          id,
          caseNumber: `26-DUALST-${suffix}-${id.slice(-4)}`,
          labOrganizationId: dualStationLabId,
          providerOrganizationId: dualStationProvId,
          doctorName: "Dr. Dual",
          patientFirstName: "Pat",
          patientLastName: `Dual${suffix}`,
          status: "received",
          createdByUserId: dualStationUserId,
        });
      }

      const locResC = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({ organizationId: dualStationLabId, name: "Scanner Gamma", status: "scan" });
      expect(locResC.status).toBe(201);
      const stationGammaId: string = locResC.body.data.id;

      // Locate each case to its own station (same `status: "scan"`, different ids).
      const patchAlpha = await request(appMod.default)
        .patch(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({ status: "scan", labLocationId: stationAlphaId });
      expect(patchAlpha.status).toBe(200);

      const patchBeta = await request(appMod.default)
        .patch(`/api/cases/${encodeURIComponent(caseBetaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({ status: "scan", labLocationId: stationBetaId });
      expect(patchBeta.status).toBe(200);

      // Each case must carry its own distinct station id and name.
      const detailAlpha = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`);
      expect(detailAlpha.status).toBe(200);
      expect(detailAlpha.body.data?.labLocationId).toBe(stationAlphaId);
      expect(detailAlpha.body.data?.labLocationName).toBe("Scanner Alpha");

      const detailBeta = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseBetaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`);
      expect(detailBeta.status).toBe(200);
      expect(detailBeta.body.data?.labLocationId).toBe(stationBetaId);
      expect(detailBeta.body.data?.labLocationName).toBe("Scanner Beta");

      // Ids must differ — no silent collapse to a single station.
      expect(detailAlpha.body.data?.labLocationId).not.toBe(detailBeta.body.data?.labLocationId);

      // Rapid same-status moves must serialize from the actual current station,
      // not the stale status value: Alpha → Beta → Gamma.
      const [moveBeta, moveGamma] = await Promise.all([
        request(appMod.default)
          .patch(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
          .set("Authorization", `Bearer ${dualStationToken}`)
          .send({ status: "scan", labLocationId: stationBetaId }),
        request(appMod.default)
          .patch(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
          .set("Authorization", `Bearer ${dualStationToken}`)
          .send({ status: "scan", labLocationId: stationGammaId }),
      ]);
      expect(moveBeta.status).toBe(200);
      expect(moveGamma.status).toBe(200);

      const afterSequence = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`);
      expect([stationBetaId, stationGammaId]).toContain(
        afterSequence.body.data?.labLocationId,
      );
      const sequence = (afterSequence.body.data?.events ?? [])
        .filter((event: any) => event.eventType === "location_changed")
        .sort(
          (a: any, b: any) =>
            new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
        );
      expect(sequence).toHaveLength(3);
      expect(sequence[0].metadataJson).toMatchObject({
        locationName: "Scanner Alpha",
        previousLocationName: null,
      });
      const concurrentMoves = sequence.slice(1);
      expect(
        new Set(concurrentMoves.map((event: any) => event.metadataJson.locationName)),
      ).toEqual(new Set(["Scanner Beta", "Scanner Gamma"]));
      expect(concurrentMoves[0].metadataJson.previousLocationName).toBe(
        "Scanner Alpha",
      );
      expect(concurrentMoves[1].metadataJson.previousLocationName).toBe(
        concurrentMoves[0].metadataJson.locationName,
      );

      // Repeating the exact current destination is not a move and must not
      // duplicate timeline history.
      const repeatCurrent = await request(appMod.default)
        .patch(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`)
        .send({
          status: "scan",
          labLocationId: afterSequence.body.data?.labLocationId,
        });
      expect(repeatCurrent.status).toBe(200);
      const afterRepeat = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseAlphaId)}`)
        .set("Authorization", `Bearer ${dualStationToken}`);
      expect(
        (afterRepeat.body.data?.events ?? []).filter(
          (event: any) => event.eventType === "location_changed",
        ),
      ).toHaveLength(3);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, dualStationLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, dualStationLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, dualStationLabId)).catch(() => {});
      await db.delete(casesTable).where(eq(casesTable.labOrganizationId, dualStationLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, dualStationLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, dualStationUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, dualStationUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, dualStationProvId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, dualStationLabId)).catch(() => {});
      await db.delete(usersTable).where(eq(usersTable.id, dualStationUserId)).catch(() => {});
    }
  });

  // ── (11) Historical hold aliases + saved station parity ──────────────────
  //
  // Legacy blobs in the field contain both HOLD and ON_HOLD. They must
  // normalize to the same workflow status, and the individually saved station
  // must win over another station that maps to the same status.
  it("(11) legacy HOLD and ON_HOLD cases return the same saved On Hold station in list and detail, then rewrite to ON_HOLD", async () => {
    const holdLocation = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "On Hold", status: "on_hold" });
    expect(holdLocation.status).toBe(201);
    const onHoldLocationId: string = holdLocation.body.data.id;

    // A second station with the same workflow status reproduces the ambiguity
    // that used to make the drawer choose a status-level "Processing" label.
    const processingLocation = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "Processing", status: "on_hold" });
    expect(processingLocation.status).toBe(201);

    const historicalHoldId = rid("c11hold");
    const canonicalHoldId = rid("c11onhold");
    await syncCase(historicalHoldId, "HOLD", {
      labLocationId: onHoldLocationId,
    });
    await syncCase(canonicalHoldId, "ON_HOLD", {
      labLocationId: onHoldLocationId,
    });

    for (const caseId of [historicalHoldId, canonicalHoldId]) {
      const listItem = await fetchCaseFromList(caseId);
      expect(listItem?.status).toBe("on_hold");
      expect(listItem?.labLocationId).toBe(onHoldLocationId);
      expect(listItem?.labLocationName).toBe("On Hold");

      const detail = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data?.status).toBe("on_hold");
      expect(detail.body.data?.labLocationId).toBe(onHoldLocationId);
      expect(detail.body.data?.labLocationName).toBe("On Hold");
    }

    const promote = await request(appMod.default)
      .post(`/api/cases/${encodeURIComponent(historicalHoldId)}/restorations`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        toothNumber: "9",
        restorationType: "crown",
        material: "Zirconia",
        quantity: 1,
        unitPrice: 0,
      });
    expect(promote.status).toBe(201);
    const { db, labCases, cases: casesTable } = dbMod as any;
    const promoted = await db.query.cases.findFirst({
      where: eq(casesTable.id, historicalHoldId),
    });
    expect(promoted?.status).toBe("on_hold");
    expect(promoted?.labLocationId).toBe(onHoldLocationId);

    // Every desktop legacy-status write uses the canonical ON_HOLD token,
    // while the saved station remains attached to each individual case.
    const rewrite = await request(appMod.default)
      .post("/api/cases/bulk-status")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseIds: [historicalHoldId, canonicalHoldId],
        // The station is authoritative even when an older client sends a
        // contradictory status.
        status: "received",
        labLocationId: onHoldLocationId,
      });
    expect(rewrite.status).toBe(200);

    for (const caseId of [historicalHoldId, canonicalHoldId]) {
      const row = await db.query.labCases.findFirst({
        where: eq(labCases.id, caseId),
      });
      const blob = JSON.parse(row.caseData);
      expect(blob.status).toBe("ON_HOLD");
      expect(blob.labLocationId).toBe(onHoldLocationId);
    }

    const statusOnlyLegacyUpdate = await request(appMod.default)
      .patch(`/api/cases/${encodeURIComponent(canonicalHoldId)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "received" });
    expect(statusOnlyLegacyUpdate.status).toBe(200);
    const statusOnlyLegacyDetail = await request(appMod.default)
      .get(`/api/cases/${encodeURIComponent(canonicalHoldId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(statusOnlyLegacyDetail.body.data).toMatchObject({
      status: "received",
      labLocationId: null,
    });
  });

  it("(12) a foreign legacy station is neither displayed nor promoted into the case", async () => {
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
      labCases,
      cases: casesTable,
      labLocations,
    } = dbMod as any;
    const foreignLabId = rid("lab12foreign");
    const foreignUserId = rid("u12foreign");
    await db.insert(users).values([
      { id: foreignUserId, username: `u12_${foreignUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: foreignLabId, type: "lab", name: "Foreign Location Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m12"),
        labId: foreignLabId,
        userId: foreignUserId,
        role: "admin",
        status: "active",
      },
    ]);
    const foreignToken = await makeSession(foreignUserId);

    try {
      const foreignLocation = await request(appMod.default)
        .post("/api/locations")
        .set("Authorization", `Bearer ${foreignToken}`)
        .send({
          organizationId: foreignLabId,
          name: "Foreign On Hold",
          status: "on_hold",
        });
      expect(foreignLocation.status).toBe(201);
      const foreignLocationId: string = foreignLocation.body.data.id;

      const caseId = rid("c12foreign");
      await syncCase(caseId, "HOLD", { labLocationId: foreignLocationId });

      const listItem = await fetchCaseFromList(caseId);
      expect(listItem?.status).toBe("on_hold");
      expect(listItem?.labLocationId).toBeNull();
      expect(listItem?.labLocationName).toBeNull();

      const detail = await request(appMod.default)
        .get(`/api/cases/${encodeURIComponent(caseId)}`)
        .set("Authorization", `Bearer ${token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data?.labLocationId).toBeNull();
      expect(detail.body.data?.labLocationName).toBeNull();

      // The restoration endpoint uses the promotion bridge. It must not copy
      // an untrusted foreign station id to the canonical cases row.
      const promote = await request(appMod.default)
        .post(`/api/cases/${encodeURIComponent(caseId)}/restorations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          toothNumber: "10",
          restorationType: "crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: 0,
        });
      expect(promote.status).toBe(201);
      const promoted = await db.query.cases.findFirst({
        where: eq(casesTable.id, caseId),
      });
      expect(promoted?.labLocationId).toBeNull();
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, foreignLabId)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.labOrganizationId, foreignLabId)).catch(() => {});
      await db.delete(labCases).where(eq(labCases.organizationId, foreignLabId)).catch(() => {});
      await db.delete(casesTable).where(eq(casesTable.labOrganizationId, foreignLabId)).catch(() => {});
      await db.delete(labLocations).where(eq(labLocations.labOrganizationId, foreignLabId)).catch(() => {});
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, foreignUserId)).catch(() => {});
      await db.delete(userSessions).where(eq(userSessions.userId, foreignUserId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, foreignLabId)).catch(() => {});
      await db.delete(users).where(eq(users.id, foreignUserId)).catch(() => {});
    }
  });

  it("(13) legacy physical moves project in order and promotion preserves them once", async () => {
    const {
      db,
      labCases,
      cases: casesTable,
      caseLocations,
      caseEvents,
    } = dbMod as any;
    const caseId = rid("c13history");

    const intakeLocation = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "Legacy Intake", status: "received" });
    expect(intakeLocation.status).toBe(201);
    const intakeId: string = intakeLocation.body.data.id;

    const designLocation = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "Legacy Design", status: "in_design" });
    expect(designLocation.status).toBe(201);
    const designId: string = designLocation.body.data.id;

    await syncCase(caseId, "INTAKE");
    const firstMove = await request(appMod.default)
      .patch(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "received", labLocationId: intakeId });
    expect(firstMove.status).toBe(200);

    const secondMove = await request(appMod.default)
      .patch(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_design", labLocationId: designId });
    expect(secondMove.status).toBe(200);

    const repeatedMove = await request(appMod.default)
      .patch(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_design", labLocationId: designId });
    expect(repeatedMove.status).toBe(200);

    // A stale mobile whole-blob sync does not know about server-authored
    // locationHistory. It must preserve the stored sequence rather than wipe
    // it, while any client-supplied history remains non-authoritative.
    const staleMobileSync = await syncCase(caseId, "DESIGN", {
      locationHistory: [
        {
          id: "forged-client-move",
          previous: { id: null, code: null, name: null },
          destination: { id: "foreign", code: "foreign", name: "Forged" },
          movedAt: new Date().toISOString(),
          movedByUserId: userId,
          actorInitials: "XX",
        },
      ],
    });
    expect(staleMobileSync.status).toBe(200);
    const forgedStationSync = await syncCase(caseId, "DESIGN", {
      labLocationId: "forged-station-id",
    });
    expect(forgedStationSync.status).toBe(200);

    const legacyRow = await db.query.labCases.findFirst({
      where: eq(labCases.id, caseId),
    });
    const legacyData = JSON.parse(legacyRow.caseData);
    expect(legacyData.labLocationId).toBe(designId);
    expect(legacyData.locationHistory).toHaveLength(2);
    expect(legacyData.locationHistory[0]).toMatchObject({
      previous: { id: null, code: null, name: null },
      destination: { id: intakeId, name: "Legacy Intake" },
    });
    expect(legacyData.locationHistory[1]).toMatchObject({
      previous: { id: intakeId, name: "Legacy Intake" },
      destination: { id: designId, name: "Legacy Design" },
    });

    // Historical rows may already disagree. Promotion must derive status from
    // the saved station rather than copying the stale blob status.
    legacyData.status = "INTAKE";
    await db
      .update(labCases)
      .set({ caseData: JSON.stringify(legacyData) })
      .where(eq(labCases.id, caseId));

    const projected = await request(appMod.default)
      .get(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(projected.status).toBe(200);
    expect(projected.body.data?.locations.map((row: any) => row.locationName)).toEqual([
      "Legacy Intake",
      "Legacy Design",
    ]);
    const projectedMoves = (projected.body.data?.events ?? [])
      .filter((event: any) => event.eventType === "location_changed")
      .sort(
        (a: any, b: any) =>
          new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
      );
    expect(projectedMoves).toHaveLength(2);
    expect(projectedMoves[1].metadataJson).toMatchObject({
      previousLabLocationId: intakeId,
      previousLocationName: "Legacy Intake",
      labLocationId: designId,
      locationName: "Legacy Design",
    });

    const promote = await request(appMod.default)
      .post(`/api/cases/${encodeURIComponent(caseId)}/restorations`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        toothNumber: "8",
        restorationType: "crown",
        material: "Zirconia",
        quantity: 1,
        unitPrice: 0,
      });
    expect(promote.status).toBe(201);
    expect(
      await db.query.cases.findFirst({ where: eq(casesTable.id, caseId) }),
    ).toMatchObject({ id: caseId, status: "in_design", labLocationId: designId });

    expect(
      await db.query.caseLocations.findMany({
        where: eq(caseLocations.caseId, caseId),
      }),
    ).toHaveLength(2);
    expect(
      (
        await db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, caseId),
        })
      ).filter((event: any) => event.eventType === "location_changed"),
    ).toHaveLength(2);

    const canonicalWrite = await request(appMod.default)
      .post(`/api/cases/${encodeURIComponent(caseId)}/restorations`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        toothNumber: "9",
        restorationType: "crown",
        material: "Zirconia",
        quantity: 1,
        unitPrice: 0,
      });
    expect(canonicalWrite.status).toBe(201);
    const postPromotionStaleSync = await syncCase(caseId, "DESIGN", {
      labLocationId: intakeId,
    });
    expect(postPromotionStaleSync.status).toBe(200);
    const legacyAfterPromotion = await db.query.labCases.findFirst({
      where: eq(labCases.id, caseId),
    });
    expect(JSON.parse(legacyAfterPromotion.caseData).labLocationId).toBe(designId);
    expect(
      await db.query.cases.findFirst({ where: eq(casesTable.id, caseId) }),
    ).toMatchObject({ labLocationId: designId });
    expect(
      await db.query.caseLocations.findMany({
        where: eq(caseLocations.caseId, caseId),
      }),
    ).toHaveLength(2);

    const deletedStation = await request(appMod.default)
      .delete(`/api/locations/${designId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deletedStation.status).toBe(200);
    const legacyAfterDeletion = await db.query.labCases.findFirst({
      where: eq(labCases.id, caseId),
    });
    const deletedLegacyData = JSON.parse(legacyAfterDeletion.caseData);
    expect(deletedLegacyData.labLocationId).toBeNull();
    expect(deletedLegacyData.locationHistory).toHaveLength(3);
    expect(deletedLegacyData.locationHistory[2]).toMatchObject({
      previous: { id: designId, name: "Legacy Design" },
      destination: { id: null, name: "Unassigned" },
    });
    expect(
      await db.query.cases.findFirst({ where: eq(casesTable.id, caseId) }),
    ).toMatchObject({ labLocationId: null });
    expect(
      await db.query.caseLocations.findMany({
        where: eq(caseLocations.caseId, caseId),
      }),
    ).toHaveLength(3);
  });

  it("(14) keeps original and remake locations independent across every read surface", async () => {
    const { db, cases: casesTable, labCases } = dbMod as any;
    const originalId = rid("c13original");
    const remakeId = rid("c13remake");
    const complete = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: `Complete ${originalId}`, status: "complete" });
    const modelRoom = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: `Model Room ${remakeId}`, status: "model_room" });
    expect(complete.status).toBe(201);
    expect(modelRoom.status).toBe(201);

    const legacyId = rid("c13legacy");
    expect((await syncCase(legacyId, "INTAKE", {
      labLocationId: complete.body.data.id,
      assignedBarcode: `PAN-${legacyId}`,
    })).status).toBe(200);
    const legacyRow = await db.query.labCases.findFirst({
      where: eq(labCases.id, legacyId),
    });
    expect(JSON.parse(legacyRow.caseData)).toMatchObject({
      status: "COMPLETE",
      labLocationId: complete.body.data.id,
      assignedBarcode: null,
    });

    await db.insert(casesTable).values([
      {
        id: originalId,
        caseNumber: `26-LOC-ORIG-${originalId.slice(-4)}`,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Location",
        patientFirstName: "Original",
        patientLastName: "Generation",
        status: "received",
        casePanBarcode: `PAN-${originalId}`,
        createdByUserId: userId,
      },
      {
        id: remakeId,
        caseNumber: `26-LOC-RMK-${remakeId.slice(-4)}`,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Location",
        patientFirstName: "Remake",
        patientLastName: "Generation",
        status: "received",
        remakeOfCaseId: originalId,
        createdByUserId: userId,
      },
    ]);

    expect((await request(appMod.default)
      .patch(`/api/cases/${originalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "received",
        labLocationId: complete.body.data.id,
        casePanBarcode: `SHOULD-NOT-SURVIVE-${originalId}`,
      })).status).toBe(200);
    expect((await request(appMod.default)
      .post("/api/cases/bulk-status")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseIds: [remakeId],
        status: "complete",
        labLocationId: modelRoom.body.data.id,
      })).status).toBe(200);

    const [original, remake, chain, list, worklist] = await Promise.all([
      request(appMod.default).get(`/api/cases/${originalId}`).set("Authorization", `Bearer ${token}`),
      request(appMod.default).get(`/api/cases/${remakeId}`).set("Authorization", `Bearer ${token}`),
      request(appMod.default).get(`/api/cases/${remakeId}/remake-chain`).set("Authorization", `Bearer ${token}`),
      request(appMod.default).get("/api/cases").set("Authorization", `Bearer ${token}`),
      request(appMod.default).get("/api/cases/worklist?openOnly=true&pageSize=100").set("Authorization", `Bearer ${token}`),
    ]);
    expect(original.body.data).toMatchObject({
      status: "complete",
      labLocationId: complete.body.data.id,
      casePanBarcode: null,
    });
    expect(remake.body.data).toMatchObject({
      status: "model_room",
      labLocationId: modelRoom.body.data.id,
    });
    expect(remake.body.data.remakeOriginal).toMatchObject({
      id: originalId,
      status: "complete",
      labLocationId: complete.body.data.id,
      labLocationName: `Complete ${originalId}`,
    });
    expect(
      original.body.data.remakeChildren.find((row: any) => row.id === remakeId),
    ).toMatchObject({
      status: "model_room",
      labLocationId: modelRoom.body.data.id,
      labLocationName: `Model Room ${remakeId}`,
    });
    const chainById = new Map((chain.body.data.chain ?? []).map((row: any) => [row.id, row]));
    expect(chainById.get(originalId)).toMatchObject({
      status: "complete",
      labLocationId: complete.body.data.id,
      labLocationName: `Complete ${originalId}`,
    });
    expect(chainById.get(remakeId)).toMatchObject({
      status: "model_room",
      labLocationId: modelRoom.body.data.id,
      labLocationName: `Model Room ${remakeId}`,
    });
    const listById = new Map((list.body.data ?? []).map((row: any) => [row.id, row]));
    expect(listById.get(originalId)).toMatchObject({ status: "complete" });
    expect(listById.get(remakeId)).toMatchObject({ status: "model_room" });
    const activeIds = (worklist.body.data?.rows ?? worklist.body.data ?? []).map((row: any) => row.id);
    expect(activeIds).toContain(remakeId);
    expect(activeIds).not.toContain(originalId);

    expect((await request(appMod.default)
      .patch(`/api/locations/${modelRoom.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "qc" })).status).toBe(200);
    expect((await request(appMod.default)
      .post("/api/cases/bulk-status")
      .set("Authorization", `Bearer ${token}`)
      .send({ caseIds: [remakeId], status: "received" })).status).toBe(200);
    const cleared = await request(appMod.default)
      .get(`/api/cases/${remakeId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(cleared.body.data).toMatchObject({ status: "received", labLocationId: null });
    expect(
      (cleared.body.data.events ?? []).some(
        (event: any) =>
          event.eventType === "location_changed" &&
          event.metadataJson?.labLocationId === null,
      ),
    ).toBe(true);

    expect((await request(appMod.default)
      .patch(`/api/locations/${complete.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "delivered" })).status).toBe(200);
    const delivered = await request(appMod.default)
      .get(`/api/cases/${legacyId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(delivered.body.data.status).toBe("delivered");
    const closedWorklist = await request(appMod.default)
      .get("/api/cases/worklist?openOnly=true&pageSize=100")
      .set("Authorization", `Bearer ${token}`);
    const closedIds = (closedWorklist.body.data?.rows ?? closedWorklist.body.data ?? []).map(
      (row: any) => row.id,
    );
    expect(closedIds).not.toContain(legacyId);
  });

  it("(15) serializes legacy promotion against a concurrent station remap", async () => {
    const { db, cases: casesTable, labCases } = dbMod as any;
    const caseId = rid("c15promotion");
    const station = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        organizationId: labOrgId,
        name: "Promotion Race Station",
        status: "received",
      });
    expect(station.status).toBe(201);
    const stationId: string = station.body.data.id;
    expect(
      (await syncCase(caseId, "INTAKE", { labLocationId: stationId })).status,
    ).toBe(200);

    const casesRoutes = await import("./cases.js");
    let releasePromotion!: () => void;
    const release = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    let promotionLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      promotionLocked = resolve;
    });
    casesRoutes._testHooks.promotionLockedHook = async () => {
      promotionLocked();
      await release;
    };

    try {
      const promotionRequest = request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          toothNumber: "7",
          restorationType: "crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: 0,
        })
        .then((response) => response);
      await locked;
      const remapRequest = request(appMod.default)
        .patch(`/api/locations/${stationId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "model_room" })
        .then((response) => response);
      releasePromotion();

      const [promotion, remap] = await Promise.all([
        promotionRequest,
        remapRequest,
      ]);
      expect(promotion.status).toBe(201);
      expect(remap.status).toBe(200);
      expect(
        await db.query.cases.findFirst({ where: eq(casesTable.id, caseId) }),
      ).toMatchObject({
        status: "model_room",
        labLocationId: stationId,
      });
      const legacy = await db.query.labCases.findFirst({
        where: eq(labCases.id, caseId),
      });
      expect(JSON.parse(legacy.caseData)).toMatchObject({
        status: "MODEL_ROOM",
        labLocationId: stationId,
      });
    } finally {
      casesRoutes._testHooks.promotionLockedHook = undefined;
      releasePromotion();
    }
  }, 30000);
});
