/**
 * Alert path for the scheduled production database identity check.
 *
 * Covers what the endpoint will accept, and that a real mismatch reaches lab
 * admins carrying the reported facts. The comparison itself lives in
 * scripts/src/data-fingerprint.ts and is tested there; this file only covers
 * the notification side.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendDatabaseIdentityAlertEmail = vi.fn();

vi.mock("./mail.js", () => ({
  sendDatabaseIdentityAlertEmail: (...args: unknown[]) =>
    sendDatabaseIdentityAlertEmail(...args),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_FINGERPRINT_PATH,
  DEFAULT_RECORD_COMMAND,
  dispatchDatabaseIdentityAlert,
  parseDatabaseIdentityAlertRequest,
  selectLabAdminRecipients,
} from "./database-identity-alerts.js";

const FACTS = [
  "scope: protected lab 00000000-0000-4000-8000-000000000234",
  "active cases: 2 (fingerprint 1001)",
  "invoices: 1 (fingerprint 2002)",
  "oldest case created_at: 2026-01-02T09:00:00.000000Z (fingerprint 2026-01-02T09:00:00.000000Z)",
  "matches the development database to the microsecond: no (development fingerprint 2026-01-03T00:00:00.000000Z, recorded 2026-01-04T00:00:00.000Z)",
];

function mismatchBody(overrides: Record<string, unknown> = {}) {
  return {
    source: "data-fingerprint-monitor",
    target: "production",
    checkedAt: "2026-10-06T18:30:00.000Z",
    facts: FACTS,
    findings: [
      {
        level: "failure",
        code: "lineage-mismatch",
        message:
          "the production oldest case created_at (2026-10-01T09:00:00.000001Z) is not the recorded 2026-05-12T15:44:59.587588Z",
      },
    ],
    fingerprintPath: "scripts/database-fingerprint.json",
    recordCommand:
      "pnpm --filter @workspace/scripts run record-production-data-fingerprint",
    ...overrides,
  };
}

const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** What the real alert mail function reports after an all-accepted send. */
function delivered(emails: string[]) {
  return { attempted: emails.length, delivered: emails, failures: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendDatabaseIdentityAlertEmail.mockImplementation(
    async ({ adminEmails }: { adminEmails: string[] }) =>
      delivered(adminEmails),
  );
});

describe("parseDatabaseIdentityAlertRequest", () => {
  it("accepts a reported mismatch and keeps the reported facts intact", () => {
    const parsed = parseDatabaseIdentityAlertRequest(mismatchBody());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.facts).toEqual(FACTS);
    expect(parsed.value.target).toBe("production");
    expect(parsed.value.checkedAt).toBe("2026-10-06T18:30:00.000Z");
    expect(parsed.value.findings).toHaveLength(1);
  });

  it("refuses a report with no failure in it", () => {
    const parsed = parseDatabaseIdentityAlertRequest(
      mismatchBody({
        findings: [
          { level: "warning", message: "no development fingerprint recorded" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/at least one failure/);
  });

  it("refuses a report that cannot say what production looked like", () => {
    expect(parseDatabaseIdentityAlertRequest(mismatchBody({ facts: [] })).ok).toBe(
      false,
    );
    expect(
      parseDatabaseIdentityAlertRequest(mismatchBody({ facts: "1596 cases" })).ok,
    ).toBe(false);
    expect(parseDatabaseIdentityAlertRequest(null).ok).toBe(false);
    expect(parseDatabaseIdentityAlertRequest("swapped").ok).toBe(false);
  });

  it("reads the worst findings first and fills in where the report came from", () => {
    const parsed = parseDatabaseIdentityAlertRequest(
      mismatchBody({
        fingerprintPath: undefined,
        recordCommand: undefined,
        findings: [
          { level: "warning", message: "development fingerprint is stale" },
          { level: "failure", message: "production holds 4 of 1596 cases" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.findings.map((f) => f.level)).toEqual([
      "failure",
      "warning",
    ]);
    expect(parsed.value.fingerprintPath).toBe(DEFAULT_FINGERPRINT_PATH);
    expect(parsed.value.recordCommand).toBe(DEFAULT_RECORD_COMMAND);
  });

  it("stamps its own timestamp when the reported one is unusable", () => {
    const parsed = parseDatabaseIdentityAlertRequest(
      mismatchBody({ checkedAt: "whenever" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Number.isFinite(Date.parse(parsed.value.checkedAt))).toBe(true);
  });
});

describe("selectLabAdminRecipients", () => {
  const labAdmin = {
    email: "owner@lab.test",
    role: "admin",
    userType: "lab",
    isActive: true,
  };

  it("keeps active lab admins, including legacy rows with no user type", () => {
    expect(
      selectLabAdminRecipients([
        labAdmin,
        { ...labAdmin, email: "legacy@lab.test", userType: null },
      ]),
    ).toEqual(["owner@lab.test", "legacy@lab.test"]);
  });

  it("only mails admins of the lab the fingerprint protects", () => {
    const PROTECTED = "00000000-0000-4000-8000-000000000234";
    const OTHER_LAB = "11111111-2222-3333-4444-555555555555";
    const member = (
      email: string,
      membershipLabId: string,
      membershipRole: string,
      membershipStatus = "active",
    ) => ({
      email,
      role: "admin",
      userType: "lab",
      isActive: true,
      membershipLabId,
      membershipRole,
      membershipStatus,
    });

    expect(
      selectLabAdminRecipients(
        [
          member("owner@protected.test", PROTECTED, "owner"),
          member("admin@protected.test", PROTECTED, "admin"),
          // Not admins of the protected lab, by three different routes.
          member("tech@protected.test", PROTECTED, "user"),
          member("former@protected.test", PROTECTED, "admin", "removed"),
          member("owner@otherlab.test", OTHER_LAB, "owner"),
        ],
        { protectedLabOrganizationId: PROTECTED },
      ),
    ).toEqual(["owner@protected.test", "admin@protected.test"]);
  });

  it("tells nobody rather than another lab when the protected lab has no admins", () => {
    // A rebound database can hold someone else's lab and not this one. That
    // is the incident, so it has to come back as "nobody was told" — mailing
    // the other lab would both miss the lab that needs to know and hand it
    // this lab's incident.
    expect(
      selectLabAdminRecipients(
        [
          {
            email: "owner@otherlab.test",
            role: "admin",
            userType: "lab",
            isActive: true,
            membershipLabId: "11111111-2222-3333-4444-555555555555",
            membershipRole: "owner",
            membershipStatus: "active",
          },
        ],
        { protectedLabOrganizationId: "00000000-0000-4000-8000-000000000234" },
      ),
    ).toEqual([]);
  });

  it("does not treat a platform operator as having told the lab", () => {
    // A rebound database can hold a reachable master admin and no lab admin
    // at all. Mailing the operator is not mailing the lab, so this has to
    // come out as "nobody was told" rather than as a delivered alert.
    expect(
      selectLabAdminRecipients([
        {
          email: "platform@labtrax.test",
          role: "admin",
          userType: "master_admin",
          isActive: true,
        },
      ]),
    ).toEqual([]);
  });

  it("drops deactivated accounts, non-admins, provider admins and blank addresses", () => {
    expect(
      selectLabAdminRecipients([
        { ...labAdmin, email: "retired@lab.test", isActive: false },
        { ...labAdmin, email: "tech@lab.test", role: "user" },
        { ...labAdmin, email: "doctor@practice.test", userType: "provider" },
        { ...labAdmin, email: "   " },
        { ...labAdmin, email: null },
      ]),
    ).toEqual([]);
  });

  it("mails one address once, however many admin rows carry it", () => {
    expect(
      selectLabAdminRecipients([
        labAdmin,
        { ...labAdmin, email: "Owner@Lab.test" },
      ]),
    ).toEqual(["owner@lab.test"]);
  });
});

describe("dispatchDatabaseIdentityAlert", () => {
  function parsedMismatch() {
    const parsed = parseDatabaseIdentityAlertRequest(mismatchBody());
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  it("emails every lab admin with the facts and the way to re-record", async () => {
    const outcome = await dispatchDatabaseIdentityAlert(
      {
        adminEmails: ["owner@lab.test", "manager@lab.test"],
        request: parsedMismatch(),
      },
      quietLogger,
    );

    expect(outcome).toEqual({
      sent: true,
      recipients: 2,
      attempted: 2,
      failures: [],
    });
    expect(sendDatabaseIdentityAlertEmail).toHaveBeenCalledTimes(1);
    const params = sendDatabaseIdentityAlertEmail.mock.calls[0]![0];
    expect(params.adminEmails).toEqual(["owner@lab.test", "manager@lab.test"]);
    expect(params.facts).toEqual(FACTS);
    expect(params.recordCommand).toContain("record-production-data-fingerprint");
    expect(params.findings[0].level).toBe("failure");
  });

  it("reports that nobody was told rather than claiming success", async () => {
    const outcome = await dispatchDatabaseIdentityAlert(
      { adminEmails: [], request: parsedMismatch() },
      quietLogger,
    );

    expect(outcome).toEqual({
      sent: false,
      recipients: 0,
      attempted: 0,
      failures: [],
    });
    expect(sendDatabaseIdentityAlertEmail).not.toHaveBeenCalled();
    expect(quietLogger.error).toHaveBeenCalled();
  });

  it("does not call a refused email a delivered alert", async () => {
    // Mail unconfigured, or SMTP refusing every address: the incident is
    // still unreported, so the monitor has to learn that nobody was told.
    sendDatabaseIdentityAlertEmail.mockResolvedValueOnce({
      attempted: 2,
      delivered: [],
      failures: [
        { email: "owner@lab.test", reason: "smtp_not_configured" },
        { email: "manager@lab.test", reason: "smtp_not_configured" },
      ],
    });

    const outcome = await dispatchDatabaseIdentityAlert(
      {
        adminEmails: ["owner@lab.test", "manager@lab.test"],
        request: parsedMismatch(),
      },
      quietLogger,
    );

    expect(outcome.sent).toBe(false);
    expect(outcome.recipients).toBe(0);
    expect(outcome.attempted).toBe(2);
    expect(outcome.failures.map((f) => f.reason)).toEqual([
      "smtp_not_configured",
      "smtp_not_configured",
    ]);
  });

  it("counts only the admins the mail server accepted", async () => {
    sendDatabaseIdentityAlertEmail.mockResolvedValueOnce({
      attempted: 3,
      delivered: ["owner@lab.test"],
      failures: [
        { email: "manager@lab.test", reason: "undeliverable_domain" },
        { email: "tech@lab.test", reason: "smtp_error" },
      ],
    });

    const outcome = await dispatchDatabaseIdentityAlert(
      {
        adminEmails: ["owner@lab.test", "manager@lab.test", "tech@lab.test"],
        request: parsedMismatch(),
      },
      quietLogger,
    );

    expect(outcome.sent).toBe(true);
    expect(outcome.recipients).toBe(1);
    expect(outcome.attempted).toBe(3);
  });

  it("mails each admin separately and reports what was actually sent", async () => {
    // The real function, not the stub above: `sendMail` treats `to` as a
    // single address and resolves `{ sent: false }` for a skipped recipient
    // instead of throwing, so a joined recipient string or an ignored result
    // would silently drop this alert. Under the test runner every send is
    // refused with `disabled_in_test`, which is exactly the shape of a
    // production mail outage.
    const realMail =
      await vi.importActual<typeof import("./mail.js")>("./mail.js");

    const delivery = await realMail.sendDatabaseIdentityAlertEmail({
      adminEmails: ["owner@lab.test", "manager@lab.test"],
      checkedAt: "2026-10-06T18:30:00.000Z",
      facts: FACTS,
      findings: [{ level: "failure", message: "production holds 4 of 1596 cases" }],
      fingerprintPath: DEFAULT_FINGERPRINT_PATH,
      recordCommand: DEFAULT_RECORD_COMMAND,
    });

    expect(delivery.attempted).toBe(2);
    expect(delivery.delivered).toEqual([]);
    expect(delivery.failures.map((f) => f.email)).toEqual([
      "owner@lab.test",
      "manager@lab.test",
    ]);
    expect(delivery.failures.every((f) => f.reason === "disabled_in_test")).toBe(
      true,
    );
  });

  it("alerts again on the next report instead of suppressing a repeat", async () => {
    const request = parsedMismatch();
    await dispatchDatabaseIdentityAlert(
      { adminEmails: ["owner@lab.test"], request },
      quietLogger,
    );
    await dispatchDatabaseIdentityAlert(
      { adminEmails: ["owner@lab.test"], request },
      quietLogger,
    );

    // While production still does not match, silence would be
    // indistinguishable from the problem having been fixed — and dedup state
    // would mean writing to the database whose identity is in question.
    expect(sendDatabaseIdentityAlertEmail).toHaveBeenCalledTimes(2);
  });
});
