import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const rid = () => randomUUID();

maybe("Cases overview — complete authorized workbench", () => {
  let mod: typeof import("@workspace/db");
  let app: import("express").Express;
  let auth: typeof import("../lib/auth.js");
  const lab = rid(), secondLab = rid(), foreignLab = rid(), practice = rid(), otherPractice = rid();
  const staff = rid(), provider = rid(), outsider = rid();
  const additionalStages = ["scan", "in_milling", "post_mill", "sintering_furnace", "in_porcelain", "qc", "on_hold", "remake"];
  const caseIds = Array.from({ length: 12 + additionalStages.length }, rid);
  let staffToken = "", providerToken = "", outsiderToken = "";

  async function session(userId: string) {
    const id = rid();
    const token = auth.signAccessToken(userId, id);
    await mod.db.insert(mod.userSessions).values({
      id, userId, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return token;
  }
  function get(token = staffToken, query = `organizationId=${lab}&localDate=2026-10-06&localTime=09:00`) {
    return request(app).get(`/api/cases/overview?${query}`).set("Authorization", `Bearer ${token}`);
  }

  beforeAll(async () => {
    mod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    await (await import("./index.js")).labtraxRoutesReady;
    auth = await import("../lib/auth.js");
    const { ensureLabCaseProjection } = await import("../lib/lab-case-projection");
    await ensureLabCaseProjection();
    await mod.db.insert(mod.users).values([
      { id: staff, username: `overview-${staff}`, password: "x", userType: "lab" },
      { id: provider, username: `overview-${provider}`, password: "x", userType: "provider" },
      { id: outsider, username: `overview-${outsider}`, password: "x", userType: "lab" },
    ]);
    await mod.db.insert(mod.organizations).values([
      { id: lab, type: "lab", name: "Overview lab" },
      { id: secondLab, type: "lab", name: "Second overview lab" },
      { id: foreignLab, type: "lab", name: "Foreign overview lab" },
      { id: practice, type: "provider", name: "Overview practice", parentLabOrganizationId: lab },
      { id: otherPractice, type: "provider", name: "Other overview practice", parentLabOrganizationId: lab },
    ]);
    await mod.db.insert(mod.organizationMemberships).values([
      { id: rid(), labId: lab, userId: staff, role: "admin", status: "active" },
      { id: rid(), labId: secondLab, userId: staff, role: "admin", status: "active" },
      { id: rid(), labId: foreignLab, userId: staff, role: "admin", status: "inactive" },
      { id: rid(), labId: practice, userId: provider, role: "owner", status: "active" },
    ]);
    await mod.db.insert(mod.cases).values(caseIds.map((id, i) => ({
      id, caseNumber: `OV-${id}`, labOrganizationId: lab,
      providerOrganizationId: i < 3 ? practice : otherPractice,
      createdByUserId: staff, patientFirstName: "Overview", patientLastName: "Fixture", doctorName: "Dr. Overview",
      status: i >= 12 ? additionalStages[i - 12]
        : i === 5 ? "complete"
        : i === 7 ? "in_design"
          : i === 8 ? "model_room"
            : i === 9 ? "shipped"
              : i === 10 ? "qc"
                : "received",
      priority: i === 0 || i === 5 ? "rush" : "normal",
      casePanBarcode: i === 0 ? "OV-DUP" : null,
      dueDate: i === 3 || i >= 12 ? null : new Date(i === 4 || i === 5 ? "2026-10-05T00:00:00Z" : "2026-10-06T00:00:00Z"),
      expectedDeliveryDate: i === 3 || i === 4 ? new Date("2026-10-06T00:00:00Z") : null,
      dueTime: i === 0 ? "08:59" : i === 1 ? "9:00" : i === 2 ? "09:01" : null,
      deletedAt: i === 6 ? new Date() : null,
    })));
    await mod.db.insert(mod.cases).values([
      { id: rid(), caseNumber: rid(), labOrganizationId: secondLab, providerOrganizationId: otherPractice, createdByUserId: staff, casePanBarcode: "OV-DUP", patientFirstName: "Second", patientLastName: "Lab", doctorName: "Dr. Second" },
      { id: rid(), caseNumber: rid(), labOrganizationId: foreignLab, providerOrganizationId: otherPractice, createdByUserId: staff, casePanBarcode: "OV-DUP", priority: "rush", patientFirstName: "Foreign", patientLastName: "Lab", doctorName: "Dr. Foreign" },
    ]);
    await mod.db.insert(mod.labCases).values([
      { id: rid(), ownerId: staff, organizationId: lab, caseData: JSON.stringify({
        patientName: "Legacy overview", status: "INTAKE", isRush: true,
        assignedBarcode: "OV-DUP", dueDate: "2026-10-06T00:00:00Z",
      }) },
      // Canonical ownership wins even if the legacy copy disagrees.
      { id: caseIds[0], ownerId: staff, organizationId: lab, caseData: '{"isRush":true,"assignedBarcode":"OV-DUP"}' },
      { id: rid(), ownerId: staff, organizationId: lab, caseData: "{malformed" },
      { id: rid(), ownerId: staff, organizationId: lab, deletedAt: new Date(), caseData: '{"isRush":true}' },
    ]);
    [staffToken, providerToken, outsiderToken] = await Promise.all([session(staff), session(provider), session(outsider)]);
  }, 120_000);

  afterAll(async () => {
    if (!mod) return;
    const orgs = [lab, secondLab, foreignLab, practice, otherPractice];
    await mod.db.delete(mod.labCases).where(inArray(mod.labCases.organizationId, orgs));
    await mod.db.delete(mod.cases).where(inArray(mod.cases.labOrganizationId, orgs));
    await mod.db.delete(mod.organizationMemberships).where(inArray(mod.organizationMemberships.userId, [staff, provider, outsider]));
    await mod.db.delete(mod.userSessions).where(inArray(mod.userSessions.userId, [staff, provider, outsider]));
    await mod.db.delete(mod.organizations).where(inArray(mod.organizations.id, [practice, otherPractice]));
    await mod.db.delete(mod.organizations).where(inArray(mod.organizations.id, [lab, secondLab, foreignLab]));
    await mod.db.delete(mod.users).where(inArray(mod.users.id, [staff, provider, outsider]));
  });

  it("counts the full canonical+legacy set, ignores list filters/page, and counts collisions as cases", async () => {
    const response = await get(staffToken, `organizationId=${lab}&localDate=2026-10-06&localTime=09:00&search=no-match&priority=normal&page=2&pageSize=1`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({
      totalCases: 21, dueToday: 9, conflicts: 2, rushCases: 3,
      processingCases: 11, inTransitCases: 1, completedCases: 1, overdueCases: 1,
      receivedCases: 8, inDesignCases: 1, modelRoomCases: 1, shippedCases: 1,
      scanCases: 1, millingCases: 1, postMillCases: 1, sinteringFurnaceCases: 1,
      porcelainCases: 1, qualityCheckCases: 2, onHoldCases: 1, remakeCases: 1,
    });
    const page = await request(app).get(`/api/cases/worklist?organizationId=${lab}&pageSize=1`).set("Authorization", `Bearer ${staffToken}`);
    expect(page.status).toBe(200);
    expect(page.body.data.rows).toHaveLength(1);
    expect(page.body.data.total).toBe(21);
    const overdue = await request(app).get("/api/cases/worklist?overdueOnly=true&localDate=2026-10-06&pageSize=100").set("Authorization", `Bearer ${staffToken}`);
    expect(overdue.status).toBe(200);
    expect(overdue.body.data.total).toBe(1);
    expect(overdue.body.data.rows.map((row: { id: string }) => row.id)).toContain(caseIds[4]);
    const allPastDue = await request(app).get("/api/cases/worklist?overdueOnly=true&localDate=2026-10-07&pageSize=100").set("Authorization", `Bearer ${staffToken}`);
    expect(allPastDue.status).toBe(200);
    expect(allPastDue.body.data.total).toBe(11);
    expect(allPastDue.body.data.rows.map((row: { id: string }) => row.id)).toContain(caseIds[3]);
    const summaryPastDue = await get(staffToken, `organizationId=${lab}&localDate=2026-10-07&localTime=09:00`);
    expect(summaryPastDue.body.data.overdueCases).toBe(11);
  });

  it("combines active authorized labs but never groups same barcodes across labs", async () => {
    const response = await get(staffToken, "localDate=2026-10-06&localTime=09:00");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalCases: 22, dueToday: 9, conflicts: 2, rushCases: 3,
      processingCases: 11, inTransitCases: 1, completedCases: 1, overdueCases: 1,
      receivedCases: 9, inDesignCases: 1, modelRoomCases: 1, shippedCases: 1,
      scanCases: 1, millingCases: 1, postMillCases: 1, sinteringFurnaceCases: 1,
      porcelainCases: 1, qualityCheckCases: 2, onHoldCases: 1, remakeCases: 1,
    });
  });

  it("matches viewer-local calendar and clock, keeping equal-time and untimed cases", async () => {
    const later = await get(staffToken, `organizationId=${lab}&localDate=2026-10-06&localTime=09:02`);
    expect(later.body.data.dueToday).toBe(7);
    const tomorrow = await get(staffToken, `organizationId=${lab}&localDate=2026-10-07&localTime=00:00`);
    expect(tomorrow.body.data.dueToday).toBe(0);
    const earlier = await get(staffToken, `organizationId=${lab}&localDate=2026-10-06&localTime=00:00`);
    expect(earlier.body.data.dueToday).toBe(10);
  });

  it("returns only a provider's authorized canonical cases, not lab-wide legacy rows", async () => {
    const response = await get(providerToken, "localDate=2026-10-06&localTime=09:00");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalCases: 3, dueToday: 2, conflicts: 0, rushCases: 1,
      processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
      receivedCases: 3, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
      scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
      porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
    });
    expect((await get(providerToken)).status).toBe(403);
  });

  it("denies foreign and inactive memberships and returns zeros for a memberless caller", async () => {
    expect((await get(staffToken, `organizationId=${foreignLab}&localDate=2026-10-06&localTime=09:00`)).status).toBe(403);
    expect((await get(outsiderToken)).status).toBe(403);
    const empty = await get(outsiderToken, "localDate=2026-10-06&localTime=09:00");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      totalCases: 0, dueToday: 0, conflicts: 0, rushCases: 0,
      processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
      receivedCases: 0, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
      scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
      porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
    });
  });

  it("validates calendar dates and time and requires authentication", async () => {
    for (const query of ["localDate=2026-02-30&localTime=09:00", "localDate=2026-10-06&localTime=25:00", "localDate=2026-10-06"]) {
      expect((await get(staffToken, query)).status).toBe(400);
    }
    for (const localDate of ["2026-02-30", "2026-99-99", "bad-date"]) {
      const overdue = await request(app).get(`/api/cases/worklist?overdueOnly=true&localDate=${localDate}`).set("Authorization", `Bearer ${staffToken}`);
      expect(overdue.status).toBe(400);
    }
    expect((await request(app).get("/api/cases/overview?localDate=2026-10-06&localTime=09:00")).status).toBe(401);
  });
});
