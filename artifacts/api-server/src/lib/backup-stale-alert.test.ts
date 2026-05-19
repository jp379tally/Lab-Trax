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
  return {
    db: {
      select: selectFn,
      insert: insertFn,
      update: updateFn,
      delete: deleteFn,
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

import { db } from "@workspace/db";
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
   *   - first call  → backup_last_successful_at row (stale)
   *   - second call → backup_stale_alert_last_sent_at row (lastSentRaw)
   *   - third call  → admin emails
   */
  function setupSelectMocks(lastSentRaw: string | null) {
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const alertRow = lastSentRaw
      ? [{ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: lastSentRaw }]
      : [];
    const adminRow = [{ email: "admin@lab.com" }];

    let selectCallCount = 0;
    (db.select as Mock).mockImplementation(() => {
      selectCallCount++;
      const call = selectCallCount;
      return {
        from: () => ({
          where: () =>
            Promise.resolve(
              call === 1 ? staleRow :
              call === 2 ? alertRow :
              adminRow,
            ),
        }),
      };
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
    // microtask interleaving is deterministic:
    //   select 1 → instance A: backup_last_successful_at (stale)
    //   select 2 → instance B: backup_last_successful_at (stale)
    //   select 3 → instance A: backup_stale_alert_last_sent_at (none)
    //   select 4 → instance B: backup_stale_alert_last_sent_at (none)
    //   select 5 → instance A: admin emails
    //   select 6 → instance B: admin emails
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const alertRow: never[] = [];
    const adminRow = [{ email: "admin@lab.com" }];

    const responses = [staleRow, staleRow, alertRow, alertRow, adminRow, adminRow];
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
    // Interleaving with 2 instances × 3 selects each:
    //   select 1 → A: stale backup
    //   select 2 → B: stale backup
    //   select 3 → A: old alert timestamp
    //   select 4 → B: old alert timestamp
    //   select 5 → A: admin emails
    //   select 6 → B: admin emails
    const staleRow = [{ key: "backup_last_successful_at", value: staleBackupAt() }];
    const oldAlert = oldAlertAt();
    const alertRow = [{ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: oldAlert }];
    const adminRow = [{ email: "admin@lab.com" }];

    const responses = [staleRow, staleRow, alertRow, alertRow, adminRow, adminRow];
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
});
