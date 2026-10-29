import { spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePostgresTool } from "./pg-tools";
import pg from "pg";
import { restoreRecordDatabasePointIsolated } from "./postgres-record-restore";
import {
  verifyDatabasePoint, type DatabaseCodec, type DatabaseObjectStore,
} from "./database-protection";

/** Deliberately separate from the full restore pipeline. Never opens media. */
export async function restoreDatabasePointIsolated(options: {
  store: DatabaseObjectStore; codec: DatabaseCodec; source: string; marker: string;
  targetUrl: string; isolationAcknowledged: boolean;
}): Promise<{ dumpBytes: number; point: string; mediaChanged: false }> {
  const target = new URL(options.targetUrl);
  if (!options.isolationAcknowledged || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      !/^\/labtrax_db_rehearsal_[a-z0-9_]+$/.test(target.pathname)) {
    throw new Error("Database-only restore requires an explicitly acknowledged, disposable loopback rehearsal database.");
  }
  if(options.marker.startsWith("records-verified-"))return restoreRecordDatabasePointIsolated(options);
  const scratch = await mkdtemp(join(tmpdir(), "labtrax-db-rehearsal-"));
  try {
    const dump = join(scratch, "database.pgdump");
    const output = await open(dump, "wx", 0o600);
    let position = 0;
    try {
      const verified = await verifyDatabasePoint(
        options.store, options.codec, options.source, options.marker,
        async chunk => {
          let offset = 0;
          while (offset < chunk.length) {
            const written = await output.write(chunk, offset, chunk.length - offset, position);
            if (written.bytesWritten <= 0) throw new Error("Could not write the verified database rehearsal dump.");
            offset += written.bytesWritten;
            position += written.bytesWritten;
          }
        },
      );
      await output.sync();
      const client = new pg.Client({ connectionString: options.targetUrl, connectionTimeoutMillis: 10_000 });
      try {
        await client.connect();
        const existing = await client.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        `);
        if (Number(existing.rows[0]?.count) !== 0) {
          throw new Error("Database-only rehearsal requires an empty disposable database; nothing was changed.");
        }
      } finally { await client.end(); }
      await output.close();
      return await new Promise<{ dumpBytes: number; point: string; mediaChanged: false }>((resolve, reject) => {
        const child = spawn(resolvePostgresTool("pg_restore"), [
          "--exit-on-error", "--single-transaction", "--clean", "--if-exists",
          "--no-owner", "--no-privileges", `--dbname=${options.targetUrl}`, dump,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        // Never include SQL or PostgreSQL stderr in status/logs.
        child.stderr.resume();
        const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
        child.once("error", () => { clearTimeout(timer); reject(new Error("Database-only restore tool could not start.")); });
        child.once("close", code => {
          clearTimeout(timer);
          if (code === 0) resolve({ dumpBytes: position, point: verified.manifest.point, mediaChanged: false });
          else reject(new Error("Database-only restore failed; its database transaction was rolled back."));
        });
      });
    } finally {
      await output.close().catch(() => undefined);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
