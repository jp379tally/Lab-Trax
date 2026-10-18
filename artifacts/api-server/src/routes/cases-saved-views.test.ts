import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const rid = () => randomUUID();

const desktopFilters = {
  search: "Mina",
  statusFilters: ["received", "in_design"],
  desktop: { dateRangeFilter: "custom", customStartDate: "2026-10-01", customEndDate: "2026-10-14" },
};
const mobileFilters = {
  search: "",
  statusFilters: ["qc"],
  mobile: {
    createdFilter: "thisWeek",
    createdCustomFrom: "",
    createdCustomTo: "",
    dueFilter: "custom",
    dueCustomFrom: "2026-10-20",
    dueCustomTo: "2026-10-31",
  },
};

maybe("Shared Cases saved views — lab scope, validation, and lifecycle", () => {
  let mod: typeof import("@workspace/db");
  let app: import("express").Express;
  let auth: typeof import("../lib/auth.js");
  const lab = rid(), otherLab = rid(), practice = rid();
  const admin = rid(), teammate = rid(), outsider = rid(), provider = rid(), inactive = rid();
  const users = [admin, teammate, outsider, provider, inactive];
  let adminToken = "", teammateToken = "", outsiderToken = "", providerToken = "", inactiveToken = "";

  async function session(userId: string) {
    const id = rid();
    const token = auth.signAccessToken(userId, id);
    await mod.db.insert(mod.userSessions).values({
      id, userId, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return token;
  }
  const list = (token: string, labOrganizationId = lab) =>
    request(app)
      .get(`/api/cases/saved-views?labOrganizationId=${encodeURIComponent(labOrganizationId)}`)
      .set("Authorization", `Bearer ${token}`);
  const create = (token: string, name: string, filters: unknown, labOrganizationId = lab) =>
    request(app)
      .post("/api/cases/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .send({ labOrganizationId, name, filters });
  const rename = (token: string, id: string, name: string, labOrganizationId = lab) =>
    request(app)
      .patch(`/api/cases/saved-views/${encodeURIComponent(id)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ labOrganizationId, name });

  const updateFilters = (token: string, id: string, filters: unknown, labOrganizationId = lab) =>
    request(app)
      .patch(`/api/cases/saved-views/${encodeURIComponent(id)}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ labOrganizationId, filters });
  const remove = (token: string, id: string, labOrganizationId = lab) =>
    request(app)
      .delete(`/api/cases/saved-views/${encodeURIComponent(id)}?labOrganizationId=${encodeURIComponent(labOrganizationId)}`)
      .set("Authorization", `Bearer ${token}`);
  async function storedView(id: string) {
    const [row] = await mod.db.select().from(mod.caseSavedViews).where(eq(mod.caseSavedViews.id, id));
    return row;
  }

  beforeAll(async () => {
    mod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    await (await import("./index.js")).labtraxRoutesReady;
    auth = await import("../lib/auth.js");
    await mod.db.insert(mod.users).values(users.map((id) => ({
      id, username: `saved-view-${id}`, password: "x", userType: id === provider ? "provider" : "lab",
    })));
    await mod.db.insert(mod.organizations).values([
      { id: lab, type: "lab", name: "Saved views lab" },
      { id: otherLab, type: "lab", name: "Other saved views lab" },
      { id: practice, type: "provider", name: "Saved views practice", parentLabOrganizationId: lab },
    ]);
    await mod.db.insert(mod.organizationMemberships).values([
      { id: rid(), labId: lab, userId: admin, role: "admin", status: "active" },
      { id: rid(), labId: lab, userId: teammate, role: "user", status: "active" },
      { id: rid(), labId: otherLab, userId: outsider, role: "admin", status: "active" },
      { id: rid(), labId: practice, userId: provider, role: "owner", status: "active" },
      { id: rid(), labId: lab, userId: inactive, role: "admin", status: "inactive" },
    ]);
    [adminToken, teammateToken, outsiderToken, providerToken, inactiveToken] = await Promise.all(
      users.map((id) => session(id)),
    );
  }, 120_000);

  afterAll(async () => {
    if (!mod) return;
    await mod.db.delete(mod.caseSavedViews).where(inArray(mod.caseSavedViews.labOrganizationId, [lab, otherLab, practice]));
    await mod.db.delete(mod.organizationMemberships).where(inArray(mod.organizationMemberships.userId, users));
    await mod.db.delete(mod.userSessions).where(inArray(mod.userSessions.userId, users));
    await mod.db.delete(mod.organizations).where(eq(mod.organizations.id, practice));
    await mod.db.delete(mod.organizations).where(inArray(mod.organizations.id, [lab, otherLab]));
    await mod.db.delete(mod.users).where(inArray(mod.users.id, users));
  });

  it("shares a lab's views with every active member and keeps desktop and mobile dates separate", async () => {
    const desktop = await create(adminToken, "Morning triage", desktopFilters);
    expect(desktop.status, JSON.stringify(desktop.body)).toBe(201);
    expect(desktop.body.data).toMatchObject({ labOrganizationId: lab, name: "Morning triage", filters: desktopFilters });
    expect((await storedView(desktop.body.data.id))?.createdByUserId).toBe(admin);

    const mobile = await create(teammateToken, "  due soon  ", mobileFilters);
    expect(mobile.status, JSON.stringify(mobile.body)).toBe(201);
    expect(mobile.body.data).toMatchObject({ name: "due soon", filters: mobileFilters });

    const otherLabView = await create(outsiderToken, "Other lab only", desktopFilters, otherLab);
    expect(otherLabView.status).toBe(201);

    const shared = await list(teammateToken);
    expect(shared.status).toBe(200);
    expect(shared.body.data.map((view: { name: string }) => view.name)).toEqual(["due soon", "Morning triage"]);
    const byName = new Map(shared.body.data.map((view: { name: string; filters: unknown }) => [view.name, view.filters]));

    expect(byName.get("Morning triage")).toEqual(desktopFilters);
    expect(byName.get("due soon")).toEqual(mobileFilters);

    const otherLabViews = await list(outsiderToken, otherLab);
    expect(otherLabViews.status).toBe(200);
    expect(otherLabViews.body.data.map((view: { name: string }) => view.name)).toEqual(["Other lab only"]);
    expect(await storedView(desktop.body.data.id)).toMatchObject({ filters: desktopFilters });
    expect(await storedView(mobile.body.data.id)).toMatchObject({ filters: mobileFilters });
  });

  it("refuses callers without an active membership in the lab that owns the view", async () => {
    const created = await create(adminToken, "Scope check", desktopFilters);
    expect(created.status).toBe(201);
    const viewId = created.body.data.id as string;

    expect((await list(outsiderToken)).status).toBe(403);
    expect((await create(outsiderToken, "Intruder", desktopFilters)).status).toBe(403);
    expect((await list(inactiveToken)).status).toBe(403);
    expect((await create(inactiveToken, "Inactive", desktopFilters)).status).toBe(403);
    expect((await request(app).get(`/api/cases/saved-views?labOrganizationId=${lab}`)).status).toBe(401);

    // A practice membership is not a lab team, even for the practice owner.
    expect((await list(providerToken, practice)).status).toBe(403);
    expect((await create(providerToken, "Practice view", mobileFilters, practice)).status).toBe(403);

    // Naming the caller's own lab cannot reach another lab's view; naming the
    // owning lab is refused before the view is touched.
    expect((await rename(outsiderToken, viewId, "Taken over", otherLab)).status).toBe(404);
    expect((await rename(outsiderToken, viewId, "Taken over")).status).toBe(403);
    expect((await remove(outsiderToken, viewId, otherLab)).status).toBe(404);
    expect((await remove(outsiderToken, viewId)).status).toBe(403);
    expect((await remove(inactiveToken, viewId)).status).toBe(403);
    expect(await storedView(viewId)).toMatchObject({ name: "Scope check", labOrganizationId: lab });
  });

  it("rejects blank or duplicate names and impossible calendar dates", async () => {
    const first = await create(adminToken, "Remakes", desktopFilters);
    const second = await create(adminToken, "Rush", mobileFilters);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    expect((await create(adminToken, "   ", desktopFilters)).status).toBe(400);
    const duplicate = await create(teammateToken, "REMAKES", mobileFilters);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toMatch(/already exists/);
    // Names are unique per lab, not across labs.
    expect((await create(outsiderToken, "Remakes", desktopFilters, otherLab)).status).toBe(201);

    const invalidDateViews = [
      {
        name: "Bad desktop received date",
        filters: { ...desktopFilters, desktop: { ...desktopFilters.desktop, customStartDate: "2026-02-30" } },
      },
      {
        name: "Bad mobile created date",
        filters: { ...mobileFilters, mobile: { ...mobileFilters.mobile, createdCustomTo: "2026-02-29" } },
      },
      {
        name: "Bad mobile due date",
        filters: { ...mobileFilters, mobile: { ...mobileFilters.mobile, dueCustomFrom: "2026-13-01" } },
      },
    ];
    for (const invalidView of invalidDateViews) {
      expect((await create(adminToken, invalidView.name, invalidView.filters)).status).toBe(400);
    }
    const unknownPreset = { ...desktopFilters, desktop: { ...desktopFilters.desktop, dateRangeFilter: "week" } };
    expect((await create(adminToken, "Unknown preset", unknownPreset)).status).toBe(400);
    const savedNames = (await list(adminToken)).body.data.map((view: { name: string }) => view.name);
    expect(savedNames).not.toContain("Bad desktop received date");
    expect(savedNames).not.toContain("Bad mobile created date");
    expect(savedNames).not.toContain("Bad mobile due date");
    expect(savedNames).not.toContain("Unknown preset");

    expect((await rename(adminToken, second.body.data.id, "remakes")).status).toBe(409);
    expect((await rename(adminToken, second.body.data.id, "  ")).status).toBe(400);
    const recased = await rename(adminToken, first.body.data.id, "REMAKES");
    expect(recased.status, JSON.stringify(recased.body)).toBe(200);
    expect(recased.body.data).toMatchObject({ id: first.body.data.id, name: "REMAKES", filters: desktopFilters });
  });

  it("lets any lab teammate rename or remove a shared view for the whole lab", async () => {
    const created = await create(adminToken, "Afternoon queue", desktopFilters);
    expect(created.status).toBe(201);
    const viewId = created.body.data.id as string;

    const renamed = await rename(teammateToken, viewId, "Evening queue");
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({ id: viewId, name: "Evening queue", filters: desktopFilters });
    const afterRename = await list(adminToken);
    expect(afterRename.body.data.map((view: { id: string; name: string }) => [view.id, view.name])).toContainEqual([viewId, "Evening queue"]);

    expect((await remove(teammateToken, viewId)).status).toBe(204);
    const afterRemove = await list(adminToken);
    expect(afterRemove.body.data.map((view: { id: string }) => view.id)).not.toContain(viewId);
    expect((await remove(teammateToken, viewId)).status).toBe(404);
    expect((await rename(adminToken, viewId, "Gone")).status).toBe(404);
  });

  it("lets lab teammates replace a shared view's filters without changing its name", async () => {
    const created = await create(adminToken, "Cross-platform triage", desktopFilters);
    expect(created.status).toBe(201);
    const viewId = created.body.data.id as string;

    expect((await updateFilters(outsiderToken, viewId, mobileFilters)).status).toBe(403);
    const emptyUpdate = await request(app)
      .patch(`/api/cases/saved-views/${encodeURIComponent(viewId)}`)
      .set("Authorization", `Bearer ${teammateToken}`)
      .send({ labOrganizationId: lab });
    expect(emptyUpdate.status).toBe(400);

    const updatedFilters = {
      ...mobileFilters,
      desktop: desktopFilters.desktop,
    };
    const updated = await updateFilters(teammateToken, viewId, updatedFilters);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      id: viewId,
      name: "Cross-platform triage",
      filters: updatedFilters,
    });
    expect(await storedView(viewId)).toMatchObject({
      name: "Cross-platform triage",
      filters: updatedFilters,
    });

    const impossibleFilters = {
      ...mobileFilters,
      mobile: { ...mobileFilters.mobile, dueCustomTo: "2026-02-30" },
    };
    expect((await updateFilters(teammateToken, viewId, impossibleFilters)).status).toBe(400);
    const refreshed = await list(adminToken);
    expect(refreshed.body.data.find((view: { id: string }) => view.id === viewId).filters)
      .toEqual(updatedFilters);
  });
});
