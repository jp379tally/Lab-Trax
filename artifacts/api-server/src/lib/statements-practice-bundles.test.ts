/**
 * Regression tests for practice statement bundles (task 4794): the desktop
 * "Generate Statements" Practices mode now sends ONE email per billed
 * practice carrying a SEPARATE statement PDF per selected doctor.
 *
 * Covered here:
 *  1. buildPracticeStatementBundles — four doctors at one practice, multiple
 *     locations of one billing practice, identical names/addresses/emails
 *     across distinct practices, positive-balance open filtering, doctor
 *     exclusions, the unassigned document, and the issue-date cutoff.
 *  2. runBatchSendStatements — one message per practice with every doctor PDF
 *     attached, per-send recipient overrides (including an explicit empty
 *     one), a single issued statement row carrying the attachment manifest,
 *     and generation failures blocking the send instead of delivering a
 *     partial bundle.
 *  3. The collision-safe file namer and the manifest coercion helper.
 *
 * The DB is fully mocked: WHERE clauses are inert, so row-level scope
 * filtering is simulated by the rows the mock returns. The date-cutoff test
 * instead asserts the operator arguments the builder passes to drizzle.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Hoisted mock handles.
// ---------------------------------------------------------------------------

const mockInvoicesFindMany = vi.hoisted(() => vi.fn());
const mockLineItemsFindMany = vi.hoisted(() => vi.fn());
const mockOrgFindFirst = vi.hoisted(() => vi.fn());
const mockScheduleFindFirst = vi.hoisted(() => vi.fn());
const mockCaseRows = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockOrgRows = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockPaymentRows = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockAdditionalEmailRows = vi.hoisted(() => vi.fn(() => [] as any[]));
/** Every db.insert(...).values(...) call, tagged with its table. */
const mockInserts = vi.hoisted(() => [] as Array<{ table: string; values: any }>);
/** Table names whose inserts must fail, to exercise write-failure paths. */
const mockFailingInsertTables = vi.hoisted(() => new Set<string>());
/** Every db.update(...).set(...) call, tagged with its table. */
const mockUpdates = vi.hoisted(() => [] as Array<{ table: string; values: any }>);
const mockSendRunFindFirst = vi.hoisted(() => vi.fn());
const mockStatementFindFirst = vi.hoisted(() => vi.fn());
/** Arguments passed to the mocked drizzle comparison operators. */
const mockOperatorCalls = vi.hoisted(
  () => [] as Array<{ op: string; column: string; value: unknown }>
);
const mockSendMail = vi.hoisted(() => vi.fn());
const mockSendSms = vi.hoisted(() => vi.fn());
const mockCheckEmailPref = vi.hoisted(() => vi.fn());
const mockDoctorProfileFindFirst = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock @workspace/db.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const col = (name: string) => ({ __col: name });
  const casesTable = { __name: "cases", id: col("id"), doctorName: col("doctorName") };
  const organizationsTable = {
    __name: "organizations",
    id: col("id"),
    name: col("name"),
    displayName: col("displayName"),
    billingEmail: col("billingEmail"),
  };
  const paymentsTable = {
    __name: "payments",
    id: col("id"),
    invoiceId: col("invoiceId"),
    amount: col("amount"),
    paidAt: col("paidAt"),
    paymentMethod: col("paymentMethod"),
    referenceNumber: col("referenceNumber"),
  };
  const additionalEmailsTable = {
    __name: "organization_additional_emails",
    organizationId: col("organizationId"),
    email: col("email"),
    type: col("type"),
  };

  const db = {
    query: {
      invoices: { findMany: mockInvoicesFindMany },
      invoiceLineItems: { findMany: mockLineItemsFindMany },
      organizations: { findFirst: mockOrgFindFirst },
      statementSchedules: { findFirst: mockScheduleFindFirst },
      statementLinkTokens: { findFirst: vi.fn().mockResolvedValue(null) },
      statementSendRuns: { findFirst: mockSendRunFindFirst },
      practiceStatements: { findFirst: mockStatementFindFirst },
      // Drizzle methods require their query-object receiver. A plain vi.fn
      // would let the production-breaking detached findFirst pass unnoticed.
      doctorProfiles: {
        findFirst: function (this: unknown, opts: unknown) {
          if (this !== db.query.doctorProfiles) {
            throw new TypeError("doctorProfiles.findFirst lost its query receiver");
          }
          return mockDoctorProfileFindFirst(opts);
        },
      },
    },
    select: vi.fn((_cols?: unknown) => ({
      from: (tbl: { __name?: string }) => {
        const name = tbl?.__name;
        const rows =
          name === "cases"
            ? mockCaseRows()
            : name === "payments"
              ? mockPaymentRows()
              : name === "organization_additional_emails"
                ? mockAdditionalEmailRows()
                : mockOrgRows();
        return {
          where: () => {
            const result = Promise.resolve(rows) as Promise<any[]> & {
              orderBy: () => Promise<any[]>;
            };
            result.orderBy = () => result;
            return result;
          },
        };
      },
    })),
    update: vi.fn((tbl: { __name?: string }) => ({
      set: (values: any) => ({
        where: () => {
          mockUpdates.push({ table: tbl?.__name ?? "unknown", values });
          return Promise.resolve(undefined);
        },
      }),
    })),
    insert: vi.fn((tbl: { __name?: string }) => ({
      values: (values: any) => {
        const table = tbl?.__name ?? "unknown";
        if (mockFailingInsertTables.has(table)) {
          // Rejects only when awaited, so callers that ignore the result do
          // not produce unhandled rejections.
          return {
            returning: async () => {
              throw new Error(`insert into ${table} failed`);
            },
          } as any;
        }
        mockInserts.push({ table: tbl?.__name ?? "unknown", values });
        const result = Promise.resolve(undefined) as Promise<unknown> & {
          returning: () => Promise<any[]>;
        };
        result.returning = async () => [
          { id: `row-${mockInserts.length}`, ...values },
        ];
        return result;
      },
    })),
  };

  return {
    db,
    cases: casesTable,
    payments: paymentsTable,
    organizations: organizationsTable,
    organizationAdditionalEmails: additionalEmailsTable,
    invoices: {
      __name: "invoices",
      labOrganizationId: col("labOrganizationId"),
      status: col("status"),
      issuedAt: col("issuedAt"),
      dueAt: col("dueAt"),
      createdAt: col("createdAt"),
      providerOrganizationId: col("providerOrganizationId"),
    },
    invoiceLineItems: { __name: "invoice_line_items", invoiceId: col("invoiceId"), sortOrder: col("sortOrder") },
    statementLinkTokens: { __name: "statement_link_tokens", token: col("token") },
    statementSchedules: { __name: "statement_schedules", labOrganizationId: col("labOrganizationId") },
    statementSendRuns: { __name: "statement_send_runs", id: col("id") },
    practiceStatements: { __name: "practice_statements", id: col("id") },
    practiceStatementSends: { __name: "practice_statement_sends", id: col("id") },
    doctorProfiles: {
      __name: "doctor_profiles",
      labOrganizationId: col("labOrganizationId"),
      doctorName: col("doctorName"),
      providerOrganizationId: col("providerOrganizationId"),
    },
    doctorPhoneEntries: { __name: "doctor_phone_entries", doctorProfileId: col("doctorProfileId") },
    doctorEmailEntries: { __name: "doctor_email_entries", doctorProfileId: col("doctorProfileId") },
  };
});

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators. Comparison operators record their arguments so
// scope/cutoff tests can assert the query the builder actually asks for.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => {
  const record =
    (op: string) =>
    (column: any, value: unknown) => {
      mockOperatorCalls.push({ op, column: column?.__col ?? "?", value });
      return {};
    };
  return {
    eq: record("eq"),
    ne: record("ne"),
    gte: record("gte"),
    gt: record("gt"),
    lt: record("lt"),
    lte: record("lte"),
    and: () => ({}),
    or: () => ({}),
    isNull: () => ({}),
    inArray: () => ({}),
    notInArray: () => ({}),
    asc: () => ({}),
    desc: () => ({}),
    sql: () => ({}),
  };
});

vi.mock("./lab-logo-storage.js", () => ({
  openLabLogoStream: vi.fn().mockResolvedValue(null),
  openInvoiceTemplateImageStream: vi.fn().mockResolvedValue(null),
}));

vi.mock("./mail.js", () => ({
  sendMail: mockSendMail,
  getAppBaseUrl: () => "http://localhost:5000",
  LAB_LOGO_CID: "lab-logo",
}));

vi.mock("./email-prefs.js", () => ({
  checkEmailPref: mockCheckEmailPref,
}));

vi.mock("./sms.js", () => ({
  sendSms: mockSendSms,
}));

vi.mock("archiver", () => ({
  default: vi.fn().mockReturnValue({
    on: vi.fn(),
    pipe: vi.fn(),
    append: vi.fn(),
    finalize: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let invoiceSeq = 0;
function makeInvoice(overrides: Row = {}): Row {
  invoiceSeq += 1;
  return {
    id: `inv-${invoiceSeq}`,
    labOrganizationId: "lab-1",
    providerOrganizationId: "org-a",
    caseId: null,
    invoiceNumber: `INV-${String(invoiceSeq).padStart(3, "0")}`,
    status: "sent",
    total: "100.00",
    balanceDue: "100.00",
    createdAt: new Date("2026-04-15T00:00:00Z"),
    issuedAt: new Date("2026-04-15T00:00:00Z"),
    dueAt: null,
    displayMetadataJson: null,
    ...overrides,
  };
}

function makeOrg(id: string, overrides: Row = {}): Row {
  return {
    id,
    name: `Practice ${id}`,
    displayName: `Practice ${id}`,
    billingEmail: `${id}@example.com`,
    phone: null,
    statementEmailOptOut: false,
    ...overrides,
  };
}

/**
 * One invoice per doctor at one practice. The doctor is resolved through the
 * invoice's linked case, which is what the bundle partition keys on.
 */
function doctorInvoices(
  orgId: string,
  entries: Array<{ doctor: string | null; total: string; balance?: string; status?: string }>
) {
  const invoices: Row[] = [];
  const cases: Row[] = [];
  entries.forEach((entry, index) => {
    const caseId = entry.doctor ? `${orgId}-case-${index}` : null;
    if (entry.doctor && caseId) {
      cases.push({ id: caseId, doctorName: entry.doctor });
    }
    invoices.push(
      makeInvoice({
        providerOrganizationId: orgId,
        caseId,
        total: entry.total,
        balanceDue: entry.balance ?? entry.total,
        ...(entry.status ? { status: entry.status } : {}),
      })
    );
  });
  return { invoices, cases };
}

type StatementsModule = typeof import("./statements.js");

async function loadStatements(): Promise<StatementsModule> {
  return import("./statements.js");
}

beforeEach(async () => {
  vi.clearAllMocks();
  invoiceSeq = 0;
  mockInserts.length = 0;
  mockUpdates.length = 0;
  mockFailingInsertTables.clear();
  mockOperatorCalls.length = 0;
  mockSendRunFindFirst.mockResolvedValue(undefined);
  mockStatementFindFirst.mockResolvedValue(undefined);
  mockScheduleFindFirst.mockResolvedValue(null);
  mockLineItemsFindMany.mockResolvedValue([]);
  mockInvoicesFindMany.mockResolvedValue([]);
  mockCaseRows.mockReturnValue([]);
  mockOrgRows.mockReturnValue([]);
  mockPaymentRows.mockReturnValue([]);
  mockAdditionalEmailRows.mockReturnValue([]);
  mockOrgFindFirst.mockResolvedValue({
    id: "lab-1",
    name: "Bright Lab",
    displayName: "Bright Lab",
    logoUrl: null,
  });
  mockCheckEmailPref.mockResolvedValue(true);
  mockDoctorProfileFindFirst.mockResolvedValue(null);
  mockSendMail.mockResolvedValue({ sent: true });
  mockSendSms.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// buildPracticeStatementBundles
// ---------------------------------------------------------------------------

describe("buildPracticeStatementBundles — one practice, one document per doctor", () => {
  it("turns four doctors at one practice into one bundle with four separate documents", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: "Dr. Chen", total: "300.00" },
      { doctor: "Dr. Diaz", total: "400.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([makeOrg("org-a", { displayName: "Sunrise Dental" })]);

    const { buildPracticeStatementBundles } = await loadStatements();
    const bundles = await buildPracticeStatementBundles("lab-1", { scope: "open" });

    // One practice → one outgoing message.
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(bundle.practiceId).toBe("org-a");
    expect(bundle.practiceName).toBe("Sunrise Dental");

    // Four selected doctors → four attachments, in stable name order.
    expect(bundle.documents.map((d) => d.documentKey)).toEqual([
      "Dr. Adams",
      "Dr. Brown",
      "Dr. Chen",
      "Dr. Diaz",
    ]);

    // Each document carries only its own doctor's invoices — no leakage.
    for (const doc of bundle.documents) {
      expect(doc.data.invoices).toHaveLength(1);
      expect(doc.data.invoices.every((i) => i.doctorName === doc.doctorName)).toBe(true);
      expect(doc.invoiceCount).toBe(1);
      expect(doc.data.practiceId).toBe(`org-a::${doc.documentKey}`);
      expect(doc.data.practiceName).toBe(doc.documentKey);
    }
    expect(bundle.documents.map((d) => d.totalBilled)).toEqual([100, 200, 300, 400]);

    // Practice-level aggregate stays the sum of the attached documents.
    expect(bundle.invoiceCount).toBe(4);
    expect(bundle.totalBilled).toBe(1000);
    expect(bundle.openBalance).toBe(1000);
  });

  it("keeps one bundle for several locations of the same billing practice", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "150.00" },
    ]);
    // Different physical locations recorded on the invoices, same billed practice.
    invoices[0]!["displayMetadataJson"] = { billTo: "12 Main St, Springfield" };
    invoices[1]!["displayMetadataJson"] = { billTo: "900 Elm Ave, Shelbyville" };
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([makeOrg("org-a", { displayName: "Sunrise Dental" })]);

    const { buildPracticeStatementBundles } = await loadStatements();
    const bundles = await buildPracticeStatementBundles("lab-1", { scope: "open" });

    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.documents).toHaveLength(2);
  });

  it("keeps practices distinct when their names, addresses, and emails are identical", async () => {
    const a = doctorInvoices("org-a", [{ doctor: "Dr. Shared", total: "100.00" }]);
    const b = doctorInvoices("org-b", [{ doctor: "Dr. Shared", total: "250.00" }]);
    for (const invoice of [...a.invoices, ...b.invoices]) {
      invoice["displayMetadataJson"] = { billTo: "1 Identical Plaza" };
    }
    mockInvoicesFindMany.mockResolvedValue([...a.invoices, ...b.invoices]);
    mockCaseRows.mockReturnValue([...a.cases, ...b.cases]);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Bright Smiles Dental",
        billingEmail: "billing@brightsmiles.example",
      }),
      makeOrg("org-b", {
        displayName: "Bright Smiles Dental",
        billingEmail: "billing@brightsmiles.example",
      }),
    ]);

    const { buildPracticeStatementBundles } = await loadStatements();
    const bundles = await buildPracticeStatementBundles("lab-1", { scope: "open" });

    // Same name, same address, same email — still two separate bundles.
    expect(bundles.map((b2) => b2.practiceId).sort()).toEqual(["org-a", "org-b"]);
    for (const bundle of bundles) {
      expect(bundle.documents).toHaveLength(1);
      expect(bundle.documents[0]!.data.invoices).toHaveLength(1);
    }
    // The same doctor name at two practices never merges into one document.
    const invoiceIds = bundles.flatMap((bundle) =>
      bundle.documents.flatMap((doc) => doc.data.invoices.map((i) => i.id))
    );
    expect(new Set(invoiceIds).size).toBe(2);
    expect(bundles.map((b2) => b2.totalBilled).sort((x, y) => x - y)).toEqual([100, 250]);
  });

  it("drops zero-balance invoices on open scopes but keeps them for 'all'", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00", balance: "0.00" },
      { doctor: "Dr. Brown", total: "200.00", balance: "50.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const { buildPracticeStatementBundles } = await loadStatements();

    const open = await buildPracticeStatementBundles("lab-1", { scope: "open" });
    // Dr. Adams has nothing outstanding, so there is no empty attachment.
    expect(open[0]!.documents.map((d) => d.documentKey)).toEqual(["Dr. Brown"]);
    expect(open[0]!.openBalance).toBe(50);

    const all = await buildPracticeStatementBundles("lab-1", { scope: "all" });
    // "all" is a history scope — the settled invoice still belongs on it.
    expect(all[0]!.documents.map((d) => d.documentKey)).toEqual([
      "Dr. Adams",
      "Dr. Brown",
    ]);
  });

  it("collects invoices with no resolvable doctor into one labeled document listed last", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: null, total: "75.00" },
      { doctor: null, total: "25.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const { buildPracticeStatementBundles, NO_DOCTOR_KEY, NO_DOCTOR_LABEL } =
      await loadStatements();
    const [bundle] = await buildPracticeStatementBundles("lab-1", { scope: "open" });

    expect(bundle!.documents.map((d) => d.documentKey)).toEqual([
      "Dr. Brown",
      NO_DOCTOR_KEY,
    ]);
    const unassigned = bundle!.documents.at(-1)!;
    expect(unassigned.label).toBe(NO_DOCTOR_LABEL);
    expect(unassigned.doctorName).toBeNull();
    // Nothing silently disappears: both unassigned invoices are on it.
    expect(unassigned.invoiceCount).toBe(2);
    expect(unassigned.totalBilled).toBe(100);
  });

  it("honours per-practice doctor exclusions, including the unassigned bucket", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: null, total: "50.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const { buildPracticeStatementBundles, NO_DOCTOR_KEY } = await loadStatements();

    const onlyAdams = await buildPracticeStatementBundles("lab-1", {
      scope: "open",
      doctorFilters: { "org-a": ["Dr. Adams"] },
    });
    expect(onlyAdams[0]!.documents.map((d) => d.documentKey)).toEqual(["Dr. Adams"]);
    expect(onlyAdams[0]!.invoiceCount).toBe(1);

    const adamsAndUnassigned = await buildPracticeStatementBundles("lab-1", {
      scope: "open",
      doctorFilters: { "org-a": ["Dr. Adams", NO_DOCTOR_KEY] },
    });
    expect(adamsAndUnassigned[0]!.documents.map((d) => d.documentKey)).toEqual([
      "Dr. Adams",
      NO_DOCTOR_KEY,
    ]);
  });

  it("applies the issue-date cutoff to the invoice query for the 'open as of' scope", async () => {
    mockInvoicesFindMany.mockResolvedValue([]);
    const asOf = new Date("2026-09-30T23:59:59.000Z");

    const { buildPracticeStatementBundles } = await loadStatements();
    await buildPracticeStatementBundles("lab-1", { scope: "open_as_of", asOf });

    // The cutoff filters issued dates — never due dates — and paid/void
    // invoices stay excluded from an open scope.
    expect(
      mockOperatorCalls.some(
        (call) => call.op === "lte" && call.column === "issuedAt" && call.value === asOf
      )
    ).toBe(true);
    expect(
      mockOperatorCalls.some((call) => call.op === "lte" && call.column === "dueAt")
    ).toBe(false);
    const excluded = mockOperatorCalls
      .filter((call) => call.op === "ne" && call.column === "status")
      .map((call) => call.value);
    expect(excluded).toEqual(["paid", "void"]);
  });

  it("restricts a custom range to invoices issued inside it", async () => {
    mockInvoicesFindMany.mockResolvedValue([]);
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-31T23:59:59.000Z");

    const { buildPracticeStatementBundles } = await loadStatements();
    await buildPracticeStatementBundles("lab-1", { scope: "custom", from, to });

    expect(
      mockOperatorCalls.some(
        (call) => call.op === "gte" && call.column === "issuedAt" && call.value === from
      )
    ).toBe(true);
    expect(
      mockOperatorCalls.some(
        (call) => call.op === "lte" && call.column === "issuedAt" && call.value === to
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runBatchSendStatements — bundle delivery
// ---------------------------------------------------------------------------

/**
 * Extracts visible text from a pdfkit buffer (FlateDecode streams with
 * hex-encoded TJ runs). Mirrors the helper in statements-pdf.test.ts.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("binary");
  const parts: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRegex.exec(raw)) !== null) {
    const streamBin = Buffer.from(m[1]!, "binary");
    let content: string;
    try {
      content = inflateSync(streamBin).toString("latin1");
    } catch {
      content = streamBin.toString("latin1");
    }
    const hexRegex = /<([0-9a-fA-F]*)>/g;
    let h: RegExpExecArray | null;
    while ((h = hexRegex.exec(content)) !== null) {
      const hex = h[1]!;
      if (!hex.length) continue;
      let text = "";
      for (let i = 0; i + 1 < hex.length; i += 2) {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      parts.push(text);
    }
  }
  return parts.join("");
}

/** Statement PDFs persisted by these tests, removed in afterAll. */
const writtenStatementFiles = new Set<string>();

function rememberWrittenFiles() {
  for (const row of mockInserts) {
    if (row.table !== "practice_statements") continue;
    const manifest = row.values?.bundleManifestJson;
    for (const attachment of manifest?.attachments ?? []) {
      if (typeof attachment?.storageKey === "string") {
        writtenStatementFiles.add(attachment.storageKey);
      }
    }
    const legacyStorageKey = row.values?.pdfStorageKey;
    if (typeof legacyStorageKey === "string") {
      writtenStatementFiles.add(legacyStorageKey);
    }
  }
}

afterAll(() => {
  const dir = path.resolve(process.cwd(), "uploads", "practice-statements");
  for (const name of writtenStatementFiles) {
    try {
      fs.rmSync(path.resolve(dir, path.basename(name)), { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("runMonthlyStatementsForLab — scheduled statement format", () => {
  it("sends one practice email with four doctor PDFs using the saved monthly scope", async () => {
    const included = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: "Dr. Chen", total: "300.00" },
      { doctor: "Dr. Diaz", total: "400.00" },
    ]);
    const excluded = doctorInvoices("org-b", [
      { doctor: "Dr. Outside", total: "500.00" },
    ]);
    const invoices = [...included.invoices, ...excluded.invoices];
    for (const invoice of invoices) {
      invoice["createdAt"] = new Date("2026-09-12T12:00:00Z");
      invoice["issuedAt"] = new Date("2026-09-12T12:00:00Z");
    }
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue([...included.cases, ...excluded.cases]);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
      }),
      makeOrg("org-b", {
        displayName: "Outside Dental",
        billingEmail: "billing@outside.example",
      }),
    ]);
    mockAdditionalEmailRows.mockReturnValue([
      {
        organizationId: "org-a",
        email: "statements@sunrise.example",
        type: "billing",
      },
    ]);
    mockScheduleFindFirst.mockResolvedValue({
      statementFormat: "per_doctor",
      includedOrgIds: ["org-a"],
      emailSubject: "Monthly statement",
      emailBody: null,
      emailReplyTo: "replies@lab.example",
    });

    const { runMonthlyStatementsForLab } = await loadStatements();
    const result = await runMonthlyStatementsForLab({
      labOrganizationId: "lab-1",
      triggeredBy: "schedule",
      asOf: new Date("2026-10-15T12:00:00Z"),
    });
    rememberWrittenFiles();

    expect(result.periodMonth).toBe("2026-09");
    expect(result.results).toMatchObject([
      {
        practiceId: "org-a",
        status: "sent",
      },
    ]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const email = mockSendMail.mock.calls[0]![0] as any;
    expect(email.to).toBe("billing@sunrise.example");
    expect(email.cc).toEqual(["statements@sunrise.example"]);
    expect(email.attachments.map((attachment: any) => attachment.filename)).toEqual([
      "statement-Sunrise_Dental-Dr_Adams-2026-09.pdf",
      "statement-Sunrise_Dental-Dr_Brown-2026-09.pdf",
      "statement-Sunrise_Dental-Dr_Chen-2026-09.pdf",
      "statement-Sunrise_Dental-Dr_Diaz-2026-09.pdf",
    ]);

    const run = mockInserts.find((row) => row.table === "statement_send_runs");
    expect(run?.values).toMatchObject({
      triggeredBy: "schedule",
      periodMonth: "2026-09",
      status: "sent",
      bundleContextJson: {
        recipients: [
          "billing@sunrise.example",
          "statements@sunrise.example",
        ],
        documentKeys: ["Dr. Adams", "Dr. Brown", "Dr. Chen", "Dr. Diaz"],
      },
    });
    const statement = mockInserts.find(
      (row) => row.table === "practice_statements"
    );
    expect(statement?.values.bundleManifestJson.attachments).toHaveLength(4);
    expect(statement?.values.invoiceCount).toBe(4);

    expect(mockOperatorCalls).toContainEqual({
      op: "gte",
      column: "createdAt",
      value: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(mockOperatorCalls).toContainEqual({
      op: "lt",
      column: "createdAt",
      value: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  it("keeps practice opt-outs and recipient email preferences in effect", async () => {
    const optedOut = doctorInvoices("org-opted-out", [
      { doctor: "Dr. No Mail", total: "100.00" },
    ]);
    const preferenceOff = doctorInvoices("org-pref-off", [
      { doctor: "Dr. Pref Off", total: "200.00" },
    ]);
    for (const invoice of [...optedOut.invoices, ...preferenceOff.invoices]) {
      invoice["createdAt"] = new Date("2026-09-12T12:00:00Z");
      invoice["issuedAt"] = new Date("2026-09-12T12:00:00Z");
    }
    mockInvoicesFindMany.mockResolvedValue([
      ...optedOut.invoices,
      ...preferenceOff.invoices,
    ]);
    mockCaseRows.mockReturnValue([...optedOut.cases, ...preferenceOff.cases]);
    mockOrgRows.mockReturnValue([
      makeOrg("org-opted-out", {
        billingEmail: "opted-out@example.com",
        statementEmailOptOut: true,
      }),
      makeOrg("org-pref-off", {
        billingEmail: "preference-off@example.com",
      }),
    ]);
    mockCheckEmailPref.mockImplementation(async (email: string) =>
      email !== "preference-off@example.com"
    );
    mockScheduleFindFirst.mockResolvedValue({
      statementFormat: "per_doctor",
      includedOrgIds: null,
      emailSubject: null,
      emailBody: null,
      emailReplyTo: null,
    });

    const { runMonthlyStatementsForLab } = await loadStatements();
    const result = await runMonthlyStatementsForLab({
      labOrganizationId: "lab-1",
      triggeredBy: "schedule",
      asOf: new Date("2026-10-15T12:00:00Z"),
    });

    expect(result.results).toMatchObject([
      { practiceId: "org-opted-out", status: "skipped_opted_out" },
      { practiceId: "org-pref-off", status: "skipped_opted_out" },
    ]);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(
      mockInserts.filter((row) => row.table === "practice_statements")
    ).toHaveLength(0);
  });

  it("keeps the consolidated PDF layout when the schedule explicitly selects it", async () => {
    const practice = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
    ]);
    for (const invoice of practice.invoices) {
      invoice["createdAt"] = new Date("2026-09-12T12:00:00Z");
    }
    mockInvoicesFindMany.mockResolvedValue(practice.invoices);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
      }),
    ]);
    mockScheduleFindFirst.mockResolvedValue({
      statementFormat: "consolidated",
      includedOrgIds: null,
      emailSubject: null,
      emailBody: null,
      emailReplyTo: null,
    });

    const { runMonthlyStatementsForLab } = await loadStatements();
    const result = await runMonthlyStatementsForLab({
      labOrganizationId: "lab-1",
      triggeredBy: "manual",
      asOf: new Date("2026-10-15T12:00:00Z"),
    });
    rememberWrittenFiles();

    expect(result.results).toMatchObject([{ practiceId: "org-a", status: "sent" }]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const email = mockSendMail.mock.calls[0]![0] as any;
    expect(email.attachments).toHaveLength(1);
    expect(
      mockInserts.find((row) => row.table === "practice_statements")?.values
        .bundleManifestJson
    ).toBeUndefined();
  });
});

describe("runBatchSendStatements — practice bundles", () => {
  function fourDoctorPractice() {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: "Dr. Chen", total: "300.00" },
      { doctor: "Dr. Diaz", total: "400.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
      }),
    ]);
    return invoices;
  }

  it("sends one email per practice carrying one distinct PDF per doctor", async () => {
    const invoices = fourDoctorPractice();
    const { runBatchSendStatements } = await loadStatements();

    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      periodLabel: "September balance statement",
    });
    rememberWrittenFiles();

    // One message for four documents — not four messages.
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0]![0] as any;
    expect(mail.to).toBe("billing@sunrise.example");
    expect(mail.attachments).toHaveLength(4);

    // Distinct, identifiable attachment names.
    const names = mail.attachments.map((a: any) => a.filename);
    const month = new Date().toISOString().slice(0, 7);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual([
      `statement-Sunrise_Dental-Dr_Adams-${month}.pdf`,
      `statement-Sunrise_Dental-Dr_Brown-${month}.pdf`,
      `statement-Sunrise_Dental-Dr_Chen-${month}.pdf`,
      `statement-Sunrise_Dental-Dr_Diaz-${month}.pdf`,
    ]);

    // Each PDF carries only its own doctor's invoice — no cross-doctor leak.
    const texts = mail.attachments.map((a: any) => pdfText(a.content as Buffer));
    const invoiceNumbers = invoices.map((i) => String(i["invoiceNumber"]));
    texts.forEach((text: string, index: number) => {
      expect(text).toContain(invoiceNumbers[index]!);
      invoiceNumbers
        .filter((_, other) => other !== index)
        .forEach((otherNumber) => expect(text).not.toContain(otherNumber));
    });
    expect(texts[0]).toContain("Dr. Adams");
    expect(texts[0]).not.toContain("Dr. Brown");

    // The result distinguishes the practice message from its attachments.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.emailStatus).toBe("sent");
    expect(result.results[0]!.recipients).toEqual(["billing@sunrise.example"]);
    expect(result.results[0]!.attachments?.map((a) => a.label)).toEqual([
      "Dr. Adams",
      "Dr. Brown",
      "Dr. Chen",
      "Dr. Diaz",
    ]);

    // Exactly ONE issued statement row for the practice, with a manifest of
    // every attachment — never one practice-wide liability per attachment.
    const statementRows = mockInserts.filter((r) => r.table === "practice_statements");
    expect(statementRows).toHaveLength(1);
    const values = statementRows[0]!.values;
    expect(Number(values.balanceDue)).toBe(1000);
    expect(values.invoiceIdsJson).toHaveLength(4);
    expect(values.bundleManifestJson.version).toBe(1);
    expect(values.bundleManifestJson.recipients).toEqual(["billing@sunrise.example"]);
    expect(values.bundleManifestJson.attachments).toHaveLength(4);
    expect(
      values.bundleManifestJson.attachments.every(
        (a: any) => typeof a.storageKey === "string" && a.invoiceIds.length === 1
      )
    ).toBe(true);
    // Legacy single-PDF columns still point at a real file.
    expect(values.pdfStorageKey).toBe(values.bundleManifestJson.attachments[0].storageKey);
  });

  it("includes billing-tagged additional addresses and skips correspondence-only ones", async () => {
    fourDoctorPractice();
    // getBillingAdditionalEmailsMap filters by type in SQL; the mock returns
    // only the billing-tagged rows the real query would.
    mockAdditionalEmailRows.mockReturnValue([
      { organizationId: "org-a", email: "ap@sunrise.example" },
      { organizationId: "org-a", email: "BILLING@sunrise.example" },
    ]);

    const { runBatchSendStatements } = await loadStatements();
    await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
    });
    rememberWrittenFiles();

    const mail = mockSendMail.mock.calls[0]![0] as any;
    expect(mail.to).toBe("billing@sunrise.example");
    // Duplicate of the primary address (different case) is removed.
    expect(mail.cc).toEqual(["ap@sunrise.example"]);
  });

  it("uses a per-send recipient override instead of saved contacts and automatic CC", async () => {
    fourDoctorPractice();
    mockAdditionalEmailRows.mockReturnValue([
      { organizationId: "org-a", email: "ap@sunrise.example" },
    ]);

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      // The user removed both saved addresses and typed one of their own.
      recipientEmails: { "org-a": ["office@sunrise.example"] },
    });
    rememberWrittenFiles();

    const mail = mockSendMail.mock.calls[0]![0] as any;
    expect(mail.to).toBe("office@sunrise.example");
    // A removed address must not come back through the automatic CC list.
    expect(mail.cc).toEqual([]);
    expect(result.results[0]!.recipients).toEqual(["office@sunrise.example"]);

    const statementRow = mockInserts.find((r) => r.table === "practice_statements")!;
    expect(statementRow.values.bundleManifestJson.recipients).toEqual([
      "office@sunrise.example",
    ]);
    // The override is for this send only — contacts are never rewritten.
    expect(mockInserts.some((r) => r.table === "organization_additional_emails")).toBe(
      false
    );
  });

  it("skips the practice when every recipient was removed for this send", async () => {
    fourDoctorPractice();

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      recipientEmails: { "org-a": [] },
    });

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(result.results[0]!.emailStatus).toBe("skipped");
    expect(result.results[0]!.emailError).toMatch(/No recipient addresses selected/i);
  });

  it("fails the practice without sending a partial bundle when a PDF cannot be generated", async () => {
    fourDoctorPractice();

    // Fail while rendering the third document: the first two already
    // succeeded, so a partial bundle would go out if the send were not
    // all-or-nothing.
    let documentsStarted = 0;
    vi.resetModules();
    vi.doMock("pdfkit", async () => {
      const actual = await vi.importActual<any>("pdfkit");
      const RealDocument = actual.default ?? actual;
      class FailingThirdDocument extends RealDocument {
        constructor(...args: any[]) {
          documentsStarted += 1;
          if (documentsStarted === 3) throw new Error("PDF render failed");
          super(...args);
        }
      }
      return { ...actual, default: FailingThirdDocument };
    });

    try {
      const { runBatchSendStatements } = await loadStatements();
      const result = await runBatchSendStatements({
        labOrganizationId: "lab-1",
        triggeredByUserId: "user-1",
        practiceIds: ["org-a"],
        invoiceScope: "open",
        channels: ["email"],
      });

      expect(documentsStarted).toBe(3);
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(result.results[0]!.emailStatus).toBe("failed");
      expect(result.results[0]!.emailError).toMatch(/PDF render failed/);
      // Nothing was issued for a message that never went out.
      expect(mockInserts.some((r) => r.table === "practice_statements")).toBe(false);
    } finally {
      vi.doUnmock("pdfkit");
      vi.resetModules();
    }
  });

  it("sends nothing when the issued PDFs cannot be stored", async () => {
    fourDoctorPractice();

    // The third PDF cannot be written. Mailing the bundle anyway would hand
    // the practice documents no retry could ever reproduce.
    let writes = 0;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<any>("node:fs");
      const writeFileSync = (...args: any[]) => {
        writes += 1;
        if (writes === 3) throw new Error("ENOSPC: no space left on device");
        return (actual.writeFileSync as any)(...args);
      };
      return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
    });

    try {
      const { runBatchSendStatements } = await loadStatements();
      const result = await runBatchSendStatements({
        labOrganizationId: "lab-1",
        triggeredByUserId: "user-1",
        practiceIds: ["org-a"],
        invoiceScope: "open",
        channels: ["email"],
      });

      expect(mockSendMail).not.toHaveBeenCalled();
      expect(result.results[0]!.emailStatus).toBe("failed");
      expect(result.results[0]!.emailError).toMatch(/could not be stored/i);
      expect(result.results[0]!.replayable).toBe(false);
      expect(mockInserts.some((r) => r.table === "practice_statements")).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      // The two PDFs written before the failure are still on disk.
      const dir = path.resolve(process.cwd(), "uploads", "practice-statements");
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (name.includes("Sunrise")) writtenStatementFiles.add(name);
      }
    }
  });

  it("sends nothing when the issued statement record cannot be written", async () => {
    fourDoctorPractice();
    // Without a statement row there is no manifest, so a retry could not
    // replay what was mailed — the send must not happen at all.
    mockFailingInsertTables.add("practice_statements");

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
    });
    const dir = path.resolve(process.cwd(), "uploads", "practice-statements");
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name.includes("Sunrise")) writtenStatementFiles.add(name);
    }

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(result.results[0]!.emailStatus).toBe("failed");
    expect(result.results[0]!.emailError).toMatch(/could not be recorded/i);
    expect(result.results[0]!.replayable).toBe(false);
    // The failure is still recorded as a send run, with no statement to
    // replay, so the practice shows up as failed in Send history.
    const run = mockInserts.find((r) => r.table === "statement_send_runs")!;
    expect(run.values.status).toBe("failed");
    expect(run.values.bundleContextJson.statementId).toBeNull();
  });

  it("reports a delivery failure per practice and leaves other practices sent", async () => {
    const a = doctorInvoices("org-a", [{ doctor: "Dr. Adams", total: "100.00" }]);
    const b = doctorInvoices("org-b", [{ doctor: "Dr. Brown", total: "200.00" }]);
    mockInvoicesFindMany.mockResolvedValue([...a.invoices, ...b.invoices]);
    mockCaseRows.mockReturnValue([...a.cases, ...b.cases]);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", { displayName: "Sunrise Dental", billingEmail: "a@example.com" }),
      makeOrg("org-b", { displayName: "Harbor Dental", billingEmail: "b@example.com" }),
    ]);
    mockSendMail
      .mockResolvedValueOnce({ sent: false, reason: "smtp rejected" })
      .mockResolvedValueOnce({ sent: true });

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      practiceIds: ["org-a", "org-b"],
      invoiceScope: "open",
      channels: ["email"],
    });
    rememberWrittenFiles();

    expect(result.results.map((r) => [r.practiceId, r.emailStatus])).toEqual([
      ["org-a", "failed"],
      ["org-b", "sent"],
    ]);
    expect(result.results[0]!.emailError).toBe("smtp rejected");
    // A failed delivery still keeps its issued PDFs for a later retry.
    const statementRows = mockInserts.filter((r) => r.table === "practice_statements");
    expect(statementRows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// retryStatementSendRun — bundles re-send what was issued
// ---------------------------------------------------------------------------

describe("retryStatementSendRun — practice bundles", () => {
  /**
   * Runs a bundle send whose delivery fails, then returns the send-run and
   * issued-statement rows it recorded — the state Send history retries from.
   */
  async function issueFailedBundle(opts: {
    recipientEmails?: Record<string, string[]>;
    doctorFilters?: Record<string, string[]>;
  }) {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
      { doctor: "Dr. Chen", total: "300.00" },
      { doctor: "Dr. Diaz", total: "400.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
      }),
    ]);
    // Saved contacts a retry must NOT reload when they were removed.
    mockAdditionalEmailRows.mockReturnValue([
      { organizationId: "org-a", email: "ap@sunrise.example" },
    ]);
    mockSendMail.mockResolvedValue({ sent: false, reason: "smtp rejected" });

    const { runBatchSendStatements } = await loadStatements();
    await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      periodLabel: "September balance statement",
      emailSubject: "Your September statement",
      ...(opts.recipientEmails ? { recipientEmails: opts.recipientEmails } : {}),
      ...(opts.doctorFilters ? { doctorFilters: opts.doctorFilters } : {}),
    });
    rememberWrittenFiles();

    const runValues = mockInserts.find(
      (r) => r.table === "statement_send_runs"
    )!.values;
    const statementRow = mockInserts.find(
      (r) => r.table === "practice_statements"
    );
    return {
      run: {
        id: "run-1",
        labOrganizationId: "lab-1",
        practiceOrganizationId: "org-a",
        practiceName: runValues.practiceName,
        practiceEmail: runValues.practiceEmail,
        periodMonth: runValues.periodMonth,
        status: "failed",
        errorMessage: runValues.errorMessage,
        invoiceCount: runValues.invoiceCount,
        totalBilled: runValues.totalBilled,
        openBalance: runValues.openBalance,
        attemptCount: 1,
        bundleContextJson: runValues.bundleContextJson,
      },
      statement: statementRow
        ? {
            id: runValues.bundleContextJson.statementId,
            ...statementRow.values,
          }
        : null,
    };
  }

  /** Puts the recorded rows behind the lookups the retry path performs. */
  function arrangeRetry(issued: { run: any; statement: any }) {
    mockSendRunFindFirst.mockResolvedValue(issued.run);
    mockStatementFindFirst.mockResolvedValue(issued.statement ?? undefined);
    mockOrgFindFirst.mockResolvedValue({
      id: "org-a",
      name: "Sunrise Dental",
      displayName: "Sunrise Dental",
      logoUrl: null,
      statementEmailOptOut: false,
    });
    // A rebuild would have to query invoices again — these stay empty so a
    // rebuild could not quietly succeed with stale fixtures.
    mockInvoicesFindMany.mockClear();
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ sent: true });
  }

  it("re-sends the issued PDFs to the chosen recipients, not saved contacts", async () => {
    const issued = await issueFailedBundle({
      // The sender removed both saved addresses and typed their own, and
      // excluded two of the four doctors.
      recipientEmails: { "org-a": ["office@sunrise.example"] },
      doctorFilters: { "org-a": ["Dr. Adams", "Dr. Brown"] },
    });
    expect(issued.run.bundleContextJson.recipients).toEqual([
      "office@sunrise.example",
    ]);
    expect(issued.run.bundleContextJson.documentKeys).toEqual([
      "Dr. Adams",
      "Dr. Brown",
    ]);

    arrangeRetry(issued);
    const { retryStatementSendRun } = await loadStatements();
    const result = await retryStatementSendRun("run-1");

    expect(result.status).toBe("sent");
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0]![0] as any;
    // Removed addresses stay removed — including through the CC list.
    expect(mail.to).toBe("office@sunrise.example");
    expect(mail.cc).toEqual([]);
    expect(JSON.stringify(mail)).not.toContain("billing@sunrise.example");
    expect(JSON.stringify(mail)).not.toContain("ap@sunrise.example");

    // Excluded doctors stay excluded: the issued documents are re-sent,
    // not a freshly computed consolidated statement for the month.
    expect(mockInvoicesFindMany).not.toHaveBeenCalled();
    const manifest = issued.statement.bundleManifestJson;
    expect(mail.attachments.map((a: any) => a.filename)).toEqual(
      manifest.attachments.map((a: any) => a.fileName)
    );
    expect(mail.attachments).toHaveLength(2);
    const texts = mail.attachments.map((a: any) => pdfText(a.content as Buffer));
    expect(texts[0]).toContain("Dr. Adams");
    expect(texts.join("")).not.toContain("Dr. Chen");
    expect(texts.join("")).not.toContain("Dr. Diaz");

    // The run is marked sent without recomputing its snapshot figures.
    const runUpdate = mockUpdates.find((u) => u.table === "statement_send_runs")!;
    expect(runUpdate.values.status).toBe("sent");
    expect(runUpdate.values.nextAttemptAt).toBeNull();
    expect(runUpdate.values).not.toHaveProperty("totalBilled");
    // The retry is recorded against the statement it re-sent.
    expect(
      mockInserts
        .filter((r) => r.table === "practice_statement_sends")
        .at(-1)!.values.recipient
    ).toBe("office@sunrise.example");
  });

  it("skips instead of falling back to saved contacts when no address was chosen", async () => {
    const issued = await issueFailedBundle({ recipientEmails: { "org-a": [] } });
    // Nothing was issued for a send that never went out …
    expect(issued.statement).toBeNull();
    expect(issued.run.bundleContextJson.recipients).toEqual([]);

    arrangeRetry(issued);
    const { retryStatementSendRun } = await loadStatements();
    const result = await retryStatementSendRun("run-1");

    expect(result.status).toBe("skipped_no_email");
    expect(result.errorMessage).toMatch(/Generate Statements/i);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockInvoicesFindMany).not.toHaveBeenCalled();
  });

  it("refuses to rebuild a consolidated statement when the issued PDFs are gone", async () => {
    const issued = await issueFailedBundle({
      recipientEmails: { "org-a": ["office@sunrise.example"] },
    });
    // The issued files were cleaned up after they were written.
    const dir = path.resolve(process.cwd(), "uploads", "practice-statements");
    for (const attachment of issued.statement.bundleManifestJson.attachments) {
      fs.rmSync(path.resolve(dir, path.basename(attachment.storageKey)), {
        force: true,
      });
    }

    arrangeRetry(issued);
    const { retryStatementSendRun } = await loadStatements();
    const result = await retryStatementSendRun("run-1");

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/no longer available/i);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockInvoicesFindMany).not.toHaveBeenCalled();
    // It leaves the automatic retry queue rather than failing every tick.
    const runUpdate = mockUpdates.find((u) => u.table === "statement_send_runs")!;
    expect(runUpdate.values.nextAttemptAt).toBeNull();
  });

  it("replays the issued documents when the wizard retries a failed practice", async () => {
    const issued = await issueFailedBundle({
      recipientEmails: { "org-a": ["office@sunrise.example"] },
      doctorFilters: { "org-a": ["Dr. Adams", "Dr. Brown"] },
    });
    arrangeRetry(issued);
    const statementRowsBefore = mockInserts.filter(
      (r) => r.table === "practice_statements"
    ).length;

    // What "Retry failed" posts: the same selection plus the run to replay.
    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      recipientEmails: { "org-a": ["office@sunrise.example"] },
      replayRuns: { "org-a": "run-1" },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.emailStatus).toBe("sent");
    expect(result.results[0]!.runId).toBe("run-1");
    expect(result.results[0]!.replayable).toBe(true);
    // Nothing is rebuilt: the invoices are not re-read and no second
    // statement is issued for documents that already exist.
    expect(mockInvoicesFindMany).not.toHaveBeenCalled();
    expect(
      mockInserts.filter((r) => r.table === "practice_statements")
    ).toHaveLength(statementRowsBefore);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0]![0] as any;
    expect(mail.to).toBe("office@sunrise.example");
    expect(mail.attachments.map((a: any) => a.filename)).toEqual(
      issued.statement.bundleManifestJson.attachments.map((a: any) => a.fileName)
    );
    expect(result.results[0]!.attachments!.map((a) => a.label)).toEqual([
      "Dr. Adams",
      "Dr. Brown",
    ]);
  });

  it("replays to a recipient list the user corrected after the failure", async () => {
    const issued = await issueFailedBundle({
      recipientEmails: { "org-a": ["typo@sunrsie.example"] },
    });
    arrangeRetry(issued);

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      recipientEmails: { "org-a": ["office@sunrise.example"] },
      replayRuns: { "org-a": "run-1" },
    });

    expect(result.results[0]!.emailStatus).toBe("sent");
    expect(result.results[0]!.recipients).toEqual(["office@sunrise.example"]);
    const mail = mockSendMail.mock.calls[0]![0] as any;
    expect(mail.to).toBe("office@sunrise.example");
    expect(JSON.stringify(mail)).not.toContain("typo@sunrsie.example");
    // The corrected list is kept on the run, so a further attempt does not
    // fall back to the address that could not be delivered.
    const runUpdate = mockUpdates.find((u) => u.table === "statement_send_runs")!;
    expect(runUpdate.values.bundleContextJson.recipients).toEqual([
      "office@sunrise.example",
    ]);
  });

  it("rebuilds when the practice was skipped and has no issued documents", async () => {
    // Nothing was issued, so "Send now" after adding an address has to build
    // the statement — there are no documents to replay.
    const issued = await issueFailedBundle({ recipientEmails: { "org-a": [] } });
    expect(issued.statement).toBeNull();
    arrangeRetry(issued);
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);

    const { runBatchSendStatements } = await loadStatements();
    const result = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      recipientEmails: { "org-a": ["office@sunrise.example"] },
      replayRuns: { "org-a": "run-1" },
    });
    rememberWrittenFiles();

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.emailStatus).toBe("sent");
    expect(mockInvoicesFindMany).toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect((mockSendMail.mock.calls[0]![0] as any).to).toBe(
      "office@sunrise.example"
    );
  });

  /** Issues a bundle whose email went out but whose SMS failed. */
  async function issueSmsFailure() {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
      { doctor: "Dr. Brown", total: "200.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
        phone: "+15555550123",
      }),
    ]);
    mockSendMail.mockResolvedValue({ sent: true });
    mockSendSms.mockResolvedValue({ ok: false, errorMessage: "carrier rejected" });

    const { runBatchSendStatements } = await loadStatements();
    const first = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email", "sms"],
    });
    rememberWrittenFiles();
    expect(first.results[0]!.emailStatus).toBe("sent");
    expect(first.results[0]!.smsStatus).toBe("failed");

    const runValues = mockInserts.find(
      (r) => r.table === "statement_send_runs"
    )!.values;
    const statementRow = mockInserts.find(
      (r) => r.table === "practice_statements"
    )!;
    return {
      first,
      run: {
        id: "run-1",
        labOrganizationId: "lab-1",
        practiceOrganizationId: "org-a",
        practiceName: runValues.practiceName,
        practiceEmail: runValues.practiceEmail,
        periodMonth: runValues.periodMonth,
        status: "failed",
        errorMessage: runValues.errorMessage,
        invoiceCount: runValues.invoiceCount,
        totalBilled: runValues.totalBilled,
        openBalance: runValues.openBalance,
        attemptCount: 1,
        bundleContextJson: runValues.bundleContextJson,
      },
      statement: {
        id: runValues.bundleContextJson.statementId,
        ...statementRow.values,
      },
    };
  }

  it("retries only the failed SMS and re-sends the issued email documents", async () => {
    const { run, statement } = await issueSmsFailure();
    mockStatementFindFirst.mockResolvedValue(statement);
    mockSendRunFindFirst.mockResolvedValue(run);
    mockOrgFindFirst.mockResolvedValue({
      id: "org-a",
      name: "Sunrise Dental",
      displayName: "Sunrise Dental",
      logoUrl: null,
      statementEmailOptOut: false,
    });
    mockSendMail.mockClear();
    mockSendSms.mockClear();
    mockSendSms.mockResolvedValue({ ok: true });
    const statementsBefore = mockInserts.filter(
      (r) => r.table === "practice_statements"
    ).length;

    // "Retry failed" on a mixed-channel send: the SMS has to be attempted
    // again, and the email must repeat the documents already issued.
    const { runBatchSendStatements } = await loadStatements();
    const retry = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email", "sms"],
      replayRuns: { "org-a": "run-1" },
    });
    rememberWrittenFiles();

    expect(retry.results).toHaveLength(1);
    expect(retry.results[0]!.smsStatus).toBe("sent");
    expect(retry.results[0]!.emailStatus).toBe("sent");
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    // One email, carrying the issued PDFs rather than freshly rendered ones,
    // and no second statement issued for the same documents.
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(
      (mockSendMail.mock.calls[0]![0] as any).attachments.map(
        (a: any) => a.filename
      )
    ).toEqual(statement.bundleManifestJson.attachments.map((a: any) => a.fileName));
    expect(
      mockInserts.filter((r) => r.table === "practice_statements")
    ).toHaveLength(statementsBefore);
  });

  it("does not email anything when only SMS is being re-sent", async () => {
    const { run, statement } = await issueSmsFailure();
    mockStatementFindFirst.mockResolvedValue(statement);
    mockSendRunFindFirst.mockResolvedValue(run);
    mockOrgFindFirst.mockResolvedValue({
      id: "org-a",
      name: "Sunrise Dental",
      displayName: "Sunrise Dental",
      logoUrl: null,
      statementEmailOptOut: false,
    });
    mockSendMail.mockClear();
    mockSendSms.mockClear();
    mockSendSms.mockResolvedValue({ ok: true });

    const { runBatchSendStatements } = await loadStatements();
    const retry = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["sms"],
      replayRuns: { "org-a": "run-1" },
    });
    rememberWrittenFiles();

    expect(retry.results[0]!.smsStatus).toBe("sent");
    expect(retry.results[0]!.emailStatus).toBeNull();
    // The sender unchecked email; replaying must not mail the statement.
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("keeps an emptied recipient list authoritative on a later history retry", async () => {
    const issued = await issueFailedBundle({
      recipientEmails: { "org-a": ["office@sunrise.example"] },
    });
    arrangeRetry(issued);

    // The sender removes every address before retrying: nothing goes out.
    const { runBatchSendStatements, retryStatementSendRun } = await loadStatements();
    const emptied = await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "practice",
      practiceIds: ["org-a"],
      invoiceScope: "open",
      channels: ["email"],
      recipientEmails: { "org-a": [] },
      replayRuns: { "org-a": "run-1" },
    });
    expect(emptied.results[0]!.emailStatus).toBe("skipped");
    expect(mockSendMail).not.toHaveBeenCalled();

    // Send history now retries that run. The empty list it recorded is a
    // decision, not missing data — the manifest's addresses stay removed.
    const runUpdate = mockUpdates.find((u) => u.table === "statement_send_runs")!;
    expect(runUpdate.values.bundleContextJson.recipients).toEqual([]);
    mockSendRunFindFirst.mockResolvedValue({
      ...issued.run,
      bundleContextJson: runUpdate.values.bundleContextJson,
    });

    const result = await retryStatementSendRun("run-1");
    expect(result.status).toBe("skipped_no_email");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("leaves a non-bundle run on the existing rebuild path", async () => {
    mockSendRunFindFirst.mockResolvedValue({
      id: "run-legacy",
      labOrganizationId: "lab-1",
      practiceOrganizationId: "org-a",
      practiceName: "Sunrise Dental",
      practiceEmail: "billing@sunrise.example",
      periodMonth: "2026-04",
      status: "failed",
      triggeredBy: "schedule",
      attemptCount: 1,
      invoiceCount: 1,
      totalBilled: "100.00",
      openBalance: "100.00",
      bundleContextJson: null,
      retryScopeJson: null,
    });
    mockOrgFindFirst.mockResolvedValue({
      id: "org-a",
      name: "Sunrise Dental",
      displayName: "Sunrise Dental",
      logoUrl: null,
      statementEmailOptOut: false,
    });
    mockInvoicesFindMany.mockResolvedValue([]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const { retryStatementSendRun } = await loadStatements();
    await retryStatementSendRun("run-legacy");

    // Scheduled retries still recompute the calendar month's statement.
    expect(mockInvoicesFindMany).toHaveBeenCalled();
    expect(
      mockOperatorCalls.find(
        (call) => call.op === "gte" && call.column === "createdAt"
      )?.value
    ).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(
      mockOperatorCalls.find(
        (call) => call.op === "lt" && call.column === "createdAt"
      )?.value
    ).toEqual(new Date("2026-05-01T00:00:00.000Z"));
  });

  it("rebuilds a manual retry using the original open-invoice cutoff", async () => {
    const { invoices, cases } = doctorInvoices("org-a", [
      { doctor: "Dr. Adams", total: "100.00" },
    ]);
    mockInvoicesFindMany.mockResolvedValue(invoices);
    mockCaseRows.mockReturnValue(cases);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", {
        displayName: "Sunrise Dental",
        billingEmail: "billing@sunrise.example",
      }),
    ]);
    mockSendMail.mockResolvedValue({ sent: false, reason: "smtp rejected" });
    const cutoff = new Date("2026-08-15T00:00:00.000Z");

    const { runBatchSendStatements, retryStatementSendRun } =
      await loadStatements();
    await runBatchSendStatements({
      labOrganizationId: "lab-1",
      triggeredByUserId: "user-1",
      recipientType: "doctor",
      doctorKeys: ["org-a::Dr. Adams"],
      invoiceScope: "open_as_of",
      asOf: cutoff,
      channels: ["email"],
      periodLabel: "Open invoices as of August 15",
    });

    const insertedRun = mockInserts.find(
      (row) => row.table === "statement_send_runs"
    )!.values;
    expect(insertedRun.retryScopeJson).toEqual({
      version: 1,
      invoiceScope: "open_as_of",
      recipientType: "doctor",
      groupKey: "org-a::Dr. Adams",
      from: null,
      to: null,
      asOf: cutoff.toISOString(),
      periodLabel: "Open invoices as of August 15",
      doctorFilters: null,
    });

    mockSendRunFindFirst.mockResolvedValue({
      id: "run-manual",
      labOrganizationId: "lab-1",
      practiceOrganizationId: "org-a",
      practiceName: "Dr. Adams",
      practiceEmail: "billing@sunrise.example",
      periodMonth: "2026-04",
      status: "failed",
      triggeredBy: "manual",
      attemptCount: 1,
      invoiceCount: 1,
      totalBilled: "100.00",
      openBalance: "100.00",
      retryScopeJson: insertedRun.retryScopeJson,
      bundleContextJson: null,
    });
    mockOrgFindFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: "lab-1",
        name: "Bright Lab",
        displayName: "Bright Lab",
        logoUrl: null,
      })
      .mockResolvedValueOnce(makeOrg("org-a"));
    mockSendMail.mockResolvedValue({ sent: true });
    mockOperatorCalls.length = 0;

    const result = await retryStatementSendRun("run-manual");

    expect(result.status).toBe("sent");
    expect(mockInvoicesFindMany).toHaveBeenCalledTimes(2);
    expect(
      mockOperatorCalls.filter(
        (call) => call.op === "lte" && call.column === "issuedAt"
      ).map((call) => call.value)
    ).toEqual([cutoff]);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("statement bundle helpers", () => {
  it("gives colliding doctor names distinct attachment file names", async () => {
    const { createStatementFileNamer, sanitizeStatementFileNamePart } =
      await loadStatements();
    const next = createStatementFileNamer();

    // Two different doctor names can sanitize to the same string …
    expect(sanitizeStatementFileNamePart("Dr. O'Neil / Smith")).toBe("Dr_O_Neil_Smith");
    expect(sanitizeStatementFileNamePart("Dr! O Neil: Smith")).toBe("Dr_O_Neil_Smith");
    // … so the namer still hands out distinct attachment names.
    expect(next("statement-practice-Dr_Adams")).toBe("statement-practice-Dr_Adams.pdf");
    expect(next("statement-practice-Dr_Adams")).toBe("statement-practice-Dr_Adams-2.pdf");
    expect(next("statement-practice-Dr_Adams")).toBe("statement-practice-Dr_Adams-3.pdf");
  });

  it("narrows a stored manifest and rejects a legacy single-PDF row", async () => {
    const { coerceStatementBundleManifest } = await loadStatements();

    expect(coerceStatementBundleManifest(null)).toBeNull();
    expect(coerceStatementBundleManifest({ recipients: ["a@b.co"] })).toBeNull();

    const manifest = coerceStatementBundleManifest({
      version: 1,
      recipients: ["a@b.co", 7],
      attachments: [
        { storageKey: "file-1.pdf", label: "Dr. Adams" },
        { label: "missing storage key" },
      ],
    });
    expect(manifest?.recipients).toEqual(["a@b.co"]);
    expect(manifest?.attachments).toHaveLength(1);
  });

  it("validates and de-duplicates per-send recipient addresses", async () => {
    const { isLikelyEmailAddress, normalizeEmailList } = await loadStatements();

    expect(isLikelyEmailAddress("office@sunrise.example")).toBe(true);
    expect(isLikelyEmailAddress("not-an-email")).toBe(false);
    expect(isLikelyEmailAddress("two addresses@a.com b@c.com")).toBe(false);
    expect(
      normalizeEmailList(["  a@b.co ", "A@B.CO", "", null, "c@d.co"])
    ).toEqual(["a@b.co", "c@d.co"]);
  });
});
