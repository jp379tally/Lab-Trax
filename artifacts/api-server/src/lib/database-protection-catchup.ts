import type { PoolClient } from "pg";
import { z } from "zod";

export const DATABASE_PROTECTION_CATCHUP_KEY = "backup_production_content_catchup_v1";

export type DatabaseProtectionTrigger = "interval" | "startup" | "catchup" | "manual";

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  pending: z.boolean(),
  deferred: z.boolean(),
  active: z.boolean(),
  activeCatchup: z.boolean(),
  generation: z.number().int().nonnegative(),
  claimedGeneration: z.number().int().nonnegative().nullable(),
  missedIntervals: z.number().int().nonnegative(),
  firstMissedAt: z.string().nullable(),
  lastMissedAt: z.string().nullable(),
  lastClaimedAt: z.string().nullable(),
  lastFinishedAt: z.string().nullable(),
  lastOutcome: z.enum(["none", "verified", "partial", "failed", "skipped"]).default("none"),
}).strict();

export type DatabaseProtectionCatchupState = z.infer<typeof stateSchema>;

export function emptyDatabaseProtectionCatchup(source: string): DatabaseProtectionCatchupState {
  return {
    schemaVersion: 1, source, pending: false, deferred: false, active: false,
    activeCatchup: false, generation: 0, claimedGeneration: null, missedIntervals: 0,
    firstMissedAt: null, lastMissedAt: null, lastClaimedAt: null,
    lastFinishedAt: null, lastOutcome: "none",
  };
}

function earlierTimestamp(existing: string | null, candidate: string): string {
  if (!existing) return candidate;
  return Date.parse(existing) <= Date.parse(candidate) ? existing : candidate;
}

function laterTimestamp(existing: string | null, candidate: string): string {
  if (!existing) return candidate;
  return Date.parse(existing) >= Date.parse(candidate) ? existing : candidate;
}

function parseState(value: string | undefined, source: string): DatabaseProtectionCatchupState {
  if (!value) return emptyDatabaseProtectionCatchup(source);
  const parsed = stateSchema.parse(JSON.parse(value));
  return parsed.source === source ? parsed : emptyDatabaseProtectionCatchup(source);
}

async function mutateState<T>(
  client: PoolClient,
  source: string,
  mutate: (current: DatabaseProtectionCatchupState) => { next: DatabaseProtectionCatchupState; result: T },
): Promise<T> {
  const initial = emptyDatabaseProtectionCatchup(source);
  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;
    await client.query(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING",
      [DATABASE_PROTECTION_CATCHUP_KEY, JSON.stringify(initial)],
    );
    const selected = await client.query<{ value: string }>(
      "SELECT value FROM system_settings WHERE key = $1 LIMIT 1 FOR UPDATE",
      [DATABASE_PROTECTION_CATCHUP_KEY],
    );
    const current = parseState(selected.rows[0]?.value, source);
    const { next, result } = mutate(current);
    await client.query(
      "UPDATE system_settings SET value = $2, updated_at = now() WHERE key = $1",
      [DATABASE_PROTECTION_CATCHUP_KEY, JSON.stringify(stateSchema.parse(next))],
    );
    await client.query("COMMIT");
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    }
    throw error;
  }
}

export async function recordDatabaseProtectionMissedInterval(
  client: PoolClient,
  source: string,
  at: Date = new Date(),
): Promise<DatabaseProtectionCatchupState> {
  return mutateState(client, source, current => {
    const timestamp = at.toISOString();
    const next = stateSchema.parse({
      ...current,
      pending: true,
      // If a catch-up itself spans another interval, preserve that miss for
      // the next scheduled tick instead of recursively chaining catch-ups.
      deferred: current.deferred || current.activeCatchup,
      generation: current.generation + 1,
      missedIntervals: current.missedIntervals + 1,
      // Concurrent workers may acquire the row lock out of timestamp order.
      // Preserve the chronological interval bounds, not lock-arrival order.
      firstMissedAt: current.pending ? earlierTimestamp(current.firstMissedAt, timestamp) : timestamp,
      lastMissedAt: current.pending ? laterTimestamp(current.lastMissedAt, timestamp) : timestamp,
    });
    return { next, result: next };
  });
}

export async function beginDatabaseProtectionAttempt(
  client: PoolClient,
  source: string,
  trigger: DatabaseProtectionTrigger,
  at: Date = new Date(),
): Promise<{ shouldRun: boolean; isCatchup: boolean; deferred: boolean }> {
  return mutateState<{ shouldRun: boolean; isCatchup: boolean; deferred: boolean }>(client, source, current => {
    if (trigger === "catchup" && (!current.pending || current.deferred)) {
      return { next: current, result: { shouldRun: false, isCatchup: false, deferred: current.deferred } };
    }
    const isCatchup = current.pending;
    const next = stateSchema.parse({
      ...current,
      // The shared advisory lock proves any prior active flag is stale.
      active: true,
      activeCatchup: isCatchup,
      // Keep the request durable until the attempt finishes. If the process
      // dies after claiming it, the next worker can safely retry it.
      pending: current.pending,
      deferred: current.deferred,
      claimedGeneration: isCatchup ? current.generation : current.claimedGeneration,
      lastClaimedAt: isCatchup ? at.toISOString() : current.lastClaimedAt,
    });
    return { next, result: { shouldRun: true, isCatchup, deferred: false } };
  });
}

export async function finishDatabaseProtectionAttempt(
  client: PoolClient,
  source: string,
  outcome: "verified" | "partial" | "failed" | "skipped",
  at: Date = new Date(),
): Promise<void> {
  await mutateState(client, source, current => {
    const catchupCompleted = current.activeCatchup &&
      (outcome === "verified" || outcome === "partial") &&
      current.claimedGeneration === current.generation;
    const newerMissedInterval = current.activeCatchup &&
      current.claimedGeneration !== current.generation;
    return {
      next: stateSchema.parse({
        ...current,
        active: false,
        activeCatchup: false,
        pending: catchupCompleted ? false : current.pending,
        deferred: current.activeCatchup
          ? !catchupCompleted && (outcome === "failed" || newerMissedInterval)
          : current.deferred,
        claimedGeneration: null,
        lastFinishedAt: at.toISOString(), lastOutcome: outcome,
      }),
      result: undefined,
    };
  });
}

export async function hasReadyDatabaseProtectionCatchup(
  client: PoolClient,
  source: string,
): Promise<boolean> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1 LIMIT 1",
    [DATABASE_PROTECTION_CATCHUP_KEY],
  );
  const state = parseState(result.rows[0]?.value, source);
  return state.pending && !state.deferred;
}

export async function readDatabaseProtectionCatchup(
  client: PoolClient,
  source: string,
): Promise<DatabaseProtectionCatchupState> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1 LIMIT 1",
    [DATABASE_PROTECTION_CATCHUP_KEY],
  );
  return parseState(result.rows[0]?.value, source);
}
