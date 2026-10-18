import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const fixture = vi.hoisted(() => ({
  row: null as { key: string; value: string } | null,
  candidates: [{ id: "creator" }] as { id: string }[],
  audits: [] as any[],
  activeSessions: new Set(["session-a", "session-b"]),
}));
vi.mock("@workspace/db", async (original) => {
  const actual: any = await original();
  const database: any = {
    select: () => ({ from: (table: any) => {
      const rows = table === actual.users ? fixture.candidates : fixture.row ? [fixture.row] : [];
      const chain: any = { then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
      for (const method of ["where", "limit", "for"]) chain[method] = () => chain;
      return chain;
    }}),
    insert: () => ({ values: (values: any) => ({ onConflictDoNothing: async () => { fixture.row ??= values; } }) }),
    update: () => ({ set: (values: any) => ({ where: async () => { fixture.row!.value = values.value; } }) }),
    transaction: async (work: any) => work(database),
  };
  return { ...actual, db: database };
});
vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const userId = req.headers["test-user"];
    const sessionId = req.headers["test-session"] ?? "session-a";
    if (!userId || !fixture.activeSessions.has(sessionId)) return res.status(401).json({ error: "Session invalid." });
    req.auth = { userId, sessionId };
    req.user = { id: userId, role: req.headers["test-role"] ?? "user", isActive: true };
    next();
  },
  requireVerifiedAccount: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("./audit", () => ({ writeAuditLogTx: async (_tx: any, { req: _req, ...entry }: any) => fixture.audits.push(entry) }));
vi.mock("./subscription-history", () => ({ subscriptionCoverage: async () => [], reconcileSubscriptionHistory: async () => ({ ok: true }) }));
vi.mock("./support-report-storage", () => ({ readSupportReportAttachment: vi.fn() }));
import creatorRouter from "../routes/creator";
import { requireCreator } from "./creator-auth";

const app = express();
app.use(express.json());
app.use("/api/creator", creatorRouter);
for (const alias of ["/api/owner/team", "/api/admin/subscriptions", "/api/admin/provider-subscriptions"]) {
  app.all(alias, requireCreator, (_req: express.Request, res: express.Response) => res.json({ private: true }));
}
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message }));
const auth = (call: any, user = "creator", session = "session-a") => call.set("test-user", user).set("test-session", session);
const unlock = (pin = "1357913", session = "session-a") => auth(request(app).post("/api/creator/unlock"), "creator", session).send({ pin });

describe("Creator identity, PIN and session boundaries", () => {
  beforeEach(() => {
    fixture.row = null; fixture.candidates = [{ id: "creator" }]; fixture.audits = [];
    fixture.activeSessions = new Set(["session-a", "session-b"]);
    vi.stubEnv("CREATOR_INITIAL_PIN", "1357913");
  });
  it("fails closed for missing or ambiguous initial identity", async () => {
    for (const candidates of [[], [{ id: "creator" }, { id: "other" }]]) {
      fixture.row = null; fixture.candidates = candidates;
      expect((await auth(request(app).get("/api/creator/access"))).body.isCreator).toBe(false);
      expect((await unlock()).status).toBe(403);
    }
  });
  it("requires authentication even when a platform secret or PIN is supplied", async () => {
    const result = await request(app).post("/api/creator/unlock").set("x-platform-admin-secret", "known").send({ pin: "1357913" });
    expect(result.status).toBe(401);
  });
  it.each(["owner", "admin", "provider", "user", "billing"])("denies %s accounts with a known Creator PIN and shared admin credentials", async (role) => {
    const denied = await auth(request(app).post("/api/creator/unlock"), "other")
      .set("test-role", role).set("x-platform-admin-pin", "known").set("x-platform-admin-secret", "known").set("x-platform-admin-session", "other:valid")
      .send({ pin: "1357913" });
    expect(denied.status).toBe(403);
    const access = await auth(request(app).get("/api/creator/access"), "other");
    expect(access.body).toEqual({ isCreator: false, pinConfigured: false, unlocked: false, expiresAt: null });
  });
  it("does not fall back to the admin PIN when Creator provisioning is absent", async () => {
    vi.stubEnv("CREATOR_INITIAL_PIN", "");
    expect((await unlock()).status).toBe(503);
    expect((await auth(request(app).get("/api/creator/access"))).body.pinConfigured).toBe(false);
  });
  it("persists only a bcrypt hash, and binding survives renaming JPP", async () => {
    expect((await unlock()).status).toBe(200);
    const state = JSON.parse(fixture.row!.value);
    expect(state.hash).toMatch(/^\$2/);
    expect(fixture.row!.value).not.toContain("1357913");
    fixture.candidates = [{ id: "replacement-jpp" }];
    expect((await auth(request(app).get("/api/creator/access"), "replacement-jpp")).body.isCreator).toBe(false);
    expect((await auth(request(app).get("/api/creator/access"))).body.isCreator).toBe(true);
  });
  it("binds unlock to the login session and protects expiry, logout and lock", async () => {
    await unlock();
    expect((await auth(request(app).get("/api/owner/team"))).status).toBe(200);
    expect((await auth(request(app).get("/api/owner/team"), "creator", "session-b")).status).toBe(403);
    const state = JSON.parse(fixture.row!.value);
    state.unlocks["session-a"].expiresAt = Date.now() - 1;
    fixture.row!.value = JSON.stringify(state);
    expect((await auth(request(app).get("/api/admin/subscriptions"))).status).toBe(403);
    await unlock();
    await auth(request(app).post("/api/creator/lock")).send({});
    expect((await auth(request(app).get("/api/admin/provider-subscriptions"))).status).toBe(403);
    await unlock();
    fixture.activeSessions.delete("session-a");
    expect((await auth(request(app).get("/api/creator/access"))).status).toBe(401);
  });
  it("shares a durable attempt limit across sessions without disabling it in tests", async () => {
    for (let n = 0; n < 5; n++) expect((await unlock("0000001", n % 2 ? "session-b" : "session-a")).status).toBe(403);
    const result = await unlock();
    expect(result.status).toBe(429);
    expect(Number(result.headers["retry-after"])).toBeGreaterThan(0);
    // Resetting the window simulates elapsed wall time; no module-local reset.
    const state = JSON.parse(fixture.row!.value);
    state.resetAt = Date.now() - 1;
    fixture.row!.value = JSON.stringify(state);
    expect((await unlock()).status).toBe(200);
  });
  it("rotation needs the current PIN and confirmation, revokes every old unlock", async () => {
    await unlock(); await unlock("1357913", "session-b");
    expect((await auth(request(app).post("/api/creator/pin")).send({ currentPin: "0000001", newPin: "2468024", confirmPin: "2468024" })).status).toBe(403);
    expect((await auth(request(app).post("/api/creator/pin")).send({ currentPin: "1357913", newPin: "2468024", confirmPin: "2468025" })).status).toBe(400);
    expect((await auth(request(app).post("/api/creator/pin")).send({ currentPin: "1357913", newPin: "2468024", confirmPin: "2468024" })).status).toBe(200);
    expect((await auth(request(app).get("/api/owner/team"), "creator", "session-b")).status).toBe(403);
    // Successful attempts also consume the durable budget.
    const state = JSON.parse(fixture.row!.value); state.resetAt = 0; fixture.row!.value = JSON.stringify(state);
    expect((await unlock("1357913")).status).toBe(403);
    expect((await unlock("2468024")).status).toBe(200);
    expect(JSON.stringify(fixture.audits)).not.toMatch(/1357913|2468024/);
  });
  it("all Creator read/mutation/download paths reject noncreators before querying data", async () => {
    for (const path of ["/api/creator/revenue", "/api/creator/feedback", "/api/creator/feedback/a/attachments/b", "/api/owner/team", "/api/admin/subscriptions", "/api/admin/provider-subscriptions"]) {
      expect((await auth(request(app).get(path), "other")).status).toBe(403);
    }
    expect((await auth(request(app).patch("/api/creator/feedback/a"), "other").send({ reviewed: true })).status).toBe(403);
  });
  it("production mounts enforce Creator on legacy aliases and retain the owner tenant checks", () => {
    const routes = readFileSync(new URL("../routes/labtrax-routes.ts", import.meta.url), "utf8");
    expect(routes).toContain('router.use("/admin/subscriptions", requireCreator');
    expect(routes).toContain('router.use("/admin/provider-subscriptions", requireCreator');
    const owner = readFileSync(new URL("../routes/owner.ts", import.meta.url), "utf8");
    expect(owner).toContain("router.use(requireCreator)");
    expect(owner).toContain("requireAnyRole(userId, orgId, OWNER_ROLES)");
  });
});
