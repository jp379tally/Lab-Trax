import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({
  select: vi.fn(), verify: vi.fn(), subject: vi.fn(), assert: vi.fn(),
}));
vi.mock("@workspace/db", async (original) => ({
  ...await original<typeof import("@workspace/db")>(),
  db: { select: mocks.select },
}));
vi.mock("../lib/auth", () => ({
  extractBearerToken: () => "present",
  verifyAccessToken: mocks.verify,
}));
vi.mock("../lib/entitlement", () => ({ getSubjectForUser: mocks.subject }));
vi.mock("./request-performance", () => ({
  timeRequestStage: (_res: unknown, _name: string, fn: () => unknown) => fn(),
}));
vi.mock("../lib/entitlement-write-guard", () => ({
  assertBillingSubjectMutationAllowed: mocks.assert,
  isMutationAllowedDuringReadOnly: () => false,
  runWithEntitlementRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
import { requireAuth } from "./auth";

describe("live authentication without redundant lookups or refresh storms", () => {
  let where: ReturnType<typeof vi.fn>;
  let limit: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    where = vi.fn();
    limit = vi.fn().mockResolvedValue([{ id: "u", isActive: true, deletedAt: null, userType: "lab" }]);
    const builder = { from: vi.fn(), innerJoin: vi.fn(), where, limit };
    builder.from.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    where.mockReturnValue(builder);
    mocks.select.mockReturnValue(builder);
    mocks.verify.mockReturnValue({ sub: "u", sid: "s" });
    mocks.subject.mockResolvedValue({ subjectType: "lab_org", subjectId: "lab" });
  });
  async function authenticate(method = "GET", originalUrl = "/api/notifications") {
    const next = vi.fn();
    const req = { method, originalUrl } as any;
    await requireAuth(req, {} as any, next);
    return { next, req };
  }
  it("checks session and account together and reuses the confirmed user type only within the request", async () => {
    const { next, req } = await authenticate();
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ userId: "u", sessionId: "s" });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.subject).toHaveBeenCalledWith("u", "lab");
    const sql = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(sql.sql).toContain('"user_sessions"."revoked_at" is null');
    expect(sql.sql).toContain('"user_sessions"."expires_at" >');
    expect(sql.params).toContain("u");
    expect(sql.params).toContain("s");
  });
  it("never caches identity across requests and denies missing or inactive identities", async () => {
    await authenticate();
    limit.mockResolvedValueOnce([]);
    expect((await authenticate()).next.mock.calls[0][0].statusCode).toBe(401);
    limit.mockResolvedValueOnce([{ isActive: false, deletedAt: null }]);
    expect((await authenticate()).next.mock.calls[0][0].statusCode).toBe(401);
    limit.mockResolvedValueOnce([{ isActive: true, deletedAt: new Date() }]);
    expect((await authenticate()).next.mock.calls[0][0].statusCode).toBe(401);
    expect(mocks.select).toHaveBeenCalledTimes(4);
  });
  it("forwards infrastructure failures, rather than falsely rejecting credentials", async () => {
    const error = new Error("Failed query", { cause: new Error("timeout exceeded when trying to connect") });
    limit.mockRejectedValueOnce(error);
    expect((await authenticate()).next).toHaveBeenCalledWith(error);
    expect(mocks.subject).not.toHaveBeenCalled();
  });
  it("still applies personal and account-scoped mutation entitlement gates", async () => {
    await authenticate("PATCH", "/api/auth/profile");
    expect(mocks.assert).toHaveBeenCalled();
    mocks.assert.mockClear();
    mocks.subject.mockResolvedValueOnce({ subjectType: "user", subjectId: "u" });
    await authenticate();
    expect(mocks.assert).toHaveBeenCalled();
  });
  it("rejects malformed/wrong-type tokens before any database work", async () => {
    mocks.verify.mockImplementationOnce(() => { throw new Error("wrong token type"); });
    expect((await authenticate()).next.mock.calls[0][0].statusCode).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
