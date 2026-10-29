import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: fake.query } }));
vi.mock("./backup-live-status-store", () => ({ ensureBackupLiveStatusSchema: vi.fn() }));
vi.mock("./backup-source", () => ({ getBackupSourceEnvironment: () => "production" }));
import { signBackupContinuation, verifyBackupContinuation, issueBackupContinuation, backupContinuationOrAdmin } from "./backup-continuation";
const runId = "12345678-1234-4234-8234-123456789012";
const key = "synthetic-test-key";
const claims = () => ({ runId, ownerId: "owner", source: "production", expiresAt: Date.now() + 3600000 });
function response() { const res: any = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res; }
beforeEach(() => { vi.stubEnv("JWT_SECRET", key); fake.query.mockReset(); });
describe("run-scoped backup continuation after session logout", () => {
  it("authenticates the existing run without a bearer, PIN, or login refresh", async () => {
    fake.query.mockResolvedValue({ rows: [{ requested_by_session_hash: "persisted-owner-session", delivery: {} }] });
    const req: any = { headers: { "x-labtrax-backup-continuation": signBackupContinuation(claims(), key) }, params: { runId } };
    const auth = vi.fn(); const next = vi.fn();
    await backupContinuationOrAdmin("status", auth)(req, response(), next);
    expect(auth).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: "owner", role: "admin", isActive: true });
    expect(req._backupContinuationSessionHash).toBe("persisted-owner-session");
    expect(fake.query.mock.calls[0][0]).toContain("u.is_active=true");
    expect(fake.query.mock.calls[0][1]).toEqual([runId, "owner"]);
  });
  it.each(["download", "status"] as const)("rejects another run for %s", async operation => {
    const res = response(); const next = vi.fn();
    await backupContinuationOrAdmin(operation, vi.fn())({ headers: { "x-labtrax-backup-continuation": signBackupContinuation(claims(), key) }, params: { runId: "other" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled(); expect(fake.query).not.toHaveBeenCalled();
  });
  it("rejects tampering, expiration, wrong signing keys, and excessive lifetime", () => {
    const token = signBackupContinuation(claims(), key);
    expect(verifyBackupContinuation(token, key)?.runId).toBe(runId);
    expect(verifyBackupContinuation(token + "x", key)).toBeNull();
    expect(verifyBackupContinuation(token, "wrong")).toBeNull();
    expect(verifyBackupContinuation(signBackupContinuation({ ...claims(), expiresAt: Date.now() - 1 }, key), key)).toBeNull();
    expect(verifyBackupContinuation(signBackupContinuation({ ...claims(), expiresAt: Date.now() + 13 * 3600000 }, key), key)).toBeNull();
  });
  it("rejects tokens from another source environment", async () => {
    const res = response();
    await backupContinuationOrAdmin("status", vi.fn())({ headers: { "x-labtrax-backup-continuation": signBackupContinuation({ ...claims(), source: "development" }, key) }, params: { runId } }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401); expect(fake.query).not.toHaveBeenCalled();
  });
  it("retains ordinary admin authentication when no continuation was supplied", async () => {
    const auth = vi.fn(); const req = { headers: {} }; const res = response(); const next = vi.fn();
    await backupContinuationOrAdmin("status", auth)(req, res, next);
    expect(auth).toHaveBeenCalledWith(req, res, next);
  });
  it("does not grant reports for arbitrary files or scheduled jobs", async () => {
    const token = signBackupContinuation(claims(), key); const next = vi.fn();
    for (const body of [{ source: "interval", status: "success", downloadRunId: runId }, { source: "manual", status: "success", downloadRunId: "other" }]) {
      const res = response(); await backupContinuationOrAdmin("report", vi.fn())({ headers: { "x-labtrax-backup-continuation": token }, body }, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    }
    fake.query.mockResolvedValue({ rows: [{ requested_by_session_hash: "hash", delivery: null }] });
    const res = response(); await backupContinuationOrAdmin("report", vi.fn())({ headers: { "x-labtrax-backup-continuation": token }, body: { source: "manual", status: "success", downloadRunId: runId } }, res, next);
    expect(res.status).toHaveBeenCalledWith(404); expect(next).not.toHaveBeenCalled();
  });
  it("fails closed for removed/disabled owners and database failures", async () => {
    const req = { headers: { "x-labtrax-backup-continuation": signBackupContinuation(claims(), key) }, params: { runId } }; const next = vi.fn();
    fake.query.mockResolvedValueOnce({ rows: [] }); const missing = response();
    await backupContinuationOrAdmin("status", vi.fn())(req, missing, next); expect(missing.status).toHaveBeenCalledWith(404);
    fake.query.mockRejectedValueOnce(new Error("synthetic outage")); const outage = response();
    await backupContinuationOrAdmin("status", vi.fn())(req, outage, next); expect(outage.status).toHaveBeenCalledWith(503); expect(next).not.toHaveBeenCalled();
  });
  it("issues only to the exact owner/session, with fixed expiry from run start", async () => {
    const started = Date.now() - 3600000;
    fake.query.mockResolvedValueOnce({ rows: [{ started_at: new Date(started) }] });
    const token = await issueBackupContinuation(runId, "owner", "session");
    expect(verifyBackupContinuation(token!, key)?.expiresAt).toBe(started + 12 * 3600000);
    expect(fake.query.mock.calls[0][1]).toEqual([runId, "owner", "session"]);
    fake.query.mockResolvedValueOnce({ rows: [] }); expect(await issueBackupContinuation(runId, "other", "other")).toBeUndefined();
    expect(await issueBackupContinuation(runId, null, "shared-secret")).toBeUndefined();
  });
});
