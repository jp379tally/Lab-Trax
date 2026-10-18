import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const transport = vi.hoisted(() => ({
  sends: [] as Array<{ to: string }>,
  deletedKeys: [] as string[],
  failDeletion: false,
}));

vi.mock("./mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mail.js")>()),
  sendMail: vi.fn(async (options: { to: string }) => {
    transport.sends.push(options);
    return { sent: true };
  }),
}));

vi.mock("./support-report-storage.js", () => ({
  readSupportReportAttachment: vi.fn(async () => Buffer.from("attachment")),
  deleteSupportReportAttachment: vi.fn(async (key: string) => {
    if (transport.failDeletion) throw new Error("simulated storage deletion failure");
    transport.deletedKeys.push(key);
  }),
}));

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);
const suite = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

suite("support report outbox (db integration)", () => {
  let dbModule: typeof import("@workspace/db");
  let outbox: typeof import("./support-report-outbox.js");
  let persistSupportReportIntake: typeof import("./support-report-intake.js").persistSupportReportIntake;
  const userId = rid("support_user");
  const organizationId = rid("support_org");
  const reportIds: string[] = [];

  beforeAll(async () => {
    dbModule = await import("@workspace/db");
    outbox = await import("./support-report-outbox.js");
    ({ persistSupportReportIntake } = await import("./support-report-intake.js"));
    await dbModule.db.insert(dbModule.users).values({
      id: userId,
      username: rid("support_reporter"),
      password: "integration-test-only",
      email: "reporter@example.com",
    });
    await dbModule.db.insert(dbModule.organizations).values({
      id: organizationId,
      type: "lab",
      name: "Support outbox integration lab",
    });
  });

  beforeEach(() => {
    transport.sends = [];
    transport.deletedKeys = [];
    transport.failDeletion = false;
  });

  afterEach(async () => {
    if (!reportIds.length) return;
    await dbModule.db.delete(dbModule.supportReports)
      .where(inArray(dbModule.supportReports.id, reportIds.splice(0)));
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    await dbModule.db.delete(dbModule.organizations).where(eq(dbModule.organizations.id, organizationId));
    await dbModule.db.delete(dbModule.users).where(eq(dbModule.users.id, userId));
  });

  function report(overrides: Partial<typeof dbModule.supportReports.$inferInsert> = {}) {
    const id = rid("support_report");
    reportIds.push(id);
    return {
      id,
      reporterUserId: userId,
      organizationId,
      portal: "lab",
      description: "Database integration support report",
      reporterEmail: "reporter@example.com",
      ownerEmail: "owner@example.com",
      ownerStatus: "pending",
      copyStatus: "pending",
      ownerNextAttemptAt: new Date(0),
      copyNextAttemptAt: new Date(0),
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      ...overrides,
    } satisfies typeof dbModule.supportReports.$inferInsert;
  }

  it("stores one report when the same idempotency key is submitted concurrently", async () => {
    const idempotencyKey = rid("idem");
    const first = report({ idempotencyKey });
    const second = report({ idempotencyKey });

    const results = await Promise.all([
      persistSupportReportIntake(first, []),
      persistSupportReportIntake(second, []),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await dbModule.db.select({ id: dbModule.supportReports.id })
      .from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.idempotencyKey, idempotencyKey));
    expect(stored).toHaveLength(1);
  });

  it("rolls back report intake when attachment metadata fails and allows retry", async () => {
    const existing = report();
    const conflictingStorageKey = rid("storage");
    await dbModule.db.insert(dbModule.supportReports).values(existing);
    await dbModule.db.insert(dbModule.supportReportAttachments).values({
      reportId: existing.id,
      filename: "existing.png",
      contentType: "image/png",
      size: 42,
      storageKey: conflictingStorageKey,
    });

    const idempotencyKey = rid("idem");
    const intake = report({ idempotencyKey });
    await expect(persistSupportReportIntake(intake, [{
      filename: "conflicting.png",
      contentType: "image/png",
      size: 24,
      storageKey: conflictingStorageKey,
    }])).rejects.toThrow();

    expect(await dbModule.db.select().from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.idempotencyKey, idempotencyKey))).toHaveLength(0);
    expect(await dbModule.db.select().from(dbModule.supportReportAttachments)
      .where(eq(dbModule.supportReportAttachments.reportId, intake.id))).toHaveLength(0);

    const retryStorageKey = rid("storage");
    await expect(persistSupportReportIntake(intake, [{
      filename: "retry.png",
      contentType: "image/png",
      size: 24,
      storageKey: retryStorageKey,
    }])).resolves.toBe(true);

    expect(await dbModule.db.select().from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.idempotencyKey, idempotencyKey))).toHaveLength(1);
    const retryAttachments = await dbModule.db.select()
      .from(dbModule.supportReportAttachments)
      .where(eq(dbModule.supportReportAttachments.reportId, intake.id));
    expect(retryAttachments).toHaveLength(1);
    expect(retryAttachments[0]?.storageKey).toBe(retryStorageKey);
  });

  it("allows two racing workers to claim each recipient only once", async () => {
    await dbModule.db.insert(dbModule.supportReports).values(report());
    const now = new Date("2026-09-11T12:00:00Z");

    const attempts = await Promise.all([
      outbox.processDueSupportReports(now),
      outbox.processDueSupportReports(now),
    ]);

    expect(attempts[0] + attempts[1]).toBe(2);
    expect(transport.sends.map((send) => send.to).sort()).toEqual([
      "owner@example.com",
      "reporter@example.com",
    ]);
    const [stored] = await dbModule.db.select().from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.id, reportIds[0]!));
    expect(stored).toMatchObject({
      ownerStatus: "sent",
      copyStatus: "sent",
      ownerAttempts: 1,
      copyAttempts: 1,
    });
  });

  it("scrubs expired content before storage deletion fails and finishes cleanup later", async () => {
    const expired = report({
      ownerStatus: "sent",
      copyStatus: "sent",
      expiresAt: new Date(0),
    });
    await dbModule.db.insert(dbModule.supportReports).values(expired);
    const storageKey = rid("storage");
    await dbModule.db.insert(dbModule.supportReportAttachments).values({
      reportId: expired.id,
      filename: "evidence.png",
      contentType: "image/png",
      size: 42,
      storageKey,
    });

    transport.failDeletion = true;
    expect(await outbox.cleanupExpiredSupportReports(new Date())).toBe(0);

    const [scrubbed] = await dbModule.db.select().from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.id, expired.id));
    const [scrubbedAttachment] = await dbModule.db.select()
      .from(dbModule.supportReportAttachments)
      .where(eq(dbModule.supportReportAttachments.reportId, expired.id));
    expect(scrubbed).toMatchObject({
      description: "",
      reporterEmail: null,
      ownerEmail: null,
      deletedAt: null,
    });
    expect(scrubbedAttachment).toMatchObject({
      filename: "",
      contentType: "application/octet-stream",
      size: 0,
      storageKey,
    });

    transport.failDeletion = false;
    expect(await outbox.cleanupExpiredSupportReports(new Date())).toBe(1);
    expect(transport.deletedKeys).toEqual([storageKey]);
    expect(await dbModule.db.select().from(dbModule.supportReportAttachments)
      .where(eq(dbModule.supportReportAttachments.reportId, expired.id))).toHaveLength(0);
    const [cleaned] = await dbModule.db.select().from(dbModule.supportReports)
      .where(eq(dbModule.supportReports.id, expired.id));
    expect(cleaned?.deletedAt).toBeInstanceOf(Date);
  });
});