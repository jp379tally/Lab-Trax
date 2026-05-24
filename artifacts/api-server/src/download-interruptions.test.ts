/**
 * Unit tests for the download-interruption tracker and alert logic.
 *
 * All DB and mail dependencies are mocked so no real database connection or
 * SMTP credentials are needed.
 *
 * Key behaviours under test:
 *   - recordDownloadInterruption: prunes events older than 24 h, keeps recent ones
 *   - maybeFireAlert (via recordDownloadInterruption): fires at threshold,
 *     suppresses within the 1 h dedup window, fires again when window expires
 *     or the failure count increases
 *   - getDownloadInterruptionStats: correct counts and lastOccurredAt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared in-memory state used by the mocks
// ---------------------------------------------------------------------------

/** Simulates the system_settings table rows keyed by settings key. */
const settingsStore = new Map<string, string>();

/** Controls which admin e-mail addresses the mock returns. */
let adminEmailsList: string[] = ["admin@example.com"];

/**
 * vi.mock factories are hoisted above variable declarations, so any variable
 * the factory needs must be lifted with vi.hoisted() so it exists in the
 * hoisted scope when the factory executes.
 */
const { sendAlertMock } = vi.hoisted(() => ({
  sendAlertMock: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks — vi.mock calls are hoisted, so they run before any imports.
// ---------------------------------------------------------------------------

/**
 * Mock drizzle-orm's `eq` so that `eq(column, value)` returns the bare value
 * string.  This lets the db mock's `.where()` handler identify which row is
 * being requested without needing a real SQL AST.
 */
vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => val,
}));

/**
 * Mock @workspace/db.
 *
 * The db object implements the subset of the Drizzle fluent API used by
 * download-interruptions.ts:
 *   db.select(fields).from(table).where(condition) → Promise<row[]>
 *   db.insert(table).values(data).onConflictDoUpdate(opts) → Promise<void>
 *
 * Because eq() is mocked to return the bare value, `.where(condition)` sees:
 *   - "installer_download_interruptions"  → SETTING_EVENTS query
 *   - "installer_download_interruption_alert_last" → SETTING_ALERT_LAST query
 *   - "admin"                             → admin users query
 */
vi.mock("@workspace/db", () => {
  const systemSettings = { key: "key", value: "value" };
  const users = { email: "email", role: "role" };

  const db = {
    select: (_fields: unknown) => ({
      from: (table: unknown) => ({
        where: (condition: unknown): Promise<unknown[]> => {
          if (table === systemSettings) {
            const val = settingsStore.get(condition as string);
            if (val != null) return Promise.resolve([{ value: val }]);
            return Promise.resolve([]);
          }
          if (table === users) {
            return Promise.resolve(adminEmailsList.map((e) => ({ email: e })));
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (data: { key: string; value: string }) => ({
        onConflictDoUpdate: (_opts: unknown): Promise<void> => {
          settingsStore.set(data.key, data.value);
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, systemSettings, users };
});

vi.mock("./lib/mail.js", () => ({
  sendDownloadInterruptionAlertEmail: sendAlertMock,
}));

vi.mock("./lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test after mocks are registered.
// ---------------------------------------------------------------------------
import {
  recordDownloadInterruption,
  getDownloadInterruptionStats,
} from "./lib/download-interruptions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * recordDownloadInterruption is fire-and-forget (void async IIFE).
 * All internal awaits resolve synchronously in the mock, so a single
 * setTimeout(0) tick lets every microtask in the chain complete.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SETTING_EVENTS = "installer_download_interruptions";
const SETTING_ALERT_LAST = "installer_download_interruption_alert_last";

/** Seed the settings store with an array of events. */
function seedEvents(events: object[]): void {
  settingsStore.set(SETTING_EVENTS, JSON.stringify({ events }));
}

/** Read back the events that were written to the store. */
function storedEvents(): object[] {
  const raw = settingsStore.get(SETTING_EVENTS);
  if (!raw) return [];
  return (JSON.parse(raw) as { events: object[] }).events;
}

/** Build an event payload (without occurredAt). */
const baseEvent = {
  kind: "zip" as const,
  absoluteOffset: 1024,
  retryFailed: false,
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  settingsStore.clear();
  adminEmailsList = ["admin@example.com"];
  sendAlertMock.mockClear();
  // Reset the threshold env var so each test starts with the default (3).
  delete process.env.DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD;
});

afterEach(() => {
  delete process.env.DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD;
});

// ---------------------------------------------------------------------------
// recordDownloadInterruption — pruning behaviour
// ---------------------------------------------------------------------------

describe("recordDownloadInterruption — pruning", () => {
  it("stores the new event when the store is empty", async () => {
    recordDownloadInterruption(baseEvent);
    await flushPromises();

    const events = storedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "zip", absoluteOffset: 1024, retryFailed: false });
    expect((events[0] as { occurredAt: string }).occurredAt).toBeDefined();
  });

  it("prunes events older than 24 h and keeps recent ones", async () => {
    const now = Date.now();
    const oldTs = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25 h ago — outside window
    const recentTs = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 h ago — inside window

    seedEvents([
      { occurredAt: oldTs, kind: "zip", absoluteOffset: 0, retryFailed: false },
      { occurredAt: recentTs, kind: "exe", absoluteOffset: 500, retryFailed: true },
    ]);

    recordDownloadInterruption(baseEvent);
    await flushPromises();

    const events = storedEvents();
    // The old event must have been pruned; the recent event and the new one must remain.
    expect(events).toHaveLength(2);
    const timestamps = (events as Array<{ occurredAt: string }>).map((e) => e.occurredAt);
    expect(timestamps).not.toContain(oldTs);
    expect(timestamps).toContain(recentTs);
  });

  it("does not prune an event that is exactly inside the 24 h window", async () => {
    const now = Date.now();
    // 23 h 59 m ago — still inside the 24 h window
    const justInsideTs = new Date(now - (24 * 60 * 60 * 1000 - 60_000)).toISOString();

    seedEvents([
      { occurredAt: justInsideTs, kind: "dmg", absoluteOffset: 0, retryFailed: false },
    ]);

    recordDownloadInterruption(baseEvent);
    await flushPromises();

    const events = storedEvents();
    const timestamps = (events as Array<{ occurredAt: string }>).map((e) => e.occurredAt);
    expect(timestamps).toContain(justInsideTs);
  });

  it("prunes all events when every existing event is older than 24 h", async () => {
    const now = Date.now();
    const oldTs1 = new Date(now - 26 * 60 * 60 * 1000).toISOString();
    const oldTs2 = new Date(now - 48 * 60 * 60 * 1000).toISOString();

    seedEvents([
      { occurredAt: oldTs1, kind: "zip", absoluteOffset: 0, retryFailed: false },
      { occurredAt: oldTs2, kind: "exe", absoluteOffset: 100, retryFailed: true },
    ]);

    recordDownloadInterruption(baseEvent);
    await flushPromises();

    const events = storedEvents();
    // Only the newly added event should remain.
    expect(events).toHaveLength(1);
    expect((events[0] as { occurredAt: string }).occurredAt).not.toBe(oldTs1);
    expect((events[0] as { occurredAt: string }).occurredAt).not.toBe(oldTs2);
  });
});

// ---------------------------------------------------------------------------
// maybeFireAlert — exercised via recordDownloadInterruption
// ---------------------------------------------------------------------------

describe("maybeFireAlert — threshold and deduplication", () => {
  it("does not send an alert when retryFailed count is below the threshold", async () => {
    // Default threshold is 3. Seed 2 retryFailed events + add one non-failed.
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    recordDownloadInterruption({ ...baseEvent, retryFailed: false });
    await flushPromises();

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it("sends an alert when retryFailed count reaches the default threshold (3)", async () => {
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    // This is the 3rd retryFailed event — should trigger the alert.
    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const args = sendAlertMock.mock.calls[0][0] as {
      adminEmails: string[];
      retryFailCount: number;
      threshold: number;
    };
    expect(args.adminEmails).toContain("admin@example.com");
    expect(args.retryFailCount).toBe(3);
    expect(args.threshold).toBe(3);
  });

  it("respects a custom threshold set via env var", async () => {
    process.env.DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD = "2";

    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    // 2nd retryFailed event — should trigger with threshold=2.
    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const args = sendAlertMock.mock.calls[0][0] as { threshold: number };
    expect(args.threshold).toBe(2);
  });

  it("suppresses a second alert for the same failure count within the 1 h dedup window", async () => {
    // Seed: 3 retryFailed events already present + an existing alert record
    // that was sent 30 minutes ago with retryFailCount=3 (within the 1 h window).
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 3000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000).toISOString();
    settingsStore.set(
      SETTING_ALERT_LAST,
      JSON.stringify({ sentAt: thirtyMinutesAgo, retryFailCount: 3 }),
    );

    // Adding a non-retryFailed event still triggers maybeFireAlert but dedup should suppress it.
    recordDownloadInterruption({ ...baseEvent, retryFailed: false });
    await flushPromises();

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it("fires a new alert when the dedup window has expired (> 1 h ago)", async () => {
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    // The last alert was sent 61 minutes ago — outside the 1 h window.
    const sixtyOneMinutesAgo = new Date(now - 61 * 60 * 1000).toISOString();
    settingsStore.set(
      SETTING_ALERT_LAST,
      JSON.stringify({ sentAt: sixtyOneMinutesAgo, retryFailCount: 3 }),
    );

    // Add the 3rd retryFailed event — threshold met and window expired.
    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
  });

  it("fires a new alert within the window when the failure count increases beyond the last alerted count", async () => {
    const now = Date.now();
    // 4 retryFailed events (count > last alerted count of 3).
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 3000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    // The last alert was 10 minutes ago with retryFailCount=3 (inside window).
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    settingsStore.set(
      SETTING_ALERT_LAST,
      JSON.stringify({ sentAt: tenMinutesAgo, retryFailCount: 3 }),
    );

    // Adding a 4th retryFailed event → count (4) > last alerted count (3) → fires.
    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const args = sendAlertMock.mock.calls[0][0] as { retryFailCount: number };
    expect(args.retryFailCount).toBe(4);
  });

  it("does not send an alert when there are no admin users", async () => {
    adminEmailsList = []; // no admins in the mock
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it("updates the alert record in the settings store after sending", async () => {
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    recordDownloadInterruption({ ...baseEvent, retryFailed: true });
    await flushPromises();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    const alertRaw = settingsStore.get(SETTING_ALERT_LAST);
    expect(alertRaw).toBeDefined();
    const alert = JSON.parse(alertRaw!) as { sentAt: string; retryFailCount: number };
    expect(alert.retryFailCount).toBe(3);
    // sentAt should be within the last 5 seconds.
    expect(Date.now() - Date.parse(alert.sentAt)).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// getDownloadInterruptionStats
// ---------------------------------------------------------------------------

describe("getDownloadInterruptionStats", () => {
  it("returns zero counts and null lastOccurredAt when the store is empty", async () => {
    const stats = await getDownloadInterruptionStats();
    expect(stats.count24h).toBe(0);
    expect(stats.retryFailCount24h).toBe(0);
    expect(stats.lastOccurredAt).toBeNull();
  });

  it("returns correct counts for a mix of retryFailed events within the window", async () => {
    const now = Date.now();
    const ts1 = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 h ago
    const ts2 = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2 h ago
    const ts3 = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // 3 h ago

    seedEvents([
      { occurredAt: ts1, kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: ts2, kind: "exe", absoluteOffset: 100, retryFailed: false },
      { occurredAt: ts3, kind: "dmg", absoluteOffset: 200, retryFailed: true },
    ]);

    const stats = await getDownloadInterruptionStats();
    expect(stats.count24h).toBe(3);
    expect(stats.retryFailCount24h).toBe(2);
    // lastOccurredAt should be the most recent event (ts1).
    expect(stats.lastOccurredAt).toBe(ts1);
  });

  it("excludes events older than 24 h from all counts", async () => {
    const now = Date.now();
    const recentTs = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    const oldTs = new Date(now - 30 * 60 * 60 * 1000).toISOString();

    seedEvents([
      { occurredAt: recentTs, kind: "zip", absoluteOffset: 0, retryFailed: true },
      { occurredAt: oldTs, kind: "zip", absoluteOffset: 0, retryFailed: true },
    ]);

    const stats = await getDownloadInterruptionStats();
    // Only the recent event should count.
    expect(stats.count24h).toBe(1);
    expect(stats.retryFailCount24h).toBe(1);
    expect(stats.lastOccurredAt).toBe(recentTs);
  });

  it("returns the most recent occurredAt as lastOccurredAt regardless of insertion order", async () => {
    const now = Date.now();
    const ts1 = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // oldest
    const ts2 = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // newest
    const ts3 = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // middle

    // Inserted in non-chronological order.
    seedEvents([
      { occurredAt: ts1, kind: "zip", absoluteOffset: 0, retryFailed: false },
      { occurredAt: ts2, kind: "exe", absoluteOffset: 0, retryFailed: false },
      { occurredAt: ts3, kind: "dmg", absoluteOffset: 0, retryFailed: false },
    ]);

    const stats = await getDownloadInterruptionStats();
    expect(stats.lastOccurredAt).toBe(ts2);
  });

  it("returns safe zero-value stats when the stored JSON is malformed", async () => {
    settingsStore.set(SETTING_EVENTS, "not-valid-json{{{");

    const stats = await getDownloadInterruptionStats();
    expect(stats.count24h).toBe(0);
    expect(stats.retryFailCount24h).toBe(0);
    expect(stats.lastOccurredAt).toBeNull();
  });

  it("counts only retryFailed:true events in retryFailCount24h", async () => {
    const now = Date.now();
    seedEvents([
      { occurredAt: new Date(now - 1000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: false },
      { occurredAt: new Date(now - 2000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: false },
      { occurredAt: new Date(now - 3000).toISOString(), kind: "zip", absoluteOffset: 0, retryFailed: false },
    ]);

    const stats = await getDownloadInterruptionStats();
    expect(stats.count24h).toBe(3);
    expect(stats.retryFailCount24h).toBe(0);
  });
});
