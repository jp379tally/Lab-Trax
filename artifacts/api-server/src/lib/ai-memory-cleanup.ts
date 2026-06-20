/**
 * Nightly cleanup for `ai_memory_candidates`.
 *
 * Every AI chat can propose pending memory candidates, and reviewed
 * (approved/rejected) rows are kept on purpose so the same thing is not
 * re-proposed. Left unchecked the table — and the admin review list — grows
 * forever. This job:
 *
 *   1. Prunes reviewed (approved/rejected) candidates older than a retention
 *      window (env AI_MEMORY_CANDIDATE_RETENTION_DAYS, mirrors the
 *      BACKUP_HISTORY_RETENTION_DAYS style; default 90 days).
 *   2. Caps pending candidates per lab (env
 *      AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB; default 500), dropping the
 *      oldest pending rows first so the review list stays manageable.
 *
 * De-dup behavior in ai-memory-learn (skip re-proposing a rejected key) is
 * preserved within the retention window: rejected rows only age out once they
 * are older than the retention window, after which re-proposing them is
 * acceptable.
 *
 * Non-fatal: failures are logged as warnings and swallowed so the daily job
 * keeps running.
 */
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, aiMemoryCandidates } from "@workspace/db";
import { logger } from "./logger";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AiMemoryCandidateCleanupConfig {
  /** Reviewed rows older than this many days are deleted. */
  retentionDays: number;
  /** Maximum pending rows kept per lab; oldest pending rows beyond this go. */
  maxPendingPerLab: number;
}

/**
 * Parse a positive integer, falling back to `dflt` for any missing, non-numeric,
 * or non-positive (< 1) value. This makes the behavior predictable: garbage and
 * out-of-range input always resolve to the documented default.
 */
function parsePositiveInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

/**
 * Parse the cleanup config from environment variables. Pure (no DB) so it is
 * easy to unit test. Missing, non-numeric, or non-positive values fall back to
 * the defaults (retention 90 days, 500 pending rows per lab).
 */
export function parseAiMemoryCandidateCleanupConfig(
  env: NodeJS.ProcessEnv = process.env,
): AiMemoryCandidateCleanupConfig {
  return {
    retentionDays: parsePositiveInt(env.AI_MEMORY_CANDIDATE_RETENTION_DAYS, 90),
    maxPendingPerLab: parsePositiveInt(
      env.AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB,
      500,
    ),
  };
}

export interface AiMemoryCandidateCleanupResult {
  reviewedDeleted: number;
  pendingDeleted: number;
}

/**
 * Prune old reviewed candidates and cap pending candidates per lab.
 * Returns the number of rows deleted in each category. Never throws.
 */
export async function cleanupAiMemoryCandidates(
  config: AiMemoryCandidateCleanupConfig = parseAiMemoryCandidateCleanupConfig(),
): Promise<AiMemoryCandidateCleanupResult> {
  const result: AiMemoryCandidateCleanupResult = {
    reviewedDeleted: 0,
    pendingDeleted: 0,
  };

  // 1. Days-based retention for reviewed (approved/rejected) rows. Use
  // reviewed_at when present, falling back to created_at so a reviewed row with
  // a missing timestamp still ages out instead of lingering forever.
  try {
    const cutoff = new Date(Date.now() - config.retentionDays * DAY_MS);
    const deleted = await db
      .delete(aiMemoryCandidates)
      .where(
        and(
          or(
            eq(aiMemoryCandidates.status, "approved"),
            eq(aiMemoryCandidates.status, "rejected"),
          ),
          lt(
            sql`coalesce(${aiMemoryCandidates.reviewedAt}, ${aiMemoryCandidates.createdAt})`,
            cutoff,
          ),
        ),
      )
      .returning({ id: aiMemoryCandidates.id });
    result.reviewedDeleted = deleted.length;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ai_memory_candidates reviewed-retention prune failed",
    );
  }

  // 2. Per-lab cap on pending rows: keep the newest N pending rows per lab,
  // delete the oldest beyond the cap. The id tie-breaker makes it deterministic
  // when created_at values match.
  try {
    const stale = await db
      .select({ id: aiMemoryCandidates.id })
      .from(aiMemoryCandidates)
      .where(
        sql`${aiMemoryCandidates.id} IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (
              PARTITION BY ${aiMemoryCandidates.labOrganizationId}
              ORDER BY ${aiMemoryCandidates.createdAt} DESC, ${aiMemoryCandidates.id} DESC
            ) AS rn
            FROM ${aiMemoryCandidates}
            WHERE ${aiMemoryCandidates.status} = 'pending'
          ) ranked
          WHERE ranked.rn > ${config.maxPendingPerLab}
        )`,
      );
    if (stale.length > 0) {
      await db.delete(aiMemoryCandidates).where(
        inArray(
          aiMemoryCandidates.id,
          stale.map((r) => r.id),
        ),
      );
      result.pendingDeleted = stale.length;
    }
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ai_memory_candidates pending-cap prune failed",
    );
  }

  if (result.reviewedDeleted > 0 || result.pendingDeleted > 0) {
    logger.info(
      {
        reviewedDeleted: result.reviewedDeleted,
        pendingDeleted: result.pendingDeleted,
        retentionDays: config.retentionDays,
        maxPendingPerLab: config.maxPendingPerLab,
      },
      "[ai-memory] Candidate cleanup pruned rows",
    );
  }

  return result;
}
