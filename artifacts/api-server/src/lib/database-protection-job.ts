import { assertExternalProductionBinding } from "./external-production-backup";
import { createHash } from "node:crypto";
import { db, pool, systemSettings } from "@workspace/db";
import { lockMediaCheckpoint, unlockMediaCheckpoint } from "./production-media-mutation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { PoolClient } from "pg";
import { getOneDriveBackupFolder, isProductionDeployment } from "./onedrive";
import { databaseOneDriveStore } from "./database-protection-onedrive";
import { databaseGoogleDriveStore, getGoogleDriveBackupFolder } from "./google-drive";
import { RecordRecoveryError, type RecordInventory } from "./postgres-record-delta";
import { isRecordDatabaseCapture, type RecordDatabaseCapture } from "./postgres-record-protection";
import { latestProductionPoint, protectProduction, type ProductionCapture } from "./production-content-protection";
import {
  DATABASE_PROTECTION_RETENTION_GRACE_HOURS,
  DATABASE_PROTECTION_RETENTION_POLICY,
  planDatabaseRetentionSweep,
  DatabaseProtectionError,
  type DatabaseCodec,
  type DatabaseDumpSource,
  type DatabaseObjectStore,
  type DatabaseRetentionPolicy,
} from "./database-protection";
import { verifyProductionBackupSource } from "./backup-production-source";
import { logger } from "./logger";
import { backupErrorMessage } from "./backup-error-copy";
import {
  beginDatabaseProtectionAttempt,
  finishDatabaseProtectionAttempt,
  hasReadyDatabaseProtectionCatchup,
  readDatabaseProtectionCatchup,
  recordDatabaseProtectionMissedInterval,
  type DatabaseProtectionTrigger,
} from "./database-protection-catchup";

/** A checked-out client has no pool idle-error handler. Keep its error event
 * handled and cancel provider work immediately if the advisory-lock session dies. */
function guardProtectionClient(client: PoolClient, upstream?: AbortSignal) {
  const lost = new AbortController();
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure ??= error;
    lost.abort(failure);
  };
  client.on("error", onError);
  const signal = upstream ? AbortSignal.any([upstream, lost.signal]) : lost.signal;
  return {
    signal,
    get failure() { return failure; },
    fail: onError,
    assert() { signal.throwIfAborted(); },
    release() {
      try { if (failure) client.release(true); else client.release(); }
      finally { client.removeListener("error", onError); }
    },
  };
}

/** Record/media capture uses other connections, so its progress does not keep
 * the exported-snapshot owner active. Keep that session alive only while its
 * snapshot is needed; the caller's deadline still bounds the capture itself. */
function keepProtectionSnapshotAlive(client: PoolClient, lease: ReturnType<typeof guardProtectionClient>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const halt = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped || lease.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || lease.signal.aborted) return;
      pending = Promise.resolve().then(async () => {
        if (stopped || lease.signal.aborted) return;
        // Match the coordinator pool's 30-second statement bound on the
        // client too, so a lost transport cannot make cleanup wait forever.
        const query = { text: "SELECT 1", query_timeout: 30_000 };
        await client.query(query);
      }).catch(error => {
        // A rejected query need not emit a client error event. Fence provider
        // writes and cancel capture through the same lost-lease signal.
        lease.fail(error instanceof Error ? error : new Error("Production backup coordinator heartbeat failed."));
      }).finally(schedule);
    }, 30_000);
    timer.unref?.();
  };
  lease.signal.addEventListener("abort", halt, { once: true });
  schedule();
  return async () => {
    // Stop synchronously before draining: neither a queued tick nor the
    // current query's completion may enqueue work after rollback/release.
    halt();
    lease.signal.removeEventListener("abort", halt);
    await pending;
  };
}

const STATUS_KEY = "backup_production_content_protection_v1";
export type ProductionCloudDestination = "onedrive" | "google-drive";
function protectionStatusKey(destination: ProductionCloudDestination): string {
  return destination === "onedrive" ? STATUS_KEY : `${STATUS_KEY}:google-drive`;
}
/** Bind a run to its chosen destination before any snapshot or provider I/O. */
export async function getProductionBackupDestination(client?: PoolClient): Promise<ProductionCloudDestination> {
  const routingKey = "backup_schedule_routing_version";
  const routing = client
    ? (await client.query<{ value: string }>("SELECT value FROM system_settings WHERE key = $1 LIMIT 1", [routingKey])).rows
    : await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, routingKey)).limit(1);
  if (routing[0]?.value !== "2") return "onedrive";
  const key = "backup_schedule_destination";
  const rows = client
    ? (await client.query<{ value: string }>("SELECT value FROM system_settings WHERE key = $1 LIMIT 1", [key])).rows
    : await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return rows[0]?.value === "google-drive" ? "google-drive" : "onedrive";
}
export const DATABASE_RETENTION_POLICY_KEY = "backup_production_database_retention_policy_v1";
const DATABASE_RETENTION_PLAN_KEY = "backup_production_database_retention_plan_v1";
const retentionConfigSchema = z.object({
  enabled: z.boolean(),
  keepAllWithinHours: z.number().int().min(1).max(24 * 90),
  keepHourlyWithinDays: z.number().int().min(1).max(365),
  keepDailyWithinDays: z.number().int().min(1).max(3650),
  safetyGraceHours: z.number().int().min(DATABASE_PROTECTION_RETENTION_GRACE_HOURS).max(24 * 30),
  approvedAt: z.string().datetime().nullable(),
  approvedBy: z.string().min(1).max(200).nullable(),
}).strict();
const retentionPlanSchema = z.object({
  version: z.literal(1),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  state: z.enum(["planned", "deleting", "complete", "paused", "failed"]),
  remaining: z.array(z.string().regex(/^(?:chunk-[a-f0-9]{64}|(?:point|verified)-[0-9]{13}-[a-f0-9-]{36})\.enc$/)).max(200_000),
  deletedCount: z.number().int().nonnegative(),
  error: z.string().max(500).nullable(),
}).strict();
export type DatabaseProtectionRetentionConfig = z.infer<typeof retentionConfigSchema>;
type DatabaseRetentionPlan = z.infer<typeof retentionPlanSchema>;
const defaultRetentionConfig: DatabaseProtectionRetentionConfig = {
  enabled: false,
  keepAllWithinHours: DATABASE_PROTECTION_RETENTION_POLICY.keepAllWithinHours,
  keepHourlyWithinDays: DATABASE_PROTECTION_RETENTION_POLICY.keepHourlyWithinDays,
  keepDailyWithinDays: DATABASE_PROTECTION_RETENTION_POLICY.keepDailyWithinDays,
  safetyGraceHours: DATABASE_PROTECTION_RETENTION_GRACE_HOURS,
  approvedAt: null,
  approvedBy: null,
};
const retentionPolicy = (config: DatabaseProtectionRetentionConfig): DatabaseRetentionPolicy => ({
  keepAllWithinHours: config.keepAllWithinHours,
  keepHourlyWithinDays: config.keepHourlyWithinDays,
  keepDailyWithinDays: config.keepDailyWithinDays,
  safetyGraceHours: config.safetyGraceHours,
});
const statusSchema = z.object({
  destination: z.enum(["onedrive", "google-drive"]).default("onedrive"),
  mode: z.enum(["incremental-storage-fresh-export", "incremental-records-and-media"]),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal("production-database-and-media"),
  coverage: z.enum(["complete", "partial"]).default("partial"),
  mediaFiles: z.number().int().nonnegative().default(0),
  mediaBytes: z.number().int().nonnegative().default(0),
  missingFiles: z.number().int().nonnegative().default(0),
  state: z.enum(["not_started", "running", "verified", "partial", "skipped_busy", "failed"]),
  stage: z.string(),
  lastAttemptAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  recoveryPointAt: z.string().nullable(),
  lastDestinationCheckAt: z.string().nullable(),
  point: z.string().nullable(),
  lastCompletePoint: z.string().nullable().default(null),
  dumpBytes: z.number().nonnegative(),
  newChunks: z.number().nonnegative(),
  newBytes: z.number().nonnegative(),
  reusedChunks: z.number().nonnegative(),
  error: z.string().nullable(),
});
export type DatabaseProtectionStatus = z.infer<typeof statusSchema>;
export function databaseProtectionVerificationError(status: DatabaseProtectionStatus, nowMs: number, intervalMinutes = 15): string | null {
  if (status.state === "failed") return status.error ?? "Database protection failed.";
  if (status.state === "partial" || (status.point && status.coverage === "partial")) {
    return `${status.error ?? `Production records/readable media verified with ${status.missingFiles} missing originals`}; not a complete recovery point.`;
  }
  if (status.point && (!status.lastDestinationCheckAt ||
      nowMs - Date.parse(status.lastDestinationCheckAt) > Math.max(20, intervalMinutes + 5) * 60_000)) {
    return "Production destination dependency verification is overdue; current protection cannot be confirmed.";
  }
  return null;
}
function emptyStatus(destination: ProductionCloudDestination = "onedrive"): DatabaseProtectionStatus {
  return {
    destination,
    mode: "incremental-records-and-media", scope: "production-database-and-media",
    coverage: "partial", mediaFiles: 0, mediaBytes: 0, missingFiles: 0,
    source: databaseProtectionSource(),
    state: "not_started", stage: "No database recovery point verified",
    lastAttemptAt: null, lastVerifiedAt: null, recoveryPointAt: null, lastDestinationCheckAt: null,
    point: null, lastCompletePoint: null,
    dumpBytes: 0, newChunks: 0, newBytes: 0, reusedChunks: 0, error: null,
  };
}
export async function getDatabaseProtectionStatus(client?: PoolClient, destination?: ProductionCloudDestination): Promise<DatabaseProtectionStatus> {
  destination ??= await getProductionBackupDestination(client);
  const key = protectionStatusKey(destination);
  const rows = client
    ? (await client.query<{ value: string }>("SELECT value FROM system_settings WHERE key = $1 LIMIT 1", [key])).rows
    : await db.select({ value: systemSettings.value }).from(systemSettings)
      .where(eq(systemSettings.key, key)).limit(1);
  try {
    const parsed = statusSchema.parse(JSON.parse(rows[0]?.value ?? "null"));
    if (parsed.source !== databaseProtectionSource() || parsed.destination !== destination) return emptyStatus(destination);
    // Before the partial state existed, partial points were persisted as
    // "verified" and could advance lastVerifiedAt. Those timestamps cannot be
    // trusted as complete protection; fail closed until a complete point is
    // verified again.
    if (parsed.coverage === "partial" && parsed.state === "verified") {
      return { ...parsed, state: "partial", lastVerifiedAt: null, lastCompletePoint: null };
    }
    return parsed;
  }
  catch { return emptyStatus(destination); }
}
async function save(status: DatabaseProtectionStatus, client?: PoolClient): Promise<void> {
  const value = JSON.stringify(statusSchema.parse(status));
  const key = protectionStatusKey(status.destination);
  if (client) {
    await client.query("INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, value]);
  } else {
    await db.insert(systemSettings).values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
  }
}
export function databaseProtectionSource(): string {
  const url = new URL(process.env.DATABASE_URL!);
  // Never logs the URL, account or database name.
  return createHash("sha256").update(`production:${url.hostname}:${url.port || "5432"}${url.pathname}`).digest("hex");
}
export function productionDatabaseStore(signal?: AbortSignal, destination: ProductionCloudDestination = "onedrive") {
  const folder = destination === "google-drive" ? getGoogleDriveBackupFolder() : getOneDriveBackupFolder();
  const factory = destination === "google-drive" ? databaseGoogleDriveStore : databaseOneDriveStore;
  return factory(`${folder}/production-content-v1/${databaseProtectionSource()}`, signal);
}
export function productionContentStores(signal?: AbortSignal, destination: ProductionCloudDestination = "onedrive", externalProduction = false) {
  const folder = externalProduction ? "Apps/LabTrax Backups" : destination === "google-drive" ? getGoogleDriveBackupFolder() : getOneDriveBackupFolder();
  const factory = destination === "google-drive" ? databaseGoogleDriveStore : databaseOneDriveStore;
  return {
    store: externalProduction ? factory(folder + "/production-content-v1/" + databaseProtectionSource(), signal) : productionDatabaseStore(signal, destination),
    databaseStore: factory(`${folder}/production-content-v1/${databaseProtectionSource()}/database`, signal),
  };
}
async function readSetting(key: string): Promise<string | null> {
  const rows = await db.select({ value: systemSettings.value }).from(systemSettings)
    .where(eq(systemSettings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}
async function writeSetting(key: string, value: string): Promise<void> {
  await db.insert(systemSettings).values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}
export async function getDatabaseProtectionRetentionConfig(): Promise<DatabaseProtectionRetentionConfig> {
  try {
    const parsed = retentionConfigSchema.parse(JSON.parse((await readSetting(DATABASE_RETENTION_POLICY_KEY)) ?? "null"));
    return parsed;
  } catch {
    // Corrupt or legacy settings must never silently turn cleanup on.
    return { ...defaultRetentionConfig };
  }
}
export async function setDatabaseProtectionRetentionConfig(
  input: { enabled: boolean; keepAllWithinHours: number; keepHourlyWithinDays: number;
    keepDailyWithinDays: number; safetyGraceHours: number },
  approvedBy: string | null,
): Promise<DatabaseProtectionRetentionConfig> {
  const enabled = input.enabled;
  if (enabled && !approvedBy) throw new DatabaseProtectionError("A signed-in platform administrator must approve database retention.");
  const config = retentionConfigSchema.parse({
    ...input,
    enabled,
    approvedAt: enabled ? new Date().toISOString() : null,
    approvedBy: enabled ? approvedBy : null,
  });
  const lock = await pool.connect();
  let held = false;
  try {
    held = (await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(80451, 15001) AS held")).rows[0]?.held === true;
    if (!held) throw new DatabaseProtectionError("Database protection is active. Retry the retention change after it finishes.");
    await writeSetting(DATABASE_RETENTION_POLICY_KEY, JSON.stringify(config));
    return config;
  } finally {
    try { if (held) await lock.query("SELECT pg_advisory_unlock(80451, 15001)"); }
    finally { lock.release(); }
  }
}
async function getDatabaseRetentionPlan(): Promise<DatabaseRetentionPlan | null> {
  try {
    const raw = await readSetting(DATABASE_RETENTION_PLAN_KEY);
    return raw ? retentionPlanSchema.parse(JSON.parse(raw)) : null;
  } catch {
    // An unreadable deletion plan is never resumed. A fresh complete mark pass
    // must be written before any destination operation.
    return null;
  }
}
async function saveDatabaseRetentionPlan(plan: DatabaseRetentionPlan): Promise<void> {
  await writeSetting(DATABASE_RETENTION_PLAN_KEY, JSON.stringify(retentionPlanSchema.parse(plan)));
}

/**
 * Called only while the shared production protection advisory lock is held.
 * Plans are durable, but every invocation rebuilds reachability before it
 * resumes. A crash after remote deletion is safe because deletion is
 * idempotent and the same object remains at the head of the persisted queue.
 */
export async function runDatabaseProtectionRetention(options: {
  codec: DatabaseCodec; store?: DatabaseObjectStore; signal?: AbortSignal; now?: Date;
}): Promise<void> {
  const config = await getDatabaseProtectionRetentionConfig();
  if (!config.enabled || !config.approvedAt || !config.approvedBy) return;
  const source = databaseProtectionSource();
  // Database-only approval does not authorize thinning full records/media
  // recovery roots or the database points those roots reference.
  const store = options.store ?? databaseOneDriveStore(
    `${getOneDriveBackupFolder()}/database-protection-v1/${source}`, options.signal,
  );
  options.signal?.throwIfAborted();
  const fresh = await planDatabaseRetentionSweep({
    store, codec: options.codec, source, policy: retentionPolicy(config), now: options.now,
  });
  const prior = await getDatabaseRetentionPlan();
  // Reachability is rebuilt before resuming; stale planned names never get
  // precedence over the current marker-first dependency-safe ordering.
  const candidates = fresh.candidates;
  let plan: DatabaseRetentionPlan = {
    version: 1, source, createdAt: prior?.source === source ? prior.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(), state: candidates.length ? "planned" : "complete",
    remaining: candidates, deletedCount: prior?.source === source ? prior.deletedCount : 0, error: null,
  };
  await saveDatabaseRetentionPlan(plan);
  const candidatesAtStart = new Set(fresh.candidates);
  const maxDeletesPerRun = 50;
  let processed = 0;
  while (plan.remaining.length && processed < maxDeletesPerRun) {
    options.signal?.throwIfAborted();
    const [name, ...rest] = plan.remaining;
    plan = { ...plan, updatedAt: new Date().toISOString(), state: "deleting", remaining: plan.remaining, error: null };
    await saveDatabaseRetentionPlan(plan);
    try {
      // A name from a stale prior plan can never override the current mark set.
      if (candidatesAtStart.has(name!)) {
        await store.delete(name!);
        const after = new Set((await store.list()).map(object => object.name));
        if (after.has(name!)) throw new Error("Destination still lists a database object after deletion.");
        plan = { ...plan, remaining: rest, deletedCount: plan.deletedCount + 1 };
      } else {
        plan = { ...plan, remaining: rest };
      }
      processed++;
      plan = { ...plan, updatedAt: new Date().toISOString(),
        state: plan.remaining.length ? "planned" : "complete", error: null };
      await saveDatabaseRetentionPlan(plan);
    } catch (error) {
      plan = {
        ...plan, updatedAt: new Date().toISOString(), state: "failed",
        error: "Destination deletion failed; the planned object remains queued for retry.",
      };
      await saveDatabaseRetentionPlan(plan);
      throw error;
    }
  }
}
export async function getDatabaseProtectionRetentionStatus(): Promise<{
  state: DatabaseRetentionPlan["state"] | "disabled" | "not_started";
  pendingObjects: number;
  deletedObjects: number;
  lastUpdatedAt: string | null;
  error: string | null;
}> {
  const config = await getDatabaseProtectionRetentionConfig();
  const plan = await getDatabaseRetentionPlan();
  return {
    state: !config.enabled ? "disabled" : plan?.source === databaseProtectionSource() ? plan.state : "not_started",
    pendingObjects: plan?.source === databaseProtectionSource() ? plan.remaining.length : 0,
    deletedObjects: plan?.source === databaseProtectionSource() ? plan.deletedCount : 0,
    lastUpdatedAt: plan?.source === databaseProtectionSource() ? plan.updatedAt : null,
    error: plan?.source === databaseProtectionSource() ? plan.error : null,
  };
}
/** A manual/full backup owns the local slot; never cancel it or call this a failed capture. */
export async function noteDatabaseProtectionBusy(): Promise<void> {
  const client = await pool.connect();
  let transaction = false;
  try {
    const now = new Date();
    const destination = await getProductionBackupDestination(client);
    const key = protectionStatusKey(destination);
    await recordDatabaseProtectionMissedInterval(client, databaseProtectionSource(), now);
    await client.query("BEGIN");
    transaction = true;
    const skipped = {
      ...emptyStatus(destination),
      state: "skipped_busy" as const,
      stage: "Existing backup is active; interval skipped and one catch-up queued",
      lastAttemptAt: now.toISOString(),
    };
    await client.query(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING",
      [key, JSON.stringify(skipped)],
    );
    await client.query(
      "SELECT value FROM system_settings WHERE key = $1 LIMIT 1 FOR UPDATE",
      [key],
    );
    const status = await getDatabaseProtectionStatus(client, destination);
    await save({
      ...status,
      state: "skipped_busy",
      stage: "Existing backup is active; interval skipped and one catch-up queued",
      lastAttemptAt: now.toISOString(),
    }, client);
    await client.query("COMMIT");
    transaction = false;
  } catch (error) {
    if (transaction) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function runDatabaseProtectionJob(options: {
  externalProductionSourceRevision?: string;
  codec: DatabaseCodec;
  capture: (snapshot: string, previousJournalPosition: string | null, onMediaPinned: () => Promise<void>,
    previousRecords: RecordInventory | null | undefined, signal: AbortSignal) => Promise<DatabaseDumpSource | RecordDatabaseCapture> | DatabaseDumpSource | RecordDatabaseCapture;
  captureMedia: ProductionCapture["captureMedia"];
  signal?: AbortSignal;
  trigger?: DatabaseProtectionTrigger;
  destination?: ProductionCloudDestination;
  intervalMinutes?: number;
}): Promise<DatabaseProtectionStatus> {
  const externalProduction = assertExternalProductionBinding(options.externalProductionSourceRevision);
  if (externalProduction && options.destination !== "onedrive") throw new Error("External production bootstrap requires OneDrive.");
  if (!isProductionDeployment() && !externalProduction) throw new Error("Routine database protection runs only on the connected production server.");
  const lock = await pool.connect();
  const lease = guardProtectionClient(lock, options.signal);
  options = { ...options, signal: lease.signal };
  const trigger = options.trigger ?? "interval";
  let destination = options.destination ?? "onedrive";
  const intervalMinutes = options.intervalMinutes ?? 15;
  let held = false, transaction = false, attemptActive = false, mediaLocked = false;
  let stopSnapshotHeartbeat = async () => {};
  const releaseMediaBoundary = async () => {
    if (mediaLocked) {
      if (lease.failure) throw lease.failure;
      await unlockMediaCheckpoint(lock); mediaLocked = false;
    }
  };
  let status = emptyStatus(destination);
  let attemptOutcome: "verified" | "partial" | "failed" | "skipped" = "skipped";
  try {
    if (!options.destination) destination = await getProductionBackupDestination(lock);
    status = await getDatabaseProtectionStatus(lock, destination);
    const claimed = await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(80451, 15001) AS held");
    held = claimed.rows[0]?.held === true;
    if (!held) {
      logger.info("[backup] Production database interval skipped/busy; another worker owns protection.");
      if (trigger !== "catchup") await noteDatabaseProtectionBusy();
      return { ...status, state: "skipped_busy", stage: "Another worker is protecting the database" };
    }
    const attempt = await beginDatabaseProtectionAttempt(lock, databaseProtectionSource(), trigger);
    if (!attempt.shouldRun) {
      return {
        ...status,
        state: "skipped_busy",
        stage: attempt.deferred
          ? "Catch-up is coalesced with the next scheduled interval"
          : "Catch-up request was already claimed by another worker",
      };
    }
    attemptActive = true;
    // The two legacy timers converge here. Only one successful point is owed
    // per 15-minute wall-clock slot, including after process restart.
    status = await getDatabaseProtectionStatus(undefined, destination);
    const now = Date.now();
    if (trigger !== "manual" && !attempt.isCatchup && status.state === "verified" && status.recoveryPointAt &&
        now - Date.parse(status.recoveryPointAt) < intervalMinutes * 60_000) {
      logger.info("[backup] Production database interval already verified; duplicate timer skipped.");
      return status;
    }
    status = { ...status, state: "running", stage: "Verify dependencies, compare record fingerprints, capture changed records and media",
      lastAttemptAt: new Date(now).toISOString(), error: null };
    await save(status, lock);
    options.signal?.throwIfAborted();
    let lastProgress = 0;
    const stores=productionContentStores(options.signal, destination, externalProduction);
    const verified = await protectProduction({
      ...stores, codec: options.codec, source: databaseProtectionSource(),
      captureMedia: options.captureMedia,
      onPhase: async stage => { lease.assert(); status = { ...status, stage }; await save(status, lock); },
      onMediaProgress: async progress => {
        lease.assert();
        if (Date.now() - lastProgress < 10_000) return;
        lastProgress = Date.now();
        status = { ...status, ...progress }; await save(status, lock);
      },
      capture: async (previousJournalPosition, previousRecords) => {
        options.signal?.throwIfAborted();
        await lockMediaCheckpoint(lock); mediaLocked = true;
        await lock.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transaction = true;
        // Keep the finite idle timeout as a fallback. Capture progress on its
        // separate connection is covered by the scoped coordinator heartbeat.
        await lock.query("SET LOCAL idle_in_transaction_session_timeout = '30min'");
        // Same snapshot for lineage checks and pg_dump. No data or trigger
        // mutations are needed for this storage-incremental method.
        await verifyProductionBackupSource(lock);
        const snapshot = await lock.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot");
        stopSnapshotHeartbeat = keepProtectionSnapshotAlive(lock, lease);
        // Await cooperative unwinding on lease loss; racing this promise would
        // release the snapshot while its capture could still be using it.
        const captured = await options.capture(snapshot.rows[0]!.snapshot, previousJournalPosition, releaseMediaBoundary, previousRecords, lease.signal);
        lease.assert();
        await releaseMediaBoundary();
        if (isRecordDatabaseCapture(captured)) {
          // Complete capture has already read selected rows and staged any
          // schema-only export. Release the source snapshot before cloud I/O.
          await stopSnapshotHeartbeat();
          lease.assert();
          await lock.query("ROLLBACK"); transaction = false;
          return captured;
        }
        const stream: AsyncIterable<Uint8Array> = Buffer.isBuffer(captured)
          ? (async function* () { yield captured; })()
          : captured;
        // pg_dump must finish using the exported snapshot before it is released.
        // protectDatabase consumes this wrapper before it begins remote writes.
        return {
          async *[Symbol.asyncIterator]() {
            try { yield* stream; }
            finally {
              await stopSnapshotHeartbeat();
              if (transaction && !lease.failure) {
                await lock.query("ROLLBACK");
                transaction = false;
              }
            }
            lease.assert();
          },
        };
      },
    });
    lease.assert();
    const complete = verified.root.coverage === "complete";
    const snapshotValue=verified.inventory.evidence?.snapshotAt;
    const snapshotAt=typeof snapshotValue==="string"&&Number.isFinite(Date.parse(snapshotValue))
      ? new Date(snapshotValue).toISOString() : verified.root.createdAt;
    status = {
      ...status, state: complete ? "verified" : "partial", stage: !complete
        ? "Records and readable media verified with coverage warnings; NOT a complete recovery point"
        : "Production records and media read back and verified",
      mode: verified.database.recordSnapshot ? "incremental-records-and-media" : "incremental-storage-fresh-export",
      coverage: verified.root.coverage,
      mediaFiles: verified.inventory.files.length,
      mediaBytes: verified.inventory.files.reduce((sum, f) => sum + f.bytes, 0),
      missingFiles: verified.inventory.missingReferences.length,
      // `point` tracks the newest committed point (including a restorable
      // partial point). Complete freshness is separate and never moves on a
      // partial point.
      lastVerifiedAt: complete ? new Date().toISOString() : status.lastVerifiedAt,
      lastCompletePoint: complete ? verified.root.point : status.lastCompletePoint,
      // Data freshness follows the source snapshot, not the end of an upload.
      recoveryPointAt: complete ? snapshotAt : status.recoveryPointAt,
      lastDestinationCheckAt: new Date().toISOString(),
      point: verified.root.point, dumpBytes: verified.database.manifest.dumpBytes,
      newChunks: verified.database.manifest.newChunks + verified.root.newChunks,
      newBytes: verified.database.manifest.newBytes + verified.root.newBytes,
      reusedChunks: verified.root.reusedChunks,
      error: verified.inventory.coverageLimitations?.length
        ? verified.inventory.coverageLimitations.join(" ") : null,
    };
    await save(status, lock);
    attemptOutcome = status.state === "verified" ? "verified" : "partial";
    try {
      if (destination === "onedrive" && !externalProduction) await runDatabaseProtectionRetention({ codec: options.codec, signal: options.signal });
    } catch (retentionError) {
      logger.warn({ err: retentionError instanceof Error ? retentionError.message : "retention failed" },
        "[backup] Database recovery retention did not finish; the verified recovery point remains intact.");
    }
    logger.info({ destination, dumpBytes: status.dumpBytes, newChunks: status.newChunks, newBytes: status.newBytes,
      reusedChunks: status.reusedChunks, mediaFiles: status.mediaFiles, missingFiles: status.missingFiles,
      durationMs:Date.now()-now,databaseCapture:verified.database.manifest.capture,
      point:status.point,snapshotAt:status.recoveryPointAt,verifiedAt:status.lastDestinationCheckAt,
      sourceRevision:typeof verified.inventory.evidence?.sourceRevision==="string"&&/^[a-f0-9]{40}$/.test(verified.inventory.evidence.sourceRevision)
        ? verified.inventory.evidence.sourceRevision : undefined,
      recordMetrics:"metrics" in verified.database.manifest?verified.database.manifest.metrics:undefined,
      databaseDestination:stores.databaseStore.readStats?.(),mediaDestination:stores.store.readStats?.(),
      coverage: status.coverage }, "[backup] Production records/readable-media protection verified; coverage explicitly recorded.");
    return status;
  } catch (error) {
    const failure = lease.failure ?? error;
    await stopSnapshotHeartbeat();
    if (lease.failure) throw failure;
    if (transaction) {
      try { await lock.query("ROLLBACK"); }
      finally { transaction = false; }
    }
    const reason = error instanceof DatabaseProtectionError || error instanceof RecordRecoveryError ? error.message
      : /lineage|source identity/i.test(error instanceof Error ? error.message : "")
        ? "Production database identity/lineage verification failed."
        : backupErrorMessage(error);
    status = { ...status, state: "failed",
      error: `${status.stage}: ${reason} Previous verified objects were preserved.` };
    attemptOutcome = "failed";
    await save(status, lock);
    return status;
  } finally {
    await stopSnapshotHeartbeat();
    try {
      if (lease.failure) {
        logger.error({ err: backupErrorMessage(lease.failure) }, "[backup] Protection database session lost; provider work aborted and prior freshness preserved");
        // Persisted running attempt is reconciled after reconnect.
      } else {
      await releaseMediaBoundary();
      if (transaction) await lock.query("ROLLBACK");
      if (attemptActive) {
        try {
          await finishDatabaseProtectionAttempt(lock, databaseProtectionSource(), attemptOutcome);
        } catch (error) {
          logger.error({ err: backupErrorMessage(error) }, "[backup] Could not finalize persisted catch-up state");
        }
      }
      }
    } finally {
      try { if (held && !lease.failure) await lock.query("SELECT pg_advisory_unlock(80451, 15001)"); }
      finally { lease.release(); }
    }
  }
}

export async function hasPendingDatabaseProtectionCatchup(): Promise<boolean> {
  const client = await pool.connect();
  try {
    return await hasReadyDatabaseProtectionCatchup(client, databaseProtectionSource());
  } finally {
    client.release();
  }
}

export async function getDatabaseProtectionCatchupState() {
  const client = await pool.connect();
  try {
    return await readDatabaseProtectionCatchup(client, databaseProtectionSource());
  } finally {
    client.release();
  }
}

/** The watchdog re-authenticates remote dependencies, not just a success row. */
export async function checkDatabaseProtectionDestination(codec: DatabaseCodec, signal?: AbortSignal): Promise<void> {
  const lock = await pool.connect();
  const lease = guardProtectionClient(lock, signal);
  signal = lease.signal;
  let held = false, destinationVerified = false;
  try {
    held = (await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(80451, 15001) AS held")).rows[0]?.held === true;
    if (!held) return;
    const destination = await getProductionBackupDestination(lock);
    const status = await getDatabaseProtectionStatus(lock, destination);
    // A running status with no held lease is an interrupted worker. Do not
    // leave it looking in-progress forever after a restart.
    try {
      const verified = await latestProductionPoint({ ...productionContentStores(signal, destination), codec, source: databaseProtectionSource() }, true);
      lease.assert();
      if (!verified || verified.root.point !== status.point) {
        throw new Error("Database recovery point is absent or its verified identity differs.");
      }
      await save({ ...status,
        ...(status.state === "running" ? { state: "failed" as const, error: "Previous database protection was interrupted; earlier point remains verified." } : {}),
        lastDestinationCheckAt: new Date().toISOString() }, lock);
      destinationVerified = true;
    } catch (error) {
      if (lease.failure) throw lease.failure;
      await save({ ...status, state: "failed", stage: "Database destination verification",
        error: `${backupErrorMessage(error)} Required recovery objects may be missing, unreadable, corrupt, or unsupported by the provider.` }, lock);
    }
    if (destinationVerified) {
      try { if (destination === "onedrive") await runDatabaseProtectionRetention({ codec, signal }); }
      catch (retentionError) {
        logger.warn({ err: retentionError instanceof Error ? retentionError.message : "retention failed" },
          "[backup] Database recovery retention did not finish; the verified recovery point remains intact.");
      }
    }
  } finally {
    try { if (held && !lease.failure) await lock.query("SELECT pg_advisory_unlock(80451, 15001)"); }
    finally { lease.release(); }
  }
}
