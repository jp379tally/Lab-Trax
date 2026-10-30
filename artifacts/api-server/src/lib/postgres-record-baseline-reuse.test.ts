import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  capturePostgresRecordChanges, MAX_CHANGED_RECORD_BYTES, recordBodyPageEnd,
  type RecordSqlClient,
} from "./postgres-record-delta";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const schema = "CREATE TABLE fixture(id integer PRIMARY KEY, value text, reference text);";
const oldProtocol = sha("synthetic-reference-v1"), newProtocol = sha("synthetic-reference-v2");
type Row = { id: number; value: string; reference: string };

/** Synthetic SQL boundary; all hashing, row validation and capture logic are real. */
function source(initial: Row[]) {
  let rows = initial, cursor = 0;
  let columns = ["id", "value", "reference"];
  let sizeAdjustment = 0, reportedSize: number | null = null;
  const bodyReads: number[] = [];
  const encoded = () => rows.map(row => {
    const json = JSON.stringify(row);
    return { key: sha(JSON.stringify([row.id])), hash: sha(json), json,
      count: "1", bytes: String(reportedSize ?? Buffer.byteLength(json) + sizeAdjustment), id: row.id };
  });
  const client: RecordSqlClient = {
    async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      let result: unknown[];
      if (sql.includes("current_setting('transaction_isolation')")) result = [{ isolation: "repeatable read", readonly: "on" }];
      else if (/^SET LOCAL |^LOCK TABLE ONLY /.test(sql)) result = [];
      else if (sql.includes("c.relkind IN ('f','m')") || sql.includes("pg_largeobject_metadata")) result = [];
      else if (sql.includes('AS "primaryKey"')) result = [{
        schema: "public", name: "fixture", columns, allColumns: columns, primaryKey: ["id"],
      }];
      else if (sql.includes("c.relkind='S'")) result = [];
      else if (sql.startsWith("DECLARE labtrax_record_fingerprints")) { cursor = 0; result = []; }
      else if (sql.startsWith("FETCH 512")) {
        result = encoded().sort((a, b) => a.key < b.key ? -1 : 1).slice(cursor, cursor + 512)
          .map(({ key, hash, count, bytes }) => ({ key, hash, count, bytes }));
        cursor += result.length;
      } else if (sql.startsWith("CLOSE labtrax_record_fingerprints")) result = [];
      else if (sql.includes(" AS json,")) {
        const selected = new Set(values![0] as string[]);
        result = encoded().filter(row => selected.has(row.key)).map(({ key, hash, json, count, id }) => {
          bodyReads.push(id); return { key, hash, json, count };
        });
      } else throw new Error("Unexpected synthetic SQL boundary");
      return { rows: result as T[] };
    },
  };
  return { client, bodyReads,
    replace(next: Row[]) { rows = next; bodyReads.length = 0; },
    reorderColumns() { columns = ["value", "id", "reference"]; },
    misreportBytes(extra: number) { sizeAdjustment = extra; },
    reportSize(bytes: number) { reportedSize = bytes; },
  };
}

describe("bounded explicit record baselines", () => {
  it.each(["reference", "schema"])("rereads all current references but buffers only exact new bodies for a %s transition", async transition => {
    const firstRows = [
      { id: 1, value: "retained", reference: "case-media/retained.png" },
      { id: 2, value: "before", reference: "case-media/before.pdf" },
    ];
    const f = source(firstRows);
    const first = await capturePostgresRecordChanges(f.client, {
      schemaSql: schema, referenceProtocol: oldProtocol, references: () => [],
    });
    const current = [firstRows[0]!,
      { id: 2, value: "after", reference: "case-media/current.pdf" },
      { id: 3, value: "new", reference: "case-media/new.mp4" },
    ];
    f.replace(current);
    const visited: number[] = [];
    const next = await capturePostgresRecordChanges(f.client, {
      previous: first.inventory,
      schemaSql: transition === "schema" ? schema + "\nCREATE INDEX fixture_value ON fixture(value);" : schema,
      referenceProtocol: transition === "reference" ? newProtocol : oldProtocol,
      references: (_table, row) => { visited.push(Number(row.id)); return [String(row.reference)]; },
    });
    expect(next.delta).toBeNull();
    expect(next.reason).toBe(transition === "schema" ? "schema-changed" : "reference-protocol-changed");
    expect(f.bodyReads.sort()).toEqual([1, 2, 3]);
    expect(visited.sort()).toEqual([1, 2, 3]);
    expect(next.inventory.tables[0]!.rows.flatMap(row => row.references).sort())
      .toEqual(current.map(row => row.reference).sort());
    expect(next.bodies.flatMap(table => table.inserts).map(row => JSON.parse(row.json).id).sort()).toEqual([2, 3]);
    expect(next.metrics.sourceRowBodyBytes).toBe(current.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
    expect(first.inventory.tables[0]!.rows.every(row => row.references.length === 0)).toBe(true);
  });

  it("retains bodies when the prior catalog differs even if key/hash/count still match", async () => {
    const rows = [{ id: 1, value: "retained", reference: "case-media/current.png" }];
    const f = source(rows);
    const first = await capturePostgresRecordChanges(f.client, { schemaSql: schema, referenceProtocol: oldProtocol });
    f.replace(rows); f.reorderColumns();
    const next = await capturePostgresRecordChanges(f.client, {
      previous: first.inventory, schemaSql: schema + "\n-- changed column ordering", referenceProtocol: oldProtocol,
    });
    expect(next.reason).toBe("schema-changed");
    expect(next.bodies[0]!.inserts).toHaveLength(1);
  });

  it("keeps the no-body-read path for a compatible unchanged interval", async () => {
    const rows = [{ id: 1, value: "retained", reference: "case-media/current.png" }];
    const f = source(rows);
    const first = await capturePostgresRecordChanges(f.client, {
      schemaSql: schema, referenceProtocol: oldProtocol, references: (_table, row) => [String(row.reference)],
    });
    f.replace(rows);
    const next = await capturePostgresRecordChanges(f.client, {
      previous: first.inventory, schemaSql: schema, referenceProtocol: oldProtocol,
      references: () => { throw new Error("Unchanged compatible row should reuse validated references"); },
    });
    expect(next.reason).toBe("changed-rows");
    expect(next.delta).not.toBeNull();
    expect(next.metrics.sourceRowBodyBytes).toBe(0);
    expect(f.bodyReads).toEqual([]);
  });

  it("rejects a freshly read reusable body if its UTF-8 size differs from the snapshot fingerprint", async () => {
    const rows = [{ id: 1, value: "retained", reference: "case-media/current.png" }];
    const f = source(rows);
    const first = await capturePostgresRecordChanges(f.client, { schemaSql: schema, referenceProtocol: oldProtocol });
    f.replace(rows); f.misreportBytes(1);
    await expect(capturePostgresRecordChanges(f.client, {
      previous: first.inventory, schemaSql: schema, referenceProtocol: newProtocol,
    })).rejects.toThrow(/snapshot fingerprint/);
  });

  it("rejects an oversized body at the fingerprint boundary before any row JSON is fetched", async () => {
    const f = source([{ id: 1, value: "small placeholder", reference: "case-media/current.png" }]);
    f.reportSize(MAX_CHANGED_RECORD_BYTES + 1);
    await expect(capturePostgresRecordChanges(f.client, { schemaSql: schema })).rejects.toThrow(/record byte length/);
    expect(f.bodyReads).toEqual([]);
  });
});

describe("record SQL body-page admission", () => {
  const mib = 1024 * 1024;
  it("counts a reusable page against the remaining buffer beside retained new rows", () => {
    expect(recordBodyPageEnd([8 * mib, 1], 0, 248 * mib)).toBe(1);
    expect(() => recordBodyPageEnd([9 * mib], 0, 248 * mib)).toThrow(/remaining capture capacity/);
    expect(() => recordBodyPageEnd([1], 0, MAX_CHANGED_RECORD_BYTES)).toThrow(/remaining capture capacity/);
  });
  it("shrinks a multi-row page to fit the remaining capture capacity", () => {
    expect(recordBodyPageEnd([4 * mib, 4 * mib], 0, 250 * mib)).toBe(1);
    expect(recordBodyPageEnd([4 * mib, 4 * mib], 0, 0)).toBe(2);
  });
  it("preserves the bounded single-large-row and 128-row limits", () => {
    expect(recordBodyPageEnd([9 * mib, 1], 0, 0)).toBe(1);
    expect(recordBodyPageEnd(Array.from({ length: 129 }, () => 1), 0, 0)).toBe(128);
    expect(() => recordBodyPageEnd([MAX_CHANGED_RECORD_BYTES + 1], 0, 0)).toThrow(/record byte length/);
  });
});
