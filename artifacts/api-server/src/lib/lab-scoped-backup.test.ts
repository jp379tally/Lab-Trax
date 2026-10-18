import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Client } from "pg";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import {
  assertLabBackupCoverage,
  LAB_BACKUP_TABLE_RULES,
  LAB_BACKUP_MEDIA_RULES,
  isBackupMediaColumn,
} from "./lab-scoped-backup-contract";
import { createFullSchemaLabBackupFixture } from "./test-support/lab-backup-full-schema";

const fixtures = vi.hoisted(() => ({
  query: vi.fn(),
  mediaCalls: [] as string[],
  realSpawn: null as typeof import("node:child_process").spawn | null,
  privateObjects: {} as Record<string, string>,
  privateCopies: [] as string[],
  privateOpens: [] as string[],
}));

vi.mock("@workspace/db", () => ({
  pool: {
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => fixtures.query(sql, params),
      release: vi.fn(),
    }),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: Parameters<typeof import("node:child_process").spawn>) => {
    if (fixtures.realSpawn) return fixtures.realSpawn(...args);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.end([
        "-- schema-only test dump",
        'CREATE TABLE public."organizations" (id text PRIMARY KEY, type text NOT NULL, name text NOT NULL, parent_lab_organization_id text);',
        'CREATE TABLE public."users" (id text PRIMARY KEY, username text NOT NULL, password text NOT NULL);',
        'CREATE TABLE public."lab_memberships" (id text PRIMARY KEY, lab_id text NOT NULL REFERENCES public."organizations"(id), user_id text NOT NULL REFERENCES public."users"(id), role text NOT NULL, status text NOT NULL, deleted_at text);',
        'CREATE TABLE public."cases" (id text PRIMARY KEY, lab_organization_id text NOT NULL REFERENCES public."organizations"(id), provider_organization_id text NOT NULL REFERENCES public."organizations"(id), created_by_user_id text NOT NULL REFERENCES public."users"(id), case_number text NOT NULL, patient_first_name text NOT NULL);',
        'CREATE TABLE public."case_attachments" (id text PRIMARY KEY, case_id text NOT NULL REFERENCES public."cases"(id), uploaded_by_user_id text NOT NULL REFERENCES public."users"(id), uploaded_by_organization_id text NOT NULL REFERENCES public."organizations"(id), file_name text NOT NULL, storage_key text NOT NULL, file_type text NOT NULL);',
        'CREATE TABLE public."legacy_case_media" (file_name text PRIMARY KEY, lab_case_id text NOT NULL, organization_id text REFERENCES public."organizations"(id), owner_id text NOT NULL);',
        'CREATE TABLE public."case_exception_notes" (id text PRIMARY KEY, exception_id text NOT NULL, note_text text NOT NULL);',
        'CREATE TABLE public."invoices" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, lab_organization_id text NOT NULL REFERENCES public."organizations"(id), invoice_number text NOT NULL);',
        ...Object.entries(groupFixtures).map(([table, fixture]) =>
          `CREATE TABLE public."${table}" (${fixture.columns.map((column) =>
            `"${column}" ${column === "invoice_id" ? "integer" : "text"}${column === "id" ? " PRIMARY KEY" : ""}`,
          ).join(", ")});`,
        ),
        // Use the actual parent relationships that are easy to lose when an
        // operational-looking table is excluded by name.
        'ALTER TABLE public."statement_payment_applications" ADD FOREIGN KEY (payment_session_id) REFERENCES public."statement_payment_sessions"(id), ADD FOREIGN KEY (invoice_id) REFERENCES public."invoices"(id);',
        'ALTER TABLE public."statement_payment_reversals" ADD FOREIGN KEY (payment_session_id) REFERENCES public."statement_payment_sessions"(id);',
        'ALTER TABLE public."customer_credits" ADD FOREIGN KEY (payment_session_id) REFERENCES public."statement_payment_sessions"(id);',
        'ALTER TABLE public."customer_credit_applications" ADD FOREIGN KEY (payment_session_id) REFERENCES public."statement_payment_sessions"(id), ADD FOREIGN KEY (invoice_id) REFERENCES public."invoices"(id), ADD FOREIGN KEY (customer_credit_id) REFERENCES public."customer_credits"(id);',
        'ALTER TABLE public."provider_auto_pay_attempts" ADD FOREIGN KEY (subscription_id) REFERENCES public."subscriptions"(id);',
        "",
      ].join("\n"));
      child.emit("close", 0);
    });
    return child;
  },
}));

vi.mock("../lib/case-media-object-storage.js", async () => {
  const { Readable } = await import("node:stream");
  return {
    openPrivateBackupObject: vi.fn(async (relativeName: string) => {
      fixtures.privateOpens.push(relativeName);
      const bytes = fixtures.privateObjects[relativeName];
      if (bytes === undefined) return null;
      return {
        relativeName,
        size: Buffer.byteLength(bytes),
        copyTo: async (destination: string) => {
          fixtures.privateCopies.push(relativeName);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, bytes);
        },
      };
    }),
    openCaseMediaObjectStream: vi.fn(async (fileName: string) => {
      fixtures.mediaCalls.push(fileName);
      return {
        stream: Readable.from([Buffer.from(`content:${fileName}`)]),
        contentType: "image/jpeg",
      };
    }),
  };
});

vi.mock("../lib/case-media.js", () => ({
  extractMediaFileName: (storageKey: string) => {
    const marker = "/uploads/case-media/";
    const markerIndex = storageKey.indexOf(marker);
    const value = markerIndex >= 0
      ? storageKey.slice(markerIndex + marker.length)
      : storageKey;
    return value ? value.split(/[?#]/)[0]!.split("/").pop() ?? null : null;
  },
  extractMediaFilenamesFromText: (text: string) =>
    [...text.matchAll(/\/uploads\/case-media\/([^"'\\?#\s)]+)/g)].map((match) => match[1]!),
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const tableColumns: Record<string, string[]> = {
  organizations: ["id", "type", "name", "parent_lab_organization_id"],
  lab_memberships: ["id", "lab_id", "user_id", "role", "status", "deleted_at"],
  users: ["id", "username", "password"],
  cases: ["id", "lab_organization_id", "provider_organization_id", "created_by_user_id", "case_number", "patient_first_name"],
  case_attachments: ["id", "case_id", "uploaded_by_user_id", "uploaded_by_organization_id", "file_name", "storage_key", "file_type"],
  legacy_case_media: ["file_name", "lab_case_id", "organization_id", "owner_id"],
  case_exception_notes: ["id", "exception_id", "note_text"],
  invoices: ["id", "lab_organization_id", "invoice_number"],
};

const fkRows = [
  ["lab_memberships", "lab_id", "organizations", "id"],
  ["lab_memberships", "user_id", "users", "id"],
  ["cases", "lab_organization_id", "organizations", "id"],
  ["cases", "provider_organization_id", "organizations", "id"],
  ["cases", "created_by_user_id", "users", "id"],
  ["case_attachments", "case_id", "cases", "id"],
  ["case_attachments", "uploaded_by_organization_id", "organizations", "id"],
  ["case_attachments", "uploaded_by_user_id", "users", "id"],
  ["legacy_case_media", "organization_id", "organizations", "id"],
  ["case_exception_notes", "exception_id", "case_exceptions", "id"],
  ["invoices", "lab_organization_id", "organizations", "id"],
].map(([table_name, column_name, foreign_table_name, foreign_column_name]) => ({
  table_name,
  column_name,
  foreign_table_name,
  foreign_column_name,
}));

const tenantRows: Record<string, Array<Record<string, unknown>>> = {
  organizations: [
    { id: "lab-a", type: "lab", name: "Lab A", parent_lab_organization_id: null },
    { id: "practice-a", type: "provider", name: "Practice A", parent_lab_organization_id: "lab-a" },
    { id: "lab-b", type: "lab", name: "Lab B", parent_lab_organization_id: null },
    { id: "practice-b", type: "provider", name: "Practice B", parent_lab_organization_id: "lab-b" },
  ],
  lab_memberships: [
    { id: "membership-a", lab_id: "lab-a", user_id: "user-a", role: "owner", status: "active", deleted_at: null },
    { id: "membership-b", lab_id: "lab-b", user_id: "user-b", role: "owner", status: "active", deleted_at: null },
  ],
  users: [
    { id: "user-a", username: "owner-a", password: "bcrypt-secret-a" },
    { id: "user-b", username: "owner-b", password: "bcrypt-secret-b" },
  ],
  cases: [
    { id: "case-a", lab_organization_id: "lab-a", provider_organization_id: "practice-a", created_by_user_id: "user-a", case_number: "CASE-A-ONLY", patient_first_name: "PatientA" },
    { id: "case-b", lab_organization_id: "lab-b", provider_organization_id: "practice-b", created_by_user_id: "user-b", case_number: "CASE-B-MUST-NOT-LEAK", patient_first_name: "PatientB" },
  ],
  case_attachments: [
    { id: "attachment-a", case_id: "case-a", uploaded_by_user_id: "user-a", uploaded_by_organization_id: "practice-a", file_name: "case-a.jpg", storage_key: "/uploads/case-media/case-a.jpg", file_type: "image/jpeg" },
    { id: "attachment-b", case_id: "case-b", uploaded_by_user_id: "user-b", uploaded_by_organization_id: "practice-b", file_name: "case-b.jpg", storage_key: "/uploads/case-media/case-b.jpg", file_type: "image/jpeg" },
  ],
  legacy_case_media: [
    { file_name: "legacy-a.jpg", lab_case_id: "legacy-case-a", organization_id: "lab-a", owner_id: "user-a" },
    { file_name: "legacy-b.jpg", lab_case_id: "legacy-case-b", organization_id: "lab-b", owner_id: "user-b" },
  ],
  case_exception_notes: [
    { id: "note-a", exception_id: "case_exceptions-a", note_text: "Lab A dependent note" },
    { id: "note-b", exception_id: "case_exceptions-b", note_text: "Lab B dependent note must not leak" },
  ],
  invoices: [
    { id: 42, lab_organization_id: "lab-a", invoice_number: "INV-A-ONLY" },
    { id: 87, lab_organization_id: "lab-b", invoice_number: "INV-B-MUST-NOT-LEAK" },
  ],
};

function selectedRows(table: string, labId: string, organizationIds: string[]): Array<Record<string, unknown>> {
  const rows = tenantRows[table] ?? [];
  if (table === "organizations") {
    return rows.filter((row) => row.id === labId || row.parent_lab_organization_id === labId);
  }
  if (table === "lab_memberships") {
    return rows.filter((row) => organizationIds.includes(String(row.lab_id)));
  }
  if (table === "users") {
    const userIds = tenantRows.lab_memberships
      ?.filter((row) => organizationIds.includes(String(row.lab_id)))
      .map((row) => row.user_id);
    return rows.filter((row) => userIds?.includes(row.id));
  }
  if (table === "cases") {
    return rows.filter((row) => row.lab_organization_id === labId);
  }
  if (table === "case_attachments") {
    return rows.filter((row) => selectedRows("cases", labId, organizationIds)
      .some((caseRow) => caseRow.id === row.case_id));
  }
  if (table === "legacy_case_media") {
    return rows.filter((row) => organizationIds.includes(String(row.organization_id)));
  }
  if (table === "invoices") {
    return rows.filter((row) => row.lab_organization_id === labId);
  }
  if (table === "case_exception_notes") {
    return rows.filter((row) => selectedRows("case_exceptions", labId, organizationIds)
      .some((exception) => exception.id === row.exception_id));
  }
  const fixture = groupFixtures[table];
  if (fixture) {
    return rows.filter((row) => fixture.parent
      ? selectedRows(fixture.parent, labId, organizationIds).some(
        (parent) => parent.id === row[fixture.scopeColumn],
      )
      : organizationIds.includes(String(row[fixture.scopeColumn])));
  }
  return [];
}

// Representative groups include organization ownership, several FK depths,
// soft parents, and every supported media source, not only canonical cases.
const groupFixtures: Record<string, {
  columns: string[]; scopeColumn: string; parent?: string; mediaColumn?: string;
}> = {
  lab_cases: { columns: ["id", "organization_id", "case_data"], scopeColumn: "organization_id", mediaColumn: "case_data" },
  lab_pending_files: { columns: ["id", "organization_id", "file_url"], scopeColumn: "organization_id", mediaColumn: "file_url" },
  lab_pending_file_note_edits: { columns: ["id", "pending_file_id", "new_notes"], scopeColumn: "pending_file_id", parent: "lab_pending_files" },
  invoice_attachments: { columns: ["id", "invoice_id", "storage_key"], scopeColumn: "invoice_id", parent: "invoices", mediaColumn: "storage_key" },
  invoice_line_items: { columns: ["id", "invoice_id"], scopeColumn: "invoice_id", parent: "invoices" },
  payments: { columns: ["id", "invoice_id"], scopeColumn: "invoice_id", parent: "invoices" },
  vendor_bills: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  vendor_bill_lines: { columns: ["id", "vendor_bill_id"], scopeColumn: "vendor_bill_id", parent: "vendor_bills" },
  bank_transactions: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  bank_deposit_batch_members: { columns: ["id", "bank_transaction_id"], scopeColumn: "bank_transaction_id", parent: "bank_transactions" },
  vacation_requests: { columns: ["id", "lab_id"], scopeColumn: "lab_id" },
  vacation_request_days: { columns: ["id", "vacation_request_id"], scopeColumn: "vacation_request_id", parent: "vacation_requests" },
  doctor_profiles: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  doctor_phone_entries: { columns: ["id", "doctor_profile_id"], scopeColumn: "doctor_profile_id", parent: "doctor_profiles" },
  provider_messenger_threads: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  provider_messenger_messages: { columns: ["id", "thread_id"], scopeColumn: "thread_id", parent: "provider_messenger_threads" },
  provider_messenger_read_watermarks: { columns: ["id", "thread_id"], scopeColumn: "thread_id", parent: "provider_messenger_threads" },
  pricing_tiers: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  lab_inbox_files: { columns: ["id", "lab_organization_id", "storage_path"], scopeColumn: "lab_organization_id", mediaColumn: "storage_path" },
  case_restorations: { columns: ["id", "case_id"], scopeColumn: "case_id", parent: "cases" },
  case_exceptions: { columns: ["id", "lab_organization_id", "case_id"], scopeColumn: "lab_organization_id" },
  case_notes: { columns: ["id", "case_id", "author_organization_id"], scopeColumn: "case_id", parent: "cases" },
  case_events: { columns: ["id", "case_id", "actor_organization_id"], scopeColumn: "case_id", parent: "cases" },
  case_submission_queue: { columns: ["id", "case_id", "submitted_by_organization_id"], scopeColumn: "case_id", parent: "cases" },
  practice_statements: { columns: ["id", "lab_organization_id", "pdf_storage_key", "bundle_manifest_json"], scopeColumn: "lab_organization_id" },
  practice_statement_sends: { columns: ["id", "statement_id"], scopeColumn: "statement_id", parent: "practice_statements" },
  customer_credits: { columns: ["id", "lab_organization_id", "payment_session_id"], scopeColumn: "lab_organization_id" },
  customer_credit_applications: { columns: ["id", "customer_credit_id", "payment_session_id", "invoice_id"], scopeColumn: "customer_credit_id", parent: "customer_credits" },
  statement_payment_sessions: { columns: ["id", "lab_organization_id", "provider_organization_id", "receipt_number"], scopeColumn: "lab_organization_id" },
  statement_payment_applications: { columns: ["id", "payment_session_id", "invoice_id"], scopeColumn: "payment_session_id", parent: "statement_payment_sessions" },
  statement_payment_reversals: { columns: ["id", "payment_session_id"], scopeColumn: "payment_session_id", parent: "statement_payment_sessions" },
  subscriptions: { columns: ["id", "subject_type", "subject_id"], scopeColumn: "subject_id" },
  provider_auto_pay_attempts: { columns: ["id", "provider_organization_id", "subscription_id"], scopeColumn: "provider_organization_id" },
  practice_authorization_documents: { columns: ["id", "lab_organization_id", "practice_organization_id", "object_key", "legacy_authorization_id", "legacy_evidence"], scopeColumn: "lab_organization_id" },
  provider_autopay_authorizations: { columns: ["id", "provider_organization_id", "signature_object_key", "document_object_key"], scopeColumn: "provider_organization_id" },
  support_reports: { columns: ["id", "organization_id"], scopeColumn: "organization_id" },
  support_report_attachments: { columns: ["id", "report_id", "storage_key"], scopeColumn: "report_id", parent: "support_reports" },
  scan_jobs: { columns: ["id", "lab_organization_id"], scopeColumn: "lab_organization_id" },
  scan_inputs: { columns: ["id", "job_id", "storage_key", "upload_path"], scopeColumn: "job_id", parent: "scan_jobs" },
  scan_input_chunks: { columns: ["id", "input_id", "storage_key"], scopeColumn: "input_id", parent: "scan_inputs" },
  scan_outputs: { columns: ["id", "job_id", "storage_key"], scopeColumn: "job_id", parent: "scan_jobs" },
  lab_documents: { columns: ["id", "lab_organization_id", "scan_job_id", "storage_key"], scopeColumn: "lab_organization_id" },
};
for (const [table, fixture] of Object.entries(groupFixtures)) {
  tableColumns[table] = fixture.columns;
  tenantRows[table] = ["a", "b"].map((suffix) => ({
    id: `${table}-${suffix}`,
    [fixture.scopeColumn]: fixture.parent
      ? fixture.parent === "cases" ? `case-${suffix}`
        : fixture.parent === "invoices" ? suffix === "a" ? 42 : 87
        : `${fixture.parent}-${suffix}`
      : `lab-${suffix}`,
    ...(fixture.mediaColumn ? {
      [fixture.mediaColumn]: fixture.mediaColumn === "case_data"
        ? JSON.stringify({ photos: [`/uploads/case-media/${table}-${suffix}.jpg`] })
        : table === "invoice_attachments"
          ? `/uploads/invoice-attachments/${table}-${suffix}.jpg`
          : `/uploads/case-media/${table}-${suffix}.jpg`,
    } : {}),
    ...(table === "case_exceptions" ? { case_id: `case-${suffix}` } : {}),
    ...(fixture.columns.includes("payment_session_id") ? {
      payment_session_id: `statement_payment_sessions-${suffix}`,
    } : {}),
    ...(fixture.columns.includes("invoice_id") ? { invoice_id: suffix === "a" ? 42 : 87 } : {}),
    ...(table === "statement_payment_sessions" ? {
      provider_organization_id: `practice-${suffix}`, receipt_number: `receipt-${suffix}`,
    } : {}),
    ...(table === "practice_authorization_documents" ? {
      practice_organization_id: `practice-${suffix}`,
    } : {}),
    ...(table === "subscriptions" ? {
      subject_type: "provider_org", subject_id: `practice-${suffix}`,
    } : {}),
    ...(table === "provider_auto_pay_attempts" ? {
      provider_organization_id: `practice-${suffix}`, subscription_id: `subscriptions-${suffix}`,
    } : {}),
    // Actors do not own the content. These deliberately point at the other lab.
    ...Object.fromEntries(fixture.columns.filter((column) =>
      ["author_organization_id", "actor_organization_id", "submitted_by_organization_id"].includes(column),
    ).map((column) => [column, `practice-${suffix === "a" ? "b" : "a"}`])),
  }));
  if (fixture.parent && table !== "lab_pending_file_note_edits") {
    fkRows.push({
      table_name: table, column_name: fixture.scopeColumn,
      foreign_table_name: fixture.parent, foreign_column_name: "id",
    });
  }
  for (const column of fixture.columns.filter((column) =>
    ["author_organization_id", "actor_organization_id", "submitted_by_organization_id"].includes(column),
  )) {
    fkRows.push({
      table_name: table, column_name: column,
      foreign_table_name: "organizations", foreign_column_name: "id",
    });
  }
}
for (const [table, column, parent] of [
  ["customer_credits", "payment_session_id", "statement_payment_sessions"],
  ["customer_credit_applications", "payment_session_id", "statement_payment_sessions"],
  ["customer_credit_applications", "invoice_id", "invoices"],
  ["statement_payment_applications", "invoice_id", "invoices"],
  ["provider_auto_pay_attempts", "subscription_id", "subscriptions"],
]) {
  fkRows.push({
    table_name: table!, column_name: column!,
    foreign_table_name: parent!, foreign_column_name: "id",
  });
}

beforeEach(() => {
  fixtures.mediaCalls = [];
  fixtures.privateCopies = [];
  fixtures.privateOpens = [];
  fixtures.privateObjects = {};
  fixtures.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("information_schema.columns")) {
        return {
        rows: Object.entries(tableColumns).flatMap(([table_name, columns]) =>
            columns.map((column_name) => ({
              table_name,
              column_name,
              is_generated: "NEVER",
              is_identity: table_name === "invoices" && column_name === "id" ? "YES" : "NO",
              column_default: null,
            })),
        ),
      };
    }
    if (sql.includes("FROM pg_constraint")) return { rows: fkRows };
    if (sql.includes("SELECT id FROM public.organizations")) {
      const suffix = String(params[0]).slice(-1);
      return { rows: [{ id: `lab-${suffix}` }, { id: `practice-${suffix}` }] };
    }
    const match = sql.match(/FROM public\."([^"]+)" "scoped_row"/);
    if (match && sql.includes("AS scan_job_id")) {
      // The export's scan ownership read, answered from the same selection.
      const [, table] = match;
      return {
        rows: selectedRows(table!, String(params[0]), params[1] as string[]).map((row) => table === "scan_inputs"
          ? { scan_input_id: row.id, scan_job_id: row.job_id }
          : { scan_job_id: row.id }),
      };
    }
    if (match && sql.includes("row_tid")) {
      const [, table] = match;
      const lastTid = params[2];
      if (lastTid !== "(0,0)") return { rows: [] };
      return {
        rows: selectedRows(table!, String(params[0]), params[1] as string[])
          .map((row) => ({ row_tid: "(0,1)", row_json: JSON.stringify(row) })),
      };
    }
    return { rows: [] };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lab-scoped backup archive", () => {
  it.each(["a", "b"])("archives every private reader's bytes for lab %s without reading the other lab", async (suffix) => {
    const { collectLabBackupMedia, streamLabScopedBackupDownload } = await import("./lab-scoped-backup.js");
    const other = suffix === "a" ? "b" : "a";
    const originalRows = structuredClone(tenantRows);
    const originalColumns = structuredClone(tableColumns);
    const locals: string[] = [];
    const expected = new Map<string, string>();
    const privateNames: Record<string, Set<string>> = { a: new Set(), b: new Set() };
    // Unique local names, so leftovers from an interrupted run cannot collide.
    const run = randomUUID();
    const chunkHex = "0123456789abcdef01234567";
    const readerReferences = (lab: string) => [
      `private-objects/case-media/practice-authorizations/lab-${lab}/practice-${lab}/practice_authorization_documents-${lab}.pdf`,
      `private-objects/case-media/lab-authorizations/lab-${lab}/old-${lab}/authorization.pdf`,
      `private-objects/case-media/lab-authorizations/lab-${lab}/old-${lab}/signature`,
      `private-objects/case-media/provider-autopay/provider_autopay_authorizations-${lab}/signature`,
      `private-objects/case-media/provider-autopay/provider_autopay_authorizations-${lab}/authorization.pdf`,
      `local-uploads/practice-statements/primary-${lab}-${run}.pdf`,
      `local-uploads/practice-statements/doctor-two-${lab}-${run}.pdf`,
      `local-uploads/profile-photos/user-${lab}-${run}.jpg`,
      `logo-owner/lab-${lab}`,
      `private-objects/support-reports/support-${lab}-${run}`,
      `private-objects/case-media/scan-scan_jobs-${lab}-input-scan_inputs-${lab}`,
      `private-objects/case-media/scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${chunkHex}`,
      `private-objects/case-media/scan-scan_jobs-${lab}-ply-lease-${lab}`,
    ];
    process.env.BACKUP_ENCRYPTION_KEY = "lab-scoped-private-test-key";
    try {
      tableColumns.users!.push("profile_photo_url");
      tableColumns.organizations!.push("logo_url");
      tableColumns.scan_input_chunks!.push("offset");
      tableColumns.scan_outputs!.push("format", "ready_at");
      for (const lab of ["a", "b"]) {
        const row = (table: string) => tenantRows[table]!.find(item => item.id === `${table}-${lab}`)!;
        Object.assign(row("practice_authorization_documents"), {
          practice_organization_id: `practice-${lab}`,
          object_key: `practice-authorizations/lab-${lab}/practice-${lab}/practice_authorization_documents-${lab}.pdf`,
        });
        Object.assign(row("provider_autopay_authorizations"), {
          signature_object_key: `provider-autopay/provider_autopay_authorizations-${lab}/signature`,
          document_object_key: `provider-autopay/provider_autopay_authorizations-${lab}/authorization.pdf`,
        });
        row("support_report_attachments").storage_key = `support-${lab}-${run}`;
        Object.assign(row("practice_statements"), {
          pdf_storage_key: `primary-${lab}-${run}.pdf`,
          bundle_manifest_json: {
            attachments: [{ storageKey: `primary-${lab}-${run}.pdf` }, { storageKey: `doctor-two-${lab}-${run}.pdf` }],
          },
        });
        row("scan_inputs").storage_key = `scan-scan_jobs-${lab}-input-scan_inputs-${lab}`;
        Object.assign(row("scan_input_chunks"), {
          offset: 0, storage_key: `scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${chunkHex}`,
        });
        Object.assign(row("scan_outputs"), {
          format: "ply", ready_at: "2026-09-12T00:00:00.000Z", storage_key: `scan-scan_jobs-${lab}-ply-lease-${lab}`,
        });
        // Saving a scan as a lab document reuses the output's object.
        Object.assign(row("lab_documents"), {
          scan_job_id: `scan_jobs-${lab}`, storage_key: `scan-scan_jobs-${lab}-ply-lease-${lab}`,
        });
        tenantRows.users!.find(item => item.id === `user-${lab}`)!.profile_photo_url = `/uploads/profile-photos/user-${lab}-${run}.jpg`;
        tenantRows.organizations!.find(item => item.id === `lab-${lab}`)!.logo_url = `/api/organizations/lab-${lab}/logo?v=123`;
        // Include retired signed evidence as well as newly uploaded forms.
        tenantRows.practice_authorization_documents!.push({
          id: `retired-${lab}`, lab_organization_id: `lab-${lab}`, practice_organization_id: `practice-${lab}`,
          legacy_authorization_id: `old-${lab}`, object_key: `lab-authorizations/lab-${lab}/old-${lab}/authorization.pdf`,
          legacy_evidence: { signatureObjectKey: `lab-authorizations/lab-${lab}/old-${lab}/signature` },
        });
        const references = new Set<string>();
        const organizations = [`lab-${lab}`, `practice-${lab}`];
        const scans = {
          jobs: new Set(selectedRows("scan_jobs", `lab-${lab}`, organizations).map((job) => String(job.id))),
          inputJobs: new Map(selectedRows("scan_inputs", `lab-${lab}`, organizations)
            .map((input) => [String(input.id), String(input.job_id)])),
        };
        for (const table of Object.keys(tenantRows)) {
          for (const item of selectedRows(table, `lab-${lab}`, organizations)) {
            collectLabBackupMedia(table, item, references, undefined, scans);
          }
        }
        // Every private reader contributes a file for each lab.
        expect([...references]).toEqual(expect.arrayContaining(readerReferences(lab)));
        for (const reference of references) {
          const bytes = `LAB-${lab}-BYTES:${reference}`;
          let archiveName = reference;
          if (reference.startsWith("private-objects/")) {
            fixtures.privateObjects[reference.slice("private-objects/".length)] = bytes;
            privateNames[lab]!.add(reference.slice("private-objects/".length));
          } else if (reference.startsWith("logo-owner/")) {
            archiveName = `private-objects/lab-logos/lab-${lab}.png`;
            fixtures.privateObjects[`lab-logos/lab-${lab}.png`] = bytes;
            privateNames[lab]!.add(`lab-logos/lab-${lab}.png`);
          } else if (reference.startsWith("local-uploads/") || reference.startsWith("invoice-attachments/")) {
            const local = reference.startsWith("local-uploads/")
              ? path.resolve("uploads", reference.slice("local-uploads/".length))
              : path.resolve("uploads", reference);
            await fs.mkdir(path.dirname(local), { recursive: true });
            await fs.writeFile(local, bytes, { flag: "wx" });
            locals.push(local);
          } else continue;
          if (lab === suffix) expected.set(`media/${archiveName}`, bytes);
        }
      }
      const response = new PassThrough() as any;
      response.status = vi.fn(() => response);
      response.setHeader = vi.fn();
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      await streamLabScopedBackupDownload({ labId: `lab-${suffix}`, labName: "Private backup test", userId: `user-${suffix}`, response });
      const encrypted = Buffer.concat(chunks);
      const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(process.env.BACKUP_ENCRYPTION_KEY!).digest(), encrypted.subarray(4, 16));
      decipher.setAuthTag(encrypted.subarray(-16));
      const zip = new AdmZip(Buffer.concat([decipher.update(encrypted.subarray(16, -16)), decipher.final()]));
      for (const [name, bytes] of expected) expect(zip.readAsText(name), name).toBe(bytes);
      for (const entry of zip.getEntries().filter(entry => entry.entryName.startsWith("media/") && !entry.isDirectory)) {
        expect(entry.getData().toString(), entry.entryName).not.toContain(`LAB-${other}-BYTES`);
      }
      // Exactly this lab's private objects were copied; the other lab's were never opened.
      expect([...fixtures.privateCopies].sort()).toEqual([...privateNames[suffix]!].sort());
      expect(fixtures.privateOpens.filter(name => privateNames[other]!.has(name))).toEqual([]);
      const recovery = zip.readAsText("RECOVERY.md");
      expect(recovery).toContain("NEW isolated PRIVATE_OBJECT_DIR");
      expect(recovery).toContain("payment processing disabled");
      for (const namespace of ["practice-statements", "profile-photos", "practice-authorizations", "lab-authorizations", "provider-autopay", "lab-logos", "support-reports"]) {
        expect(recovery).toContain(namespace);
      }
      const manifest = JSON.parse(zip.readAsText("manifest.json")) as { mediaLayout?: Record<string, string> };
      expect(manifest.mediaLayout?.["media/private-objects/<namespace>/<key>"]).toContain("new isolated PRIVATE_OBJECT_DIR");
      expect(manifest.mediaLayout?.["media/local-uploads/<namespace>/<file>"]).toBe("uploads/<namespace>/<file>");
    } finally {
      for (const file of locals) await fs.rm(file, { force: true });
      for (const key of Object.keys(tenantRows)) tenantRows[key] = originalRows[key]!;
      for (const key of Object.keys(tableColumns)) tableColumns[key] = originalColumns[key]!;
    }
  });

  it.each([
    ["a", "saved scan document"], ["b", "saved scan document"],
    ["a", "scan input chunk"], ["b", "scan input chunk"],
  ])("stops lab %s's export before reading bytes when a %s names the other lab's scan job", async (suffix, kind) => {
    const { streamLabScopedBackupDownload } = await import("./lab-scoped-backup.js");
    const other = suffix === "a" ? "b" : "a";
    const originalRows = structuredClone(tenantRows);
    const originalColumns = structuredClone(tableColumns);
    const priorKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = "lab-scoped-scan-job-test-key";
    try {
      tableColumns.scan_input_chunks!.push("offset");
      const own = (table: string) => tenantRows[table]!.find(item => item.id === `${table}-${suffix}`)!;
      const foreign = kind === "saved scan document"
        ? `scan-scan_jobs-${other}-ply-lease-${other}`
        : `scan-scan_jobs-${other}-input-scan_inputs-${suffix}-chunk-0-0123456789abcdef01234567`;
      // The other lab's object really exists, so only the ownership check keeps it out.
      fixtures.privateObjects[`case-media/${foreign}`] = `LAB-${other}-BYTES`;
      if (kind === "saved scan document") {
        // Selected by its own lab column; the foreign key only proves that the job exists.
        Object.assign(own("lab_documents"), { scan_job_id: `scan_jobs-${other}`, storage_key: foreign });
      } else {
        // This lab's own input, but the key names the other lab's job.
        Object.assign(own("scan_input_chunks"), { offset: 0, storage_key: foreign });
      }
      const response = new PassThrough() as any;
      response.status = vi.fn(() => response);
      response.setHeader = vi.fn();
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      await expect(streamLabScopedBackupDownload({
        labId: `lab-${suffix}`, labName: "Scan ownership test", userId: `user-${suffix}`, response,
      })).rejects.toThrow(kind === "saved scan document"
        ? "does not belong to one of this lab's scan jobs"
        : "does not belong to this scan input chunk");
      expect(chunks).toEqual([]);
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(fixtures.privateOpens).toEqual([]);
      expect(fixtures.privateCopies).toEqual([]);
      expect(fixtures.mediaCalls).toEqual([]);
      expect(fixtures.query).toHaveBeenCalledWith("ROLLBACK", undefined);
    } finally {
      for (const key of Object.keys(tenantRows)) tenantRows[key] = originalRows[key]!;
      for (const key of Object.keys(tableColumns)) tableColumns[key] = originalColumns[key]!;
      if (priorKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = priorKey;
    }
  });

  it.each(["a", "b"])("exports only lab %s rows and referenced media with a safe isolated recovery script", async (suffix) => {
    const other = suffix === "a" ? "b" : "a";
    const priorEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = "lab-scoped-archive-test-key";
    const invoiceFiles = ["a", "b"].map((lab) =>
      path.resolve("uploads", "invoice-attachments", `invoice_attachments-${lab}.jpg`));
    for (const file of invoiceFiles) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `content:${path.basename(file)}`, { flag: "wx" });
    }
    try {
      const { streamLabScopedBackupDownload } = await import("./lab-scoped-backup.js");
      const response = new PassThrough() as PassThrough & {
        status: (status: number) => PassThrough;
        setHeader: (name: string, value: string) => void;
      };
      response.status = vi.fn(() => response);
      response.setHeader = vi.fn();
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

      await streamLabScopedBackupDownload({
        labId: `lab-${suffix}`,
        labName: `Lab ${suffix.toUpperCase()}`,
        userId: `user-${suffix}`,
        response: response as any,
      });

      const encrypted = Buffer.concat(chunks);
      expect(encrypted.subarray(0, 4).toString("ascii")).toBe("LTR2");
      const key = createHash("sha256").update("lab-scoped-archive-test-key").digest();
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(4, 16));
      decipher.setAuthTag(encrypted.subarray(-16));
      const zipBytes = Buffer.concat([
        decipher.update(encrypted.subarray(16, -16)),
        decipher.final(),
      ]);
      const zip = new AdmZip(zipBytes);
      const entries = zip.getEntries();
      const names = entries.map((entry) => entry.entryName);
      const dataSql = zip.readAsText("db/lab-data.sql");
      const recovery = zip.readAsText("RECOVERY.md");
      const manifest = JSON.parse(zip.readAsText("manifest.json")) as Record<string, unknown>;

      expect(names).toContain("db/schema.sql");
      expect(names).toContain("db/lab-data.sql");
      const expectedMedia = [`case-${suffix}.jpg`, `legacy-${suffix}.jpg`];
      for (const [table, fixture] of Object.entries(groupFixtures)) {
        if (!LAB_BACKUP_TABLE_RULES[table]?.include) {
          expect(dataSql).not.toContain(`INSERT INTO public."${table}"`);
          continue;
        }
        expect(dataSql).toContain(`"${table}"`);
        expect(dataSql).toContain(`${table}-${suffix}`);
        expect(dataSql).not.toContain(`${table}-${other}`);
        if (fixture.mediaColumn) expectedMedia.push(
          `${table === "invoice_attachments" ? "invoice-attachments/" : ""}${table}-${suffix}.jpg`,
        );
      }
      expect(names.filter((name) => name.startsWith("media/") && !name.endsWith("/")).sort())
        .toEqual(expectedMedia.map((name) => `media/${name}`).sort());
      expect(dataSql).toContain(suffix === "a" ? "CASE-A-ONLY" : "CASE-B-MUST-NOT-LEAK");
      expect(dataSql).toContain(`Lab ${suffix.toUpperCase()} dependent note`);
      expect(dataSql).toContain("DISABLE TRIGGER USER");
      expect(dataSql).toContain("OVERRIDING SYSTEM VALUE");
      expect(dataSql).toContain("pg_get_serial_sequence");
      expect(dataSql).not.toContain(other === "a" ? "CASE-A-ONLY" : "CASE-B-MUST-NOT-LEAK");
      expect(dataSql).not.toContain(`Lab ${other.toUpperCase()} dependent note`);
      expect(dataSql).not.toContain(other === "a" ? "INV-A-ONLY" : "INV-B-MUST-NOT-LEAK");
      expect(dataSql).not.toContain("bcrypt-secret");
      expect(dataSql).toContain("lab-backup-password-reset-required");
      expect(dataSql).not.toMatch(/\b(?:DROP|TRUNCATE|UPDATE)\b/i);
      expect(recovery).toMatch(/new, empty PostgreSQL database/i);
      expect(recovery).toContain("platform-wide restore endpoint");
      expect(manifest).toMatchObject({
        archiveKind: "lab-scoped",
        labId: `lab-${suffix}`,
        sensitiveValuesRedacted: true,
      });
      expect(fixtures.mediaCalls.sort()).toEqual(expectedMedia.filter((name) => !name.startsWith("invoice-attachments/")).sort());
      for (const name of expectedMedia) {
        expect(zip.readAsText(`media/${name}`)).toBe(`content:${path.basename(name)}`);
      }
      expect(manifest.mediaFileCount).toBe(expectedMedia.length);
      expect(manifest.excludedTables).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "subscriptions" }),
        expect.objectContaining({ table: "provider_auto_pay_attempts" }),
      ]));

      // Exercise the supplied recovery SQL against a transactional throwaway
      // schema. This confirms the archive can recover its selected lab without
      // touching the shared public schema or overwriting another tenant.
      if (process.env.DATABASE_URL) {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        const schema = `lab_backup_recovery_${Date.now()}`;
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`CREATE SCHEMA "${schema}"`);
          const schemaSql = zip.readAsText("db/schema.sql")
            .replaceAll("public.", `"${schema}".`)
            .replaceAll("'public'::regnamespace", `'${schema}'::regnamespace`);
          const scopedDataSql = dataSql.replaceAll("public.", `"${schema}".`);
          await client.query(schemaSql);
          await client.query(scopedDataSql);
          const restoredCases = await client.query(
            `SELECT case_number FROM "${schema}"."cases" ORDER BY case_number`,
          );
          expect(restoredCases.rows).toEqual([{ case_number: suffix === "a" ? "CASE-A-ONLY" : "CASE-B-MUST-NOT-LEAK" }]);
          const restoredNotes = await client.query(
            `SELECT note_text FROM "${schema}"."case_exception_notes"`,
          );
          expect(restoredNotes.rows).toEqual([{ note_text: `Lab ${suffix.toUpperCase()} dependent note${suffix === "b" ? " must not leak" : ""}` }]);
          const restoredInvoiceNumbers = await client.query(
            `SELECT invoice_number FROM "${schema}"."invoices"`,
          );
          expect(restoredInvoiceNumbers.rows).toEqual([{ invoice_number: suffix === "a" ? "INV-A-ONLY" : "INV-B-MUST-NOT-LEAK" }]);
          for (const table of Object.keys(groupFixtures)) {
            const result = await client.query(`SELECT id FROM "${schema}"."${table}"`);
            expect(result.rows).toEqual(
              LAB_BACKUP_TABLE_RULES[table]?.include ? [{ id: `${table}-${suffix}` }] : [],
            );
          }
          const restoredApplications = await client.query(
            `SELECT application.id, receipt.receipt_number FROM "${schema}"."statement_payment_applications" application ` +
            `JOIN "${schema}"."statement_payment_sessions" receipt ON receipt.id = application.payment_session_id`,
          );
          expect(restoredApplications.rows).toEqual([{
            id: `statement_payment_applications-${suffix}`, receipt_number: `receipt-${suffix}`,
          }]);
          const nextIdentity = await client.query(
            `SELECT nextval(pg_get_serial_sequence('"${schema}"."invoices"', 'id')) AS next_id`,
          );
          expect(nextIdentity.rows).toEqual([{ next_id: suffix === "a" ? "43" : "88" }]);
        } finally {
          await client.query("ROLLBACK");
          await client.end();
        }
      }
    } finally {
      for (const file of invoiceFiles) await fs.rm(file, { force: true });
      if (priorEncryptionKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = priorEncryptionKey;
    }
  });
});

describe("full-schema isolated lab recovery", () => {
  it("recovers both labs separately with all declared FKs and financial evidence intact", async () => {
    // No platform restore endpoint and no writes to DATABASE_URL: the helper
    // owns a private PostgreSQL cluster, source DB, recovery DBs and media tree.
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = await createFullSchemaLabBackupFixture(childProcess);
    const oldCwd = process.cwd();
    const oldUrl = process.env.DATABASE_URL;
    const oldKey = process.env.BACKUP_ENCRYPTION_KEY;
    try {
      process.chdir(fixture.directory);
      process.env.DATABASE_URL = fixture.sourceUrl;
      process.env.BACKUP_ENCRYPTION_KEY = "full-schema-lab-backup-test-key";
      fixtures.realSpawn = childProcess.spawn;
      fixtures.query.mockImplementation(async (sql, params) => {
        try {
          return await fixture.source.query(sql, params);
        } catch (error) {
          throw new Error(`Full-schema source query failed: ${sql}`, { cause: error });
        }
      });
      const { streamLabScopedBackupDownload } = await import("./lab-scoped-backup.js");
      for (const suffix of ["a", "b"]) {
        fixtures.mediaCalls.length = 0;
        const response = new PassThrough() as any;
        response.status = vi.fn(() => response);
        response.setHeader = vi.fn();
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        await streamLabScopedBackupDownload({
          labId: `lab-${suffix}`, labName: `Lab ${suffix}`, userId: `owner-${suffix}`, response,
        });
        const encrypted = Buffer.concat(chunks);
        expect(encrypted.subarray(0, 4).toString()).toBe("LTR2");
        const decipher = createDecipheriv("aes-256-gcm",
          createHash("sha256").update(process.env.BACKUP_ENCRYPTION_KEY).digest(),
          encrypted.subarray(4, 16));
        decipher.setAuthTag(encrypted.subarray(-16));
        const archive = new AdmZip(Buffer.concat([
          decipher.update(encrypted.subarray(16, -16)), decipher.final(),
        ]));
        await fixture.assertRecovery(archive, suffix, schemaTables);
        expect(fixtures.mediaCalls).toEqual([]); // All bytes came from the isolated uploads tree.
      }
      await fixture.assertSourceUnchanged();
    } finally {
      fixtures.realSpawn = null;
      process.chdir(oldCwd);
      if (oldUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = oldKey;
      await fixture.cleanup();
    }
  }, 180_000);
});

const schemaTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

describe("schema-driven lab backup coverage", () => {
  it("classifies every declared table and every media-shaped or JSON column", () => {
    assertLabBackupCoverage(schemaTables);
    expect(Object.keys(LAB_BACKUP_TABLE_RULES).sort()).toEqual(schemaTables.map((table) => table.name).sort());
    expect(LAB_BACKUP_TABLE_RULES.backup_live_status.include).toBe(false);
    expect(LAB_BACKUP_MEDIA_RULES.backup_live_status.metrics.kind).toBe("metadata");
    expect(LAB_BACKUP_MEDIA_RULES.backup_live_status.archive_evidence.kind).toBe("metadata");
    for (const [table, rules] of Object.entries(LAB_BACKUP_MEDIA_RULES)) {
      const columns = schemaTables.find((entry) => entry.name === table)?.columns ?? [];
      for (const column of Object.keys(rules)) {
        expect(columns.some((entry) => entry.name === column), `${table}.${column} is a stale policy`).toBe(true);
      }
    }
  });

  it.each([
    { name: "future_lab_records", columns: [{ name: "lab_organization_id" }] },
    { name: "future_case_details", columns: [{ name: "case_id" }] },
    { name: "future_user_records", columns: [{ name: "user_id" }] },
  ])("rejects new unclassified table $name even without a lab column", (table) => {
    expect(() => assertLabBackupCoverage([table])).toThrow(`Unclassified table: ${table.name}`);
  });

  it.each([
    { name: "object_storage_key" },
    { name: "document_url" },
    { name: "attachment_path" },
    { name: "future_payload", dataType: "json" },
  ])("rejects a new unclassified media/JSON column $name on an existing table", (column) => {
    expect(isBackupMediaColumn(column.name, column.dataType)).toBe(true);
    expect(() => assertLabBackupCoverage([{ name: "cases", columns: [column] }]))
      .toThrow(`Unclassified media/JSON column: cases.${column.name}`);
  });

  it("has a working ownership predicate for every included schema table", async () => {
    const { buildTablePredicate } = await import("./lab-scoped-backup.js");
    const shape = {
      columnsByTable: new Map(schemaTables.map((table) => [
        table.name, new Set(table.columns.map((column) => column.name)),
      ])),
      generatedColumnsByTable: new Map<string, Set<string>>(),
      sequenceColumnsByTable: new Map<string, Set<string>>(),
      identityColumnsByTable: new Map<string, Set<string>>(),
      foreignKeysByTable: new Map(schemaTables.map((table) => [
        table.name,
        table.foreignKeys.flatMap((key) => {
          const reference = key.reference();
          return reference.columns.map((column, index) => ({
            constraint_id: key.getName(),
            table_name: table.name,
            column_name: column.name,
            foreign_table_name: getTableConfig(reference.foreignTable).name,
            foreign_column_name: reference.foreignColumns[index]!.name,
          }));
        }),
      ])),
    };
    for (const table of schemaTables) {
      const predicate = buildTablePredicate(table.name, shape);
      if (LAB_BACKUP_TABLE_RULES[table.name]?.include) {
        expect(predicate, `Missing ownership predicate: ${table.name}`).not.toBeNull();
      } else {
        expect(predicate, `Excluded table: ${table.name}`).toBeNull();
      }
    }
  });

  it("never includes a table whose declared FK parent is excluded, even for nullable references", () => {
    for (const table of schemaTables) {
      if (!LAB_BACKUP_TABLE_RULES[table.name]?.include) continue;
      for (const key of table.foreignKeys) {
        const parent = getTableConfig(key.reference().foreignTable).name;
        expect(LAB_BACKUP_TABLE_RULES[parent]?.include,
          `${table.name} requires ${parent}; excluding its parent makes recovery fail`).toBe(true);
      }
    }
  });

  it("refuses populated unsupported media instead of exporting dangling pointers", async () => {
    const { collectLabBackupMedia } = await import("./lab-scoped-backup.js");
    let exercised = 0;
    for (const [table, rules] of Object.entries(LAB_BACKUP_MEDIA_RULES)) {
      if (!LAB_BACKUP_TABLE_RULES[table]?.include) continue;
      for (const [column, rule] of Object.entries(rules)) {
        if (rule.kind !== "unsupported") continue;
        expect(() => collectLabBackupMedia(table, { [column]: "private/blob" }, new Set()))
          .toThrow(`${table}.${column}`);
        expect(() => collectLabBackupMedia(table, { [column]: null }, new Set())).not.toThrow();
        exercised += 1;
      }
    }
    expect(exercised).toBeGreaterThan(0);
    expect(() => collectLabBackupMedia("case_attachments", { storage_key: "/objects/private.jpg" }, new Set()))
      .toThrow("Unsupported media namespace");
    expect(() => collectLabBackupMedia("organizations", {
      invoice_template: { image: "/objects/template.png" },
    }, new Set())).toThrow("private media embedded");
  });

  it.each(["table", "media", "json"])("stops a live export before sending bytes when a new %s is unclassified", async (kind) => {
    const originalQuery = fixtures.query.getMockImplementation()!;
    fixtures.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const result = await originalQuery(sql, params);
      if (sql.includes("information_schema.columns")) {
        result.rows.push({
          table_name: kind === "table" ? "future_lab_records" : "cases",
          column_name: kind === "table" ? "lab_organization_id" : kind === "media" ? "future_object_key" : "future_payload",
          data_type: kind === "json" ? "jsonb" : "text",
          is_generated: "NEVER", is_identity: "NO", column_default: null,
        });
      }
      return result;
    });
    const priorKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = "contract-rejection-test-key";
    const response = new PassThrough() as any;
    response.status = vi.fn(() => response);
    response.setHeader = vi.fn();
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    try {
      const { streamLabScopedBackupDownload } = await import("./lab-scoped-backup.js");
      await expect(streamLabScopedBackupDownload({
        labId: "lab-a", labName: "Lab A", userId: "user-a", response,
      })).rejects.toThrow("Lab backup coverage contract failed");
      expect(chunks).toEqual([]);
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(fixtures.mediaCalls).toEqual([]);
      expect(fixtures.query).toHaveBeenCalledWith("ROLLBACK", undefined);
    } finally {
      if (priorKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = priorKey;
    }
  });

  it("evaluates the real ownership SQL for both labs across all supported fixture groups", async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required to prove SQL-level two-lab backup isolation.");
    }
    const {
      buildTablePredicate, assertExclusiveOpaqueMedia, collectLabBackupMedia, readLabScanOwnership,
    } = await import("./lab-scoped-backup.js");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const namespace = `lab_backup_selection_${Date.now()}`;
    const shape = {
      columnsByTable: new Map(Object.entries(tableColumns).map(([table, columns]) => [table, new Set(columns)])),
      generatedColumnsByTable: new Map<string, Set<string>>(),
      sequenceColumnsByTable: new Map<string, Set<string>>(),
      identityColumnsByTable: new Map<string, Set<string>>(),
      foreignKeysByTable: new Map(Object.keys(tableColumns).map((table) => [
        table, fkRows.filter((row) => row.table_name === table),
      ])),
    };
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${namespace}"`);
      for (const [table, columns] of Object.entries(tableColumns)) {
        await client.query(`CREATE TABLE "${namespace}"."${table}" (${columns.map((column) =>
          `"${column}" ${column === "invoice_id" || (table === "invoices" && column === "id") ? "integer" : "text"}`,
        ).join(", ")})`);
        for (const row of tenantRows[table] ?? []) {
          await client.query(
            `INSERT INTO "${namespace}"."${table}" (${columns.map((column) => `"${column}"`).join(", ")}) ` +
            `VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
            columns.map((column) => row[column] ?? null),
          );
        }
      }
      // A foreign case uploaded by our practice still belongs to the foreign lab.
      await client.query(
        `UPDATE "${namespace}"."case_attachments" SET uploaded_by_organization_id = 'practice-a', uploaded_by_user_id = 'user-a' WHERE id = 'attachment-b'`,
      );
      for (const suffix of ["a", "b"]) {
        const organizationIds = [`lab-${suffix}`, `practice-${suffix}`];
        for (const table of Object.keys(tableColumns)) {
          const predicate = buildTablePredicate(table, shape);
          if (!LAB_BACKUP_TABLE_RULES[table]?.include) {
            expect(predicate, table).toBeNull();
            continue;
          }
          expect(predicate, table).not.toBeNull();
          const result = await client.query(
            (`SELECT "scoped_row".* FROM public."${table}" "scoped_row" WHERE (${predicate}) ` +
             `AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL`).replaceAll("public.", `"${namespace}".`),
            [`lab-${suffix}`, organizationIds],
          );
          const key = table === "legacy_case_media" ? "file_name" : "id";
          const expected = selectedRows(table, `lab-${suffix}`, organizationIds).map((row) => row[key]);
          if (table === "users" && suffix === "b") {
            // Lab B may need this shared actor's identity to recover its own
            // attachment, but none of that actor's Lab A records.
            expected.push("user-a");
          }
          expect(result.rows.map((row) => row[key]).sort(), `${table}: lab ${suffix}`)
            .toEqual(expected.sort());
        }
      }
      const isolatedClient = {
        query: (sql: string, values: unknown[]) => client.query(sql.replaceAll("public.", `"${namespace}".`), values),
      };
      // Statement files have opaque generated names, so the export proves in SQL
      // that no row outside the lab references the same file, including the
      // nested doctor PDFs of a statement bundle.
      await client.query(
        `ALTER TABLE "${namespace}"."practice_statements" ALTER COLUMN bundle_manifest_json TYPE jsonb USING bundle_manifest_json::jsonb`,
      );
      const statement = (key: string) => `local-uploads/practice-statements/${key}`;
      const exclusive = (lab: string, references: string[]) => assertExclusiveOpaqueMedia(
        isolatedClient, references, `lab-${lab}`, [`lab-${lab}`, `practice-${lab}`], shape,
      );
      const setStatement = (lab: string, pdf: string | null, bundle: unknown) => client.query(
        `UPDATE "${namespace}"."practice_statements" SET pdf_storage_key = $1, bundle_manifest_json = $2::jsonb WHERE id = $3`,
        [pdf, bundle === null ? null : JSON.stringify(bundle), `practice_statements-${lab}`],
      );
      await setStatement("a", "own-a.pdf", { attachments: [{ storageKey: "own-a.pdf" }, { storageKey: "doctor-a.pdf" }] });
      await setStatement("b", "own-b.pdf", null);
      await expect(exclusive("a", [statement("own-a.pdf"), statement("doctor-a.pdf")])).resolves.toBeUndefined();
      await expect(exclusive("b", [statement("own-b.pdf")])).resolves.toBeUndefined();
      // Another lab's primary PDF names our file: neither lab may export it.
      await setStatement("b", "own-a.pdf", null);
      await expect(exclusive("a", [statement("own-a.pdf")])).rejects.toThrow("claimed outside this lab");
      await expect(exclusive("b", [statement("own-a.pdf")])).rejects.toThrow("claimed outside this lab");
      // Another lab's bundle names our doctor PDF.
      await setStatement("b", "own-b.pdf", { attachments: [{ storageKey: "own-b.pdf" }, { storageKey: "doctor-a.pdf" }] });
      await expect(exclusive("a", [statement("doctor-a.pdf")])).rejects.toThrow("claimed outside this lab");
      await expect(exclusive("a", [statement("own-a.pdf")])).resolves.toBeUndefined();
      // Manifests the app ignores cannot claim a file or break the check.
      for (const bundle of [[], "text", {}, { attachments: {} }, { attachments: [null, 7, { storageKey: 7 }] }]) {
        await setStatement("b", "own-b.pdf", bundle);
        await expect(exclusive("a", [statement("own-a.pdf"), statement("doctor-a.pdf")]), JSON.stringify(bundle))
          .resolves.toBeUndefined();
      }
      // Large exports are checked in batches; a conflict in a later batch still stops it.
      const many = Array.from({ length: 2500 }, (_, index) => statement(`batch-${index}.pdf`));
      await setStatement("b", "batch-2499.pdf", null);
      await expect(exclusive("a", many)).rejects.toThrow("claimed outside this lab");
      // Other namespaces are bound to their owning rows and are not queried here.
      await expect(exclusive("a", ["private-objects/support-reports/batch-2499.pdf"])).resolves.toBeUndefined();

      // Scan keys name their scan job. A saved document is selected by its own
      // lab column and a chunk by its input, so neither proves the job in the
      // key is the lab's; the export reads the lab's scan jobs in its snapshot.
      const hex = "0123456789abcdef01234567";
      const organizationsOf = (lab: string) => [`lab-${lab}`, `practice-${lab}`];
      const scanRows = async (lab: string, table: string) => (await isolatedClient.query(
        `SELECT "scoped_row".* FROM public."${table}" "scoped_row" WHERE (${buildTablePredicate(table, shape)}) ` +
        `AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL`,
        [`lab-${lab}`, organizationsOf(lab)],
      )).rows;
      const scanFiles = async (lab: string) => {
        const scans = await readLabScanOwnership(isolatedClient, `lab-${lab}`, organizationsOf(lab), shape);
        const files = new Set<string>();
        for (const table of ["scan_input_chunks", "lab_documents"]) {
          for (const row of await scanRows(lab, table)) collectLabBackupMedia(table, row, files, undefined, scans);
        }
        return { scans, files: [...files].sort() };
      };
      const setScanKeys = async (lab: string, documentJob: string, documentKey: string, chunkKey: string) => {
        await client.query(`UPDATE "${namespace}"."lab_documents" SET scan_job_id = $1, storage_key = $2 WHERE id = $3`,
          [documentJob, documentKey, `lab_documents-${lab}`]);
        await client.query(`UPDATE "${namespace}"."scan_input_chunks" SET "offset" = 0, storage_key = $1 WHERE id = $2`,
          [chunkKey, `scan_input_chunks-${lab}`]);
      };
      await client.query(`ALTER TABLE "${namespace}"."scan_input_chunks" ADD COLUMN "offset" integer`);
      for (const lab of ["a", "b"]) {
        await setScanKeys(lab, `scan_jobs-${lab}`, `scan-scan_jobs-${lab}-ply-lease-${lab}`,
          `scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${hex}`);
      }
      for (const lab of ["a", "b"]) {
        const { scans, files } = await scanFiles(lab);
        expect([...scans.jobs], lab).toEqual([`scan_jobs-${lab}`]);
        expect([...scans.inputJobs], lab).toEqual([[`scan_inputs-${lab}`, `scan_jobs-${lab}`]]);
        expect(files, lab).toEqual([
          `private-objects/case-media/scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${hex}`,
          `private-objects/case-media/scan-scan_jobs-${lab}-ply-lease-${lab}`,
        ]);
      }
      for (const [lab, other] of [["a", "b"], ["b", "a"]] as const) {
        // The lab's own saved document names the other lab's job and object.
        await setScanKeys(lab, `scan_jobs-${other}`, `scan-scan_jobs-${other}-ply-lease-${other}`,
          `scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${hex}`);
        expect((await scanRows(lab, "lab_documents")).map((row) => row.id)).toEqual([`lab_documents-${lab}`]);
        await expect(scanFiles(lab)).rejects.toThrow("does not belong to one of this lab's scan jobs");
        expect((await scanFiles(other)).files).toEqual([
          `private-objects/case-media/scan-scan_jobs-${other}-input-scan_inputs-${other}-chunk-0-${hex}`,
          `private-objects/case-media/scan-scan_jobs-${other}-ply-lease-${other}`,
        ]);
        // The lab's own chunk carries a key that names the other lab's job.
        await setScanKeys(lab, `scan_jobs-${lab}`, `scan-scan_jobs-${lab}-ply-lease-${lab}`,
          `scan-scan_jobs-${other}-input-scan_inputs-${lab}-chunk-0-${hex}`);
        await expect(scanFiles(lab)).rejects.toThrow("does not belong to this scan input chunk");
        await setScanKeys(lab, `scan_jobs-${lab}`, `scan-scan_jobs-${lab}-ply-lease-${lab}`,
          `scan-scan_jobs-${lab}-input-scan_inputs-${lab}-chunk-0-${hex}`);
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
