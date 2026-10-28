import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  production: true, held: true, saved: null as string | null, failCapture: false,
  catchupSaved: null as string | null,
  verify: vi.fn(), capture: vi.fn(), release: vi.fn(), queries: [] as string[],
  protect: vi.fn(), latest: vi.fn(), settings: new Map<string, string>(),
  clientErrors: [] as Array<(error: Error) => void>,
  providerSignals: [] as Array<AbortSignal | undefined>,
}));
vi.mock("drizzle-orm", () => ({ eq: (_column: unknown, key: string) => key }));
vi.mock("@workspace/db", () => ({
  systemSettings: { key: "key" },
  db: {
    select: () => ({ from: () => ({ where: (key: string) => ({
      limit: async () => {
        const value = key === "backup_production_content_protection_v1" ? fake.saved : fake.settings.get(key);
        return value ? [{ value }] : [];
      },
    }) }) }),
    insert: () => ({ values: (row: { value: string }) => ({
      onConflictDoUpdate: async () => {
        const key = (row as { key?: string }).key ?? "unknown";
        fake.settings.set(key, row.value);
        if (key === "backup_production_content_protection_v1") fake.saved = row.value;
      },
    }) }),
  },
  pool: { connect: async () => ({
    on: (event: string, listener: (error: Error) => void) => { if (event === "error") fake.clientErrors.push(listener); },
    removeListener: (event: string, listener: (error: Error) => void) => {
      if (event === "error") fake.clientErrors = fake.clientErrors.filter(value => value !== listener);
    },
    query: async (sql: string, params?: unknown[]) => {
      fake.queries.push(sql);
      if (sql.startsWith("INSERT INTO system_settings")) {
        const key = String(params?.[0]);
        const value = String(params?.[1]);
        if (key === "backup_production_content_catchup_v1") {
          if (sql.includes("DO NOTHING")) fake.catchupSaved ??= value;
          else fake.catchupSaved = value;
        } else if (key === "backup_production_content_protection_v1") {
          if (sql.includes("DO NOTHING")) fake.saved ??= value;
          else fake.saved = value;
        } else {
          if (!sql.includes("DO NOTHING") || !fake.settings.has(key)) fake.settings.set(key, value);
        }
      }
      if (sql.startsWith("UPDATE system_settings")) {
        const key = String(params?.[0]);
        const value = String(params?.[1]);
        if (key === "backup_production_content_catchup_v1") fake.catchupSaved = value;
        else if (key === "backup_production_content_protection_v1") fake.saved = value;
        else fake.settings.set(key, value);
      }
      if (sql.startsWith("SELECT value FROM system_settings")) {
        const key = String(params?.[0]);
        const value = key === "backup_production_content_catchup_v1" ? fake.catchupSaved
          : key === "backup_production_content_protection_v1" ? fake.saved : fake.settings.get(key);
        return { rows: value ? [{ value }] : [] };
      }
      return { rows: sql.includes("try_advisory") ? [{ held: fake.held }] : sql.includes("export_snapshot") ? [{ snapshot: "synthetic-snapshot" }] : [] };
    },
    release: fake.release,
  }) },
}));
vi.mock("./onedrive", () => ({
  isProductionDeployment: () => fake.production,
  getOneDriveBackupFolder: () => "synthetic-private-folder",
}));
vi.mock("./database-protection-onedrive", () => ({
  databaseOneDriveStore: vi.fn((_folder: string, signal?: AbortSignal) => {
    fake.providerSignals.push(signal);
    return {
    list: async () => [],
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    };
  }),
}));
vi.mock("./google-drive", () => ({
  getGoogleDriveBackupFolder: () => "synthetic-google-folder",
  databaseGoogleDriveStore: vi.fn((_folder: string, signal?: AbortSignal) => {
    fake.providerSignals.push(signal);
    return { list: async () => [], get: async () => null, put: async () => {}, delete: async () => {} };
  }),
}));
vi.mock("./production-content-protection", () => ({
  protectProduction: fake.protect, latestProductionPoint: fake.latest,
}));
vi.mock("./backup-production-source", () => ({ verifyProductionBackupSource: fake.verify }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import {
  runDatabaseProtectionJob as runJob, getDatabaseProtectionStatus, checkDatabaseProtectionDestination,
  noteDatabaseProtectionBusy, databaseProtectionVerificationError, getDatabaseProtectionCatchupState,
  hasPendingDatabaseProtectionCatchup,
  runDatabaseProtectionRetention, setDatabaseProtectionRetentionConfig,
  getDatabaseProtectionRetentionStatus, databaseProtectionSource,
} from "./database-protection-job";
import { protectDatabase, type DatabaseObjectStore } from "./database-protection";
import { databaseOneDriveStore } from "./database-protection-onedrive";
import { databaseGoogleDriveStore } from "./google-drive";
const codec = { encrypt: (v: Buffer) => v, decrypt: (v: Buffer) => v };
afterEach(()=>vi.useRealTimers());
const runDatabaseProtectionJob = (options: Parameters<typeof runJob>[0] | { codec: typeof codec; capture: typeof fake.capture }) =>
  runJob({ captureMedia: async () => ({ sourceVersions: [], missingReferences: [], evidence: {} }), ...options });
describe("production database job coordination (synthetic metadata)", () => {
  beforeEach(() => {
    vi.mocked(databaseGoogleDriveStore).mockClear();
    vi.mocked(databaseOneDriveStore).mockClear();
    vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/synthetic_source");
    fake.production = true; fake.held = true; fake.saved = null; fake.catchupSaved = null; fake.settings.clear(); fake.queries = [];
    fake.verify.mockReset().mockResolvedValue("verified-lineage");
    fake.capture.mockReset().mockResolvedValue(Buffer.from("PGDMPsynthetic"));
    fake.release.mockClear(); fake.clientErrors = []; fake.providerSignals = [];
    fake.protect.mockReset().mockImplementation(async options => {
      await options.onPhase("Exporting a consistent production database snapshot");
      expect(options.captureMedia).toBeTypeOf("function");
      const source = await options.capture();
      if (!Buffer.isBuffer(source)) {
        for await (const _chunk of source) { /* consume through snapshot rollback */ }
      }
      return { root: { point: "synthetic-point", createdAt: new Date().toISOString(),
        coverage: "complete", newBytes: 500, newChunks: 0, reusedChunks: 1 },
        inventory: { files: [], missingReferences: [] },
        database: { manifest: { dumpBytes: 1000, newChunks: 2, newBytes: 50 } } };
    });
    fake.latest.mockReset().mockResolvedValue({ root: { point: "synthetic-point" } });
  });
  it("keeps legacy protection until a new destination is explicitly saved", async () => {
    fake.settings.set("backup_schedule_destination", "google-drive");
    fake.settings.set("backup_schedule_enabled", "false");
    expect((await getDatabaseProtectionStatus()).destination).toBe("onedrive");
    fake.settings.set("backup_schedule_routing_version", "2");
    expect((await getDatabaseProtectionStatus()).destination).toBe("google-drive");
  });

  it("binds Google Drive stores and verification status without inheriting OneDrive freshness", async () => {
    await runDatabaseProtectionJob({ codec, capture: fake.capture, destination: "onedrive" });
    const previousOneDrive = fake.saved;
    fake.settings.set("backup_schedule_destination", "google-drive");
    fake.settings.set("backup_schedule_routing_version", "2");
    const empty = await getDatabaseProtectionStatus();
    expect(empty.destination).toBe("google-drive");
    expect(empty.lastVerifiedAt).toBeNull();
    expect(empty.point).toBeNull();
    vi.mocked(databaseOneDriveStore).mockClear();
    await runDatabaseProtectionJob({ codec, capture: fake.capture, intervalMinutes: 5 });
    expect(databaseGoogleDriveStore).toHaveBeenCalledTimes(2);
    expect(databaseOneDriveStore).not.toHaveBeenCalled();
    expect(fake.saved).toBe(previousOneDrive);
    expect(JSON.parse(fake.settings.get("backup_production_content_protection_v1:google-drive")!).state).toBe("verified");
  });
  it("honors a five-minute interval instead of suppressing the next point for fifteen minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    await runDatabaseProtectionJob({ codec, capture: fake.capture, intervalMinutes: 5 });
    fake.protect.mockClear();
    vi.setSystemTime(new Date("2026-10-27T12:06:00.000Z"));
    await runDatabaseProtectionJob({ codec, capture: fake.capture, intervalMinutes: 5 });
    expect(fake.protect).toHaveBeenCalledTimes(1);
  });
  it("aborts both Google Drive stores on lost lock and leaves its verified point unchanged", async () => {
    fake.settings.set("backup_schedule_destination", "google-drive");
    fake.settings.set("backup_schedule_routing_version", "2");
    await runDatabaseProtectionJob({ codec, capture: fake.capture });
    const previous = JSON.parse(fake.settings.get("backup_production_content_protection_v1:google-drive")!);
    await noteDatabaseProtectionBusy();
    fake.providerSignals = [];
    const lost = new Error("Synthetic Google protection lock session lost");
    fake.protect.mockImplementationOnce(async () => {
      fake.clientErrors[0]!(lost);
      expect(fake.providerSignals).toHaveLength(2);
      expect(fake.providerSignals.every(signal => signal?.aborted)).toBe(true);
      throw lost;
    });
    await expect(runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "manual" })).rejects.toBe(lost);
    const after = JSON.parse(fake.settings.get("backup_production_content_protection_v1:google-drive")!);
    expect(after.lastVerifiedAt).toBe(previous.lastVerifiedAt);
    expect(after.point).toBe(previous.point);
  });
  it("aborts cloud work on advisory-lock client loss without advancing freshness or finalizing catch-up", async () => {
    const terminated = new Error("Synthetic session terminated");
    fake.protect.mockImplementationOnce(async () => {
      expect(fake.clientErrors).toHaveLength(1);
      fake.clientErrors[0]!(terminated);
      expect(fake.providerSignals).toHaveLength(2);
      for (const signal of fake.providerSignals) expect(signal?.aborted).toBe(true);
      throw terminated;
    });
    await expect(runDatabaseProtectionJob({ codec, capture: fake.capture })).rejects.toBe(terminated);
    const saved = JSON.parse(fake.saved!);
    expect(saved.state).toBe("running");
    expect(saved.lastVerifiedAt).toBeNull();
    expect(saved.lastCompletePoint).toBeNull();
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.clientErrors).toHaveLength(0);
    expect(fake.queries.some(query => query.includes("pg_advisory_unlock"))).toBe(false);
    expect(JSON.parse(fake.catchupSaved!).active).toBe(true);
    expect(JSON.parse(fake.catchupSaved!).lastFinishedAt).toBeNull();
  });
  it("does not certify a provider result returned after the advisory session was lost", async () => {
    const normal = fake.protect.getMockImplementation()!;
    const previous = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    fake.saved = JSON.stringify({ ...previous, state: "failed" });
    fake.release.mockClear();
    const terminated = new Error("Synthetic late disconnect");
    fake.protect.mockImplementationOnce(async options => {
      const result = await normal(options);
      fake.clientErrors[0]!(terminated);
      return result;
    });
    await expect(runDatabaseProtectionJob({ codec, capture: fake.capture })).rejects.toBe(terminated);
    expect(JSON.parse(fake.saved!).state).toBe("running");
    expect(JSON.parse(fake.saved!).lastVerifiedAt).toBe(previous.lastVerifiedAt);
    expect(JSON.parse(fake.saved!).lastCompletePoint).toBe(previous.lastCompletePoint);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("watchdog disconnect aborts its destination reads without writing verification success", async () => {
    const terminated = new Error("Synthetic watchdog disconnect");
    fake.latest.mockImplementationOnce(async () => {
      fake.clientErrors[0]!(terminated);
      expect(fake.providerSignals.every(signal => signal?.aborted)).toBe(true);
      throw terminated;
    });
    await expect(checkDatabaseProtectionDestination(codec)).rejects.toBe(terminated);
    expect(fake.saved).toBeNull();
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.clientErrors).toHaveLength(0);
  });
  it("uses a read-only exported snapshot and never includes media capture", async () => {
    fake.capture.mockImplementation(async () => (async function* () {
      expect(fake.queries).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(fake.queries).not.toContain("ROLLBACK");
      yield Buffer.from("PGDMPsynthetic");
      expect(fake.queries).not.toContain("ROLLBACK");
    })());
    const status = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(status.state).toBe("verified");
    expect(status.scope).toBe("production-database-and-media");
    expect(fake.capture).toHaveBeenCalledWith("synthetic-snapshot", undefined, expect.any(Function), undefined);
    expect(fake.verify).toHaveBeenCalledOnce();
    expect(fake.queries).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(fake.queries).toContain("SET LOCAL idle_in_transaction_session_timeout = '30min'");
    expect(fake.queries.indexOf("SET LOCAL idle_in_transaction_session_timeout = '30min'"))
      .toBeLessThan(fake.queries.indexOf("SELECT pg_export_snapshot() AS snapshot"));
    expect(fake.queries).toContain("ROLLBACK");
    expect(fake.queries.some(q => /advisory_unlock/.test(q))).toBe(true);
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it("rolls back an exported snapshot before recording a failed protection attempt if the stream is not consumed", async () => {
    fake.protect.mockImplementationOnce(async options => {
      await options.capture();
      throw new Error("Synthetic pre-consumption failure");
    });
    const status = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(status.state).toBe("failed");
    const rollback = fake.queries.indexOf("ROLLBACK");
    const failedStatusWrite = fake.queries.findIndex((query, index) =>
      index > rollback && query.startsWith("INSERT INTO system_settings"));
    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(failedStatusWrite).toBeGreaterThan(rollback);
  });
  it("records the source snapshot time rather than upload completion as recovery freshness", async () => {
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
    const snapshotAt=new Date(Date.now()-60*60_000).toISOString();
    const completedAt=new Date().toISOString();
    fake.protect.mockResolvedValueOnce({
      root:{point:"synthetic-old-snapshot",createdAt:completedAt,coverage:"complete",newBytes:10,newChunks:1,reusedChunks:0},
      inventory:{files:[],missingReferences:[],evidence:{snapshotAt}},
      database:{manifest:{dumpBytes:10,newChunks:1,newBytes:10}},
    });
    const status=await runDatabaseProtectionJob({codec,capture:fake.capture});
    expect(status.recoveryPointAt).toBe(snapshotAt);
    expect(status.lastDestinationCheckAt).toBe(completedAt);
    expect(status.recoveryPointAt).not.toBe(status.lastVerifiedAt);
  });
  it("deduplicates a verified slot after restart using persisted state", async () => {
    await runDatabaseProtectionJob({ codec, capture: fake.capture });
    await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(fake.protect).toHaveBeenCalledOnce();
    expect((await getDatabaseProtectionStatus()).state).toBe("verified");
  });
  it("skips overlapping workers without writing a failure over their progress", async () => {
    fake.held = false;
    const status = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(status.state).toBe("skipped_busy");
    expect(JSON.parse(fake.saved!).state).toBe("skipped_busy");
    expect((await getDatabaseProtectionCatchupState()).pending).toBe(true);
    expect(fake.protect).not.toHaveBeenCalled();
  });
  it("keeps a prior verified point on failure and retries a failed slot", async () => {
    await runDatabaseProtectionJob({ codec, capture: fake.capture });
    const prior = JSON.parse(fake.saved!);
    expect(prior.lastCompletePoint).toBe("synthetic-point");
    prior.state = "failed";
    fake.saved = JSON.stringify(prior);
    fake.settings.set("backup_production_content_protection_v1", fake.saved);
    fake.protect.mockRejectedValueOnce(new Error("HTTP 503; synthetic provider detail"));
    const failed = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(failed.state).toBe("failed");
    expect(failed.point).toBe("synthetic-point");
    expect(failed.lastCompletePoint).toBe(prior.lastCompletePoint);
    expect(failed.lastVerifiedAt).toBe(prior.lastVerifiedAt);
    expect(failed.error).toContain("HTTP 503");
    expect(failed.error).not.toContain("synthetic provider detail");
    expect((await runDatabaseProtectionJob({ codec, capture: fake.capture })).state).toBe("verified");
  });
  it("marks destination corruption failed without advancing the recovery time", async () => {
    const prior = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    fake.latest.mockRejectedValueOnce(new Error("Synthetic missing chunk"));
    await checkDatabaseProtectionDestination(codec);
    const status = await getDatabaseProtectionStatus();
    expect(status.state).toBe("failed");
    expect(status.lastVerifiedAt).toBe(prior.lastVerifiedAt);
    expect(status.error).toContain("missing");
  });
  it("refuses development sources", async () => {
    fake.production = false;
    await expect(runDatabaseProtectionJob({ codec, capture: fake.capture })).rejects.toThrow(/production/);
    expect(fake.capture).not.toHaveBeenCalled();
  });
  it("never captures when production lineage verification fails and rolls back", async () => {
    fake.verify.mockRejectedValueOnce(new Error("Production lineage mismatch"));
    const status = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(status.state).toBe("failed");
    expect(status.error).toContain("identity/lineage");
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.queries).toContain("ROLLBACK");
  });
  it("destination checks skip an active worker rather than clobbering progress", async () => {
    fake.held = false;
    await checkDatabaseProtectionDestination(codec);
    expect(fake.latest).not.toHaveBeenCalled();
    expect(fake.saved).toBe(null);
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it("records a skipped interval behind a manual backup while retaining the verified point", async () => {
    const prior = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    await noteDatabaseProtectionBusy();
    const status = await getDatabaseProtectionStatus();
    expect(status.state).toBe("skipped_busy");
    expect(status.lastVerifiedAt).toBe(prior.lastVerifiedAt);
    expect(status.point).toBe(prior.point);
    expect(status.lastCompletePoint).toBe(prior.lastCompletePoint);
    const queued = await getDatabaseProtectionCatchupState();
    expect(queued.pending).toBe(true);
    expect(queued.missedIntervals).toBe(1);
  });
  it("coalesces busy ticks across restart into one catch-up and never duplicates a claimed request", async () => {
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
    const prior = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    fake.protect.mockClear();
    await noteDatabaseProtectionBusy();
    await noteDatabaseProtectionBusy();
    await noteDatabaseProtectionBusy();
    const pendingBeforeRestart = await getDatabaseProtectionCatchupState();
    expect(pendingBeforeRestart.pending).toBe(true);
    expect(pendingBeforeRestart.missedIntervals).toBe(3);
    expect(pendingBeforeRestart.generation).toBe(3);
    expect(await hasPendingDatabaseProtectionCatchup()).toBe(true);

    // The catch-up row is persisted independently from process-local state.
    const afterRestart = await getDatabaseProtectionCatchupState();
    expect(afterRestart).toEqual(pendingBeforeRestart);
    vi.setSystemTime(Date.now()+1000);
    const caughtUp = await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    expect(caughtUp.state).toBe("verified");
    expect(fake.protect).toHaveBeenCalledOnce();
    expect((await getDatabaseProtectionCatchupState()).pending).toBe(false);
    expect((await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" })).state)
      .toBe("skipped_busy");
    expect(fake.protect).toHaveBeenCalledOnce();
    expect(caughtUp.lastCompletePoint).toBe("synthetic-point");
    expect(caughtUp.lastVerifiedAt).not.toBe(prior.lastVerifiedAt);
  });
  it("retains an interrupted catch-up claim and defers a failed retry until a regular tick", async () => {
    await noteDatabaseProtectionBusy();
    const interruptedClaim = await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    expect(interruptedClaim.state).toBe("verified");
    // Simulate a process interruption after the request is recorded but before
    // a new worker can observe completion: an active row plus a pending request
    // remains retryable under the shared lock.
    const state = await getDatabaseProtectionCatchupState();
    fake.catchupSaved = JSON.stringify({ ...state, pending: true, deferred: false, active: true,
      activeCatchup: true, claimedGeneration: state.generation });
    fake.protect.mockClear();
    fake.protect.mockRejectedValueOnce(new Error("Synthetic catch-up interruption"));
    const failedRetry = await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    expect(failedRetry.state).toBe("failed");
    const retained = await getDatabaseProtectionCatchupState();
    expect(retained.pending).toBe(true);
    expect(retained.deferred).toBe(true);
    expect(await hasPendingDatabaseProtectionCatchup()).toBe(false);
    const pollAttempt = await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    expect(pollAttempt.state).toBe("skipped_busy");
    expect(fake.protect).toHaveBeenCalledOnce();
    fake.protect.mockResolvedValueOnce({
      root: { point: "synthetic-retry-point", createdAt: new Date().toISOString(),
        coverage: "complete", newBytes: 50, newChunks: 1, reusedChunks: 0 },
      inventory: { files: [], missingReferences: [] },
      database: { manifest: { dumpBytes: 1000, newChunks: 1, newBytes: 50 } },
    });
    expect((await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "interval" })).state)
      .toBe("verified");
    expect((await getDatabaseProtectionCatchupState()).pending).toBe(false);
  });
  it("does not recursively self-trigger when busy intervals arrive during a catch-up", async () => {
    await noteDatabaseProtectionBusy();
    fake.protect.mockImplementationOnce(async options => {
      await noteDatabaseProtectionBusy();
      const source = await options.capture();
      if (!Buffer.isBuffer(source)) for await (const _chunk of source) { /* consume snapshot */ }
      return {
        root: { point: "synthetic-catchup-point", createdAt: new Date().toISOString(),
          coverage: "complete", newBytes: 50, newChunks: 1, reusedChunks: 0 },
        inventory: { files: [], missingReferences: [] },
        database: { manifest: { dumpBytes: 1000, newChunks: 1, newBytes: 50 } },
      };
    });
    await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    const deferred = await getDatabaseProtectionCatchupState();
    expect(deferred.pending).toBe(true);
    expect(deferred.deferred).toBe(true);
    expect(await hasPendingDatabaseProtectionCatchup()).toBe(false);
    const pollAttempt = await runDatabaseProtectionJob({ codec, capture: fake.capture, trigger: "catchup" });
    expect(pollAttempt.state).toBe("skipped_busy");
    expect(fake.protect).toHaveBeenCalledOnce();
  });
  it("retains partial points without promoting complete freshness, including after persisted reads and failure", async () => {
    const prior = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    const priorCompleteAt = prior.lastVerifiedAt;
    const priorCompletePoint = prior.lastCompletePoint;
    const persisted = JSON.parse(fake.saved!);
    persisted.recoveryPointAt = new Date(Date.now() - 16 * 60_000).toISOString();
    fake.saved = JSON.stringify(persisted);

    fake.protect.mockImplementationOnce(async () => ({
      root: { point: "synthetic-partial-point", createdAt: new Date().toISOString(),
        coverage: "partial", newBytes: 10, newChunks: 1, reusedChunks: 0 },
      inventory: { files: [], missingReferences: ["case-media/missing-synthetic.bin"] },
      database: { manifest: { dumpBytes: 1000, newChunks: 1, newBytes: 10 } },
    }));
    const partial = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(partial.state).toBe("partial");
    expect(partial.coverage).toBe("partial");
    expect(partial.point).toBe("synthetic-partial-point");
    expect(partial.lastVerifiedAt).toBe(priorCompleteAt);
    expect(partial.lastCompletePoint).toBe(priorCompletePoint);
    expect(partial.recoveryPointAt).toBe(persisted.recoveryPointAt);
    expect((await getDatabaseProtectionStatus()).state).toBe("partial");
    expect(databaseProtectionVerificationError(partial, Date.now())).toContain("not a complete recovery point");

    const partialPersisted = JSON.parse(fake.saved!);
    partialPersisted.recoveryPointAt = new Date(Date.now() - 16 * 60_000).toISOString();
    fake.saved = JSON.stringify(partialPersisted);
    fake.protect.mockRejectedValueOnce(new Error("Synthetic retry failure"));
    const failed = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(failed.state).toBe("failed");
    expect(failed.point).toBe("synthetic-partial-point");
    expect(failed.lastVerifiedAt).toBe(priorCompleteAt);
    expect(failed.lastCompletePoint).toBe(priorCompletePoint);
    expect((await getDatabaseProtectionStatus()).lastVerifiedAt).toBe(priorCompleteAt);
  });
  it("downgrades previously misreported partial verified freshness during status migration", async () => {
    const legacy = {
      ...JSON.parse(JSON.stringify(await runDatabaseProtectionJob({ codec, capture: fake.capture }))),
      coverage: "partial", state: "verified", missingFiles: 1,
      lastVerifiedAt: "2026-10-25T00:00:00.000Z",
    };
    fake.saved = JSON.stringify(legacy);
    const status = await getDatabaseProtectionStatus();
    expect(status.state).toBe("partial");
    expect(status.lastVerifiedAt).toBeNull();
    expect(status.lastCompletePoint).toBeNull();
  });
  it("does not treat an old recorded success as current remote verification", async () => {
    const status = await runDatabaseProtectionJob({ codec, capture: fake.capture });
    expect(databaseProtectionVerificationError(status, Date.now())).toBe(null);
    expect(databaseProtectionVerificationError(status, Date.now() + 21 * 60_000)).toContain("overdue");
  });
  it("keeps cleanup disabled until explicit approval", async () => {
    let deletes = 0;
    const store: DatabaseObjectStore = {
      list: async () => [],
      get: async () => null,
      put: async () => {},
      delete: async () => { deletes++; },
    };
    await runDatabaseProtectionRetention({ codec, store });
    expect(deletes).toBe(0);
    expect((await getDatabaseProtectionRetentionStatus()).state).toBe("disabled");
    await expect(setDatabaseProtectionRetentionConfig({
      enabled: true, keepAllWithinHours: 24, keepHourlyWithinDays: 7,
      keepDailyWithinDays: 30, safetyGraceHours: 48,
    }, null)).rejects.toThrow(/must approve/);
  });
  it("limits database-only approval to the legacy namespace, never full records/media dependencies", async () => {
    await setDatabaseProtectionRetentionConfig({
      enabled: true, keepAllWithinHours: 24, keepHourlyWithinDays: 7,
      keepDailyWithinDays: 30, safetyGraceHours: 48,
    }, "synthetic-platform-owner");
    vi.mocked(databaseOneDriveStore).mockClear();
    await runDatabaseProtectionRetention({ codec });
    expect(databaseOneDriveStore).toHaveBeenCalledExactlyOnceWith(
      `synthetic-private-folder/database-protection-v1/${databaseProtectionSource()}`,
      undefined,
    );
    expect((await getDatabaseProtectionRetentionStatus()).state).toBe("complete");
  });
  it("persists and resumes a synthetic deletion plan after an interrupted delete", async () => {
    const objects = new Map<string, Buffer>();
    const objectTimes = new Map<string, string>();
    let writeTime = "";
    let failNextDelete = true;
    const store: DatabaseObjectStore = {
      list: async () => [...objects.keys()].map(name => ({ name, createdAt: objectTimes.get(name) ?? null })),
      get: async name => objects.get(name) ? Buffer.from(objects.get(name)!) : null,
      put: async (name, bytes) => {
        if (objects.has(name)) throw new Error("Synthetic overwrite refused");
        objects.set(name, Buffer.from(bytes));
        objectTimes.set(name, writeTime);
      },
      delete: async name => {
        if (failNextDelete) { failNextDelete = false; throw new Error("Synthetic interruption after planning"); }
        objects.delete(name); objectTimes.delete(name);
      },
    };
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    const makeDump = (fill: number) => Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(2 * 1024 * 1024, fill)]);
    const addPoint = async (at: number, content: Buffer) => {
      writeTime = new Date(at).toISOString();
      const actual = await vi.importActual<typeof import("./database-protection")>("./database-protection");
      await actual.protectDatabase({ store, codec, source: databaseProtectionSource(), now: new Date(at), capture: async () => content });
    };
    await addPoint(start, makeDump(11));
    await addPoint(start + 10 * 24 * 60 * 60_000, makeDump(22));
    await addPoint(start + 20 * 24 * 60 * 60_000, makeDump(33));
    await setDatabaseProtectionRetentionConfig({
      enabled: true, keepAllWithinHours: 1, keepHourlyWithinDays: 1,
      keepDailyWithinDays: 1, safetyGraceHours: 48,
    }, "synthetic-platform-owner");
    const now = new Date(start + 20 * 24 * 60 * 60_000);
    await expect(runDatabaseProtectionRetention({ codec, store, now })).rejects.toThrow(/Synthetic interruption/);
    const interrupted = await getDatabaseProtectionRetentionStatus();
    expect(interrupted.state).toBe("failed");
    expect(interrupted.pendingObjects).toBeGreaterThan(0);
    await runDatabaseProtectionRetention({ codec, store, now });
    const resumed = await getDatabaseProtectionRetentionStatus();
    expect(resumed.state).toBe("complete");
    expect(resumed.pendingObjects).toBe(0);
    expect(resumed.deletedObjects).toBeGreaterThan(0);
    expect((await store.list()).some(item => item.name.startsWith("verified-"))).toBe(true);
  });
});
