/**
 * Integration tests for RevenueCat webhook event handling (Task #433).
 *
 * Skipped when no DATABASE_URL is configured — same convention as other
 * api-server integration tests (doctors.test.ts, cases-similarity.test.ts).
 *
 * Each test:
 *  1. Inserts a subscription row with a known status and RC app user id.
 *  2. POSTs a RevenueCat webhook payload to /api/billing/webhook/revenuecat.
 *  3. Asserts both the resulting `status` and `paymentMethodOnFile` in the DB.
 *  4. Cleans up its own rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type { Express } from "express";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("RevenueCat webhook → subscription transitions (db integration)", () => {
  type DbMod = typeof import("@workspace/db");
  let db: DbMod["db"];
  let subs: DbMod["subscriptions"];
  let subEvents: DbMod["subscriptionEvents"];
  let app: Express;

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-rc-webhook";
    const dbMod = await import("@workspace/db");
    const appMod = await import("../app.js");
    db = dbMod.db;
    subs = dbMod.subscriptions;
    subEvents = dbMod.subscriptionEvents;
    app = appMod.default;
  });

  afterAll(async () => {
    /* Individual tests clean up their own rows. */
  });

  /** Insert a minimal subscription row and return its id. */
  async function insertSub(opts: {
    appUserId: string;
    status: string;
    paymentMethodOnFile?: boolean;
  }): Promise<string> {
    const subjectId = rid("subj");
    const [row] = await (db as any)
      .insert(subs)
      .values({
        subjectType: "user",
        subjectId,
        provider: "revenuecat",
        revenueCatAppUserId: opts.appUserId,
        status: opts.status,
        paymentMethodOnFile: opts.paymentMethodOnFile ?? false,
      })
      .returning();
    return row.id as string;
  }

  /** Fetch the subscription row by id. */
  async function fetchSub(id: string) {
    const [row] = await (db as any)
      .select()
      .from(subs)
      .where(eq(subs.id, id));
    return row as {
      status: string;
      paymentMethodOnFile: boolean;
      currentPeriodEnd: Date | null;
      gracePeriodStartAt: Date | null;
    };
  }

  /** Delete subscription rows (and their events) by id. */
  async function deleteSubs(ids: string[]) {
    await (db as any)
      .delete(subEvents)
      .where(inArray(subEvents.subscriptionId, ids));
    await (db as any)
      .delete(subs)
      .where(inArray(subs.id, ids));
  }

  /** Count subscription_events rows tied to a specific subscription id. */
  async function countEvents(subscriptionId: string): Promise<number> {
    const rows = await (db as any)
      .select()
      .from(subEvents)
      .where(eq(subEvents.subscriptionId, subscriptionId));
    return (rows as unknown[]).length;
  }

  /** Delete orphan subscription_events rows whose rawPayloadJson contains a given appUserId. */
  async function deleteOrphanEventsByAppUserId(appUserId: string) {
    await (db as any)
      .delete(subEvents)
      .where(
        sql`${subEvents.rawPayloadJson}->>'appUserId' = ${appUserId} AND ${subEvents.subscriptionId} IS NULL`
      );
  }

  /** Post a RevenueCat webhook payload. */
  function postRC(
    eventType: string,
    appUserId: string,
    extra: Record<string, unknown> = {}
  ) {
    return request(app)
      .post("/api/billing/webhook/revenuecat")
      .send({
        event: {
          type: eventType,
          app_user_id: appUserId,
          ...extra,
        },
      });
  }

  it("INITIAL_PURCHASE transitions trialing → active and sets paymentMethodOnFile=true", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "trialing",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("INITIAL_PURCHASE", appUserId);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("INITIAL_PURCHASE on already-active sub keeps status=active and sets paymentMethodOnFile=true", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "active",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("INITIAL_PURCHASE", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("RENEWAL transitions grace → active and sets paymentMethodOnFile=true", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "grace",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("RENEWAL", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("RENEWAL sets currentPeriodEnd when expiration_at_ms is provided", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "past_due",
      paymentMethodOnFile: false,
    });
    const futureMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    try {
      const res = await postRC("RENEWAL", appUserId, {
        expiration_at_ms: futureMs,
      });
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);
      expect(row.currentPeriodEnd).not.toBeNull();
      const periodEnd = new Date(row.currentPeriodEnd!).getTime();
      expect(Math.abs(periodEnd - futureMs)).toBeLessThan(1000);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("PRODUCT_CHANGE transitions locked → active and sets paymentMethodOnFile=true", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "locked",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("PRODUCT_CHANGE", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("CANCELLATION transitions active → grace and does NOT clear paymentMethodOnFile", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "active",
      paymentMethodOnFile: true,
    });
    try {
      const res = await postRC("CANCELLATION", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("grace");
      expect(row.gracePeriodStartAt).not.toBeNull();
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("EXPIRATION transitions active → grace and does NOT clear paymentMethodOnFile", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "active",
      paymentMethodOnFile: true,
    });
    try {
      const res = await postRC("EXPIRATION", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("grace");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("EXPIRATION transitions past_due → grace and does NOT clear paymentMethodOnFile", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "past_due",
      paymentMethodOnFile: true,
    });
    try {
      const res = await postRC("EXPIRATION", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("grace");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("EXPIRATION on trialing sub does NOT change status or paymentMethodOnFile (guard clause)", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "trialing",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("EXPIRATION", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("trialing");
      expect(row.paymentMethodOnFile).toBe(false);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("BILLING_ISSUE transitions active → past_due and does NOT clear paymentMethodOnFile", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "active",
      paymentMethodOnFile: true,
    });
    try {
      const res = await postRC("BILLING_ISSUE", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("past_due");
      expect(row.paymentMethodOnFile).toBe(true);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("BILLING_ISSUE on non-active sub does NOT change status or paymentMethodOnFile (guard clause)", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "trialing",
      paymentMethodOnFile: false,
    });
    try {
      const res = await postRC("BILLING_ISSUE", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("trialing");
      expect(row.paymentMethodOnFile).toBe(false);
    } finally {
      await deleteSubs([subId]);
    }
  });

  it("missing app_user_id returns 400", async () => {
    const res = await request(app)
      .post("/api/billing/webhook/revenuecat")
      .send({ event: { type: "INITIAL_PURCHASE" } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("unknown app_user_id returns 200 without crashing (orphan event written and cleaned up)", async () => {
    const unknownUserId = rid("nonexistent");
    try {
      const res = await postRC("INITIAL_PURCHASE", unknownUserId);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      await deleteOrphanEventsByAppUserId(unknownUserId);
    }
  });

  it("unrecognised event type on known sub does NOT change status or paymentMethodOnFile, and appends a subscriptionEvent row", async () => {
    const appUserId = rid("rc");
    const subId = await insertSub({
      appUserId,
      status: "active",
      paymentMethodOnFile: true,
    });
    try {
      const eventsBefore = await countEvents(subId);

      const res = await postRC("SOME_FUTURE_EVENT", appUserId);
      expect(res.status).toBe(200);

      const row = await fetchSub(subId);
      expect(row.status).toBe("active");
      expect(row.paymentMethodOnFile).toBe(true);

      const eventsAfter = await countEvents(subId);
      expect(eventsAfter).toBe(eventsBefore + 1);
    } finally {
      await deleteSubs([subId]);
    }
  });
});
