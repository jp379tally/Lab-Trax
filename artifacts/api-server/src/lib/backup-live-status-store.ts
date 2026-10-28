import { pool } from "@workspace/db";
import type { BackupLiveStatus } from "./backup-phase";

let schemaReady: Promise<void> | undefined;

export const BACKUP_LIVE_STATUS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS backup_live_status (
    run_id uuid PRIMARY KEY,
    state text NOT NULL CHECK (state IN (
      'running', 'awaiting_verification', 'finalizing', 'completed', 'failed', 'cancelled', 'stale'
    )),
    phase text NOT NULL,
    started_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS archive_evidence jsonb;
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS request_fingerprint text;
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS requested_by_user_id text;
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS requested_by_session_hash text;
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS delivery jsonb;
  ALTER TABLE backup_live_status DROP CONSTRAINT IF EXISTS backup_live_status_state_check;
  ALTER TABLE backup_live_status ADD CONSTRAINT backup_live_status_state_check CHECK (state IN (
    'running', 'awaiting_verification', 'finalizing', 'completed', 'failed', 'cancelled', 'stale'
  ));
  CREATE INDEX IF NOT EXISTS backup_live_status_created_at_idx
    ON backup_live_status (created_at);
`;

export async function ensureBackupLiveStatusSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(BACKUP_LIVE_STATUS_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
  }
  await schemaReady;
}

interface BackupLiveStatusRow {
  runId: string;
  state: BackupLiveStatus["state"];
  phase: string;
  startedAt: string | Date;
  updatedAt: string | Date;
  elapsedMs: string | number;
  metrics: Record<string, number> | string;
  archiveEvidence?: unknown;
  delivery?: unknown;
  requestedByUserId?: string | null;
}

const ARCHIVE_EVIDENCE_KINDS = new Set(["complete-production", "complete-non-production", "partial-production", "partial-non-production", "database-only"]);

/** Only a fully formed complete-archive record may vouch for a deferred run. */
function asArchiveEvidence(value: unknown): BackupLiveStatus["archiveEvidence"] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const evidence = parsed as Record<string, unknown>;
  const counts = [evidence.coverageVersion, evidence.mediaFileCount, evidence.attachmentRowCount];
  if (typeof evidence.archiveKind !== "string" || !ARCHIVE_EVIDENCE_KINDS.has(evidence.archiveKind) ||
    !counts.every(count => Number.isSafeInteger(count) && (count as number) >= 0)) {
    return undefined;
  }
  if (evidence.archiveKind.startsWith("partial-") &&
      (!Number.isSafeInteger(evidence.missingFileCount) || (evidence.missingFileCount as number) <= 0)) return undefined;
  return {
    archiveKind: evidence.archiveKind as NonNullable<BackupLiveStatus["archiveEvidence"]>["archiveKind"],
    coverageVersion: evidence.coverageVersion as number,
    mediaFileCount: evidence.mediaFileCount as number,
    attachmentRowCount: evidence.attachmentRowCount as number,
    ...(Number.isSafeInteger(evidence.missingFileCount) && (evidence.missingFileCount as number) >= 0
      ? { missingFileCount: evidence.missingFileCount as number } : {}),
  };
}

function asStatus(row: BackupLiveStatusRow | undefined): BackupLiveStatus | undefined {
  if (!row) return undefined;
  let metrics: Record<string, number> = {};
  if (typeof row.metrics === "string") {
    try {
      metrics = JSON.parse(row.metrics) as Record<string, number>;
    } catch {
      metrics = {};
    }
  } else if (row.metrics && typeof row.metrics === "object") {
    metrics = row.metrics;
  }
  const archiveEvidence = asArchiveEvidence(row.archiveEvidence);
  const delivery = asDelivery(row.delivery);
  return {
    runId: row.runId,
    state: row.state,
    phase: row.phase,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : String(row.startedAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    elapsedMs: Number(row.elapsedMs),
    metrics,
    ...(archiveEvidence ? { archiveEvidence } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

function asDelivery(value: unknown): BackupLiveStatus["delivery"] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const item = parsed as Record<string, unknown>;
  if (typeof item.fileName !== "string" || item.fileName.length > 255 ||
      !Number.isSafeInteger(item.size) || (item.size as number) <= 0 ||
      !["complete-production", "complete-non-production", "partial-production",
        "partial-non-production", "database-only"].includes(String(item.archiveKind)) ||
      !["production", "non-production"].includes(String(item.sourceEnvironment)) ||
      typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))) return undefined;
  return {
    fileName: item.fileName,
    size: item.size as number,
    archiveKind: item.archiveKind as NonNullable<BackupLiveStatus["delivery"]>["archiveKind"],
    sourceEnvironment: item.sourceEnvironment as "production" | "non-production",
    expiresAt: item.expiresAt,
  };
}

export async function saveBackupLiveStatus(status: BackupLiveStatus): Promise<void> {
  await ensureBackupLiveStatusSchema();
  const archiveEvidence = asArchiveEvidence(status.archiveEvidence);
  const delivery = asDelivery(status.delivery);
  await pool.query(
    `INSERT INTO backup_live_status
       (run_id, state, phase, started_at, updated_at, elapsed_ms, metrics, archive_evidence, delivery)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::bigint, $7::jsonb, $8::jsonb, $9::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET
       state = EXCLUDED.state,
       phase = EXCLUDED.phase,
       started_at = EXCLUDED.started_at,
       updated_at = EXCLUDED.updated_at,
       elapsed_ms = EXCLUDED.elapsed_ms,
       metrics = EXCLUDED.metrics,
       archive_evidence = COALESCE(EXCLUDED.archive_evidence, backup_live_status.archive_evidence),
       delivery = COALESCE(EXCLUDED.delivery, backup_live_status.delivery)
     WHERE backup_live_status.state NOT IN ('completed', 'failed', 'cancelled', 'stale')`,
    [
      status.runId,
      status.state,
      status.phase,
      status.startedAt,
      status.updatedAt,
      status.elapsedMs,
      JSON.stringify(status.metrics),
      archiveEvidence ? JSON.stringify(archiveEvidence) : null,
      delivery ? JSON.stringify(delivery) : null,
    ],
  );
}

export async function readBackupLiveStatus(runId: string): Promise<BackupLiveStatus | undefined> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query<BackupLiveStatusRow>(
    `SELECT run_id AS "runId", state, phase, started_at AS "startedAt",
            updated_at AS "updatedAt", elapsed_ms AS "elapsedMs", metrics,
            archive_evidence AS "archiveEvidence", delivery
       FROM backup_live_status
      WHERE run_id = $1::uuid`,
    [runId],
  );
  return asStatus(result.rows[0]);
}

/** A stage may be reclaimed only after its producer has stopped running. */
export async function isBackupRunActive(runId: string): Promise<boolean> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query(
    `SELECT 1 FROM backup_live_status
      WHERE run_id = $1::uuid AND state IN ('running', 'finalizing')
      LIMIT 1`,
    [runId],
  );
  return Boolean(result.rowCount);
}

/**
 * Null means a legacy/scheduled run with no manual owner; false means this
 * manual run belongs to a different user or authenticated session.
 */
export async function manualBackupRunAccessibleTo(
  runId: string,
  userId: string | null,
  sessionHash: string | null,
): Promise<boolean | null> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query<{
    requestedByUserId: string | null;
    requestedBySessionHash: string | null;
  }>(
    `SELECT requested_by_user_id AS "requestedByUserId",
            requested_by_session_hash AS "requestedBySessionHash"
       FROM backup_live_status
      WHERE run_id = $1::uuid`,
    [runId],
  );
  const owner = result.rows[0];
  if (!owner || (!owner.requestedByUserId && !owner.requestedBySessionHash)) return null;
  return Boolean(sessionHash &&
    (owner.requestedByUserId ?? null) === userId &&
    owner.requestedBySessionHash === sessionHash);
}

/** Explicitly reconnect only the authenticated owner of a manual run.
 * Status/download reads still require the owning session. Shared-secret
 * sessions cannot take over a user-owned run or another secret's run.
 */
export async function reconnectManualBackupSession(
  runId: string, userId: string | null, sessionHash: string,
): Promise<"reconnected" | "not_found" | "forbidden"> {
  await ensureBackupLiveStatusSchema();
  if (userId) {
    const changed = await pool.query(
      "UPDATE backup_live_status SET requested_by_session_hash = $3 WHERE run_id = $1::uuid AND requested_by_user_id = $2 RETURNING run_id",
      [runId, userId, sessionHash],
    );
    if (changed.rowCount) return "reconnected";
  }
  const existing = await pool.query<{
    requested_by_user_id: string | null; requested_by_session_hash: string | null;
  }>("SELECT requested_by_user_id, requested_by_session_hash FROM backup_live_status WHERE run_id = $1::uuid", [runId]);
  const owner = existing.rows[0];
  if (!owner) return "not_found";
  return (owner.requested_by_user_id ?? null) === userId &&
    owner.requested_by_session_hash === sessionHash ? "reconnected" : "forbidden";
}

/** Atomic cross-worker claim. Phase updates never overwrite this fingerprint. */
export async function claimManualBackupRun(
  runId: string,
  fingerprint: string,
  userId: string | null,
  sessionHash: string | null,
): Promise<boolean> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query(
    `INSERT INTO backup_live_status
        (run_id, state, phase, started_at, updated_at, elapsed_ms, metrics, request_fingerprint,
         requested_by_user_id, requested_by_session_hash)
      SELECT $1::uuid, 'running', 'starting backup', now(), now(), 0, '{}'::jsonb, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM backup_runs WHERE download_run_id = $1::text)
     ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
     [runId, fingerprint, userId, sessionHash],
  );
  if (result.rowCount) return true;
  const existing = await pool.query(
    `SELECT request_fingerprint, requested_by_user_id, requested_by_session_hash
       FROM backup_live_status WHERE run_id = $1::uuid`,
    [runId],
  );
  if (existing.rows[0]?.request_fingerprint !== fingerprint ||
      (existing.rows[0]?.requested_by_user_id ?? null) !== userId ||
      (existing.rows[0]?.requested_by_session_hash ?? null) !== sessionHash) {
    throw Object.assign(new Error("This run ID belongs to an existing or different backup request. Use its status/history."), { status: 409 });
  }
  return false;
}

/** Atomically cancel only an active manual run owned by this authenticated user. */
export async function cancelManualBackupRun(
  runId: string,
  userId: string | null,
  sessionHash: string,
): Promise<"cancelled" | "terminal" | "not_found"> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query(
    `UPDATE backup_live_status
        SET state = 'cancelled', phase = 'backup cancelled', updated_at = now()
      WHERE run_id = $1::uuid AND requested_by_user_id IS NOT DISTINCT FROM $2
        AND requested_by_session_hash = $3
        AND state IN ('running', 'awaiting_verification')
      RETURNING run_id`,
    [runId, userId, sessionHash],
  );
  if (result.rowCount) return "cancelled";
  const existing = await pool.query(
    `SELECT state FROM backup_live_status
      WHERE run_id = $1::uuid AND requested_by_user_id IS NOT DISTINCT FROM $2
        AND requested_by_session_hash = $3`,
    [runId, userId, sessionHash],
  );
  return existing.rowCount ? "terminal" : "not_found";
}

/** Claim the report/finalization race before success can be written to history. */
export async function claimManualBackupFinalization(
  runId: string,
  userId: string | null,
  sessionHash: string,
): Promise<boolean> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query(
    `UPDATE backup_live_status
        SET state = 'finalizing', phase = 'desktop verification', updated_at = now()
      WHERE run_id = $1::uuid AND requested_by_user_id IS NOT DISTINCT FROM $2
        AND requested_by_session_hash = $3
        AND state = 'awaiting_verification'
      RETURNING run_id`,
    [runId, userId, sessionHash],
  );
  return Boolean(result.rowCount);
}

export async function pruneBackupLiveStatuses(
  now: number,
  staleRunMs: number,
  liveStatusTtlMs: number,
  maxLiveRuns: number,
): Promise<void> {
  await ensureBackupLiveStatusSchema();
  const nowIso = new Date(now).toISOString();
  await pool.query(
    `UPDATE backup_live_status
        SET state = 'stale', phase = 'backup failed', updated_at = $1::timestamptz
      WHERE (state IN ('running', 'finalizing') OR
             (state = 'awaiting_verification' AND
               (delivery IS NULL OR (delivery->>'expiresAt')::timestamptz <= $1::timestamptz)))
        AND updated_at < $1::timestamptz - ($2::double precision * interval '1 millisecond')`,
    [nowIso, staleRunMs],
  );
  await pool.query(
    `DELETE FROM backup_live_status
      WHERE state NOT IN ('running', 'awaiting_verification', 'finalizing')
        AND updated_at < $1::timestamptz - ($2::double precision * interval '1 millisecond')`,
    [nowIso, liveStatusTtlMs],
  );
  await pool.query(
    `DELETE FROM backup_live_status
      WHERE run_id IN (
        SELECT run_id FROM backup_live_status
         ORDER BY created_at DESC, run_id DESC
         OFFSET $1
      )`,
    [maxLiveRuns],
  );
}
