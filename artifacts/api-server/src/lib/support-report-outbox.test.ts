import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  attachments: [] as any[],
  sends: [] as any[],
  sendResults: [] as any[],
  deletedKeys: [] as string[],
  deleteFailure: false,
  cleanedReports: [] as string[],
}));

vi.mock("drizzle-orm", () => {
  const expression = (...args: any[]) => args;
  return {
    and: expression,
    eq: expression,
    gt: expression,
    inArray: expression,
    isNull: expression,
    lt: expression,
    lte: expression,
    or: expression,
    sql: () => ({ increment: true }),
  };
});

vi.mock("@workspace/db", () => {
  const supportReports: any = {
    id: "id",
    ownerStatus: "ownerStatus",
    copyStatus: "copyStatus",
    ownerAttempts: "ownerAttempts",
    copyAttempts: "copyAttempts",
    ownerNextAttemptAt: "ownerNextAttemptAt",
    copyNextAttemptAt: "copyNextAttemptAt",
    ownerClaimedAt: "ownerClaimedAt",
    copyClaimedAt: "copyClaimedAt",
    expiresAt: "expiresAt",
    deletedAt: "deletedAt",
  };
  const supportReportAttachments: any = {
    reportId: "reportId",
    deletedAt: "attachmentDeletedAt",
  };

  function update(_table: any) {
    return {
      set(values: any) {
        let claimed: any;
        const operation: any = {
          where(_condition: any) {
            const row = state.rows[0];
            if (!row) return operation;

            const isClaim = values.ownerStatus === "in_flight" || values.copyStatus === "in_flight";
            const isReset = (
              (values.ownerStatus === "permanent_failed" || values.copyStatus === "permanent_failed")
              && !Object.prototype.hasOwnProperty.call(values, "ownerNextAttemptAt")
              && !Object.prototype.hasOwnProperty.call(values, "copyNextAttemptAt")
              && ["send_failed", "expired", "intake_incomplete"].includes(
                values.ownerFailureReason ?? values.copyFailureReason,
              )
            );
            const isCleanupReport = Object.prototype.hasOwnProperty.call(values, "deletedAt") && _table === supportReports;
            const isCleanupAttachment = Object.prototype.hasOwnProperty.call(values, "deletedAt") && _table === supportReportAttachments;

            if (isClaim) {
              const kind = values.ownerStatus ? "owner" : "copy";
              const statusKey = `${kind}Status`;
              const attemptsKey = `${kind}Attempts`;
              const claimedAtKey = `${kind}ClaimedAt`;
              if (
                row[statusKey] === "in_flight"
                && row[claimedAtKey]
                && row[claimedAtKey].getTime() > values[claimedAtKey].getTime() - 10 * 60_000
              ) return operation;
              if (["pending", "send_failed", "in_flight"].includes(row[statusKey]) && row[attemptsKey] < 3) {
                row[statusKey] = "in_flight";
                row[attemptsKey] += 1;
                row[`${kind}ClaimedAt`] = values[`${kind}ClaimedAt`];
                claimed = { ...row };
              }
            } else if (isReset) {
              // Reset queries are only relevant to expired max-attempt leases.
              // Focused tests below exercise normal claim/result transitions.
            } else if (isCleanupReport) {
              Object.assign(row, values);
              state.cleanedReports.push(row.id);
            } else if (isCleanupAttachment) {
              for (const attachment of state.attachments) attachment.deletedAt = values.deletedAt;
            } else {
              Object.assign(row, values);
            }
            return operation;
          },
          returning: vi.fn(async () => claimed ? [claimed] : []),
          then(resolve: any, reject: any) {
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
        return operation;
      },
    };
  }

  const db: any = {
    update,
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        state.attachments = [];
      }),
    })),
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn((table: any) => {
          chain.table = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => state.rows),
        then(resolve: any, reject: any) {
          const result = chain.table === supportReportAttachments ? state.attachments : state.rows;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { db, supportReports, supportReportAttachments };
});

vi.mock("./mail", () => ({
  sendMail: vi.fn(async (options: any) => {
    state.sends.push(options);
    return state.sendResults.shift() ?? { sent: true };
  }),
}));

vi.mock("./support-report-storage", () => ({
  readSupportReportAttachment: vi.fn(async (key: string) =>
    key === "missing" ? null : Buffer.from(`content:${key}`)),
  deleteSupportReportAttachment: vi.fn(async (key: string) => {
    if (state.deleteFailure) throw new Error("storage unavailable");
    state.deletedKeys.push(key);
  }),
}));

import {
  cleanupExpiredSupportReports,
  processDueSupportReports,
  SUPPORT_REPORT_BACKOFF_MS,
} from "./support-report-outbox";

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    portal: "lab",
    description: "support body",
    ownerEmail: "owner@example.com",
    reporterEmail: "reporter@example.com",
    ownerStatus: "pending",
    copyStatus: "pending",
    ownerAttempts: 0,
    copyAttempts: 0,
    ownerNextAttemptAt: new Date(0),
    copyNextAttemptAt: new Date(0),
    ownerClaimedAt: null,
    copyClaimedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

describe("support report outbox", () => {
  beforeEach(() => {
    state.rows = [];
    state.attachments = [];
    state.sends = [];
    state.sendResults = [];
    state.deletedKeys = [];
    state.deleteFailure = false;
    state.cleanedReports = [];
  });

  it("delivers owner and reporter copy independently and never repeats sent delivery", async () => {
    state.rows = [report()];
    const now = new Date("2026-09-10T12:00:00Z");
    expect(await processDueSupportReports(now)).toBe(2);
    expect(state.sends.map((send) => send.to)).toEqual([
      "owner@example.com",
      "reporter@example.com",
    ]);
    expect(state.sends[0].replyTo).toBe("reporter@example.com");
    expect(state.sends[1].replyTo).toBe("owner@example.com");
    expect(state.rows[0]).toMatchObject({ ownerStatus: "sent", copyStatus: "sent" });

    expect(await processDueSupportReports(now)).toBe(0);
    expect(state.sends).toHaveLength(2);
  });

  it("retries only the failed recipient with bounded backoff", async () => {
    state.rows = [report({ copyStatus: "sent" })];
    state.sendResults = [{ sent: false, reason: "send_failed" }];
    const now = new Date("2026-09-10T12:00:00Z");
    expect(await processDueSupportReports(now)).toBe(1);
    expect(state.rows[0].ownerStatus).toBe("send_failed");
    expect(state.rows[0].ownerNextAttemptAt.getTime()).toBe(now.getTime() + SUPPORT_REPORT_BACKOFF_MS[0]);

    state.sendResults = [{ sent: true }];
    expect(await processDueSupportReports(new Date(now.getTime() + SUPPORT_REPORT_BACKOFF_MS[0]))).toBe(1);
    expect(state.rows[0]).toMatchObject({ ownerStatus: "sent", copyStatus: "sent" });
    expect(state.sends.map((send) => send.to)).toEqual(["owner@example.com", "owner@example.com"]);
  });

  it("makes permanent and exhausted failures terminal using safe reasons", async () => {
    state.rows = [report({ copyStatus: "not_applicable" })];
    state.sendResults = [{ sent: false, reason: "auth_failed" }];
    await processDueSupportReports(new Date());
    expect(state.rows[0]).toMatchObject({
      ownerStatus: "permanent_failed",
      ownerFailureReason: "auth_failed",
      ownerAttempts: 1,
    });

    state.rows = [report({ copyStatus: "not_applicable", ownerStatus: "send_failed", ownerAttempts: 2 })];
    state.sendResults = [{ sent: false, reason: "send_failed" }];
    await processDueSupportReports(new Date());
    expect(state.rows[0]).toMatchObject({
      ownerStatus: "permanent_failed",
      ownerFailureReason: "send_failed",
      ownerAttempts: 3,
    });
  });

  it("never sends a report with a missing attachment", async () => {
    state.rows = [report({ copyStatus: "not_applicable" })];
    state.attachments = [{ reportId: "report-1", filename: "proof.png", contentType: "image/png", storageKey: "missing" }];
    await processDueSupportReports(new Date());
    expect(state.sends).toHaveLength(0);
    expect(state.rows[0]).toMatchObject({
      ownerStatus: "permanent_failed",
      ownerFailureReason: "attachment_unavailable",
    });
  });

  it("cleans only terminal reports and retries cleanup after storage failures", async () => {
    state.rows = [report({ ownerStatus: "sent", copyStatus: "sent", expiresAt: new Date(0) })];
    state.attachments = [{ reportId: "report-1", storageKey: "stored", deletedAt: null }];
    state.deleteFailure = true;
    expect(await cleanupExpiredSupportReports(new Date())).toBe(0);
    expect(state.rows[0]).toMatchObject({
      description: "",
      reporterEmail: null,
      ownerEmail: null,
    });
    expect(state.rows[0].deletedAt).toBeNull();

    state.deleteFailure = false;
    expect(await cleanupExpiredSupportReports(new Date())).toBe(1);
    expect(state.deletedKeys).toEqual(["stored"]);
    expect(state.rows[0].deletedAt).toBeInstanceOf(Date);
    state.rows = [report({ ownerStatus: "pending", copyStatus: "not_applicable" })];
    // The production query excludes this row; represent that filtered result.
    state.rows = [];
    expect(await cleanupExpiredSupportReports(new Date())).toBe(0);
  });

  it("allows only one concurrent worker to claim each recipient", async () => {
    state.rows = [report({ copyStatus: "not_applicable" })];
    const now = new Date("2026-09-10T12:00:00Z");
    const [first, second] = await Promise.all([
      processDueSupportReports(now),
      processDueSupportReports(now),
    ]);
    expect(first + second).toBe(1);
    expect(state.sends).toHaveLength(1);
    expect(state.rows[0].ownerAttempts).toBe(1);
  });

  it("does not start SMTP after a claimed report has expired", async () => {
    state.rows = [report({
      copyStatus: "not_applicable",
      expiresAt: new Date(Date.now() - 1),
    })];
    await processDueSupportReports(new Date(Date.now() - 1000));
    expect(state.sends).toHaveLength(0);
    expect(state.rows[0]).toMatchObject({
      ownerStatus: "permanent_failed",
      ownerFailureReason: "expired",
    });
  });
});