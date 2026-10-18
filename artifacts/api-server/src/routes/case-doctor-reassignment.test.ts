import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const suite = process.env.DATABASE_URL ? describe : describe.skip;
const id = () => randomUUID();

suite("case-only doctor reassignment (isolated fixture identities)", () => {
  let m: typeof import("@workspace/db");
  let app: import("express").Express;
  const lab = id(), otherLab = id(), practice = id(), otherPractice = id(), foreignPractice = id();
  const orgIds = [lab, otherLab, practice, otherPractice, foreignPractice];
  const owner = id(), admin = id(), staff = id(), outsider = id(), provider = id(), revoked = id();
  const target = id(), sameNameTarget = id(), unavailable = id(), removed = id(), retired = id();
  const userIds = [owner, admin, staff, outsider, provider, revoked, target, sameNameTarget, unavailable, removed, retired];
  const tokens = new Map<string, string>();
  const caseIds: string[] = [];
  const legacyIds: string[] = [];
  let invoiceId: string;
  let originalCase: string;
  const oldName = "Original Doctor";
  const targetName = "Zero-case Doctor";

  async function newCase(options: { doctorName?: string; labId?: string; practiceId?: string } = {}) {
    const caseId = id();
    caseIds.push(caseId);
    await m.db.insert(m.cases).values({
      id: caseId, caseNumber: `CASE-${caseId}`, labOrganizationId: options.labId ?? lab,
      providerOrganizationId: options.practiceId ?? practice,
      doctorName: options.doctorName ?? oldName, patientFirstName: "Fixture", patientLastName: "Patient",
      status: "draft", priority: "rush", shade: "A2", rxNotes: "Clinical fields must stay",
      createdByUserId: owner,
    });
    return caseId;
  }
  async function newLegacy(extra: Record<string, unknown> = {}) {
    const caseId = id();
    legacyIds.push(caseId);
    await m.db.insert(m.labCases).values({
      id: caseId, organizationId: lab, ownerId: owner,
      caseData: JSON.stringify({
        caseNumber: `LEGACY-${caseId}`, providerOrganizationId: practice,
        doctorName: oldName, patientName: "Legacy Fixture", shade: "B2", toothIndices: [1, 2],
        clinicalCustomField: { kept: true }, activityLog: [{ id: "prior", type: "created", timestamp: 1 }],
        ...extra,
      }),
    });
    return caseId;
  }
  function getRoster(caseId: string, user = admin, query: Record<string, unknown> = {}) {
    return request(app).get(`/api/cases/${caseId}/doctor-candidates`)
      .set("Authorization", `Bearer ${tokens.get(user)}`).set("X-Provider-Organization-Id", practice).query(query);
  }
  function save(caseId: string, assignment: any, candidateKey = `user:${target}`, user = admin) {
    return request(app).post(`/api/cases/${caseId}/doctor-reassignment`)
      .set("Authorization", `Bearer ${tokens.get(user)}`).set("X-Provider-Organization-Id", practice)
      .send({
        recordType: assignment.recordType, expectedDoctorName: assignment.doctorName,
        expectedPracticeId: assignment.providerOrganizationId, expectedRevision: assignment.revision, candidateKey,
      });
  }
  function undo(caseId: string, audit: string, user = admin) {
    return request(app).post(`/api/cases/${caseId}/doctor-reassignment/${audit}/undo`)
      .set("Authorization", `Bearer ${tokens.get(user)}`).set("X-Provider-Organization-Id", practice).send({});
  }
  async function snapshotProtected() {
    const { db } = m;
    return {
      cases: await db.select().from(m.cases).where(inArray(m.cases.id, caseIds)).orderBy(m.cases.id),
      legacy: await db.select().from(m.labCases).where(inArray(m.labCases.id, legacyIds)).orderBy(m.labCases.id),
      pricing: await db.select().from(m.pricingOverrides).where(inArray(m.pricingOverrides.labOrganizationId, [lab, otherLab])).orderBy(m.pricingOverrides.id),
      mappings: await db.select().from(m.rxDoctorPracticeMemory).where(inArray(m.rxDoctorPracticeMemory.labOrganizationId, [lab, otherLab])).orderBy(m.rxDoctorPracticeMemory.id),
      profiles: await db.select().from(m.doctorProfiles).where(inArray(m.doctorProfiles.labOrganizationId, [lab, otherLab])).orderBy(m.doctorProfiles.id),
      members: await db.select().from(m.organizationMemberships).where(inArray(m.organizationMemberships.labId, orgIds)).orderBy(m.organizationMemberships.id),
      users: await db.select().from(m.users).where(inArray(m.users.id, userIds)).orderBy(m.users.id),
      unassigned: await db.select().from(m.labUnassignedDoctors).where(eq(m.labUnassignedDoctors.labOrganizationId, lab)).orderBy(m.labUnassignedDoctors.id),
      invoices: await db.select().from(m.invoices).where(eq(m.invoices.labOrganizationId, lab)).orderBy(m.invoices.id),
      payments: await db.select().from(m.payments).where(eq(m.payments.invoiceId, invoiceId)).orderBy(m.payments.id),
      allocation: await db.select().from(m.platformAccountSequences).orderBy(m.platformAccountSequences.year, m.platformAccountSequences.entityType),
      orgs: await db.select().from(m.organizations).where(inArray(m.organizations.id, orgIds)).orderBy(m.organizations.id),
    };
  }
  function withoutAssignment(row: Record<string, unknown>) {
    const { doctorName: _doctorName, updatedAt: _updatedAt, ...rest } = row;
    return rest;
  }

  beforeAll(async () => {
    m = await import("@workspace/db");
    app = (await import("../app.js")).default;
    await (await import("./index.js")).labtraxRoutesReady;
    const { signAccessToken } = await import("../lib/auth.js");
    await m.db.insert(m.users).values(userIds.map((userId) => ({
      id: userId, username: `assignment-${userId}`, password: "test-only-not-used",
      firstName: userId === target || userId === sameNameTarget ? targetName :
        userId === unavailable ? "Inactive Doctor" : userId === retired ? "Retired Doctor" :
        userId === removed ? "Removed Doctor" : `Fixture ${userId}`,
      userType: [target, sameNameTarget, unavailable, removed, retired, provider].includes(userId) ? "provider" : "lab",
      // Staff deliberately has a global admin label: only lab membership counts.
      role: userId === staff ? "admin" : "user",
      emailVerifiedAt: new Date(), isActive: userId !== unavailable,
      deletedAt: userId === retired ? new Date() : null,
    })));
    await m.db.insert(m.organizations).values([
      { id: lab, type: "lab", name: `Assignment lab ${lab}`, createdByUserId: owner },
      { id: otherLab, type: "lab", name: `Foreign lab ${otherLab}`, createdByUserId: outsider },
    ]);
    await m.db.insert(m.organizations).values([
      { id: practice, type: "provider", name: `Practice ${practice}`, parentLabOrganizationId: lab, createdByUserId: owner },
      { id: otherPractice, type: "provider", name: `Other practice ${otherPractice}`, parentLabOrganizationId: lab, createdByUserId: owner },
      { id: foreignPractice, type: "provider", name: `Foreign practice ${foreignPractice}`, parentLabOrganizationId: otherLab, createdByUserId: outsider },
    ]);
    await m.db.insert(m.organizationMemberships).values([
      { labId: lab, userId: owner, role: "owner", status: "active" },
      { labId: lab, userId: admin, role: "admin", status: "active" },
      { labId: lab, userId: staff, role: "user", status: "active" },
      { labId: lab, userId: revoked, role: "admin", status: "pending" },
      { labId: otherLab, userId: outsider, role: "owner", status: "active" },
      ...[target, sameNameTarget, unavailable, retired, provider].map((userId) => ({
        labId: practice, userId, role: "user", status: "active",
      })),
      // The explicit unassigned record must fence even a stale active membership.
      { labId: practice, userId: removed, role: "user", status: "active" },
    ]);
    await m.db.insert(m.labUnassignedDoctors).values({
      labOrganizationId: lab, userId: removed, doctorName: "Removed Doctor", removedFromOrganizationId: practice,
    });
    // A removal bearing the same name must not hide distinct active accounts.
    await m.db.insert(m.labUnassignedDoctors).values({
      labOrganizationId: lab, doctorName: targetName, removedFromOrganizationId: otherPractice,
    });
    for (const userId of [owner, admin, staff, outsider, provider, revoked]) {
      const sessionId = id();
      const token = signAccessToken(userId, sessionId);
      tokens.set(userId, token);
      await m.db.insert(m.userSessions).values({
        id: sessionId, userId, tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    originalCase = await newCase();
    await newCase();
    await newCase({ practiceId: otherPractice });
    await newCase({ practiceId: foreignPractice, labId: otherLab });
    await newLegacy();
    await newLegacy({ providerOrganizationId: otherPractice });
    for (const name of [oldName, "Name-only Doctor", "Inactive Doctor", "Retired Doctor", "Removed Doctor"]) {
      await m.db.insert(m.pricingOverrides).values({
        labOrganizationId: lab, providerOrganizationId: practice, doctorName: name,
        pricesJson: { crown: 123 }, discountPercent: "12.00", createdByUserId: owner,
      });
    }
    await m.db.insert(m.pricingOverrides).values({
      labOrganizationId: lab, providerOrganizationId: otherPractice, doctorName: "Unrelated Doctor", pricesJson: { crown: 99 },
    });
    await m.db.insert(m.rxDoctorPracticeMemory).values({
      labOrganizationId: lab, providerOrganizationId: practice, doctorName: oldName.toLowerCase(), createdByUserId: owner,
    });
    const [profile] = await m.db.insert(m.doctorProfiles).values({
      labOrganizationId: lab, providerOrganizationId: practice, doctorName: oldName,
    }).returning();
    invoiceId = id();
    await m.db.insert(m.invoices).values({
      id: invoiceId, invoiceNumber: `SNAPSHOT-${invoiceId}`, caseId: originalCase,
      labOrganizationId: lab, providerOrganizationId: otherPractice, doctorIdentity: profile.id,
      subtotal: "125.00", tax: "5.00", total: "130.00", balanceDue: "110.00", status: "partially_paid",
      issuedAt: new Date(), createdByUserId: owner, displayMetadataJson: { doctorName: oldName, patientName: "Frozen patient" },
    });
    await m.db.insert(m.payments).values({
      invoiceId, amount: "20.00", paymentMethod: "check", recordedByUserId: owner, referenceNumber: "snapshot",
    });
  }, 90_000);

  afterAll(async () => {
    if (!m) return;
    // Every delete is limited to fixture-owned ids/labs, never a table reset.
    await m.db.delete(m.payments).where(eq(m.payments.invoiceId, invoiceId));
    await m.db.delete(m.invoices).where(eq(m.invoices.labOrganizationId, lab));
    await m.db.delete(m.caseEvents).where(inArray(m.caseEvents.caseId, caseIds));
    await m.db.delete(m.auditLogs).where(inArray(m.auditLogs.organizationId, [lab, otherLab]));
    await m.db.delete(m.cases).where(inArray(m.cases.id, caseIds));
    await m.db.delete(m.labCases).where(inArray(m.labCases.id, legacyIds));
    await m.db.delete(m.pricingOverrides).where(inArray(m.pricingOverrides.labOrganizationId, [lab, otherLab]));
    await m.db.delete(m.rxDoctorPracticeMemory).where(eq(m.rxDoctorPracticeMemory.labOrganizationId, lab));
    await m.db.delete(m.doctorProfiles).where(eq(m.doctorProfiles.labOrganizationId, lab));
    await m.db.delete(m.labUnassignedDoctors).where(eq(m.labUnassignedDoctors.labOrganizationId, lab));
    await m.db.delete(m.organizationMemberships).where(inArray(m.organizationMemberships.labId, orgIds));
    await m.db.delete(m.organizations).where(inArray(m.organizations.id, [practice, otherPractice, foreignPractice]));
    await m.db.delete(m.organizations).where(inArray(m.organizations.id, [lab, otherLab]));
    await m.db.delete(m.userSessions).where(inArray(m.userSessions.userId, userIds));
    await m.db.delete(m.users).where(inArray(m.users.id, userIds));
  });

  it("includes distinct zero-case accounts and name-only roster entries, never inactive/retired/removed/unrelated doctors", async () => {
    const response = await getRoster(originalCase);
    expect(response.status, response.text).toBe(200);
    const entries = response.body.data.entries;
    expect(entries.filter((e: any) => e.doctorName === targetName)).toHaveLength(2);
    expect(entries.map((e: any) => e.key)).toEqual(expect.arrayContaining([`user:${target}`, `user:${sameNameTarget}`]));
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ doctorName: "Name-only Doctor", userId: null })]));
    for (const name of ["Inactive Doctor", "Retired Doctor", "Removed Doctor", "Unrelated Doctor"]) {
      expect(entries.some((e: any) => e.doctorName === name)).toBe(false);
    }
  });

  it.each(["case", "profile", "pricing", "legacy"])("does not apply another practice's name-only removal to an independent %s roster entry", async (source) => {
    const name = `Independent Doctor ${id()}`;
    const current = await newCase();
    const removedAtOtherPractice = await newCase({ practiceId: otherPractice, doctorName: name });
    const previousOtherRoster = await getRoster(removedAtOtherPractice, admin, { q: name });
    expect(previousOtherRoster.status, previousOtherRoster.text).toBe(200);
    const removedCandidate = previousOtherRoster.body.data.entries.find((entry: any) => entry.doctorName === name);
    expect(removedCandidate).toBeTruthy();
    if (source === "case") await newCase({ doctorName: name });
    else if (source === "legacy") await newLegacy({ doctorName: name });
    else if (source === "profile") {
      await m.db.insert(m.doctorProfiles).values({ labOrganizationId: lab, providerOrganizationId: practice, doctorName: name });
    } else {
      await m.db.insert(m.pricingOverrides).values({
        labOrganizationId: lab, providerOrganizationId: practice, doctorName: name, pricesJson: { crown: 123 },
      });
    }
    await m.db.insert(m.labUnassignedDoctors).values({
      labOrganizationId: lab, doctorName: name, removedFromOrganizationId: otherPractice,
    });
    const available = await getRoster(current, admin, { q: name });
    expect(available.status, available.text).toBe(200);
    expect(available.body.data.entries).toEqual([expect.objectContaining({ doctorName: name, userId: null })]);
    const otherRoster = await getRoster(removedAtOtherPractice, admin, { q: name });
    expect(otherRoster.status, otherRoster.text).toBe(200);
    expect(otherRoster.body.data.entries).toEqual([]);
    const selected = await save(current, available.body.data.assignment, available.body.data.entries[0].key);
    expect(selected.status, selected.text).toBe(200);
    expect(selected.body.data.assignment).toMatchObject({ caseId: current, providerOrganizationId: practice, doctorName: name });
    // The removed practice remains fenced, even with its previously valid key.
    expect((await save(removedAtOtherPractice, otherRoster.body.data.assignment, removedCandidate.key)).status).toBe(409);
    const restored = await undo(current, selected.body.data.auditLogId);
    expect(restored.status, restored.text).toBe(200);
    expect(restored.body.data.assignment.doctorName).toBe(oldName);
  });

  it("scopes and searches before pagination, including doctors beyond 100 lab-wide or practice results", async () => {
    const rows = Array.from({ length: 121 }, (_, i) => ({
      id: id(), username: `paging-${id()}`, password: "test", firstName: `Paged Doctor ${String(i).padStart(3, "0")}`,
      userType: "provider", isActive: true,
    }));
    userIds.push(...rows.map((row) => row.id));
    await m.db.insert(m.users).values(rows);
    await m.db.insert(m.organizationMemberships).values(rows.map((row) => ({
      userId: row.id, labId: practice, role: "user", status: "active",
    })));
    const keys: string[] = [];
    let offset: number | null = 0;
    let total = 0;
    while (offset !== null) {
      const response = await getRoster(originalCase, admin, { limit: 50, offset });
      expect(response.status, response.text).toBe(200);
      total = response.body.data.total;
      keys.push(...response.body.data.entries.map((entry: any) => entry.key));
      offset = response.body.data.nextOffset;
    }
    expect(keys).toHaveLength(total);
    expect(new Set(keys).size).toBe(total);
    expect(keys).toEqual(expect.arrayContaining(rows.map((row) => `user:${row.id}`)));
    const searched = await getRoster(originalCase, admin, { q: "Paged Doctor 120", limit: 1 });
    expect(searched.body.data.entries).toEqual([expect.objectContaining({ key: `user:${rows[120].id}` })]);
    expect(searched.body.data.total).toBe(1);
    expect((await getRoster(originalCase, admin, { offset: 0.5 })).status).toBe(400);
  });

  it("an admin changes exactly one case, persists history, and an owner undoes exactly that assignment", async () => {
    const before = await snapshotProtected();
    const roster = await getRoster(originalCase);
    const response = await save(originalCase, roster.body.data.assignment);
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.assignment).toMatchObject({ caseId: originalCase, doctorName: targetName, providerOrganizationId: practice });
    const changed = await snapshotProtected();
    expect(changed.cases.find((row) => row.id === originalCase)?.doctorName).toBe(targetName);
    expect(changed.cases.map(withoutAssignment)).toEqual(before.cases.map(withoutAssignment));
    expect(changed.cases.filter((row) => row.id !== originalCase)).toEqual(before.cases.filter((row) => row.id !== originalCase));
    const { cases: _cases, ...otherBefore } = before;
    const { cases: _changedCases, ...otherAfter } = changed;
    expect(otherAfter).toEqual(otherBefore);
    const reopened = await request(app).get(`/api/cases/${originalCase}`).set("Authorization", `Bearer ${tokens.get(admin)}`);
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.body.data.doctorName).toBe(targetName);
    const history = await m.db.select().from(m.caseEvents).where(eq(m.caseEvents.caseId, originalCase));
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({
      eventType: "case_doctor_reassigned", metadataJson: expect.objectContaining({ beforeDoctorName: oldName, doctorName: targetName }),
    })]));
    const audit = await m.db.query.auditLogs.findFirst({ where: eq(m.auditLogs.id, response.body.data.auditLogId) });
    expect(audit).toMatchObject({ entityId: originalCase, action: "case_doctor_reassigned", organizationId: lab });
    const undone = await undo(originalCase, response.body.data.auditLogId, owner);
    expect(undone.status, undone.text).toBe(200);
    expect(undone.body.data.assignment.doctorName).toBe(oldName);
    expect(undone.body.data.undoExpiresAt).toBeNull();
    const after = await snapshotProtected();
    expect(after.cases.map(withoutAssignment)).toEqual(before.cases.map(withoutAssignment));
    expect(after.cases.find((row) => row.id === originalCase)?.doctorName).toBe(oldName);
    const { cases: _afterCases, ...otherUndone } = after;
    expect(otherUndone).toEqual(otherBefore);
    expect((await undo(originalCase, response.body.data.auditLogId)).status).toBe(409);
  });

  it.each([staff, provider, outsider, revoked])("denies roster, write and undo to non-active case-lab admins: %s", async (user) => {
    const caseId = await newCase();
    const roster = await getRoster(caseId);
    const change = await save(caseId, roster.body.data.assignment);
    expect(change.status, change.text).toBe(200);
    expect((await getRoster(caseId, user)).status).toBe(403);
    expect((await save(caseId, change.body.data.assignment, `user:${sameNameTarget}`, user)).status).toBe(403);
    expect((await undo(caseId, change.body.data.auditLogId, user)).status).toBe(403);
    expect((await getRoster(caseId)).body.data.assignment.doctorName).toBe(targetName);
  });

  it("allows an owner to save and blocks no-op/repeated/stale/wrong-record requests without side effects", async () => {
    const caseId = await newCase();
    const roster = await getRoster(caseId);
    const a = roster.body.data.assignment;
    const oldCandidate = roster.body.data.entries.find((e: any) => e.doctorName === oldName);
    const before = await snapshotProtected();
    expect((await save(caseId, a, oldCandidate.key)).status).toBe(400);
    expect((await save(caseId, { ...a, recordType: "legacy" })).status).toBe(409);
    expect((await save(caseId, { ...a, doctorName: "Unsaved value" })).status).toBe(409);
    expect((await save(caseId, { ...a, providerOrganizationId: otherPractice })).status).toBe(409);
    expect(await snapshotProtected()).toEqual(before);
    const changed = await save(caseId, a, `user:${target}`, owner);
    expect(changed.status, changed.text).toBe(200);
    expect((await save(caseId, a, `user:${target}`, owner)).status).toBe(409);
    expect(await m.db.select().from(m.auditLogs).where(and(eq(m.auditLogs.entityId, caseId), eq(m.auditLogs.action, "case_doctor_reassigned")))).toHaveLength(1);
  });

  it("refuses unavailable and cross-practice targets, never moves practice or creates an account", async () => {
    const caseId = await newCase();
    const roster = await getRoster(caseId);
    const foreignId = id();
    userIds.push(foreignId);
    await m.db.insert(m.users).values({ id: foreignId, username: `foreign-${foreignId}`, password: "test", firstName: targetName, userType: "provider" });
    await m.db.insert(m.organizationMemberships).values({ userId: foreignId, labId: otherPractice, role: "user", status: "active" });
    const before = await snapshotProtected();
    for (const key of [`user:${unavailable}`, `user:${removed}`, `user:${retired}`, `user:${foreignId}`, "name:invented"]) {
      const rejected = await save(caseId, roster.body.data.assignment, key);
      expect(rejected.status, rejected.text).toBe(409);
      expect(rejected.body.message ?? rejected.body.error?.message).toMatch(/not currently associated/i);
    }
    expect(await snapshotProtected()).toEqual(before);
  });

  it("revalidates a candidate removed after search and supports name-only selection", async () => {
    const caseId = await newCase();
    const roster = await getRoster(caseId);
    await m.db.update(m.organizationMemberships).set({ status: "pending" }).where(and(
      eq(m.organizationMemberships.labId, practice), eq(m.organizationMemberships.userId, sameNameTarget),
    ));
    expect((await save(caseId, roster.body.data.assignment, `user:${sameNameTarget}`)).status).toBe(409);
    await m.db.update(m.organizationMemberships).set({ status: "active" }).where(and(
      eq(m.organizationMemberships.labId, practice), eq(m.organizationMemberships.userId, sameNameTarget),
    ));
    const entry = (await getRoster(caseId, admin, { q: "Name-only" })).body.data.entries[0];
    const result = await save(caseId, roster.body.data.assignment, entry.key);
    expect(result.status, result.text).toBe(200);
    expect(result.body.data.assignment.doctorName).toBe("Name-only Doctor");
  });

  it("serializes duplicate concurrent requests; undo never overwrites subsequent edits or assignments", async () => {
    const caseId = await newCase();
    const a = (await getRoster(caseId)).body.data.assignment;
    const responses = await Promise.all([save(caseId, a), save(caseId, a)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const changed = responses.find((r) => r.status === 200)!;
    await m.db.update(m.cases).set({ doctorName: "Later Doctor", updatedAt: new Date(Date.now() + 1000) }).where(eq(m.cases.id, caseId));
    const before = await snapshotProtected();
    expect((await undo(caseId, changed.body.data.auditLogId)).status).toBe(409);
    expect(await snapshotProtected()).toEqual(before);
    expect((await undo(originalCase, changed.body.data.auditLogId)).status).toBe(404);
  });

  it("expires undo and refuses directory-merge audit records", async () => {
    const caseId = await newCase();
    const a = (await getRoster(caseId)).body.data.assignment;
    const changed = await save(caseId, a);
    await m.db.update(m.auditLogs).set({ metadataJson: { undoExpiresAt: new Date(0).toISOString() } }).where(eq(m.auditLogs.id, changed.body.data.auditLogId));
    expect((await undo(caseId, changed.body.data.auditLogId)).status).toBe(409);
    const fakeMergeId = id();
    await m.db.insert(m.auditLogs).values({
      id: fakeMergeId, organizationId: lab, userId: admin, entityType: "case", entityId: caseId,
      action: "doctor_merge", beforeJson: a, afterJson: changed.body.data.assignment,
      metadataJson: { undoExpiresAt: new Date(Date.now() + 600_000).toISOString() },
    });
    expect((await undo(caseId, fakeMergeId)).status).toBe(404);
  });

  it("updates/undoes an eligible legacy row by exact identity, leaving every sibling blob untouched", async () => {
    const legacyId = await newLegacy();
    const before = await snapshotProtected();
    const a = (await getRoster(legacyId)).body.data.assignment;
    expect(a.recordType).toBe("legacy");
    const changed = await save(legacyId, a);
    expect(changed.status, changed.text).toBe(200);
    const after = await snapshotProtected();
    const beforeBlob = JSON.parse(before.legacy.find((r) => r.id === legacyId)!.caseData);
    const afterBlob = JSON.parse(after.legacy.find((r) => r.id === legacyId)!.caseData);
    expect(afterBlob).toEqual({
      ...beforeBlob, doctorName: targetName,
      activityLog: [...beforeBlob.activityLog, expect.objectContaining({ type: "case_doctor_reassigned", description: expect.stringContaining(targetName) })],
    });
    expect(after.legacy.filter((r) => r.id !== legacyId)).toEqual(before.legacy.filter((r) => r.id !== legacyId));
    const { legacy: _oldLegacy, ...protectedBefore } = before;
    const { legacy: _newLegacy, ...protectedAfter } = after;
    expect(protectedAfter).toEqual(protectedBefore);
    const reopened = await request(app).get(`/api/cases/${legacyId}`).set("Authorization", `Bearer ${tokens.get(admin)}`);
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.body.data).toMatchObject({ doctorName: targetName, providerOrganizationId: practice });
    const undone = await undo(legacyId, changed.body.data.auditLogId);
    expect(undone.status, undone.text).toBe(200);
    const restored = await snapshotProtected();
    const restoredBlob = JSON.parse(restored.legacy.find((r) => r.id === legacyId)!.caseData);
    expect(restoredBlob.doctorName).toBe(oldName);
    expect(restoredBlob.activityLog.at(-1).type).toBe("case_doctor_reassignment_undone");
    const { legacy: _restoredLegacy, ...protectedRestored } = restored;
    expect(protectedRestored).toEqual(protectedBefore);
  });

  it("refuses ambiguous legacy practice and embedded invoice attribution rather than guessing or repairing billing", async () => {
    for (const extra of [{ providerOrganizationId: null }, { invoiceId: "saved-embedded-invoice", price: 120 }, { activityLog: { unreadable: "preserve" } }]) {
      const legacyId = await newLegacy(extra);
      const before = await snapshotProtected();
      expect((await getRoster(legacyId)).status).toBe(409);
      expect((await save(legacyId, { recordType: "legacy", doctorName: oldName, providerOrganizationId: practice, revision: "stale" })).status).toBe(409);
      expect(await snapshotProtected()).toEqual(before);
    }
  });

  it("rolls the assignment and history back when the atomic audit insert fails", async () => {
    const caseId = await newCase();
    const a = (await getRoster(caseId)).body.data.assignment;
    const realTransaction = m.db.transaction.bind(m.db);
    const spy = vi.spyOn(m.db, "transaction").mockImplementation((callback, config) =>
      realTransaction(async (tx) => {
        const originalInsert = tx.insert.bind(tx);
        const insertSpy = vi.spyOn(tx, "insert").mockImplementation(((table: unknown) => {
          if (table === m.auditLogs) throw new Error("Fixture audit insert refused");
          return originalInsert(table as any);
        }) as typeof tx.insert);
        try { return await callback(tx); } finally { insertSpy.mockRestore(); }
      }, config),
    );
    try {
      expect((await save(caseId, a)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const [saved] = await m.db.select().from(m.cases).where(eq(m.cases.id, caseId));
    expect(saved.doctorName).toBe(oldName);
    expect(await m.db.select().from(m.caseEvents).where(eq(m.caseEvents.caseId, caseId))).toHaveLength(0);
    expect(await m.db.select().from(m.auditLogs).where(eq(m.auditLogs.entityId, caseId))).toHaveLength(0);
  });
});
