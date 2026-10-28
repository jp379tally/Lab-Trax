import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { requireIsolatedRestoreTest } from "./restore-test-isolation";

// Capability experiments only, NOT a deployed record-change capture engine.
// All SQL runs in the owned disposable cluster; no production introspection.
requireIsolatedRestoreTest();

describe("application-level record capture feasibility without logical WAL", () => {
  const suffix = randomBytes(8).toString("hex");
  const role = `delta_probe_${suffix}`;
  const schema = `delta_probe_${suffix}`;
  let admin: pg.Client;
  let writer: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
    await admin.query(`SET ROLE "${role}"`);
    await admin.query(`
      CREATE TABLE "${schema}".records (id integer PRIMARY KEY, value text);
      CREATE TABLE "${schema}".changes (
        position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        operation text NOT NULL, old_row jsonb, new_row jsonb
      );
      CREATE FUNCTION "${schema}".capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "${schema}".changes(operation, old_row, new_row)
          VALUES (TG_OP, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NULL;
      END $$;
      CREATE TRIGGER capture AFTER INSERT OR UPDATE OR DELETE ON "${schema}".records
        FOR EACH ROW EXECUTE FUNCTION "${schema}".capture();
    `);
    writer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    await writer.query(`SET ROLE "${role}"`);
  });
  afterAll(async () => {
    await writer?.query("ROLLBACK");
    await writer?.end();
    if (admin) {
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  });

  it("proves owner-installed triggers capture committed SQL changes and roll back failed writes", async () => {
    await admin.query(`INSERT INTO "${schema}".records VALUES (1, 'synthetic original'), (2, 'synthetic deleted')`);
    await admin.query(`UPDATE "${schema}".records SET value='synthetic revised' WHERE id=1`);
    await admin.query(`DELETE FROM "${schema}".records WHERE id=2`);
    await admin.query("BEGIN");
    await admin.query(`UPDATE "${schema}".records SET value='synthetic rolled back' WHERE id=1`);
    await admin.query("ROLLBACK");
    const events = await admin.query(`SELECT operation FROM "${schema}".changes ORDER BY position`);
    expect(events.rows.map(row => row.operation)).toEqual(["INSERT", "INSERT", "UPDATE", "DELETE"]);
    const row = await admin.query(`SELECT value FROM "${schema}".records WHERE id=1`);
    expect(row.rows[0].value).toBe("synthetic revised");
  });

  it("proves row triggers alone miss schema-derived row values and owner role cannot install a DDL event trigger", async () => {
    const before = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".changes`);
    // PostgreSQL computes fresh per-row defaults without firing DML triggers.
    // Saving only the schema expression cannot recover these exact values.
    await admin.query(`ALTER TABLE "${schema}".records ADD COLUMN generated_value double precision NOT NULL DEFAULT random()`);
    const row = await admin.query(`SELECT generated_value FROM "${schema}".records WHERE id=1`);
    expect(typeof row.rows[0].generated_value).toBe("number");
    const after = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".changes`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await admin.query(`CREATE FUNCTION "${schema}".capture_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$`);
    await expect(admin.query(`CREATE EVENT TRIGGER "${schema}" ON ddl_command_end EXECUTE FUNCTION "${schema}".capture_ddl()`))
      .rejects.toMatchObject({ code: "42501" });
    const authority = await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user");
    expect(authority.rows[0].rolsuper).toBe(false);
  });

  it("proves an unfenced owner can bypass row capture without leaving changed trigger metadata", async () => {
    const metadata = () => admin.query(`
      SELECT pg_get_triggerdef(oid) AS definition, tgenabled AS enabled
      FROM pg_trigger WHERE tgrelid='"${schema}".records'::regclass AND tgname='capture'
    `);
    const before = await metadata();
    const count = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".changes`);
    await admin.query(`ALTER TABLE "${schema}".records DISABLE TRIGGER capture`);
    await admin.query(`UPDATE "${schema}".records SET value='synthetic untracked mutation' WHERE id=1`);
    await admin.query(`ALTER TABLE "${schema}".records ENABLE TRIGGER capture`);
    const after = await metadata();
    expect(after.rows).toEqual(before.rows);
    const next = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".changes`);
    expect(next.rows[0].n).toBe(count.rows[0].n);
    const record = await admin.query(`SELECT value FROM "${schema}".records WHERE id=1`);
    expect(record.rows[0].value).toBe("synthetic untracked mutation");
  });

  it("proves a max-position cursor loses late commits, so a transaction-visibility protocol is mandatory", async () => {
    await writer.query("BEGIN");
    await writer.query(`INSERT INTO "${schema}".records(id,value) VALUES(3,'synthetic late commit')`);
    await admin.query(`INSERT INTO "${schema}".records(id,value) VALUES(4,'synthetic early commit')`);
    const checkpoint = await admin.query(`SELECT max(position)::text AS position FROM "${schema}".changes`);
    await writer.query("COMMIT");
    const lost = await admin.query(`SELECT position FROM "${schema}".changes WHERE new_row->>'id'='3'`);
    expect(BigInt(lost.rows[0].position)).toBeLessThan(BigInt(checkpoint.rows[0].position));
    const cursorRead = await admin.query(`SELECT position FROM "${schema}".changes WHERE position>$1 AND new_row->>'id'='3'`, [checkpoint.rows[0].position]);
    expect(cursorRead.rows).toEqual([]);
  });
});
