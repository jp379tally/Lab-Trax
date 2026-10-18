/**
 * Unit tests for checkAndAlertBackupStaleness() — specifically the
 * compare-and-swap claim that prevents duplicate alert emails when multiple
 * server instances run concurrently (Task #521).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────
// Must be declared before importing the module under test so Vitest hoists them.

vi.mock("@workspace/db", () => {
  const selectFn = vi.fn();
  const insertFn = vi.fn();
  const updateFn = vi.fn();
  const deleteFn = vi.fn();
  const queryFn = vi.fn();
  return {
    db: {
      select: selectFn,
      insert: insertFn,
      update: updateFn,
      delete: deleteFn,
    },
    pool: {
      query: queryFn,
    },
    systemSettings: { key: "key", value: "value" },
    users: { email: "email", role: "role" },
    backupRuns: {},
  };
});

vi.mock("./mail.js", () => ({
  sendBackupStaleAlertEmail: vi.fn(),
  sendBackupNotificationEmail: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { db, pool } from "@workspace/db";
import { sendBackupStaleAlertEmail } from "./mail.js";
import { checkAndAlertBackupStaleness, SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT } from "./backup.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ISO timestamp that is 10 days in the past — well beyond the 7-day stale threshold. */
function staleBackupAt(): string {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
}

/** ISO timestamp that is 1 day in the past — within the 3-day rate-limit window. */
function recentAlertAt(): string {
  return new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
}

/** ISO timestamp that is 5 days in the past — outside the rate-limit but present. */
function oldAlertAt(): string {
  return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkAndAlertBackupStaleness — compare-and-swap claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default delete stub (no-op, used by claim rollback path).
    (db.delete as Mock).mockReturnValue({
      where: () => Promise.resolve({ rowCount: 1 }),
    });
  });

  /**
   * Helper that wires up db.select() to return:
   *   - call 1 → backup_last_successful_at row (stale)
   *   - call 2 → stale-alert settings rows (empty → uses defaults)
   *   - call 3 → backup schedule config rows (empty → non-local dest, uses defaults)
   *   - call 4 → backup_stale_alert_last_sent_at row (lastSentRaw)
   *   - call 5 → admin emails (with emailPreferences to opt-in to backupAlerts)
   *
   * Calls 1–3 run concurrently via Promise.all([getLastSuccessfulBackupAt(),
   * getBackupStaleAlertSettings(), getBackupScheduleConfig()]).
   * Call 4 is the sequential rate-limit check.
   * Call 5 is getAdminEmails() / filterEmailsByPref().
   *
   * Note: pool.query is NOT called for non-local destinations (getLastDesktopBackupAt
   * is only invoked when destination === "local").
   */
  function setupSelectMocks(lastSentRaw: string | null) {
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const settingsRow: never[] = []; // empty → getBackupStaleAlertSettings uses defaults
    const scheduleConfigRow: never[] = []; // empty → getBackupScheduleConfig → destination=null (non-local)
    const alertRow = lastSentRaw
      ? [{ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: lastSentRaw }]
      : [];
    // Includes emailPreferences so that filterEmailsByPref("backupAlerts")
    // — which issues its own db.select for user prefs — sees the admin as
    // opted-in. After defaults flipped to OFF, omitting this field caused
    // the email to be silently dropped.
    const adminRow = [
      { email: "admin@lab.com", emailPreferences: { backupAlerts: true } },
    ];

    let selectCallCount = 0;
    (db.select as Mock).mockImplementation(() => {
      selectCallCount++;
      const call = selectCallCount;
      return {
        from: () => ({
          where: () =>
            Promise.resolve(
              call === 1 ? staleRow :
              call === 2 ? settingsRow :
              call === 3 ? scheduleConfigRow :
              call === 4 ? alertRow :
              adminRow,
            ),
        }),
      };
    });
  }

  /**
   * Set up mocks for a local-destination schedule scenario.
   *
   * db.select() sequence (5 calls, same count as non-local):
   *   1 → backup_last_successful_at (fresh — proves we're NOT using this for local)
   *   2 → stale-alert settings (empty → defaults)
   *   3 → schedule config (local, 1440 min interval, enabled)
   *   4 → backup_stale_alert_last_sent_at (lastSentRaw)
   *   5 → admin emails
   *
   * pool.query is called once for getLastDesktopBackupAt(). The result is
   * controlled by desktopCompletedAt (null → no desktop run ever, ISO string → that timestamp).
   */
  function setupLocalSelectMocks(lastSentRaw: string | null, desktopCompletedAt: string | null) {
    const freshWatermarkRow = [{
      key: "backup_last_successful_at",
      value: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 h ago — fresh
    }];
    const settingsRow: never[] = [];
    const localScheduleRow = [
      { key: "backup_schedule_destination", value: "local" },
      { key: "backup_schedule_interval_minutes", value: "1440" },
      { key: "backup_schedule_enabled", value: "true" },
    ];
    const alertRow = lastSentRaw
      ? [{ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: lastSentRaw }]
      : [];
    const adminRow = [{ email: "admin@lab.com", emailPreferences: { backupAlerts: true } }];

    let selectCallCount = 0;
    (db.select as Mock).mockImplementation(() => {
      selectCallCount++;
      const call = selectCallCount;
      return {
        from: () => ({
          where: () =>
            Promise.resolve(
              call === 1 ? freshWatermarkRow :
              call === 2 ? settingsRow :
              call === 3 ? localScheduleRow :
              call === 4 ? alertRow :
              adminRow,
            ),
        }),
      };
    });

    // Mock pool.query for getLastDesktopBackupAt()
    (pool.query as Mock).mockResolvedValue({
      rows: desktopCompletedAt !== null
        ? [{ completed_at: new Date(desktopCompletedAt) }]
        : [],
    });
  }

  // ── INSERT path (no prior alert row) ─────────────────────────────────────

  it("sends the alert when no prior alert row exists and INSERT succeeds", async () => {
    setupSelectMocks(null);

    (db.insert as Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
  });

  it("does NOT send the alert when INSERT returns 0 rows (concurrent instance won)", async () => {
    setupSelectMocks(null);

    (db.insert as Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve({ rowCount: 0 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).not.toHaveBeenCalled();
  });

  // ── UPDATE path (prior row exists outside the rate-limit window) ──────────

  it("sends the alert when prior row exists and conditional UPDATE succeeds", async () => {
    setupSelectMocks(oldAlertAt());

    (db.update as Mock).mockReturnValue({
      set: () => ({
        where: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
  });

  it("does NOT send the alert when conditional UPDATE returns 0 rows (concurrent instance won)", async () => {
    setupSelectMocks(oldAlertAt());

    (db.update as Mock).mockReturnValue({
      set: () => ({
        where: () => Promise.resolve({ rowCount: 0 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).not.toHaveBeenCalled();
  });

  // ── Rate-limit suppression ────────────────────────────────────────────────

  it("suppresses the alert via rate limit when last alert was sent recently", async () => {
    setupSelectMocks(recentAlertAt());

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  // ── Send-failure rollback ─────────────────────────────────────────────────

  it("rolls back the claim (DELETE) when email delivery fails after a fresh INSERT", async () => {
    setupSelectMocks(null);

    (db.insert as Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    (sendBackupStaleAlertEmail as Mock).mockRejectedValue(new Error("SMTP timeout"));

    const deleteSpy = db.delete as Mock;
    deleteSpy.mockReturnValue({
      where: () => Promise.resolve({ rowCount: 1 }),
    });

    // The function catches and swallows the re-thrown send error internally.
    await checkAndAlertBackupStaleness();

    // Claim should have been rolled back so the next invocation can retry.
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("rolls back the claim (UPDATE to old value) when email delivery fails after a conditional UPDATE", async () => {
    const oldSentAt = oldAlertAt();
    setupSelectMocks(oldSentAt);

    (db.update as Mock).mockReturnValue({
      set: () => ({
        where: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    (sendBackupStaleAlertEmail as Mock).mockRejectedValue(new Error("SMTP timeout"));

    await checkAndAlertBackupStaleness();

    // db.update is called twice: once for the claim, once for the rollback.
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  // ── Concurrent simulation — INSERT path ──────────────────────────────────

  it("simulates two concurrent calls (no prior row) — only one sends the email", async () => {
    // Both concurrent calls read the same DB state before either writes.
    //
    // JavaScript is single-threaded. With Promise.resolve() mocks the
    // microtask interleaving is deterministic. Each instance issues 5 selects:
    //   select 1  → instance A: backup_last_successful_at (stale)
    //   select 2  → instance A: stale-alert settings (empty → defaults)
    //   select 3  → instance A: schedule config (empty → non-local)
    //   select 4  → instance B: backup_last_successful_at (stale)
    //   select 5  → instance B: stale-alert settings (empty → defaults)
    //   select 6  → instance B: schedule config (empty → non-local)
    //   select 7  → instance A: backup_stale_alert_last_sent_at (none)
    //   select 8  → instance B: backup_stale_alert_last_sent_at (none)
    //   select 9  → instance A: admin emails
    //   select 10 → instance B: admin emails
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const alertRow: never[] = [];
    const adminRow = [{ email: "admin@lab.com", emailPreferences: { backupAlerts: true } }];

    const responses = [staleRow, [], [], staleRow, [], [], alertRow, alertRow, adminRow, adminRow];
    let selectCallCount = 0;
    (db.select as Mock).mockImplementation(() => {
      const response = responses[selectCallCount++] ?? adminRow;
      return {
        from: () => ({
          where: () => Promise.resolve(response),
        }),
      };
    });

    let insertCallCount = 0;
    (db.insert as Mock).mockImplementation(() => ({
      values: () => ({
        onConflictDoNothing: () => {
          insertCallCount++;
          // First INSERT wins (rowCount 1), second loses (rowCount 0)
          // — simulating the DB unique-constraint CAS.
          return Promise.resolve({ rowCount: insertCallCount === 1 ? 1 : 0 });
        },
      }),
    }));

    await Promise.all([
      checkAndAlertBackupStaleness(),
      checkAndAlertBackupStaleness(),
    ]);

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
  });

  // ── Concurrent simulation — UPDATE path ──────────────────────────────────

  it("simulates two concurrent calls (prior row exists) — only one sends the email", async () => {
    // Both instances read the same old alert timestamp before either writes.
    // Interleaving with 2 instances × 5 selects each = 10 total:
    //   select 1  → A: stale backup
    //   select 2  → A: stale-alert settings (empty → defaults)
    //   select 3  → A: schedule config (empty → non-local)
    //   select 4  → B: stale backup
    //   select 5  → B: stale-alert settings (empty → defaults)
    //   select 6  → B: schedule config (empty → non-local)
    //   select 7  → A: old alert timestamp
    //   select 8  → B: old alert timestamp
    //   select 9  → A: admin emails
    //   select 10 → B: admin emails
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const oldAlert = oldAlertAt();
    const alertRow = [{ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: oldAlert }];
    const adminRow = [{ email: "admin@lab.com", emailPreferences: { backupAlerts: true } }];

    const responses = [staleRow, [], [], staleRow, [], [], alertRow, alertRow, adminRow, adminRow];
    let selectCallCount = 0;
    (db.select as Mock).mockImplementation(() => {
      const response = responses[selectCallCount++] ?? adminRow;
      return {
        from: () => ({
          where: () => Promise.resolve(response),
        }),
      };
    });

    let updateCallCount = 0;
    (db.update as Mock).mockImplementation(() => ({
      set: () => ({
        where: () => {
          updateCallCount++;
          // First UPDATE wins; second sees 0 rows (value was already changed).
          return Promise.resolve({ rowCount: updateCallCount === 1 ? 1 : 0 });
        },
      }),
    }));

    await Promise.all([
      checkAndAlertBackupStaleness(),
      checkAndAlertBackupStaleness(),
    ]);

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
  });

  // ── Local-destination data-source tests ──────────────────────────────────

  it("local destination — fires alert with isLocalDestination=true when desktop backup_runs is stale (ignores fresh global watermark)", async () => {
    // Global watermark is FRESH (1 h ago) — would suppress the alert if used.
    // Desktop backup_runs is STALE (3 days ago) — should trigger the alert.
    // This proves the function uses backup_runs, NOT the watermark, for local schedules.
    const staleDesktopAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    setupLocalSelectMocks(null, staleDesktopAt);

    (db.insert as Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
    const callArgs = (sendBackupStaleAlertEmail as Mock).mock.calls[0]![0];
    expect(callArgs.isLocalDestination).toBe(true);
    expect(callArgs.thresholdDays).toBe(2); // 2 × 1 day (1440 min), min 2 days
  });

  it("local destination — suppresses alert when desktop backup_runs is fresh even though global watermark is stale", async () => {
    // This is the key data-source test: a recent desktop run must prevent the alert,
    // even when the global watermark happens to be stale (e.g. after a server restart
    // or DB migration that cleared the watermark but not backup_runs).
    //
    // Fresh desktop run = 1 h ago (well within 2-day threshold for a 24 h interval).
    const freshDesktopAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    setupLocalSelectMocks(null, freshDesktopAt);

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).not.toHaveBeenCalled();
  });

  it("local destination — fires alert when no desktop backup run has ever been recorded", async () => {
    // null from getLastDesktopBackupAt() → daysSince = Infinity → always stale.
    setupLocalSelectMocks(null, null);

    (db.insert as Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve({ rowCount: 1 }),
      }),
    });

    await checkAndAlertBackupStaleness();

    expect(sendBackupStaleAlertEmail).toHaveBeenCalledOnce();
    const callArgs = (sendBackupStaleAlertEmail as Mock).mock.calls[0]![0];
    expect(callArgs.isLocalDestination).toBe(true);
    expect(callArgs.lastSuccessfulAt).toBeNull();
  });
});
