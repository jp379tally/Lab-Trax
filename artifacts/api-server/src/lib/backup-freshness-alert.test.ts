/**
 * The silence that let backups stop for eighteen days.
 *
 * Each test here stands for one way the old design produced no signal at all:
 *  - the scheduler never ticked, so the failure email never fired and the
 *    in-process watchdog never ran;
 *  - an upload "succeeded" with nothing in the folder afterwards;
 *  - the alert itself could not be sent, and that only reached the log;
 *  - a run that dropped content was reported as a clean success.
 *
 * Everything runs against in-memory doubles: these are statements about the
 * alerting logic, not about the dev database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module doubles ──────────────────────────────────────────────────────────

interface FakeRow {
  [column: string]: unknown;
}

// Hoisted so the vi.mock factory below (which runs before this module's body)
// can reach the same objects the tests mutate.
const { store, TABLES, collectParams, settingKeyFrom } = vi.hoisted(() => {
  const store = {
    settings: new Map<string, string>(),
    notifications: [] as Array<Record<string, unknown>>,
    users: [] as Array<Record<string, unknown>>,
    backupRuns: [] as Array<Record<string, unknown>>,
    failNotificationInsert: false,
  };

  const TABLES = {
    systemSettings: { __table: "system_settings", key: "key", value: "value" },
    users: { __table: "users", id: "id", email: "email", role: "role", userType: "user_type" },
    notifications: { __table: "notifications", type: "type", readAt: "read_at" },
    backupRuns: {
      __table: "backup_runs",
      destination: "destination",
      status: "status",
      completedAt: "completed_at",
      archiveKind: "archive_kind",
      partialFailure: "partial_failure",
      remoteItemId: "remote_item_id",
      fileName: "file_name",
      sizeBytes: "size_bytes",
    },
  };

  /**
   * Pull the bound values out of a drizzle condition. The fake tables are
   * plain strings, so every operand lands as a parameter; that is enough to
   * tell which settings row a query is about without reimplementing SQL.
   */
  function collectParams(node: unknown, out: unknown[] = []): unknown[] {
    if (node === null || node === undefined) return out;
    // Operands of the fake tables arrive as plain strings in the chunk list;
    // literal SQL text arrives as { value: string[] } and is skipped.
    if (typeof node === "string") {
      out.push(node);
      return out;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectParams(item, out);
      return out;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if ("queryChunks" in obj) return collectParams(obj["queryChunks"], out);
      if ("value" in obj && !Array.isArray(obj["value"])) {
        out.push(obj["value"]);
        return out;
      }
      return out;
    }
    return out;
  }

  function settingKeyFrom(params: unknown[]): string | null {
    for (const p of params) {
      if (typeof p === "string" && store.settings.has(p)) return p;
    }
    for (const p of params) {
      if (typeof p === "string" && p.startsWith("backup_")) return p;
    }
    return null;
  }

  return { store, TABLES, collectParams, settingKeyFrom };
});

vi.mock("@workspace/db", () => {
  function selectBuilder() {
    let table: unknown = null;
    let params: unknown[] = [];
    let limit: number | null = null;
    const resolve = (): FakeRow[] => {
      if (table === TABLES.systemSettings) {
        return [...store.settings.entries()]
          .filter(([key]) => params.includes(key))
          .map(([key, value]) => ({ key, value }));
      }
      if (table === TABLES.users) return store.users.map((u) => ({ ...u }));
      if (table === TABLES.notifications) return store.notifications.map((n) => ({ ...n }));
      if (table === TABLES.backupRuns) {
        const rows = [...store.backupRuns].sort(
          (a, b) =>
            new Date(String(b["completedAt"])).getTime() -
            new Date(String(a["completedAt"])).getTime(),
        ).filter(
          (row) =>
            !params.includes("complete-production") ||
            row["partialFailure"] === false,
        );
        return limit === null ? rows : rows.slice(0, limit);
      }
      return [];
    };
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      where(cond: unknown) {
        params = collectParams(cond);
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      then(onFulfilled: (rows: FakeRow[]) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    db: {
      select: () => selectBuilder(),
      insert: (table: unknown) => ({
        values: (value: FakeRow) => {
          const run = async (mode: "nothing" | "update" | "plain") => {
            if (table === TABLES.notifications) {
              if (store.failNotificationInsert) {
                throw new Error("notifications table is unavailable");
              }
              const dedupeKey = value["dedupeKey"];
              if (
                typeof dedupeKey === "string" &&
                store.notifications.some((n) => n["dedupeKey"] === dedupeKey)
              ) {
                return { rowCount: 0 };
              }
              store.notifications.push({ ...value });
              return { rowCount: 1 };
            }
            if (table === TABLES.systemSettings) {
              const key = String(value["key"]);
              const exists = store.settings.has(key);
              if (exists && mode === "nothing") return { rowCount: 0 };
              store.settings.set(key, String(value["value"]));
              return { rowCount: 1 };
            }
            return { rowCount: 1 };
          };
          return {
            onConflictDoNothing: () => run("nothing"),
            onConflictDoUpdate: () => run("update"),
            then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              run("plain").then(ok, bad),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (value: FakeRow) => ({
          where: (cond: unknown) => {
            const params = collectParams(cond);
            if (table === TABLES.notifications) {
              if (!params.includes("backup_offsite_failure")) {
                return Promise.resolve({ rowCount: 0 });
              }
              let rowCount = 0;
              for (const notification of store.notifications) {
                if (
                  notification["type"] === "backup_offsite_failure" &&
                  notification["readAt"] == null
                ) {
                  notification["readAt"] = value["readAt"];
                  rowCount += 1;
                }
              }
              return Promise.resolve({ rowCount });
            }
            if (table !== TABLES.systemSettings) return Promise.resolve({ rowCount: 0 });
            const key = settingKeyFrom(params);
            const expected = params[params.length - 1];
            if (key === null) return Promise.resolve({ rowCount: 0 });
            if (store.settings.get(key) !== expected) return Promise.resolve({ rowCount: 0 });
            store.settings.set(key, String(value["value"]));
            return Promise.resolve({ rowCount: 1 });
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: (cond: unknown) => {
          if (table !== TABLES.systemSettings) return Promise.resolve({ rowCount: 0 });
          let removed = 0;
          for (const param of collectParams(cond)) {
            if (typeof param === "string" && store.settings.delete(param)) removed += 1;
          }
          return Promise.resolve({ rowCount: removed });
        },
      }),
    },
    pool: { query: vi.fn() },
    systemSettings: TABLES.systemSettings,
    users: TABLES.users,
    notifications: TABLES.notifications,
    backupRuns: TABLES.backupRuns,
  };
});

// Partial mock: the send functions are replaced, but the real
// describeBackupEmailFailures stays, so these tests read a refused send the
// same way production does.
vi.mock("./mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mail")>()),
  sendBackupNotificationEmail: vi
    .fn()
    .mockResolvedValue({ attempted: 2, sent: 2, failures: [] }),
  sendBackupStaleAlertEmail: vi
    .fn()
    .mockResolvedValue({ attempted: 2, sent: 2, failures: [] }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./onedrive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onedrive")>()),
  isOneDriveConnectorAvailable: vi.fn(() => true),
  listOneDriveBackupFiles: vi.fn(async () => [] as unknown[]),
  getOneDriveFileByName: vi.fn(async () => null as unknown),
}));

// ── Imports (after the mocks) ───────────────────────────────────────────────

import { sendBackupNotificationEmail } from "./mail";
import {
  isOneDriveConnectorAvailable,
  listOneDriveBackupFiles,
  getOneDriveFileByName,
} from "./onedrive";
import {
  evaluateOffsiteFreshness,
  getOffsiteFreshness,
  getUndeliveredBackupAlert,
  getBackupAlertDeliveryLog,
  runBackupFreshnessCheck,
  reconcileOffsiteBackupAlerts,
  verifyOneDriveArchive,
  minPlausibleBackupBytes,
  SETTING_BACKUP_OFFSITE_ENABLED,
  SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES,
  SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT,
  SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT,
} from "./backup";

// ── Helpers ─────────────────────────────────────────────────────────────────

const ARCHIVE_BYTES = minPlausibleBackupBytes() * 4;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function archive(ageMinutes: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    name: `labtrax-backup-${ageMinutes}.zip.enc`,
    size: ARCHIVE_BYTES,
    createdDateTime: minutesAgo(ageMinutes),
    ...overrides,
  };
}

function plantArchives(files: unknown[], verified = true): void {
  vi.mocked(listOneDriveBackupFiles).mockResolvedValue(files as never);
  if (verified) store.backupRuns = files.map(item => {
    const file = item as ReturnType<typeof archive>;
    return {
      completedAt: new Date(file.createdDateTime), destination: "onedrive", status: "success",
      archiveKind: "complete-production", partialFailure: false,
      fileName: file.name, remoteItemId: file.id, size: file.size, sizeBytes: file.size,
    };
  });
}

function notificationsOfType(type: string): FakeRow[] {
  return store.notifications.filter((n) => n["type"] === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.settings.clear();
  store.notifications = [];
  store.backupRuns = [];
  store.failNotificationInsert = false;
  store.users = [
    { id: "admin-1", email: "owner@lab.test", role: "admin", userType: "lab" },
    { id: "admin-2", email: "second@lab.test", role: "admin", userType: "lab" },
  ];
  store.settings.set(SETTING_BACKUP_OFFSITE_ENABLED, "true");
  store.settings.set(SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES, "15");
  vi.stubEnv("LABTRAX_DISABLE_OFFSITE_BACKUP", "");
  vi.stubEnv("OFFSITE_BACKUP_INTERVAL_MINUTES", "");
  vi.mocked(isOneDriveConnectorAvailable).mockReturnValue(true);
  vi.mocked(sendBackupNotificationEmail).mockResolvedValue({
    attempted: 2,
    sent: 2,
    failures: [],
  });
  plantArchives([archive(5)]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── The window ──────────────────────────────────────────────────────────────

describe("staleness window", () => {
  it("is a multiple of the configured interval, not a flat seven days", () => {
    const base = {
      nowMs: Date.now(),
      newestArchiveAt: null,
      listingError: "unreadable",
      lastVerifiedAt: null,
    };
    expect(evaluateOffsiteFreshness({ ...base, intervalMinutes: 60 }).windowMinutes).toBe(180);
    expect(evaluateOffsiteFreshness({ ...base, intervalMinutes: 240 }).windowMinutes).toBe(720);
    // Seven days would be 10080 minutes — the figure that let the outage run.
    expect(
      evaluateOffsiteFreshness({ ...base, intervalMinutes: 15 }).windowMinutes,
    ).toBeLessThan(7 * 24 * 60);
  });

  it("holds a floor so a very fast cadence does not alert on one late tick", () => {
    const verdict = evaluateOffsiteFreshness({
      nowMs: Date.now(),
      intervalMinutes: 5,
      newestArchiveAt: minutesAgo(30),
      listingError: null,
      lastVerifiedAt: null,
    });
    expect(verdict.windowMinutes).toBe(45);
    expect(verdict.stale).toBe(false);
  });

  it("treats a readable but empty folder as stale, not as inconclusive", async () => {
    plantArchives([]);
    const freshness = await getOffsiteFreshness();
    expect(freshness.stale).toBe(true);
    expect(freshness.source).toBe("none");
    expect(freshness.reason).toMatch(/no verified complete/i);
  });

  it("ignores a file too small to be a real archive", async () => {
    plantArchives([archive(2, { size: 512 })]);
    const freshness = await getOffsiteFreshness();
    expect(freshness.newestArchive).toBeNull();
    expect(freshness.stale).toBe(true);
  });
  it("does not claim completeness from a destination filename alone", async () => {
    store.backupRuns = [];
    plantArchives([archive(2)], false);
    expect((await getOffsiteFreshness()).stale).toBe(true);
  });

  it("does not clear a full-protection alarm with history alone when the folder cannot be read", async () => {
    vi.mocked(listOneDriveBackupFiles).mockRejectedValue(new Error("Graph is down"));
    store.backupRuns.push({ completedAt: new Date(Date.now() - 10 * 60_000) });
    const freshness = await getOffsiteFreshness();
    expect(freshness.source).toBe("none");
    expect(freshness.destinationUnreadable).toBe(true);
    expect(freshness.stale).toBe(true);
  });
});

describe("resolving off-site failure alerts", () => {
  const activeFailure = {
    type: "backup_offsite_failure",
    readAt: null,
  };

  it("resolves active failure notifications after a fresh matched complete archive is confirmed", async () => {
    store.notifications = [
      { ...activeFailure },
      { type: "backup_local_error", readAt: null },
      { type: "backup_offsite_failure", readAt: new Date("2026-01-01T00:00:00Z") },
    ];
    plantArchives([archive(3)]);

    const result = await runBackupFreshnessCheck();

    expect(result.ok).toBe(true);
    expect(store.notifications.map((notification) => notification["readAt"])).toEqual([
      expect.any(Date),
      null,
      new Date("2026-01-01T00:00:00Z"),
    ]);
  });

  it("leaves active notifications unread when the destination archive is stale", async () => {
    store.notifications = [{ ...activeFailure }];
    plantArchives([archive(5 * 24 * 60)]);

    const freshness = await getOffsiteFreshness();
    await reconcileOffsiteBackupAlerts(freshness);

    expect(freshness.stale).toBe(true);
    expect(store.notifications[0]?.["readAt"]).toBeNull();
  });

  it("leaves active notifications unread when the archive run was partial", async () => {
    store.notifications = [{ ...activeFailure }];
    plantArchives([archive(3)]);
    store.backupRuns[0]!.partialFailure = true;

    const freshness = await getOffsiteFreshness();
    await reconcileOffsiteBackupAlerts(freshness);

    expect(freshness.stale).toBe(true);
    expect(store.notifications[0]?.["readAt"]).toBeNull();
  });

  it("leaves active notifications unread when the destination object has no matching run", async () => {
    store.notifications = [{ ...activeFailure }];
    plantArchives([archive(3)], false);

    const freshness = await getOffsiteFreshness();
    await reconcileOffsiteBackupAlerts(freshness);

    expect(freshness.stale).toBe(true);
    expect(store.notifications[0]?.["readAt"]).toBeNull();
  });

  it("does not treat a successful run record without a listed destination object as confirmation", async () => {
    store.notifications = [{ ...activeFailure }];
    store.backupRuns.push({
      completedAt: new Date(),
      destination: "onedrive",
      status: "success",
      archiveKind: "complete-production",
      partialFailure: false,
      fileName: "labtrax-backup-record-only.zip.enc",
      remoteItemId: "record-only",
      sizeBytes: ARCHIVE_BYTES,
    });
    plantArchives([], false);

    const freshness = await getOffsiteFreshness();
    await reconcileOffsiteBackupAlerts(freshness);

    expect(freshness.stale).toBe(true);
    expect(store.notifications[0]?.["readAt"]).toBeNull();
  });

  it("leaves active notifications unread when the destination cannot be read", async () => {
    store.notifications = [{ ...activeFailure }];
    vi.mocked(listOneDriveBackupFiles).mockRejectedValue(new Error("Graph is down"));

    const freshness = await getOffsiteFreshness();
    await reconcileOffsiteBackupAlerts(freshness);

    expect(freshness.destinationUnreadable).toBe(true);
    expect(freshness.stale).toBe(true);
    expect(store.notifications[0]?.["readAt"]).toBeNull();
  });
});

// ── A scheduler that never ticks ────────────────────────────────────────────

describe("a scheduler that never ticks", () => {
  it("still alerts, from outside the API process, with no run rows at all", async () => {
    // Eighteen days of silence: no backup_runs row was ever written, so
    // nothing in the database says anything is wrong.
    store.backupRuns = [];
    plantArchives([archive(18 * 24 * 60)], false);
    expect(store.backupRuns).toHaveLength(0);

    const result = await runBackupFreshnessCheck();

    expect(result.ok).toBe(false);
    expect(result.alerted).toBe(true);
    expect(result.freshness.source).toBe("none");
    expect(result.freshness.reason).toMatch(/no verified complete/i);

    // Every admin is told in-app…
    expect(notificationsOfType("backup_offsite_failure")).toHaveLength(2);
    // …and by email, which the old design never sent because nothing ran.
    expect(sendBackupNotificationEmail).toHaveBeenCalledTimes(1);

    // Both attempts are on the record with their outcome.
    const log = await getBackupAlertDeliveryLog();
    expect(log.map((e) => `${e.channel}:${e.outcome}`)).toEqual(
      expect.arrayContaining(["in_app:delivered", "email:delivered"]),
    );
    expect(await getUndeliveredBackupAlert()).toBeNull();
  });

  it("is not silenced by an alert the dying in-process watchdog already claimed", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    // The API process raised (and rate-limited) its own alert minutes ago.
    store.settings.set(SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT, minutesAgo(5));

    const result = await runBackupFreshnessCheck();

    expect(result.alerted).toBe(true);
    expect(sendBackupNotificationEmail).toHaveBeenCalledTimes(1);
    expect(store.settings.get(SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT)).toBeTruthy();
  });

  it("keeps its own rate limit so a long outage does not spam", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    await runBackupFreshnessCheck();
    const second = await runBackupFreshnessCheck();

    expect(sendBackupNotificationEmail).toHaveBeenCalledTimes(1);
    expect(second.alertSuppressed).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("clears the rate limits once an archive lands again", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    await runBackupFreshnessCheck();
    expect(store.settings.get(SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT)).toBeTruthy();

    plantArchives([archive(3)]);
    const healthy = await runBackupFreshnessCheck();

    expect(healthy.ok).toBe(true);
    expect(store.settings.has(SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT)).toBe(false);
    expect(store.settings.has(SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT)).toBe(false);
  });
});

// ── An upload whose file is absent afterwards ───────────────────────────────

describe("an upload whose file is absent afterwards", () => {
  const uploaded = {
    fileName: "labtrax-backup-2026-10-06.zip.enc",
    itemId: "item-9",
    folder: "Apps/LabTrax Backups",
    webUrl: null,
  } as never;

  it("fails the run when the archive is not in the folder", async () => {
    vi.mocked(getOneDriveFileByName).mockResolvedValue(null as never);
    await expect(verifyOneDriveArchive(uploaded, ARCHIVE_BYTES)).rejects.toThrow(
      /is not in OneDrive/i,
    );
  });

  it("fails the run when the stored file is short", async () => {
    vi.mocked(getOneDriveFileByName).mockResolvedValue({
      id: "item-9",
      name: "labtrax-backup-2026-10-06.zip.enc",
      size: ARCHIVE_BYTES - 1,
      createdDateTime: new Date().toISOString(),
    } as never);
    await expect(verifyOneDriveArchive(uploaded, ARCHIVE_BYTES)).rejects.toThrow(
      /size is unconfirmed/i,
    );
  });

  it("fails the run when the read-back itself cannot be done", async () => {
    vi.mocked(getOneDriveFileByName).mockRejectedValue(new Error("Graph timed out"));
    await expect(verifyOneDriveArchive(uploaded, ARCHIVE_BYTES)).rejects.toThrow(
      /could not be verified/i,
    );
  });

  it("accepts the run when the archive is present at the expected size", async () => {
    vi.mocked(getOneDriveFileByName).mockResolvedValue({
      id: "item-9",
      name: "labtrax-backup-2026-10-06.zip.enc",
      size: ARCHIVE_BYTES,
      createdDateTime: new Date().toISOString(),
    } as never);
    await expect(verifyOneDriveArchive(uploaded, ARCHIVE_BYTES)).resolves.toBeUndefined();
  });
});

// ── An alert that cannot be delivered ───────────────────────────────────────

describe("an alert that cannot be delivered", () => {
  it("records the failed email and tells admins in the app", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    vi.mocked(sendBackupNotificationEmail).mockRejectedValue(new Error("SMTP refused the message"));

    const result = await runBackupFreshnessCheck();

    expect(result.alerted).toBe(false);
    expect(result.alertError).toMatch(/SMTP refused the message/);

    const undelivered = await getUndeliveredBackupAlert();
    expect(undelivered?.channel).toBe("email");
    expect(undelivered?.outcome).toBe("failed");
    expect(undelivered?.detail).toMatch(/SMTP refused the message/);

    // Visible to an admin, not only in the server log.
    expect(notificationsOfType("backup_alert_undeliverable")).toHaveLength(2);
  });

  it("treats having nobody to email as an undelivered alert", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    store.users = [{ id: "admin-1", email: null, role: "admin", userType: "lab" }];

    await runBackupFreshnessCheck();

    const undelivered = await getUndeliveredBackupAlert();
    expect(undelivered?.channel).toBe("email");
    expect(undelivered?.detail).toMatch(/no lab admin email addresses/i);
    expect(sendBackupNotificationEmail).not.toHaveBeenCalled();
    expect(notificationsOfType("backup_alert_undeliverable")).toHaveLength(1);
  });

  it("records a failed in-app alert when the notification cannot be written", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    store.failNotificationInsert = true;

    await runBackupFreshnessCheck();

    const log = await getBackupAlertDeliveryLog();
    expect(log.some((e) => e.channel === "in_app" && e.outcome === "failed")).toBe(true);
  });

  it("reports mail the server simply refused, without an exception", async () => {
    // The mailer answers a refused or skipped send by returning
    // `{ sent: false }` — unconfigured SMTP, bad credentials, a rejected
    // recipient. Nothing throws. Reading that as a delivery is how an alarm
    // goes quiet while believing it spoke.
    plantArchives([archive(5 * 24 * 60)]);
    vi.mocked(sendBackupNotificationEmail).mockResolvedValueOnce({
      attempted: 2,
      sent: 0,
      failures: [
        { email: "owner@lab.test", reason: "smtp_not_configured" },
        { email: "second@lab.test", reason: "smtp_not_configured" },
      ],
    });

    const result = await runBackupFreshnessCheck();

    expect(result.alerted).toBe(false);
    expect(result.alertError).toMatch(/smtp_not_configured/);
    const undelivered = await getUndeliveredBackupAlert();
    expect(undelivered?.channel).toBe("email");
    expect(undelivered?.outcome).toBe("failed");
    expect(notificationsOfType("backup_alert_undeliverable").length).toBeGreaterThan(0);

    // Nothing was sent, so the six-hour rate limit must not be holding: the
    // very next check is free to try again.
    expect(store.settings.get(SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT)).toBeUndefined();
    await runBackupFreshnessCheck();
    expect(sendBackupNotificationEmail).toHaveBeenCalledTimes(2);
  });

  it("keeps the failed email visible when only the in-app alert gets through", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    vi.mocked(sendBackupNotificationEmail).mockRejectedValue(new Error("SMTP refused"));
    await runBackupFreshnessCheck();
    expect((await getUndeliveredBackupAlert())?.channel).toBe("email");

    // A new admin joins, so the next run writes a fresh in-app notification
    // while mail keeps failing. One channel working must not retire the other
    // channel's failure — that is how a bounced alert went unnoticed.
    store.users.push({ id: "admin-3", email: "third@lab.test", role: "admin", userType: "lab" });
    await runBackupFreshnessCheck();

    expect(
      (await getBackupAlertDeliveryLog()).some(
        (e) => e.channel === "in_app" && e.outcome === "delivered",
      ),
    ).toBe(true);
    const stillUndelivered = await getUndeliveredBackupAlert();
    expect(stillUndelivered?.channel).toBe("email");
    expect(stillUndelivered?.outcome).toBe("failed");
  });

  it("stops reporting an undelivered alert once a later one gets through", async () => {
    plantArchives([archive(5 * 24 * 60)]);
    vi.mocked(sendBackupNotificationEmail).mockRejectedValueOnce(new Error("SMTP refused"));
    await runBackupFreshnessCheck();
    expect((await getUndeliveredBackupAlert())?.outcome).toBe("failed");

    // A later outage, past the rate limit, whose mail goes out.
    store.settings.delete(SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT);
    await runBackupFreshnessCheck();

    expect(await getUndeliveredBackupAlert()).toBeNull();
  });
});
