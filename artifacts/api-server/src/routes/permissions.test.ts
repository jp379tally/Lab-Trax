import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { json } from "express";

const { mockRequireAnyRole } = vi.hoisted(() => ({
  mockRequireAnyRole: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...orig,
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      query: {
        organizationMemberships: { findFirst: vi.fn() },
        labPermissionDefinitions: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn(),
        },
        labMemberPermissions: { findMany: vi.fn().mockResolvedValue([]) },
      },
    },
    labPermissionDefinitions: orig.labPermissionDefinitions ?? {},
    labMemberPermissions: orig.labMemberPermissions ?? {},
    organizationMemberships: orig.organizationMemberships ?? {},
  };
});

vi.mock("../middlewares/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/rbac.js", () => ({
  requireAnyRole: mockRequireAnyRole,
  OWNER_ROLES: ["owner"],
}));

import permissionsRouter from "./permissions.js";

function makeApp(overrideUser?: Record<string, unknown>) {
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    (req as { user?: Record<string, unknown> }).user = overrideUser ?? {
      id: "user_owner",
      role: "owner",
      practiceOrganizationId: "org_lab_1",
    };
    next();
  });
  app.use("/organizations", permissionsRouter);
  return app;
}

function rejectForbidden() {
  const err = new Error("You do not have permission for this action.") as Error & { statusCode: number };
  err.statusCode = 403;
  return mockRequireAnyRole.mockRejectedValue(err);
}

describe("Permission Definitions CRUD", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAnyRole.mockResolvedValue({ role: "owner" });
    app = makeApp();
  });

  it("GET /:orgId/permission-definitions - returns 403 when not a member", async () => {
    rejectForbidden();

    const res = await request(app).get("/organizations/org_lab_1/permission-definitions");
    expect(res.status).toBe(403);
  });

  it("POST /:orgId/permission-definitions - rejects invalid capabilityKey", async () => {
    const res = await request(app)
      .post("/organizations/org_lab_1/permission-definitions")
      .send({ name: "Test", capabilityKey: "not_a_real_key" });
    expect(res.status).toBe(400);
  });

  it("POST /:orgId/permission-definitions - rejects missing name", async () => {
    const res = await request(app)
      .post("/organizations/org_lab_1/permission-definitions")
      .send({ capabilityKey: "delete_cases" });
    expect(res.status).toBe(400);
  });

  it("POST /:orgId/permission-definitions - returns 403 for non-owner role", async () => {
    rejectForbidden();
    const adminApp = makeApp({ id: "user_admin", role: "admin", practiceOrganizationId: "org_lab_1" });

    const res = await request(adminApp)
      .post("/organizations/org_lab_1/permission-definitions")
      .send({ name: "Test", capabilityKey: "delete_cases" });
    expect(res.status).toBe(403);
  });
});

describe("Self Permissions", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAnyRole.mockResolvedValue({ role: "owner" });
    app = makeApp({ id: "user_self", role: "user" });
  });

  it("GET /:orgId/members/self/permissions - returns 404 when not a member", async () => {
    const { db } = await import("@workspace/db");
    (db.query.organizationMemberships.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined
    );

    const res = await request(app).get("/organizations/org_lab_1/members/self/permissions");
    expect(res.status).toBe(404);
  });

  it("GET /:orgId/members/self/permissions - returns empty permissions when no grants", async () => {
    const { db } = await import("@workspace/db");
    (db.query.organizationMemberships.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem_self",
      labId: "org_lab_1",
      userId: "user_self",
      status: "active",
    });
    (db.query.labMemberPermissions.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await request(app).get("/organizations/org_lab_1/members/self/permissions");
    expect(res.status).toBe(200);
    expect(res.body.data.membershipId).toBe("mem_self");
    expect(res.body.data.permissions).toEqual([]);
  });

  it("GET /:orgId/members/self/permissions - returns full definitions for granted permissions", async () => {
    const { db } = await import("@workspace/db");
    (db.query.organizationMemberships.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem_self",
      labId: "org_lab_1",
      userId: "user_self",
      status: "active",
    });
    (db.query.labMemberPermissions.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { membershipId: "mem_self", permissionDefinitionId: "def_1" },
    ]);
    (db.query.labPermissionDefinitions.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "def_1",
        labId: "org_lab_1",
        name: "Finance Viewer",
        description: "Can view financial reports",
        capabilityKey: "view_financial_reports",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(app).get("/organizations/org_lab_1/members/self/permissions");
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toHaveLength(1);
    expect(res.body.data.permissions[0].name).toBe("Finance Viewer");
    expect(res.body.data.permissions[0].capabilityKey).toBe("view_financial_reports");
    expect(res.body.data.permissions[0].description).toBe("Can view financial reports");
  });

  it("GET /:orgId/members/self/permissions - does NOT require owner role (no requireAnyRole call)", async () => {
    const { db } = await import("@workspace/db");
    (db.query.organizationMemberships.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem_self",
      labId: "org_lab_1",
      userId: "user_self",
      status: "active",
    });
    (db.query.labMemberPermissions.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const nonOwnerApp = makeApp({ id: "user_self", role: "user" });
    const res = await request(nonOwnerApp).get("/organizations/org_lab_1/members/self/permissions");
    expect(res.status).toBe(200);
    expect(mockRequireAnyRole).not.toHaveBeenCalled();
  });
});

describe("Member Permissions", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAnyRole.mockResolvedValue({ role: "owner" });
    app = makeApp();
  });

  it("PUT /:orgId/members/:membershipId/permissions - rejects invalid def IDs format", async () => {
    const res = await request(app)
      .put("/organizations/org_lab_1/members/mem_1/permissions")
      .send({ permissionDefinitionIds: "not-an-array" });
    expect(res.status).toBe(400);
  });

  it("PUT /:orgId/members/:membershipId/permissions - returns 403 for non-owner", async () => {
    rejectForbidden();
    const adminApp = makeApp({ id: "user_admin", role: "admin", practiceOrganizationId: "org_lab_1" });

    const res = await request(adminApp)
      .put("/organizations/org_lab_1/members/mem_1/permissions")
      .send({ permissionDefinitionIds: [] });
    expect(res.status).toBe(403);
  });

  it("GET /:orgId/members/:membershipId/permissions - returns 403 for non-owner", async () => {
    rejectForbidden();
    const adminApp = makeApp({ id: "user_admin", role: "admin", practiceOrganizationId: "org_lab_1" });

    const res = await request(adminApp).get("/organizations/org_lab_1/members/mem_1/permissions");
    expect(res.status).toBe(403);
  });
});
