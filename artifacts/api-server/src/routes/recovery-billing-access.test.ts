import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/http";

const mocks = vi.hoisted(() => ({
  available: true,
  requireAnyRole: vi.fn(),
  auth: vi.fn(),
  verified: vi.fn(),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mocks.auth();
    (req as any).auth = { userId: "synthetic-user" };
    next();
  },
  requireVerifiedAccount: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mocks.verified();
    next();
  },
}));

vi.mock("../lib/rbac", () => ({
  BILLING_ROLES: ["owner", "admin", "billing"],
  ADMIN_ROLES: ["owner", "admin"],
  requireAnyRole: mocks.requireAnyRole,
}));

vi.mock("../lib/recovery-billing-scope", () => ({
  RECOVERY_LAB_ID: "synthetic-lab",
  RECOVERY_TIMEZONE: "UTC",
  RECOVERY_SAFEGUARD_VERSION: "synthetic-safeguard",
  RECOVERY_TAG: "synthetic-tag",
  get recoveryDataAvailable() {
    return mocks.available;
  },
  assertRecoveryDataAvailable: () => {
    if (!mocks.available) throw new Error("Recovery data unavailable.");
  },
}));

import recoveryBillingRouter from "./recovery-billing";

function createApp() {
  const app = express();
  app.use(recoveryBillingRouter);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return app;
}

describe("recovery billing access availability probe", () => {
  beforeEach(() => {
    mocks.available = true;
    mocks.requireAnyRole.mockReset();
    mocks.auth.mockClear();
    mocks.verified.mockClear();
  });

  it("returns available:false without a membership query when private data is absent", async () => {
    mocks.available = false;
    const response = await request(createApp()).get("/access");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false });
    expect(mocks.requireAnyRole).not.toHaveBeenCalled();
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.verified).toHaveBeenCalledOnce();
  });

  it.each([
    ["no membership in the configured lab", "You do not belong to this organization."],
    ["a role outside the allowed billing set", "You do not have permission for this action."],
  ])("returns available:false for %s", async (_label, message) => {
    mocks.requireAnyRole.mockRejectedValue(new HttpError(403, message));
    const response = await request(createApp()).get("/access");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false });
    expect(mocks.requireAnyRole).toHaveBeenCalledWith(
      "synthetic-user",
      "synthetic-lab",
      ["owner", "admin", "billing"],
    );
  });

  it("returns the authorized billing role only when data and membership are available", async () => {
    mocks.requireAnyRole.mockResolvedValue({ role: "billing" });
    const response = await request(createApp()).get("/access");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: true, role: "staff" });
  });

  it("does not turn non-authorization failures into an unavailable result", async () => {
    mocks.requireAnyRole.mockRejectedValue(new HttpError(503, "Membership lookup unavailable."));
    const response = await request(createApp()).get("/access");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: "Membership lookup unavailable." });
  });
});
