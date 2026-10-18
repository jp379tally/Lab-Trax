/**
 * A backup that dropped content must not read as a clean success.
 *
 * The run that lost profile photos was reported to the API and to the success
 * email as a plain success; only the history list showed it amber. These
 * tests pin the success email to the partial state, with the SMTP and DNS
 * layers mocked so the real template renders without dispatching mail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailImpl = vi.fn();

vi.mock("./mailer", () => ({
  getMailerConfig: () => ({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "lab@example-lab.com",
    pass: "abcdefghijklmnop",
    from: "lab@example-lab.com",
  }),
  createTransport: () => ({ sendMail: sendMailImpl }),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async () => [{ exchange: "mx.gmail.com", priority: 10 }],
    resolve: async () => ["192.0.2.1"],
  },
}));

const WARNING =
  "Retried without profile photos and succeeded: 42 profile photo file(s) were NOT included in this backup.";

function successParams(overrides: Record<string, unknown> = {}) {
  return {
    adminEmails: ["owner@gmail.com"],
    triggeredBy: "scheduler:interval",
    success: true as const,
    result: {
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
      ...overrides,
    },
  };
}

describe("partial backups are reported as partial in the success email", () => {
  let mail: typeof import("./mail.js");

  beforeEach(async () => {
    vi.stubEnv("VITEST", "");
    sendMailImpl.mockReset();
    sendMailImpl.mockResolvedValue({ accepted: ["owner@gmail.com"] });
    mail = await import("./mail.js");
    mail.__clearMxCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says WITH WARNINGS without putting technical failure details in the primary message", async () => {
    await mail.sendBackupNotificationEmail(
      successParams({ partialFailure: true, warnings: WARNING }) as never,
    );

    expect(sendMailImpl).toHaveBeenCalledOnce();
    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.subject).toContain("WITH WARNINGS");
    expect(message.subject).not.toContain("successfully");
    expect(message.html).toContain("Backup completed with warnings");
    expect(message.html).toContain("This archive is incomplete");
    expect(message.html).toContain("not a complete recovery point");
    expect(message.html).not.toContain("profile photo file(s) were NOT included");
    // Amber, matching the history list — not the clean-success green.
    expect(message.html).toContain("#d68910");
    expect(message.html).not.toContain("#27ae60");
    expect(message.text).toContain("WITH WARNINGS");
    expect(message.text).toContain("not a complete recovery point");
    expect(message.text).not.toContain(WARNING);
  });

  it("still names the gap when the run recorded no warning text", async () => {
    await mail.sendBackupNotificationEmail(successParams({ partialFailure: true }) as never);

    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.subject).toContain("WITH WARNINGS");
    expect(message.html).toContain("not a complete recovery point");
  });

  it("leaves a genuinely clean run reading as a clean success", async () => {
    await mail.sendBackupNotificationEmail(successParams() as never);

    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.subject).toContain("completed successfully");
    expect(message.html).toContain("Backup completed successfully");
    expect(message.html).not.toContain("incomplete");
    expect(message.html).toContain("#27ae60");
  });

  it("uses a concise failure summary in email instead of exposing the technical cause", async () => {
    await mail.sendBackupNotificationEmail({
      adminEmails: ["owner@gmail.com"],
      triggeredBy: "scheduler:interval",
      success: false,
      errorMessage: "Backup failed during database dump: SQLSTATE 08006: connection pool exhausted.",
      failedAt: "2026-10-06T09:30:00.000Z",
      destination: "onedrive",
    } as never);

    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.html).toContain("no new complete recovery point was created");
    expect(message.html).toContain("failure details");
    expect(message.html).not.toContain("SQLSTATE");
    expect(message.text).toContain("no new complete recovery point was created");
    expect(message.text).not.toContain("connection pool exhausted");
  });
});

// ── What backup mail reports back to the alarm ─────────────────────────────
//
// The real mailer does not throw when it cannot send: an unconfigured SMTP, a
// rejected credential, or a refused recipient all come back as a resolved
// `{ sent: false }`. An alert path that only watches for a thrown error records
// a delivery that never happened and then sits out its rate limit. These tests
// pin the contract the backup alarm depends on, against the real function.
describe("backup mail reports what actually happened", () => {
  let mail: typeof import("./mail.js");

  beforeEach(async () => {
    vi.stubEnv("VITEST", "");
    sendMailImpl.mockReset();
    mail = await import("./mail.js");
    mail.__clearMxCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports zero sent when the mail server refuses the message", async () => {
    sendMailImpl.mockRejectedValue(
      Object.assign(new Error("535 authentication failed"), {
        code: "EAUTH",
        responseCode: 535,
      }),
    );

    const delivery = await mail.sendBackupNotificationEmail({
      adminEmails: ["owner@gmail.com", "second@gmail.com"],
      triggeredBy: "scheduler:offsite",
      success: false,
      errorMessage: "No off-site archive in the last 45 minutes.",
      failedAt: "2026-10-06T09:30:00.000Z",
      destination: "onedrive",
    } as never);

    expect(delivery).toEqual({
      attempted: 2,
      sent: 0,
      failures: [
        { email: "owner@gmail.com", reason: "auth_failed" },
        { email: "second@gmail.com", reason: "auth_failed" },
      ],
    });
    expect(mail.describeBackupEmailFailures(delivery)).toMatch(
      /2 of 2 recipient\(s\) were not reached \(auth_failed\)/,
    );
  });

  it("reports the recipients that did get it when only some sends fail", async () => {
    sendMailImpl
      .mockResolvedValueOnce({ accepted: ["owner@gmail.com"] })
      .mockRejectedValueOnce(new Error("550 mailbox unavailable"));

    const delivery = await mail.sendBackupNotificationEmail({
      adminEmails: ["owner@gmail.com", "second@gmail.com"],
      triggeredBy: "scheduler:offsite",
      success: false,
      errorMessage: "No off-site archive in the last 45 minutes.",
      failedAt: "2026-10-06T09:30:00.000Z",
      destination: "onedrive",
    } as never);

    expect(delivery.sent).toBe(1);
    expect(delivery.failures).toHaveLength(1);
    expect(delivery.failures[0]!.email).toBe("second@gmail.com");
  });

  it("reports a successful send as sent, with nothing to explain", async () => {
    sendMailImpl.mockResolvedValue({ accepted: ["owner@gmail.com"] });

    const delivery = await mail.sendBackupStaleAlertEmail({
      adminEmails: ["owner@gmail.com"],
      lastSuccessfulAt: "2026-09-18T04:00:00.000Z",
      daysSinceBackup: 18,
      thresholdDays: 1,
    } as never);

    expect(delivery).toEqual({ attempted: 1, sent: 1, failures: [] });
    expect(mail.describeBackupEmailFailures(delivery)).toBe("");
  });
});
