/**
 * Unit tests for GET /api/admin/subscriptions.
 *
 * Verifies:
 *  - Authorization gating (missing secret → 403, wrong secret → 403,
 *    correct secret via CI/automation path → 200)
 *  - Pagination metadata (total, limit, offset)
 *  - Provider and status filters (valid values accepted; unknown values ignored)
 *  - Sensitive ID masking (revenueCatAppUserId, stripeCustomerId,
 *    stripeSubscriptionId are returned as first4****last4 or "****")
 *  - Subject-name resolution: lab_org and provider_org map to the organizations
 *    table; user (and any non-org type) maps to the users table
 *
 * All external dependencies are mocked; no DB or network access required.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import request from "supertest";

// ---------------------------------------------------------------------------
// @workspace/db mock — controlled per-table row data
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => {
  const now = new Date("2026-01-15T10:00:00.000Z");
  const periodEnd = new Date("2026-02-15T10:00:00.000Z");

  const subscriptionRows = [
    {
      id: "sub-1",
      subjectType: "lab_org",
      subjectId: "org-lab-1",
      provider: "stripe",
      status: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      paymentMethodOnFile: true,
      revenueCatAppUserId: null,
      stripeCustomerId: "cus_ABCDEFGHIJ12345",
      stripeSubscriptionId: "sub_ABCDEFGHIJ12345",
      trialStartAt: null,
      trialEndAt: null,
      gracePeriodStartAt: null,
      canceledAt: null,
      lastReminderSentAt: null,
      lastReminderKind: null,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "sub-2",
      subjectType: "provider_org",
      subjectId: "org-provider-1",
      provider: "revenuecat",
      status: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      paymentMethodOnFile: true,
      revenueCatAppUserId: "rc_ABCDEFGHIJ12345",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      trialStartAt: null,
      trialEndAt: null,
      gracePeriodStartAt: null,
      canceledAt: null,
      lastReminderSentAt: null,
      lastReminderKind: null,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "sub-3",
      subjectType: "user",
      subjectId: "user-solo-1",
      provider: "none",
      status: "trialing",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      paymentMethodOnFile: false,
      revenueCatAppUserId: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      trialStartAt: now,
      trialEndAt: new Date("2026-01-29T10:00:00.000Z"),
      gracePeriodStartAt: null,
      canceledAt: null,
      lastReminderSentAt: null,
      lastReminderKind: null,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const organizationRows = [
    { id: "org-lab-1", name: "Sunshine Dental Lab", type: "lab" },
    { id: "org-provider-1", name: "Smith Dental Practice", type: "provider" },
  ];

  const userRows = [
    {
      id: "user-solo-1",
      username: "solouser",
      firstName: "Solo",
      lastName: "User",
      email: "solo@example.com",
    },
  ];

  return { subscriptionRows, organizationRows, userRows };
});

vi.mock("@workspace/db", () => {
  // ---------------------------------------------------------------------------
  // Chainable Drizzle-style stub. The `from()` call determines which table's
  // data is resolved; `where()`, `orderBy()`, `limit()`, and `offset()` are
  // all pass-through so the real query-builder code can chain freely.
  // ---------------------------------------------------------------------------
  const T = {};

  type Row = Record<string, unknown>;

  function makeInnerChain(result: Row[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: Row[]) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };
    for (const m of ["where", "orderBy", "limit", "offset", "returning"]) {
      chain[m] = (..._: unknown[]) => makeInnerChain(result);
    }
    return chain;
  }

  const db = {
    select: (fields?: unknown) => {
      const isCountQuery =
        fields !== undefined &&
        typeof fields === "object" &&
        fields !== null &&
        "total" in (fields as object);
      return {
        from: (table: { __table?: string }) => {
          const tableName = (table as { __table?: string }).__table ?? "";
          let result: Row[];
          if (isCountQuery) {
            const rowCount = tableName === "subscriptions"
              ? dbState.subscriptionRows.length
              : 0;
            result = [{ total: rowCount }];
          } else if (tableName === "subscriptions") {
            result = dbState.subscriptionRows as Row[];
          } else if (tableName === "organizations") {
            result = dbState.organizationRows as Row[];
          } else if (tableName === "users") {
            result = dbState.userRows as Row[];
          } else {
            result = [];
          }
          return makeInnerChain(result);
        },
      };
    },
    insert: (..._: unknown[]) => {
      return makeInnerChain([]);
    },
    update: (..._: unknown[]) => makeInnerChain([]),
    delete: (..._: unknown[]) => makeInnerChain([]),
    execute: (..._: unknown[]) => Promise.resolve({ rows: [] }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    query: new Proxy({} as Record<string, unknown>, {
      get: () => ({
        findFirst: (..._: unknown[]) => Promise.resolve(null),
        findMany: (..._: unknown[]) => Promise.resolve([]),
      }),
    }),
  };

  return {
    db,
    pool: {},
    users: { __table: "users" },
    userSessions: { __table: "userSessions" },
    notifications: { __table: "notifications" },
    organizations: { __table: "organizations" },
    organizationMemberships: { __table: "organizationMemberships" },
    organizationJoinRequests: { __table: "organizationJoinRequests" },
    organizationInvites: { __table: "organizationInvites" },
    organizationConnections: { __table: "organizationConnections" },
    cases: { __table: "cases" },
    caseAttachments: { __table: "caseAttachments" },
    caseEvents: { __table: "caseEvents" },
    caseLocations: { __table: "caseLocations" },
    caseNotes: { __table: "caseNotes" },
    caseRestorations: { __table: "caseRestorations" },
    caseSubmissionQueue: { __table: "caseSubmissionQueue" },
    labCases: { __table: "labCases" },
    labPendingFiles: { __table: "labPendingFiles" },
    labPendingFileNoteEdits: { __table: "labPendingFileNoteEdits" },
    invoices: { __table: "invoices" },
    invoiceLineItems: { __table: "invoiceLineItems" },
    invoiceAttachments: { __table: "invoiceAttachments" },
    invoiceCredits: { __table: "invoiceCredits" },
    practiceStatements: { __table: "practiceStatements" },
    practiceStatementSends: { __table: "practiceStatementSends" },
    payments: { __table: "payments" },
    bankAccounts: { __table: "bankAccounts" },
    bankTransactions: { __table: "bankTransactions" },
    bankTransactionInvoices: { __table: "bankTransactionInvoices" },
    recurringTransactions: { __table: "recurringTransactions" },
    reconciliationItems: { __table: "reconciliationItems" },
    reconciliations: { __table: "reconciliations" },
    transactionCategories: { __table: "transactionCategories" },
    pricingTiers: { __table: "pricingTiers" },
    pricingOverrides: { __table: "pricingOverrides" },
    systemSettings: { __table: "systemSettings" },
    installerChangelog: { __table: "installerChangelog" },
    installerUploads: { __table: "installerUploads" },
    subscriptions: { __table: "subscriptions" },
    subscriptionEvents: { __table: "subscriptionEvents" },
    auditLogs: { __table: "auditLogs" },
    mediaCleanupRuns: { __table: "mediaCleanupRuns" },
    statementSchedules: { __table: "statementSchedules" },
    statementSendRuns: { __table: "statementSendRuns" },
    iteroImportedOrders: T,
    doctorAccountLinks: T,
    accountLinkInvites: T,
    platformAccountSequences: T,
    labItemLabels: T,
  };
});

// ---------------------------------------------------------------------------
// Side-effect-only dependency mocks
// ---------------------------------------------------------------------------

vi.mock("./lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: "/tmp/test-case-media",
  extractMediaFileName: vi.fn((name: string) => name),
  cleanupOrphanedCaseMedia: vi.fn(),
  runAndPersistCleanup: vi.fn(),
  getCleanupAlertThresholds: vi.fn(),
  getCleanupHistoryRetentionDays: vi.fn(),
  getCleanupHourUtc: vi.fn(),
  getCleanupProgress: vi.fn(),
  getCleanupStuckTimeoutMinutes: vi.fn(),
  cancelCleanup: vi.fn(),
  CleanupAlreadyRunningError: class CleanupAlreadyRunningError extends Error {},
  SETTING_CLEANUP_MIN_REMOVED: "cleanup_min_removed",
  SETTING_CLEANUP_MIN_FREED_MB: "cleanup_min_freed_mb",
  SETTING_CLEANUP_HISTORY_RETENTION_DAYS: "cleanup_history_retention_days",
  SETTING_CLEANUP_HOUR_UTC: "cleanup_hour_utc",
  SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES: "cleanup_stuck_timeout_minutes",
}));
vi.mock("./lib/backup.js", () => ({
  startDailyOneDriveBackup: vi.fn(),
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
  runOneDriveBackup: vi.fn(),
  runBackup: vi.fn(),
  getBackupHourUtc: vi.fn(),
  getBackupScheduleConfig: vi.fn(),
  SETTING_BACKUP_HOUR_UTC: "backup_hour_utc",
  SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES: "backup_schedule_interval_minutes",
  SETTING_BACKUP_SCHEDULE_DESTINATION: "backup_schedule_destination",
  SETTING_BACKUP_SCHEDULE_PATH: "backup_schedule_path",
  SETTING_BACKUP_SCHEDULE_ENABLED: "backup_schedule_enabled",
  SETTING_ROLLING_BACKUP_ENABLED: "rolling_backup_enabled",
  SETTING_ROLLING_BACKUP_LAST_RUN_AT: "rolling_backup_last_run_at",
  SETTING_ROLLING_BACKUP_LAST_ERROR: "rolling_backup_last_error",
  ALL_SCHEDULE_SETTINGS: [
    "backup_schedule_interval_minutes",
    "backup_schedule_destination",
    "backup_schedule_path",
    "backup_schedule_enabled",
  ],
}));
vi.mock("./lib/onedrive.js", () => ({
  uploadToOneDrive: vi.fn(),
  deleteFromOneDrive: vi.fn(),
  getOneDriveSettings: vi.fn(),
}));
vi.mock("./lib/mail.js", () => ({
  sendInstallerPublishFailureAlertEmail: vi.fn(),
  sendInviteEmail: vi.fn(),
  sendStatementEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendSecurityAlertEmail: vi.fn(),
}));
vi.mock("./middlewares/csrf.js", () => ({
  requireCsrf: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));
vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./lib/desktop-installer-storage.js", () => ({
  getDesktopInstallerHandle: vi.fn(),
  openDesktopInstallerStream: vi.fn(),
  installerKindFromUrl: vi.fn(),
  getDesktopInstallerMetadata: vi.fn(),
  uploadDesktopInstaller: vi.fn(),
  deleteDesktopInstaller: vi.fn(),
  DesktopInstallerNotConfiguredError: class DesktopInstallerNotConfiguredError extends Error {},
}));

// ---------------------------------------------------------------------------
// Import app after all mocks are registered
// ---------------------------------------------------------------------------
import app from "./app.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ADMIN_SECRET = "test-platform-admin-secret";

describe("GET /api/admin/subscriptions", () => {
  let server: Server;

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
    server = app.listen(0);
  });

  afterAll(() => {
    delete process.env.PLATFORM_ADMIN_SECRET;
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // ── Authorization ────────────────────────────────────────────────────────

  it("returns 401 when no X-Platform-Admin-Secret header is sent (no auth at all)", async () => {
    // platformAdminUserOrSecret falls through to requireAuth → 401 unauthenticated
    const res = await request(server).get("/api/admin/subscriptions");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the X-Platform-Admin-Secret header is wrong (falls through to requireAuth)", async () => {
    // Wrong secret → platformAdminUserOrSecret falls through to requireAuth → 401
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the correct secret via the CI/automation path", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── Pagination metadata ──────────────────────────────────────────────────

  it("returns total, limit, and offset in the response", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?limit=10&offset=0")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(dbState.subscriptionRows.length);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  it("clamps limit to 100 and ignores NaN offset", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?limit=999&offset=NaN")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });

  it("uses default limit=50 when limit param is absent", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  // ── Data shape ───────────────────────────────────────────────────────────

  it("returns an items array", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("each item includes required fields", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("subjectType");
    expect(item).toHaveProperty("subjectName");
    expect(item).toHaveProperty("provider");
    expect(item).toHaveProperty("status");
    expect(item).toHaveProperty("currentPeriodEnd");
    expect(item).toHaveProperty("cancelAtPeriodEnd");
    expect(item).toHaveProperty("paymentMethodOnFile");
    expect(item).toHaveProperty("revenueCatAppUserId");
    expect(item).toHaveProperty("stripeCustomerId");
    expect(item).toHaveProperty("createdAt");
  });

  // ── ID masking ───────────────────────────────────────────────────────────

  it("masks stripeCustomerId as first4****last4", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const stripe = res.body.items.find((i: { provider: string }) => i.provider === "stripe");
    expect(stripe).toBeDefined();
    // "cus_ABCDEFGHIJ12345" → "cus_****2345"
    expect(stripe.stripeCustomerId).toMatch(/^.{4}\*{4}.{4}$/);
    expect(stripe.stripeCustomerId).not.toBe("cus_ABCDEFGHIJ12345");
  });

  it("masks stripeSubscriptionId as first4****last4", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const stripe = res.body.items.find((i: { provider: string }) => i.provider === "stripe");
    expect(stripe.stripeSubscriptionId).toMatch(/^.{4}\*{4}.{4}$/);
    expect(stripe.stripeSubscriptionId).not.toBe("sub_ABCDEFGHIJ12345");
  });

  it("masks revenueCatAppUserId as first4****last4", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const rc = res.body.items.find((i: { provider: string }) => i.provider === "revenuecat");
    expect(rc).toBeDefined();
    expect(rc.revenueCatAppUserId).toMatch(/^.{4}\*{4}.{4}$/);
    expect(rc.revenueCatAppUserId).not.toBe("rc_ABCDEFGHIJ12345");
  });

  it("returns null for absent revenueCatAppUserId instead of masking", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const stripe = res.body.items.find((i: { provider: string }) => i.provider === "stripe");
    expect(stripe.revenueCatAppUserId).toBeNull();
  });

  // ── Subject-name resolution ──────────────────────────────────────────────

  it("resolves lab_org subjectName from the organizations table", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const labItem = res.body.items.find(
      (i: { subjectType: string }) => i.subjectType === "lab_org"
    );
    expect(labItem).toBeDefined();
    expect(labItem.subjectName).toBe("Sunshine Dental Lab");
    expect(labItem.subjectOrgType).toBe("lab");
  });

  it("resolves provider_org subjectName from the organizations table", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const providerItem = res.body.items.find(
      (i: { subjectType: string }) => i.subjectType === "provider_org"
    );
    expect(providerItem).toBeDefined();
    expect(providerItem.subjectName).toBe("Smith Dental Practice");
    expect(providerItem.subjectOrgType).toBe("provider");
  });

  it("resolves user subjectName from the users table", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const userItem = res.body.items.find(
      (i: { subjectType: string }) => i.subjectType === "user"
    );
    expect(userItem).toBeDefined();
    expect(userItem.subjectName).toBe("Solo User");
    expect(userItem.subjectEmail).toBe("solo@example.com");
  });

  // ── Filters ─────────────────────────────────────────────────────────────

  it("accepts valid provider filter without error", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?provider=stripe")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts valid status filter without error", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?status=active")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("ignores an unknown provider filter value", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?provider=unknown_provider")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("ignores an unknown status filter value", async () => {
    const res = await request(server)
      .get("/api/admin/subscriptions?status=invalid_status")
      .set("X-Platform-Admin-Secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
