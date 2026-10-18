import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  queryMock,
  releaseMock,
  reconcileMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  reconcileMock: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { connect: connectMock },
  bankAccounts: {},
  bankTransactions: {},
  invoices: {},
  notifications: {},
  organizationMemberships: {},
  organizations: {},
  providerAutoPayAttempts: {},
  providerAutopayAuthorizations: {},
  providerAutopayAuthorizationLabs: {},
  providerPaymentAllocations: {},
  providerPaymentCheckouts: {},
  providerPaymentCustomers: {},
  subscriptions: {},
  users: {},
}));

vi.mock("./rbac", () => ({ ADMIN_ROLES: [] }));
vi.mock("./entitlement", () => ({
  appendSubscriptionEvent: vi.fn(),
  expiredTrialTransition: vi.fn(),
  transitionSubscription: vi.fn(),
}));
vi.mock("./mail", () => ({ sendMail: vi.fn() }));
vi.mock("./backup", () => ({ checkAndAlertBackupStaleness: vi.fn() }));
vi.mock("./email-prefs", () => ({ checkEmailPref: vi.fn() }));
vi.mock("./installer-health-job", () => ({
  checkAndAlertInstallerHealth: vi.fn(),
  startInstallerHealthCheckJob: vi.fn(),
}));
vi.mock("./ai-memory-cleanup", () => ({ cleanupAiMemoryCandidates: vi.fn() }));
vi.mock("./provider-invoice-payments", () => ({
  chargeProviderAutoPayCheckout: vi.fn(),
  completeProviderAutoPayAttempt: vi.fn(),
  getProviderDefaultCard: vi.fn(),
}));
vi.mock("./stripeClient", () => ({ getUncachableStripeClient: vi.fn() }));
vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("../routes/payment-sessions.js", () => ({
  reconcileExpiredInlineCardReservations: reconcileMock,
}));

import { runExpiredInlineCardReconciliationOnce } from "./billing-jobs.js";

describe("scheduled inline card reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [{ acquired: true }] });
    connectMock.mockResolvedValue({
      query: queryMock,
      release: releaseMock,
    });
    reconcileMock.mockResolvedValue({
      found: 0,
      succeeded: 0,
      released: 0,
      deferred: 0,
    });
  });

  it("runs under the advisory lock and releases its pooled connection", async () => {
    await runExpiredInlineCardReconciliationOnce();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      ["labtrax:inline-card-reconciliation"],
    );
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock(hashtext($1))",
      ["labtrax:inline-card-reconciliation"],
    );
    expect(releaseMock).toHaveBeenCalledWith(false);
  });

  it("skips work when another API instance owns the advisory lock", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    await runExpiredInlineCardReconciliationOnce();

    expect(reconcileMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(false);
  });

  it("does not overlap scheduled passes in one API instance", async () => {
    let finish: (() => void) | undefined;
    reconcileMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      finish = () => resolve();
    }));

    const first = runExpiredInlineCardReconciliationOnce();
    await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
    await runExpiredInlineCardReconciliationOnce();
    expect(connectMock).toHaveBeenCalledTimes(1);

    finish?.();
    await first;
  });
});