import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import { resolvePostgresTool } from "./pg-tools";
import type { DatabaseCodec, DatabaseObjectStore } from "./database-protection";
import {
  verifyRecordDatabasePoint,
  readRecordSchema,
  readRecordBodies,
} from "./postgres-record-protection";
import {
  insertPostgresRecordBody,
  preparePostgresRecordRestore,
  verifyPostgresRecordInventory,
} from "./postgres-record-delta";

function requireIsolatedTarget(url: string, acknowledged: boolean): void {
  const target = new URL(url);
  if (
    !acknowledged ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/labtrax_db_rehearsal_[a-z0-9_]+$/.test(target.pathname)
  ) {
    throw new Error(
      "Record restore requires an explicitly acknowledged, disposable loopback rehearsal database.",
    );
  }
}
async function restoreSchema(
  targetUrl: string,
  file: string,
  section: "pre-data" | "post-data",
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      resolvePostgresTool("pg_restore"),
      [
        "--exit-on-error",
        "--single-transaction",
        ...(section === "pre-data" ? ["--clean", "--if-exists"] : []),
        "--no-owner",
        "--no-privileges",
        `--section=${section}`,
        `--dbname=${targetUrl}`,
        file,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Record schema restore tool could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Record schema restore failed. Discard this disposable target before retrying; retained recovery points were not changed.",
            ),
          );
    });
  });
}

/** Separate isolated entry point; never restores a live database or opens media. */
export async function restoreRecordDatabasePointIsolated(options: {
  store: DatabaseObjectStore;
  codec: DatabaseCodec;
  source: string;
  marker: string;
  targetUrl: string;
  isolationAcknowledged: boolean;
}): Promise<{ dumpBytes: number; point: string; mediaChanged: false }> {
  requireIsolatedTarget(options.targetUrl, options.isolationAcknowledged);
  const verified = await verifyRecordDatabasePoint(options, options.marker);
  const scratch = await mkdtemp(join(tmpdir(), "labtrax-record-rehearsal-"));
  const client = new pg.Client({
    connectionString: options.targetUrl,
    connectionTimeoutMillis: 10_000,
  });
  let connected = false,
    transaction = false;
  try {
    const schemaPath = join(scratch, "schema.pgdump"),
      rowsPath = join(scratch, "records.jsonl");
    const schema = await open(schemaPath, "wx", 0o600),
      rows = await open(rowsPath, "wx", 0o600);
    let bytes = 0;
    try {
      // Authenticate all schema and row bytes before any target mutation.
      await readRecordSchema(options, verified, async (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await schema.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (!result.bytesWritten)
            throw new Error("Could not stage verified record schema.");
          offset += result.bytesWritten;
        }
      });
      const byTable = new Map(
        verified.recordSnapshot.records.tables.map((table, index) => [
          JSON.stringify([table.schema, table.name]),
          index,
        ]),
      );
      await readRecordBodies(options, verified, async (table, json, count) => {
        const line = Buffer.from(
          JSON.stringify({
            table: byTable.get(JSON.stringify([table.schema, table.name])),
            json,
            count,
          }) + "\n",
        );
        let offset = 0;
        while (offset < line.length) {
          const result = await rows.write(line, offset, line.length - offset);
          if (!result.bytesWritten)
            throw new Error("Could not stage verified record rows.");
          offset += result.bytesWritten;
        }
        bytes += Buffer.byteLength(json) * count;
      });
      await schema.sync();
      await rows.sync();
    } finally {
      await schema.close();
      await rows.close();
    }
    await client.connect();
    connected = true;
    const existing = await client.query<{
      count: string;
    }>(`SELECT count(*)::text AS count FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_(toast|temp)' AND c.relkind IN ('r','p','v','m','S','f')`);
    if (Number(existing.rows[0]?.count) !== 0)
      throw new Error(
        "Record rehearsal requires an empty disposable database; nothing was changed.",
      );
    await restoreSchema(options.targetUrl, schemaPath, "pre-data");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transaction = true;
    await preparePostgresRecordRestore(client);
    const unexpectedTriggers =
      await client.query(`SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND t.tgenabled<>'D'
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)' LIMIT 1`);
    if (unexpectedTriggers.rows.length)
      throw new Error(
        "Schema pre-data installed active user triggers; this isolated restore cannot safely insert rows.",
      );
    // Extensions can seed tables when their schema is installed. The target is
    // owned/disposable and was checked empty before schema creation.
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    for (const table of verified.recordSnapshot.records.tables)
      await client.query(
        `DELETE FROM ONLY ${quote(table.schema)}.${quote(table.name)}`,
      );
    const lines = createInterface({
      input: createReadStream(rowsPath),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        const row = JSON.parse(line) as {
          table: number;
          json: string;
          count: number;
        };
        const table = verified.recordSnapshot.records.tables[row.table];
        if (!table) throw new Error("Staged record table identity differs.");
        await insertPostgresRecordBody(client, table, row.json, row.count);
      }
    } finally {
      lines.close();
    }
    await client.query("COMMIT");
    transaction = false;
    await restoreSchema(options.targetUrl, schemaPath, "post-data");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transaction = true;
    await preparePostgresRecordRestore(client);
    // Sequence state is inherently non-MVCC in PostgreSQL. Restore its captured
    // exact value/is_called after rows and all post-data constraints validate.
    await verifyPostgresRecordInventory(
      client,
      verified.recordSnapshot.records,
      false,
    );
    for (const sequence of verified.recordSnapshot.records.sequences)
      await client.query("SELECT setval($1::regclass,$2::bigint,$3::boolean)", [
        `${quote(sequence.schema)}.${quote(sequence.name)}`,
        sequence.value,
        sequence.called,
      ]);
    await verifyPostgresRecordInventory(
      client,
      verified.recordSnapshot.records,
    );
    await client.query("COMMIT");
    transaction = false;
    return {
      dumpBytes: bytes,
      point: verified.manifest.point,
      mediaChanged: false,
    };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (connected) await client.end();
    await rm(scratch, { recursive: true, force: true });
  }
}
