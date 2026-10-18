import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/audited-organization-recovery-operation", () => ({
  runAuditedOrganizationRecovery: vi.fn().mockResolvedValue({ state: "ready" }),
}));
import { auditedOrganizationRecoveryRouter, requireRecoveryAutomation } from "./audited-organization-recovery";
import { runAuditedOrganizationRecovery } from "../lib/audited-organization-recovery-operation";

function app(role = "admin", verifiedSession = false) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as any).user = { role, id: null };
    (req as any)._platformAdminSessionVerified = verifiedSession;
    next();
  });
  server.use(requireRecoveryAutomation, auditedOrganizationRecoveryRouter());
  return server;
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("operator recovery authorization and request fencing", () => {
  it.each(["admin", "owner", "lab_admin", "provider"])("rejects %s roles and admin sessions without the automation credential", async (role) => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    expect((await request(app(role, true)).post("/").set("x-platform-admin-pin", "synthetic-pin").send({})).status).toBe(403);
    expect(runAuditedOrganizationRecovery).not.toHaveBeenCalled();
  });
  it("fails closed if the credential is unconfigured", async () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "");
    expect((await request(app()).post("/").send({})).status).toBe(403);
  });
  it("does not accept a lab role even with a credential header", async () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    expect((await request(app("lab_admin")).post("/").set("x-platform-admin-secret", "synthetic-operator-secret").send({})).status).toBe(403);
  });
  it("defaults an authorized empty request to dry run", async () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    const response = await request(app()).post("/").set("x-platform-admin-secret", "synthetic-operator-secret").send({});
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(runAuditedOrganizationRecovery).toHaveBeenCalledWith(true, null);
  });
  it.each([
    { dryRun: false }, { dryRun: false, confirm: "OTHER" },
    { dryRun: false, confirm: "RECOVER_THE_24_AUDITED_ORGANIZATIONS", organizationIds: ["other-org"] },
  ])("rejects unconfirmed or expanded live requests", async (body) => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    expect((await request(app()).post("/").set("x-platform-admin-secret", "synthetic-operator-secret").send(body)).status).toBe(400);
    expect(runAuditedOrganizationRecovery).not.toHaveBeenCalled();
  });
  it("accepts only the exact authorized live confirmation", async () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    expect((await request(app()).post("/").set("x-platform-admin-secret", "synthetic-operator-secret").send({
      dryRun: false, confirm: "RECOVER_THE_24_AUDITED_ORGANIZATIONS",
    })).status).toBe(200);
    expect(runAuditedOrganizationRecovery).toHaveBeenCalledWith(false, null);
  });
});
