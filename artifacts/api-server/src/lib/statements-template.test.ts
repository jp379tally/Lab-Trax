/**
 * Unit tests for renderStatementTemplate / DEFAULT_STATEMENT_SUBJECT /
 * DEFAULT_STATEMENT_BODY / StatementEmailVars.
 *
 * renderStatementTemplate is a pure string-interpolation function, so no DB
 * access is required. The heavy module-level dependencies (pdfkit, nodemailer,
 * archiver, @workspace/db) are mocked below so the module can be imported
 * without a live database or SMTP server.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

const { sendMailMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Stub out module-level side-effecting imports so statements.ts can load.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      statementSchedules: { findMany: vi.fn() },
      organizations: { findFirst: vi.fn() },
      invoices: { findMany: vi.fn() },
      invoiceLineItems: { findMany: vi.fn() },
    },
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
  },
  cases: {},
  invoiceLineItems: { invoiceId: {}, sortOrder: {} },
  invoices: { labOrganizationId: {}, createdAt: {}, providerOrganizationId: {} },
  organizations: { id: {}, name: {}, displayName: {}, billingEmail: {} },
  statementLinkTokens: {},
  statementSchedules: {},
  statementSendRuns: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ne: () => ({}),
  gte: () => ({}),
  gt: () => ({}),
  lt: () => ({}),
  lte: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  asc: () => ({}),
  desc: () => ({}),
  notInArray: () => ({}),
}));

vi.mock("pdfkit", () => ({ default: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
vi.mock("archiver", () => ({ default: vi.fn() }));

vi.mock("./lab-logo-storage", () => ({ openLabLogoStream: vi.fn() }));
vi.mock("./mail", () => ({
  getAppBaseUrl: vi.fn().mockReturnValue("http://localhost"),
  LAB_LOGO_CID: "lab-logo@labtrax",
  sendMail: sendMailMock,
}));
vi.mock("./mailer", () => ({
  normalizeSmtpValue: (v: string) => v,
  normalizeSmtpPassword: (v: string) => v,
}));
vi.mock("./email-prefs", () => ({ checkEmailPref: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVars(
  overrides: Partial<import("./statements.js").StatementEmailVars> = {}
): import("./statements.js").StatementEmailVars {
  return {
    practiceName: "Sunrise Dental",
    doctorName: "",
    labName: "Crystal Labs",
    periodLabel: "April 2025",
    totalBilled: "$1,200.00",
    openBalance: "$300.00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderStatementTemplate", () => {
  // Import lazily so all vi.mock factories are in effect first.
  let renderStatementTemplate: typeof import("./statements.js").renderStatementTemplate;
  let DEFAULT_STATEMENT_SUBJECT: typeof import("./statements.js").DEFAULT_STATEMENT_SUBJECT;
  let DEFAULT_STATEMENT_BODY: typeof import("./statements.js").DEFAULT_STATEMENT_BODY;
  let DEFAULT_STATEMENT_BODY_DOCTOR: typeof import("./statements.js").DEFAULT_STATEMENT_BODY_DOCTOR;
  let defaultStatementBody: typeof import("./statements.js").defaultStatementBody;
  let sendStatementEmail: typeof import("./statements.js").sendStatementEmail;

  beforeAll(async () => {
    ({
      renderStatementTemplate,
      DEFAULT_STATEMENT_SUBJECT,
      DEFAULT_STATEMENT_BODY,
      DEFAULT_STATEMENT_BODY_DOCTOR,
      defaultStatementBody,
      sendStatementEmail,
    } = await import("./statements.js"));
  });

  // ── Default templates contain the expected placeholders ──────────────────

  it("DEFAULT_STATEMENT_SUBJECT contains {{practiceName}} and {{periodLabel}}", () => {
    expect(DEFAULT_STATEMENT_SUBJECT).toContain("{{practiceName}}");
    expect(DEFAULT_STATEMENT_SUBJECT).toContain("{{periodLabel}}");
  });

  it("DEFAULT_STATEMENT_BODY contains {{practiceName}}, {{periodLabel}}, and {{labName}}", () => {
    expect(DEFAULT_STATEMENT_BODY).toContain("{{practiceName}}");
    expect(DEFAULT_STATEMENT_BODY).toContain("{{periodLabel}}");
    expect(DEFAULT_STATEMENT_BODY).toContain("{{labName}}");
  });

  it("uses recipient-aware default greetings", () => {
    expect(DEFAULT_STATEMENT_BODY).toMatch(/^Hello \{\{practiceName\}\},/);
    expect(DEFAULT_STATEMENT_BODY_DOCTOR).toMatch(/^Hello \{\{doctorName\}\},/);
    expect(defaultStatementBody("practice")).toBe(DEFAULT_STATEMENT_BODY);
    expect(defaultStatementBody("doctor")).toBe(DEFAULT_STATEMENT_BODY_DOCTOR);
  });

  // ── Every StatementEmailVars field is substituted ────────────────────────

  it("substitutes {{practiceName}} in subject", () => {
    const result = renderStatementTemplate("Hello {{practiceName}}", makeVars());
    expect(result).toBe("Hello Sunrise Dental");
  });

  it("substitutes {{labName}} in body", () => {
    const result = renderStatementTemplate("From {{labName}}", makeVars());
    expect(result).toBe("From Crystal Labs");
  });

  it("substitutes {{periodLabel}} in body", () => {
    const result = renderStatementTemplate("Period: {{periodLabel}}", makeVars());
    expect(result).toBe("Period: April 2025");
  });

  it("substitutes {{totalBilled}} in body", () => {
    const result = renderStatementTemplate("Billed: {{totalBilled}}", makeVars());
    expect(result).toBe("Billed: $1,200.00");
  });

  it("substitutes {{openBalance}} in body", () => {
    const result = renderStatementTemplate("Balance: {{openBalance}}", makeVars());
    expect(result).toBe("Balance: $300.00");
  });

  it("substitutes {{doctorName}} in body (doctor-recipient variant)", () => {
    const vars = makeVars({ doctorName: "Dr. Synthetic063" });
    const result = renderStatementTemplate("Dear {{doctorName}},", vars);
    expect(result).toBe("Dear Dr. Synthetic063,");
  });

  // ── Multiple variables substituted in one pass ───────────────────────────

  it("substitutes all variables in the DEFAULT_STATEMENT_SUBJECT", () => {
    const vars = makeVars();
    const result = renderStatementTemplate(DEFAULT_STATEMENT_SUBJECT, vars);
    expect(result).toContain("Sunrise Dental");
    expect(result).toContain("April 2025");
    expect(result).not.toContain("{{");
    expect(result).not.toContain("}}");
  });

  it("substitutes all variables in the DEFAULT_STATEMENT_BODY", () => {
    const vars = makeVars();
    const result = renderStatementTemplate(DEFAULT_STATEMENT_BODY, vars);
    expect(result).toContain("Sunrise Dental");
    expect(result).toContain("April 2025");
    expect(result).toContain("Crystal Labs");
    expect(result).not.toContain("{{");
    expect(result).not.toContain("}}");
  });

  it("substitutes every variable when all appear together in one template", () => {
    const template =
      "{{practiceName}} {{doctorName}} {{labName}} {{periodLabel}} {{totalBilled}} {{openBalance}}";
    const vars = makeVars({ doctorName: "Dr. Lee" });
    const result = renderStatementTemplate(template, vars);
    expect(result).toBe(
      "Sunrise Dental Dr. Lee Crystal Labs April 2025 $1,200.00 $300.00"
    );
  });

  // ── Doctor-recipient variant (subject + body) ────────────────────────────

  it("substitutes doctorName into a doctor-specific subject template", () => {
    const template = "Statement for {{doctorName}} at {{practiceName}} — {{periodLabel}}";
    const vars = makeVars({ doctorName: "Dr. Johnson" });
    const result = renderStatementTemplate(template, vars);
    expect(result).toBe("Statement for Dr. Johnson at Sunrise Dental — April 2025");
  });

  it("substitutes doctorName into a doctor-specific body template", () => {
    const template =
      "Dear {{doctorName}},\n\nHere is your statement for {{periodLabel}}.\nBalance: {{openBalance}}\n\n{{labName}}";
    const vars = makeVars({ doctorName: "Dr. Johnson" });
    const result = renderStatementTemplate(template, vars);
    expect(result).toBe(
      "Dear Dr. Johnson,\n\nHere is your statement for April 2025.\nBalance: $300.00\n\nCrystal Labs"
    );
  });

  it("leaves doctorName placeholder when doctorName is empty string (practice mode)", () => {
    // In practice mode doctorName is ""; the placeholder is substituted with ""
    const vars = makeVars({ doctorName: "" });
    const result = renderStatementTemplate("Dear {{doctorName}},", vars);
    // Empty string IS a defined value — the placeholder is replaced with ""
    expect(result).toBe("Dear ,");
  });

  // ── Unknown variables are preserved as-is ────────────────────────────────

  it("leaves unknown variables unreplaced", () => {
    const result = renderStatementTemplate("Hello {{unknown}}", makeVars());
    expect(result).toBe("Hello {{unknown}}");
  });

  it("leaves multiple unknown variables unreplaced while substituting known ones", () => {
    const result = renderStatementTemplate(
      "{{practiceName}} {{foo}} {{openBalance}} {{bar}}",
      makeVars()
    );
    expect(result).toBe("Sunrise Dental {{foo}} $300.00 {{bar}}");
  });

  it("does not throw for a template with only unknown variables", () => {
    expect(() =>
      renderStatementTemplate("{{nope}} {{also_nope}}", makeVars())
    ).not.toThrow();
    const result = renderStatementTemplate("{{nope}} {{also_nope}}", makeVars());
    expect(result).toBe("{{nope}} {{also_nope}}");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("returns an empty string unchanged", () => {
    expect(renderStatementTemplate("", makeVars())).toBe("");
  });

  it("returns plain text with no placeholders unchanged", () => {
    const plain = "No placeholders here.";
    expect(renderStatementTemplate(plain, makeVars())).toBe(plain);
  });

  it("handles whitespace inside braces — {{ practiceName }}", () => {
    // The regex allows optional whitespace: /\{\{\s*(\w+)\s*\}\}/
    const result = renderStatementTemplate("Hello {{ practiceName }}", makeVars());
    expect(result).toBe("Hello Sunrise Dental");
  });

  it("substitutes the same variable multiple times in one template", () => {
    const result = renderStatementTemplate(
      "{{practiceName}} + {{practiceName}}",
      makeVars()
    );
    expect(result).toBe("Sunrise Dental + Sunrise Dental");
  });
});

describe("sendStatementEmail inline logo", () => {
  it("uses a CID reference and attaches the matching logo bytes", async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ sent: true });
    const logo = Buffer.from("statement-logo-bytes");

    const { sendStatementEmail } = await import("./statements.js");
    const result = await sendStatementEmail({
      to: "billing@example.com",
      fromName: "Crystal Labs",
      practiceName: "Sunrise Dental",
      periodLabel: "April 2025",
      pdfBuffer: Buffer.from("pdf"),
      pdfFilename: "statement.pdf",
      totals: { billed: 1200, open: 300 },
      labLogo: { content: logo, contentType: "image/png" },
    });

    expect(result).toEqual({ delivered: true });
    expect(sendMailMock).toHaveBeenCalledOnce();
    const mail = sendMailMock.mock.calls[0]![0];
    expect(mail.html).toContain('src="cid:lab-logo@labtrax"');
    expect(mail.html).not.toContain("/api/organizations/");
    expect(mail.attachments).toHaveLength(2);
    expect(mail.attachments[1]).toMatchObject({
      filename: "lab-logo",
      contentType: "image/png",
      cid: "lab-logo@labtrax",
      contentDisposition: "inline",
    });
    expect(Buffer.isBuffer(mail.attachments[1].content)).toBe(true);
    expect(mail.attachments[1].content.equals(logo)).toBe(true);
  });

  it("omits the logo attachment and CID when no logo is available", async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ sent: true });

    const { sendStatementEmail } = await import("./statements.js");
    const result = await sendStatementEmail({
      to: "billing@example.com",
      fromName: "Crystal Labs",
      practiceName: "Sunrise Dental",
      periodLabel: "April 2025",
      pdfBuffer: Buffer.from("pdf"),
      pdfFilename: "statement.pdf",
      totals: { billed: 1200, open: 300 },
      labLogo: null,
    });

    expect(result).toEqual({ delivered: true });
    const mail = sendMailMock.mock.calls[0]![0];
    expect(mail.html).not.toContain("cid:lab-logo@labtrax");
    expect(mail.attachments).toHaveLength(1);
  });

  it("uses the doctor greeting fallback and renders the doctor name", async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ sent: true });
    const { sendStatementEmail } = await import("./statements.js");

    await sendStatementEmail({
      to: "doctor@example.com",
      fromName: "Crystal Labs",
      practiceName: "Sunrise Dental",
      recipientType: "doctor",
      doctorName: "Dr. Synthetic033",
      periodLabel: "April 2025",
      pdfBuffer: Buffer.from("pdf"),
      pdfFilename: "statement.pdf",
      totals: { billed: 1200, open: 300 },
    });

    expect(sendMailMock.mock.calls[0]![0].text).toMatch(/^Hello Dr\. Synthetic033,/);
    expect(sendMailMock.mock.calls[0]![0].text).not.toContain("Hello ,");
  });

  it("uses the practice greeting fallback without an empty salutation", async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ sent: true });
    const { sendStatementEmail } = await import("./statements.js");

    await sendStatementEmail({
      to: "billing@example.com",
      fromName: "Crystal Labs",
      practiceName: "Sunrise Dental",
      recipientType: "practice",
      periodLabel: "April 2025",
      pdfBuffer: Buffer.from("pdf"),
      pdfFilename: "statement.pdf",
      totals: { billed: 1200, open: 300 },
    });

    expect(sendMailMock.mock.calls[0]![0].text).toMatch(/^Hello Sunrise Dental,/);
    expect(sendMailMock.mock.calls[0]![0].text).not.toContain("Hello ,");
  });
});
