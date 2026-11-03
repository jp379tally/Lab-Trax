import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { HttpError } from "../lib/http";
import { registerSupportAssistantRoutes } from "./support-assistant";

const mocks = vi.hoisted(() => ({ create: vi.fn(), resolve: vi.fn(), lookup: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/ai-openai-client", () => ({ getAiClient: () => ({ responses: { create: mocks.create } }) }));
vi.mock("../lib/support-assistant-data", () => ({ resolveSupportScope: mocks.resolve, lookupSupportData: mocks.lookup }));
vi.mock("../lib/audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== "Bearer valid") return res.status(401).json({ error: "Authentication required." });
    req.user = { id: "user-a" }; next();
  },
  requireVerifiedAccount: (req: any, res: any, next: any) => {
    if (req.headers["x-unverified"]) return res.status(403).json({ error: "Verify account." });
    next();
  },
}));
function app() {
  const app = express(); app.use(express.json());
  const router = express.Router(); registerSupportAssistantRoutes(router); app.use("/api", router);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: error.message }));
  return app;
}
beforeEach(() => {
  vi.clearAllMocks(); process.env.SUPPORT_ASSISTANT_ENABLED = "true";
  mocks.resolve.mockResolvedValue({ userId: "user-a", providerOrganizationId: "practice-a" });
  mocks.create.mockResolvedValue({ output: [], output_text: "Use iTero ID 40938." });
  mocks.audit.mockResolvedValue(undefined);
});
describe("support HTTP endpoints", () => {
  it("keeps the feature disabled unless explicitly enabled", async () => {
    delete process.env.SUPPORT_ASSISTANT_ENABLED;
    expect((await request(app()).post("/api/support-assistant/public").send({ message: "hello" })).status).toBe(404);
    expect((await request(app()).get("/api/support-assistant/config")).body.data.enabled).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("serves public answers without resolving account scope, even with forged body identity", async () => {
    const response = await request(app()).post("/api/support-assistant/public").send({ message: "iTero?", userId: "user-a", providerOrganizationId: "practice-b" });
    expect(response.status).toBe(200); expect(response.body.data.mode).toBe("public");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and unverified account requests before model or database lookup", async () => {
    const response = await request(app()).post("/api/support-assistant/account").send({ message: "case?" });
    expect(response.status).toBe(401);
    expect((await request(app()).post("/api/support-assistant/account").set("Authorization", "Bearer valid").set("x-unverified", "yes").send({ message: "case?" })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("validates selected practice server-side before invoking AI", async () => {
    mocks.resolve.mockRejectedValueOnce(new HttpError(403, "Practice not assigned."));
    const response = await request(app()).post("/api/support-assistant/account").set("Authorization", "Bearer valid").set("x-provider-organization-id", "practice-b").send({ message: "case?", userId: "attacker" });
    expect(response.status).toBe(403);
    expect(mocks.resolve).toHaveBeenCalledWith("user-a", "practice-b"); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("audits account answers without question or patient text", async () => {
    const response = await request(app()).post("/api/support-assistant/account").set("Authorization", "Bearer valid").send({ message: "private question" });
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.audit.mock.calls[0][0].metadataJson).toEqual({ mode: "account" });
  });
  it("redacts upstream and database failures", async () => {
    mocks.create.mockRejectedValueOnce(new Error("sk-secret and SQL patient text"));
    const response = await request(app()).post("/api/support-assistant/public").send({ message: "hello" });
    expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain("sk-secret");
  });
  it("returns a 400 for invalid questions", async () => {
    expect((await request(app()).post("/api/support-assistant/public").send({ message: " " })).status).toBe(400);
  });
  it("limits account questions per authenticated user", async () => {
    const server = app();
    for (let i = 0; i < 10; i++) {
      expect((await request(server).post("/api/support-assistant/account").set("Authorization", "Bearer valid").send({ message: "help" })).status).toBe(200);
    }
    expect((await request(server).post("/api/support-assistant/account").set("Authorization", "Bearer valid").send({ message: "help" })).status).toBe(429);
    expect(mocks.create).toHaveBeenCalledTimes(10);
  });
  it("sets embedding boundaries: public only on SDR; account page cannot be framed", async () => {
    const publicPage = await request(app()).get("/api/support-assistant/embed");
    expect(publicPage.headers["content-security-policy"]).toContain("frame-ancestors https://sdrdl.com https://www.sdrdl.com 'self'");
    expect(publicPage.text).toContain("document.createTextNode(text)");
    const privatePage = await request(app()).get("/api/support-assistant/portal");
    expect(privatePage.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(privatePage.headers["cache-control"]).toBe("no-store");
  });
});
