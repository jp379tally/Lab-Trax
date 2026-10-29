import { createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
import { ensureBackupLiveStatusSchema } from "./backup-live-status-store";
import { getBackupSourceEnvironment } from "./backup-source";

const HEADER = "x-labtrax-backup-continuation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Claims = { runId: string; ownerId: string; source: string; expiresAt: number };
function signature(payload: string, key: string): Buffer {
  return createHmac("sha256", key).update("labtrax-backup-continuation-v1:" + payload).digest();
}
// A separate token format/domain cannot be used as an ordinary access token.
export function signBackupContinuation(claims: Claims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + signature(payload, key).toString("base64url");
}
export function verifyBackupContinuation(token: string, key: string, now = Date.now()): Claims | null {
  try {
    if (!key || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const actual = Buffer.from(parts[1], "base64url");
    const expected = signature(parts[0], key);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Claims;
    if (!UUID.test(c.runId) || typeof c.ownerId !== "string" || !c.ownerId ||
        !["production", "development"].includes(c.source) ||
        !Number.isFinite(c.expiresAt) || c.expiresAt <= now || c.expiresAt > now + 12 * 60 * 60 * 1000) return null;
    return c;
  } catch { return null; }
}
export async function issueBackupContinuation(runId: string, ownerId: string | null, sessionHash: string | null): Promise<string | undefined> {
  // Shared-secret integrations retain their existing authentication contract.
  if (!ownerId || !sessionHash || !process.env.JWT_SECRET) return undefined;
  await ensureBackupLiveStatusSchema();
  const result = await pool.query<{ started_at: Date }>(
    "SELECT started_at FROM backup_live_status WHERE run_id=$1 AND requested_by_user_id=$2 AND requested_by_session_hash=$3",
    [runId, ownerId, sessionHash],
  );
  if (!result.rows[0]) return undefined;
  const expiresAt = new Date(result.rows[0].started_at).getTime() + 12 * 60 * 60 * 1000;
  if (expiresAt <= Date.now()) return undefined;
  return signBackupContinuation({ runId, ownerId, source: getBackupSourceEnvironment(), expiresAt }, process.env.JWT_SECRET);
}
// Install ONLY on status/download/report. This grants no start, cancel, list,
// restore, schedule, or other application access. Never log or persist tokens.
export function backupContinuationOrAdmin(operation: "status" | "download" | "report", normalAuth: any) {
  return async (req: any, res: any, next: any) => {
    const token = req.headers[HEADER];
    if (token === undefined) return normalAuth(req, res, next);
    const claims = typeof token === "string"
      ? verifyBackupContinuation(token, process.env.JWT_SECRET ?? "") : null;
    const runId = operation === "report" ? req.body?.downloadRunId : req.params.runId;
    if (!claims || claims.runId !== runId || claims.source !== getBackupSourceEnvironment() ||
        (operation === "report" && (req.body?.source !== "manual" || !["success", "error"].includes(req.body?.status)))) {
      return res.status(401).json({ error: "Backup continuation expired or invalid. Sign in to reconnect this backup." });
    }
    try {
      await ensureBackupLiveStatusSchema();
      const result = await pool.query<{ requested_by_session_hash: string; delivery: unknown }>(
        "SELECT b.requested_by_session_hash, b.delivery FROM backup_live_status b JOIN users u ON u.id=b.requested_by_user_id WHERE b.run_id=$1 AND b.requested_by_user_id=$2 AND u.role='admin' AND u.is_active=true AND u.deleted_at IS NULL",
        [claims.runId, claims.ownerId],
      );
      const row = result.rows[0];
      if (!row?.requested_by_session_hash || (operation === "report" && !row.delivery)) {
        return res.status(404).json({ error: "Backup run not found." });
      }
      req.user = { id: claims.ownerId, role: "admin", isActive: true };
      req._platformAdminSessionVerified = true;
      req._backupContinuationSessionHash = row.requested_by_session_hash;
      return next();
    } catch {
      return res.status(503).json({ error: "Backup continuation temporarily unavailable. Retry this backup connection." });
    }
  };
}
