import type * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "pg";
import type AdmZip from "adm-zip";
import { expect } from "vitest";
import type { getTableConfig } from "drizzle-orm/pg-core";
import { LAB_BACKUP_TABLE_RULES } from "../lab-scoped-backup-contract";

type SchemaTable = ReturnType<typeof getTableConfig>;
type Row = Record<string, unknown>;
const date = "2026-01-15T00:00:00Z";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Explicit financial values, not auto-filled NOT NULL placeholders. Each lab
// has a receipt creating credit, a later receipt spending it, processor-backed
// evidence, banking, AP, canonical cases and legacy/pending-file media.
function labRows(s: string): Record<string, Row[]> {
  const lab = `lab-${s}`, practice = `practice-${s}`, actor = `owner-${s}`;
  const id = (name: string) => `${name}-${s}`;
  const owned = { lab_organization_id: lab, provider_organization_id: practice };
  return {
    users: [
      { id: actor, username: actor, password: `private-password-${s}` },
      ...(s === "a" ? [{ id: "shared-actor", username: "shared-actor", password: "private-shared-password" }] : []),
    ],
    organizations: [
      { id: lab, type: "lab", name: lab, created_by_user_id: actor },
      { id: practice, type: "provider", name: practice, parent_lab_organization_id: lab, created_by_user_id: "shared-actor" },
    ],
    lab_memberships: [
      { id: id("membership"), lab_id: lab, user_id: actor, role: "owner" },
      ...(s === "b" ? [{ id: "shared-membership-b", lab_id: lab, user_id: "shared-actor", role: "member" }] : []),
    ],
    doctor_profiles: [{ id: id("doctor"), ...owned, doctor_name: id("Doctor") }],
    cases: [{ id: id("case"), ...owned, case_number: id("CASE"), patient_first_name: "Patient",
      patient_last_name: s, doctor_name: id("Doctor"), created_by_user_id: actor }],
    case_restorations: [{ id: id("restoration"), case_id: id("case"), tooth_number: "8", restoration_type: "crown" }],
    case_attachments: [{ id: id("attachment"), case_id: id("case"), uploaded_by_user_id: "shared-actor",
      uploaded_by_organization_id: practice, file_name: id("case") + ".jpg",
      storage_key: `/uploads/case-media/${id("case")}.jpg`, file_type: "image/jpeg" }],
    lab_cases: [{ id: id("legacy"), organization_id: lab, owner_id: actor,
      case_data: JSON.stringify({ photos: [`/uploads/case-media/${id("embedded")}.jpg`] }) }],
    legacy_case_media: [{ file_name: id("ledger") + ".jpg", lab_case_id: id("legacy"), organization_id: lab, owner_id: actor }],
    lab_pending_files: [{ id: id("pending"), organization_id: lab, uploader_user_id: actor,
      file_name: id("pending") + ".jpg", file_url: `/uploads/case-media/${id("pending")}.jpg`, mime_type: "image/jpeg" }],
    lab_pending_file_note_edits: [{ id: id("pending-note"), pending_file_id: id("pending"), editor_user_id: actor, new_notes: "Recovered note" }],
    invoices: [
      { id: id("invoice"), ...owned, case_id: id("case"), doctor_identity: id("doctor"),
        invoice_number: id("INV"), total: "100.00", subtotal: "100.00", balance_due: "30.00", created_by_user_id: actor },
      { id: id("unassigned-invoice"), lab_organization_id: lab, invoice_number: id("UNASSIGNED-INV"),
        total: "50.00", subtotal: "50.00", balance_due: "50.00", created_by_user_id: actor },
    ],
    invoice_line_items: [{ id: id("line"), invoice_id: id("invoice"), case_restoration_id: id("restoration"),
      description: "Crown", quantity: "1", unit_price: "100.00", line_total: "100.00" }],
    invoice_attachments: [{ id: id("invoice-file"), invoice_id: id("invoice"),
      file_name: id("invoice") + ".jpg", storage_key: `/uploads/invoice-attachments/${id("invoice")}.jpg`,
      file_type: "image/jpeg", uploaded_by_user_id: "shared-actor" }],
    invoice_credits: [{ id: id("invoice-credit"), lab_organization_id: lab, invoice_id: id("invoice"),
      amount: "10.00", source_kind: "manual", applied_by_user_id: actor }],
    practice_statements: [{ id: id("statement"), ...owned, period_start: date, period_end: date,
      invoice_count: 1, total_billed: "100.00", total_paid: "70.00", balance_due: "30.00",
      invoice_ids_json: [id("invoice")], created_by_user_id: actor }],
    bank_accounts: [{ id: id("bank"), lab_organization_id: lab, name: "Bank", created_by_user_id: actor }],
    bank_transactions: [{ id: id("deposit"), lab_organization_id: lab, bank_account_id: id("bank"),
      txn_date: date, type: "deposit", credit_amount: "80.00", net_amount: "80.00", created_by_user_id: actor }],
    bank_transaction_invoices: [{ id: id("bank-invoice"), bank_transaction_id: id("deposit"), invoice_id: id("invoice") }],
    provider_payment_customers: [{ id: id("processor-customer"), provider_organization_id: practice, stripe_customer_id: id("cus") }],
    provider_payment_checkouts: [{ id: id("checkout"), provider_organization_id: practice, initiated_by_user_id: actor,
      total_amount: "80.00", status: "completed", stripe_checkout_session_id: id("cs"), stripe_payment_intent_id: id("pi") }],
    provider_payment_allocations: [{ id: id("allocation"), checkout_id: id("checkout"), invoice_id: id("invoice"), amount: "40.00" }],
    statement_payment_sessions: [
      { id: id("receipt"), ...owned, statement_id: id("statement"), bank_transaction_id: id("deposit"),
        provider_payment_checkout_id: id("checkout"), request_fingerprint: id("fingerprint"), receipt_number: id("RCPT"),
        received_amount: "80.00", applied_amount: "40.00", customer_credit_amount: "40.00",
        account_balance_after: "20.00", payment_method: "card", lab_name: lab, created_by_user_id: actor },
      { id: id("credit-receipt"), ...owned, request_fingerprint: id("credit-fingerprint"), receipt_number: id("CREDIT-RCPT"),
        received_amount: "0.00", applied_amount: "20.00", customer_credit_amount: "0.00",
        account_balance_after: "10.00", payment_method: "credit", lab_name: lab, created_by_user_id: actor },
    ],
    payments: [{ id: id("payment"), invoice_id: id("invoice"), amount: "40.00", payment_method: "card",
      payment_session_id: id("receipt"), provider_payment_checkout_id: id("checkout"),
      bank_transaction_id: id("deposit"), recorded_by_user_id: "shared-actor" }],
    statement_payment_applications: [{ id: id("application"), payment_session_id: id("receipt"),
      invoice_id: id("invoice"), invoice_number: id("INV"), invoice_total: "100.00", amount: "40.00",
      invoice_balance_before: "100.00", invoice_balance_after: "60.00" }],
    customer_credits: [{ id: id("credit"), ...owned, payment_session_id: id("receipt"), amount: "40.00",
      remaining_amount: "20.00", created_by_user_id: actor }],
    customer_credit_applications: [{ id: id("credit-application"), customer_credit_id: id("credit"),
      payment_session_id: id("credit-receipt"), invoice_id: id("invoice"), amount: "20.00" }],
    statement_payment_reversals: [{ id: id("reversal"), payment_session_id: id("receipt"),
      processor_idempotency_key: id("refund-key"), amount: "80.00", status: "failed", initiated_by_user_id: actor }],
    vendors: [{ id: id("vendor"), lab_organization_id: lab, name: "Supplier" }],
    vendor_bills: [{ id: id("bill"), lab_organization_id: lab, vendor_id: id("vendor"), bill_date: date,
      due_date: date, total: "50.00", amount_paid: "20.00", amount_credited: "10.00", balance_due: "20.00", created_by_user_id: actor }],
    vendor_bill_lines: [{ id: id("bill-line"), bill_id: id("bill"), description: "Material", amount: "50.00" }],
    vendor_credits: [{ id: id("vendor-credit"), lab_organization_id: lab, vendor_id: id("vendor"), credit_date: date,
      amount: "10.00", amount_applied: "10.00", remaining_amount: "0.00", created_by_user_id: actor }],
    vendor_payments: [{ id: id("vendor-payment"), lab_organization_id: lab, vendor_id: id("vendor"), payment_date: date,
      payment_method: "check", cash_amount: "20.00", credit_amount: "10.00", total_amount: "30.00",
      bank_transaction_id: id("deposit"), bank_account_id: id("bank"), created_by_user_id: actor }],
    vendor_payment_allocations: [
      { id: id("vendor-allocation"), vendor_payment_id: id("vendor-payment"), bill_id: id("bill"), amount: "20.00", applied_at: date },
      { id: id("vendor-credit-allocation"), vendor_payment_id: id("vendor-payment"), bill_id: id("bill"),
        vendor_credit_id: id("vendor-credit"), amount: "10.00", applied_at: date },
    ],
    // Processor/account workflow state is intentionally NOT recovery data.
    subscriptions: [{ id: id("subscription"), subject_type: "provider", subject_id: practice }],
    provider_auto_pay_attempts: [{ id: id("attempt"), provider_organization_id: practice,
      subscription_id: id("subscription"), kind: "subscription", scheduled_for: date }],
    user_sessions: [{ id: id("session"), user_id: actor, token_hash: id("private-token"), expires_at: date }],
    statement_link_tokens: [{ id: id("link"), token: id("private-link"), lab_organization_id: lab,
      recipient_type: "practice", recipient_key: practice, practice_name: practice, invoice_scope: "open", expires_at: date }],
  };
}

export async function createFullSchemaLabBackupFixture(actual: typeof childProcess) {
  const run = promisify(actual.execFile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lab-backup-full-schema-"));
  const pgdata = path.join(directory, "pgdata");
  const socket = path.join(directory, "socket");
  let started = false;
  const clients: Client[] = [];
  const cleanup = async () => {
    await Promise.all(clients.map((client) => client.end()));
    try {
      if (started) await run("pg_ctl", ["-D", pgdata, "-m", "immediate", "stop"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await fs.mkdir(socket);
    await run("initdb", ["-D", pgdata, "-A", "trust", "--no-instructions"]);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number };
        server.close(() => resolve(address.port));
      });
    });
    await run("pg_ctl", ["-D", pgdata, "-o", `-k ${socket} -p ${port} -h 127.0.0.1`,
      "-l", path.join(directory, "postgres.log"), "start"]);
    started = true;
    // This fixture's private local cluster intentionally runs without TLS.
    // Pin that test-only policy in the URL so a CI runner's verified-TLS
    // PGSSLMODE cannot leak into this separate synthetic PostgreSQL server.
    const dbUrl = (database: string) =>
      `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:${port}/${database}?sslmode=disable`;
    const admin = new Client({ connectionString: dbUrl("postgres") });
    await admin.connect();
    clients.push(admin);
    await admin.query('CREATE DATABASE lab_backup_source');
    const sourceUrl = dbUrl("lab_backup_source");
    const source = new Client({ connectionString: sourceUrl });
    await source.connect();
    clients.push(source);
    // Materialize the complete checked-in schema, including FKs missing from
    // older dev snapshots. The exporter then uses real pg_dump on this DB.
    // No shared database is consulted or modified by this harness.
    const { stdout: schemaSql } = await run("pnpm", ["--filter", "@workspace/db", "exec",
      "drizzle-kit", "export", "--dialect", "postgresql", "--schema", "./src/schema/index.ts"],
    { maxBuffer: 8 * 1024 * 1024 });
    await source.query("CREATE EXTENSION pg_trgm");
    await source.query(schemaSql);
    await source.query(`CREATE FUNCTION public.lab_backup_test_guard() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'immutable evidence'; END $$;
      CREATE TRIGGER lab_backup_test_guard BEFORE INSERT ON public.payments
      FOR EACH ROW EXECUTE FUNCTION public.lab_backup_test_guard()`);
    await source.query('ALTER TABLE public.payments DISABLE TRIGGER USER');
    const rows = { a: labRows("a"), b: labRows("b") };
    // Seed cyclic and out-of-order financial parents with all declared FKs
    // enforced at COMMIT, just as the archive's recovery schema will do.
    await source.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint WHERE contype = 'f'
      LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', r.t, r.conname);
      END LOOP; END $$`);
    await source.query("BEGIN");
    for (const tables of Object.values(rows)) {
      for (const [table, records] of Object.entries(tables)) {
        for (const record of records) {
          const columns = Object.keys(record);
          await source.query(`INSERT INTO public.${quote(table)} (${columns.map(quote).join(",")})
            VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
          columns.map((column) => {
            const value = record[column];
            return typeof value === "object" && value !== null ? JSON.stringify(value) : value;
          }));
        }
      }
    }
    await source.query("COMMIT");
    await source.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint WHERE contype = 'f'
      LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', r.t, r.conname);
      END LOOP; END $$`);
    await source.query('ALTER TABLE public.payments ENABLE TRIGGER USER');
    for (const s of ["a", "b"]) {
      for (const group of ["case", "embedded", "ledger", "pending", "invoice"]) {
        const folder = group === "invoice" ? "invoice-attachments" : "case-media";
        await fs.mkdir(path.join(directory, "uploads", folder), { recursive: true });
        await fs.writeFile(path.join(directory, "uploads", folder, `${group}-${s}.jpg`), `bytes:${group}-${s}`);
      }
    }
    const sourceSnapshot = new Map<string, Row[]>();
    const sourceTables = await source.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
    for (const { table_name } of sourceTables.rows) {
      const result = await source.query(`SELECT to_jsonb(t) AS row FROM public.${quote(table_name)} t`);
      sourceSnapshot.set(table_name, result.rows.map(({ row }) => row));
    }
    return {
      directory, sourceUrl, source, cleanup,
      async assertSourceUnchanged() {
        for (const [table, records] of sourceSnapshot) {
          const result = await source.query(`SELECT to_jsonb(t) AS row FROM public.${quote(table)} t`);
          expect(result.rows.map(({ row }) => row), `source ${table}`).toEqual(expect.arrayContaining(records));
          expect(result.rowCount, `source ${table}`).toBe(records.length);
        }
      },
      async assertRecovery(archive: AdmZip, s: string, schemaTables: SchemaTable[]) {
        const database = `lab_backup_recovered_${s}`;
        await admin.query(`CREATE DATABASE ${quote(database)}`);
        const recovery = new Client({ connectionString: dbUrl(database) });
        await recovery.connect();
        clients.push(recovery);
        const schemaFile = path.join(directory, `schema-${s}.sql`);
        const dataFile = path.join(directory, `data-${s}.sql`);
        const dumpedSchema = archive.readAsText("db/schema.sql");
        expect(dumpedSchema).toContain("PostgreSQL database dump");
        expect(dumpedSchema).not.toContain("INSERT INTO");
        await fs.writeFile(schemaFile, dumpedSchema);
        await fs.writeFile(dataFile, archive.readAsText("db/lab-data.sql"));
        // Execute the EXACT supplied files with psql, including dump meta
        // commands, the data transaction and its commit-time FK validation.
        for (const file of [schemaFile, dataFile]) {
          await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", `--dbname=${dbUrl(database)}`, "-f", file],
            { maxBuffer: 8 * 1024 * 1024 });
        }
        const tables = await recovery.query(`SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
        expect(tables.rows.map((row) => row.table_name)).toEqual(schemaTables.map((table) => table.name).sort());
        const keys = await recovery.query(`SELECT conname, convalidated, condeferrable FROM pg_constraint
          WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY conname`);
        // PostgreSQL truncates these ASCII constraint names to NAMEDATALEN-1.
        expect(keys.rows.map((row) => row.conname).sort()).toEqual(schemaTables.flatMap((table) =>
          table.foreignKeys.map((fk) => fk.getName().slice(0, 63))).sort());
        expect(keys.rows.every((row) => row.convalidated && row.condeferrable)).toBe(true);
        // Exact whole-row parity catches not only FK loss but overwritten
        // totals, JSON snapshots and linked identities. Empty tables are
        // checked too, so leakage outside the fixture groups cannot hide.
        let count = 0;
        for (const table of schemaTables) {
          const expected = LAB_BACKUP_TABLE_RULES[table.name]?.include ? rows[s as "a" | "b"][table.name] ?? [] : [];
          const key = table.name === "legacy_case_media" ? "file_name" : "id";
          const actualRows = await recovery.query(`SELECT to_jsonb(t) AS row FROM public.${quote(table.name)} t`);
          const expectedRows = [];
          if (table.name === "users") {
            expectedRows.push(...sourceSnapshot.get("users")!.filter((row) =>
              [`owner-${s}`, "shared-actor"].includes(String(row.id))));
          } else {
            for (const record of expected) {
              expectedRows.push(sourceSnapshot.get(table.name)!.find((row) => row[key] === record[key])!);
            }
          }
          // Reversal leases are credentials and intentionally redacted.
          const redact = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([column, value]) => [
            column, !/(?:_at|_date|_timestamp)$/i.test(column) &&
              /(?:password|pass_hash|secret|token|api.?key|private.?key|credential|(?:^|_)pin$)/i.test(column) && value !== null
              ? typeof value === "string" ? column.includes("password")
                ? "!lab-backup-password-reset-required!" : "[REDACTED IN LAB BACKUP]" : null : value,
          ]));
          expect(actualRows.rows.map(({ row }) => row), table.name)
            .toEqual(expect.arrayContaining(expectedRows.map(redact)));
          expect(actualRows.rowCount, `${table.name} must contain no foreign lab rows`).toBe(expectedRows.length);
          count += expectedRows.length;
        }
        const manifest = JSON.parse(archive.readAsText("manifest.json"));
        expect(manifest).toMatchObject({ labId: `lab-${s}`, rowCount: count, mediaFileCount: 5 });
        for (const table of ["subscriptions", "provider_auto_pay_attempts", "user_sessions", "statement_link_tokens"]) {
          expect(manifest.excludedTables).toContainEqual(expect.objectContaining({ table }));
        }
        const media = archive.getEntries().filter((entry) => entry.entryName.startsWith("media/") && !entry.isDirectory);
        const names = ["case", "embedded", "ledger", "pending"].map((group) => `media/${group}-${s}.jpg`)
          .concat(`media/invoice-attachments/invoice-${s}.jpg`);
        expect(media.map((entry) => entry.entryName).sort()).toEqual(names.sort());
        const extracted = path.join(directory, `recovered-media-${s}`);
        for (const entry of media) {
          const target = path.join(extracted, entry.entryName);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, entry.getData());
          const group = path.basename(target).replace(`-${s}.jpg`, "");
          expect(await fs.readFile(target, "utf8")).toBe(`bytes:${group}-${s}`);
        }
        // User triggers were restored and re-enabled, not disabled permanently.
        await expect(recovery.query(`INSERT INTO payments (invoice_id, amount, payment_method, recorded_by_user_id)
          VALUES ($1, 1, 'cash', $2)`, [`invoice-${s}`, `owner-${s}`])).rejects.toThrow("immutable evidence");
        // Break the deeper credit chain and prove deferred checks still reject
        // an incomplete ledger at COMMIT (not merely marked valid). Updating
        // the child avoids ON DELETE RESTRICT's intentionally immediate check.
        await recovery.query("BEGIN");
        await recovery.query("UPDATE customer_credit_applications SET customer_credit_id='missing-credit' WHERE id=$1",
          [`credit-application-${s}`]);
        await expect(recovery.query("COMMIT")).rejects.toThrow(/foreign key constraint/);
        await recovery.query("ROLLBACK");
        expect((await recovery.query("SELECT id FROM customer_credits")).rows).toEqual([{ id: `credit-${s}` }]);
        // Removing the included accounting receipt must make the archive fail
        // atomically, rather than accepting dangling payment/credit references.
        const brokenDatabase = `lab_backup_incomplete_${s}`;
        await admin.query(`CREATE DATABASE ${quote(brokenDatabase)}`);
        await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", `--dbname=${dbUrl(brokenDatabase)}`, "-f", schemaFile],
          { maxBuffer: 8 * 1024 * 1024 });
        const brokenDataFile = path.join(directory, `incomplete-data-${s}.sql`);
        const dataSql = archive.readAsText("db/lab-data.sql");
        const brokenDataSql = dataSql.split("\n")
          .filter((line) => !line.startsWith('INSERT INTO public."statement_payment_sessions" ')).join("\n");
        expect(brokenDataSql).not.toBe(dataSql);
        await fs.writeFile(brokenDataFile, brokenDataSql);
        await expect(run("psql", ["-X", "-v", "ON_ERROR_STOP=1", `--dbname=${dbUrl(brokenDatabase)}`, "-f", brokenDataFile],
          { maxBuffer: 8 * 1024 * 1024 })).rejects.toThrow(/violates foreign key constraint/);
        const incomplete = new Client({ connectionString: dbUrl(brokenDatabase) });
        await incomplete.connect();
        clients.push(incomplete);
        for (const table of ["users", "organizations", "invoices", "payments", "customer_credits"]) {
          expect((await incomplete.query(`SELECT count(*)::int AS count FROM public.${quote(table)}`)).rows)
            .toEqual([{ count: 0 }]);
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
