import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  pageRowsKeyset,
  parsePagination,
  sortTime,
  type Keyset,
} from "./pagination.js";

type Row = { id: string; date: string };

/** Newest first, ties broken by the descending id — the finance list order. */
const keyset: Keyset<Row> = {
  sortValues: (row) => [sortTime(row.date)],
  id: (row) => row.id,
  directions: ["desc"],
  idDirection: "desc",
};

const sorted = (rows: Row[]) =>
  [...rows].sort((a, b) =>
    a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1,
  );

const row = (id: string, date: string): Row => ({ id, date });

describe("keyset pagination", () => {
  const base = sorted([
    row("e", "2026-01-05"),
    row("d", "2026-01-04"),
    row("c", "2026-01-03"),
    row("b", "2026-01-02"),
    row("a", "2026-01-01"),
  ]);

  it("walks a stable list exactly once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = pageRowsKeyset(
        base,
        parsePagination({ limit: "2", ...(cursor ? { cursor } : {}) }),
        keyset,
      );
      seen.push(...page.rows.map((r) => r.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("neither skips nor repeats a row when records arrive between batches", () => {
    const first = pageRowsKeyset(base, parsePagination({ limit: "2" }), keyset);
    expect(first.rows.map((r) => r.id)).toEqual(["e", "d"]);

    // Two newer rows arrive at the head of the list, which under offset paging
    // would push "c" and "b" past the second window and hide them.
    const grown = sorted([...base, row("g", "2026-01-07"), row("f", "2026-01-06")]);
    const second = pageRowsKeyset(
      grown,
      parsePagination({ limit: "2", cursor: first.nextCursor! }),
      keyset,
    );
    expect(second.rows.map((r) => r.id)).toEqual(["c", "b"]);

    const third = pageRowsKeyset(
      grown,
      parsePagination({ limit: "2", cursor: second.nextCursor! }),
      keyset,
    );
    expect(third.rows.map((r) => r.id)).toEqual(["a"]);
    expect(third.hasMore).toBe(false);

    const walked = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(walked).toEqual(["e", "d", "c", "b", "a"]);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("keeps serving unseen rows when the anchor itself is re-sorted", () => {
    const first = pageRowsKeyset(base, parsePagination({ limit: "2" }), keyset);
    expect(first.rows.map((r) => r.id)).toEqual(["e", "d"]);

    // The anchor row is re-dated to the very bottom of the list. Resuming
    // from where "d" now sits would jump the window past c, b and a.
    const reordered = sorted([
      ...base.filter((r) => r.id !== "d"),
      row("d", "2025-12-31"),
    ]);
    const second = pageRowsKeyset(
      reordered,
      parsePagination({ limit: "3", cursor: first.nextCursor! }),
      keyset,
    );
    expect(second.rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("resumes by locale order when a deleted anchor holds non-ASCII text", () => {
    // "É" sorts after "Z" by code unit but before it by locale, which is how
    // the list comparators order names.
    const byName: Keyset<Row> = {
      sortValues: (r) => [r.date],
      id: (r) => r.id,
      directions: ["asc"],
    };
    const names = [row("1", "Alice"), row("2", "Émile"), row("3", "Zoe")];
    const second = pageRowsKeyset(names, parsePagination({ limit: "1" }), byName);
    expect(second.rows.map((r) => r.id)).toEqual(["1"]);
    const anchored = pageRowsKeyset(
      names,
      parsePagination({ limit: "1", cursor: second.nextCursor! }),
      byName,
    );
    expect(anchored.rows.map((r) => r.id)).toEqual(["2"]);

    const withoutEmile = names.filter((r) => r.id !== "2");
    const afterDeletedAnchor = pageRowsKeyset(
      withoutEmile,
      parsePagination({ limit: "1", cursor: anchored.nextCursor! }),
      byName,
    );
    expect(afterDeletedAnchor.rows.map((r) => r.id)).toEqual(["3"]);
  });

  it("resumes from the anchor's sort position when the anchor row is gone", () => {
    const first = pageRowsKeyset(base, parsePagination({ limit: "2" }), keyset);
    const withoutAnchor = base.filter((r) => r.id !== "d");
    const second = pageRowsKeyset(
      withoutAnchor,
      parsePagination({ limit: "2", cursor: first.nextCursor! }),
      keyset,
    );
    expect(second.rows.map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("reports the resolved position so loaded counters stay meaningful", () => {
    const first = pageRowsKeyset(base, parsePagination({ limit: "2" }), keyset);
    const second = pageRowsKeyset(
      base,
      parsePagination({ limit: "2", cursor: first.nextCursor! }),
      keyset,
    );
    expect(second).toMatchObject({ offset: 2, total: 5, hasMore: true });
  });

  it("falls back to offset paging and stays inactive without paging params", () => {
    expect(parsePagination({}).active).toBe(false);
    const page = pageRowsKeyset(base, parsePagination({ limit: "2", offset: "3" }), keyset);
    expect(page.rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(page.offset).toBe(3);
  });

  it("ignores offset when a cursor is supplied", () => {
    const first = pageRowsKeyset(base, parsePagination({ limit: "1" }), keyset);
    const second = pageRowsKeyset(
      base,
      parsePagination({ limit: "1", offset: "4", cursor: first.nextCursor! }),
      keyset,
    );
    expect(second.rows.map((r) => r.id)).toEqual(["d"]);
  });

  it("round-trips a cursor and rejects a malformed one", () => {
    const cursor = encodeCursor({ sort: [1, "x", null], id: "row-1" });
    expect(decodeCursor(cursor)).toEqual({ sort: [1, "x", null], id: "row-1" });
    expect(() => decodeCursor("not-a-cursor")).toThrow(/cursor/);
    expect(() => decodeCursor(Buffer.from("{}", "utf8").toString("base64url")))
      .toThrow(/cursor/);
    expect(() => parsePagination({ limit: "10", cursor: "%%%" })).toThrow(/cursor/);
  });
});
