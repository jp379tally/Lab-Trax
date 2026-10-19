import { pool } from "@workspace/db";
import type { BackupLiveStatus } from "./backup-phase";

let schemaReady: Promise<void> | undefined;

export const BACKUP_LIVE_STATUS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS backup_live_status (
    run_id uuid PRIMARY KEY,
    state text NOT NULL CHECK (state IN (
      'running', 'awaiting_verification', 'completed', 'failed', 'stale'
    )),
    phase text NOT NULL,
    started_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE backup_live_status ADD COLUMN IF NOT EXISTS archive_evidence jsonb;
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
}

const ARCHIVE_EVIDENCE_KINDS = new Set(["complete-production", "complete-non-production"]);

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
  return {
    archiveKind: evidence.archiveKind as NonNullable<BackupLiveStatus["archiveEvidence"]>["archiveKind"],
    coverageVersion: evidence.coverageVersion as number,
    mediaFileCount: evidence.mediaFileCount as number,
    attachmentRowCount: evidence.attachmentRowCount as number,
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
  return {
    runId: row.runId,
    state: row.state,
    phase: row.phase,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : String(row.startedAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    elapsedMs: Number(row.elapsedMs),
    metrics,
    ...(archiveEvidence ? { archiveEvidence } : {}),
  };
}

export async function saveBackupLiveStatus(status: BackupLiveStatus): Promise<void> {
  await ensureBackupLiveStatusSchema();
  const archiveEvidence = asArchiveEvidence(status.archiveEvidence);
  await pool.query(
    `INSERT INTO backup_live_status
       (run_id, state, phase, started_at, updated_at, elapsed_ms, metrics, archive_evidence)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::bigint, $7::jsonb, $8::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET
       state = EXCLUDED.state,
       phase = EXCLUDED.phase,
       started_at = EXCLUDED.started_at,
       updated_at = EXCLUDED.updated_at,
       elapsed_ms = EXCLUDED.elapsed_ms,
       metrics = EXCLUDED.metrics,
       archive_evidence = COALESCE(EXCLUDED.archive_evidence, backup_live_status.archive_evidence)`,
    [
      status.runId,
      status.state,
      status.phase,
      status.startedAt,
      status.updatedAt,
      status.elapsedMs,
      JSON.stringify(status.metrics),
      archiveEvidence ? JSON.stringify(archiveEvidence) : null,
    ],
  );
}

export async function readBackupLiveStatus(runId: string): Promise<BackupLiveStatus | undefined> {
  await ensureBackupLiveStatusSchema();
  const result = await pool.query<BackupLiveStatusRow>(
    `SELECT run_id AS "runId", state, phase, started_at AS "startedAt",
            updated_at AS "updatedAt", elapsed_ms AS "elapsedMs", metrics,
            archive_evidence AS "archiveEvidence"
       FROM backup_live_status
      WHERE run_id = $1::uuid`,
    [runId],
  );
  return asStatus(result.rows[0]);
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
      WHERE state IN ('running', 'awaiting_verification')
        AND updated_at < $1::timestamptz - ($2::double precision * interval '1 millisecond')`,
    [nowIso, staleRunMs],
  );
  await pool.query(
    `DELETE FROM backup_live_status
      WHERE state NOT IN ('running', 'awaiting_verification')
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
