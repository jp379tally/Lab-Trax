import type { ParsedQs } from "qs";
import { HttpError } from "./http";

export type SortValue = string | number | null;

/**
 * Anchor for keyset ("cursor") paging: the sort values of the last row a
 * client received plus that row's stable identity, which every paged list
 * uses as its final tiebreaker.
 */
export type PageCursor = {
  sort: SortValue[];
  id: string;
};

export type Pagination = {
  active: boolean;
  limit: number;
  offset: number;
  cursor: PageCursor | null;
};

export type SortDirection = "asc" | "desc";

/**
 * Describes the order a list is already sorted in so a cursor can be resolved
 * back to a position. `sortValues` must return the same values, in the same
 * significance order, that the list's comparator (or SQL ORDER BY) used, and
 * `id` must be the stable unique tiebreaker.
 */
export type Keyset<T> = {
  sortValues: (row: T) => SortValue[];
  id: (row: T) => string;
  directions: readonly SortDirection[];
  /** Direction of the id tiebreaker. Defaults to ascending. */
  idDirection?: SortDirection;
};

export type PagedResult<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type KeysetPagedResult<T> = PagedResult<T> & {
  /** Anchor the caller passes back as `?cursor=` to fetch the next batch. */
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 100;

function parseInteger(value: unknown, name: string): number {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new HttpError(400, `${name} must be an integer.`);
  }
  return Number(value);
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, s: cursor.sort, i: cursor.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(raw: unknown): PageCursor {
  if (typeof raw !== "string" || !raw) {
    throw new HttpError(400, "cursor must be a pagination cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "cursor must be a pagination cursor.");
  }
  const candidate = parsed as { v?: unknown; s?: unknown; i?: unknown } | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.v !== 1 ||
    typeof candidate.i !== "string" ||
    !Array.isArray(candidate.s) ||
    !candidate.s.every(
      (value) =>
        value === null || typeof value === "string" || typeof value === "number",
    )
  ) {
    throw new HttpError(400, "cursor must be a pagination cursor.");
  }
  return { sort: candidate.s as SortValue[], id: candidate.i };
}

/**
 * Pagination is deliberately opt-in so existing consumers retain their
 * response shape. Once any paging parameter is present, the omitted
 * parameters receive their conventional defaults.
 *
 * `cursor` is the stable way to walk a list: it anchors the next batch on the
 * last row already received, so records created or re-sorted between two
 * requests cannot shift the window and make a row be skipped or repeated.
 * `offset` remains supported for callers that page a snapshot, and is ignored
 * when a cursor is supplied.
 */
export function parsePagination(query: ParsedQs | Record<string, unknown>): Pagination {
  const hasLimit = Object.prototype.hasOwnProperty.call(query, "limit");
  const hasOffset = Object.prototype.hasOwnProperty.call(query, "offset");
  const hasCursor = Object.prototype.hasOwnProperty.call(query, "cursor");
  if (!hasLimit && !hasOffset && !hasCursor) {
    return { active: false, limit: DEFAULT_LIMIT, offset: 0, cursor: null };
  }
  const limit = hasLimit ? parseInteger(query.limit, "limit") : DEFAULT_LIMIT;
  const offset = hasOffset ? parseInteger(query.offset, "offset") : 0;
  if (limit < 1 || limit > 100) {
    throw new HttpError(400, "limit must be between 1 and 100.");
  }
  const cursor = hasCursor ? decodeCursor(query.cursor) : null;
  return { active: true, limit, offset: cursor ? 0 : offset, cursor };
}

export function pageRows<T>(rows: T[], pagination: Pagination): PagedResult<T> {
  const total = rows.length;
  const page = rows.slice(pagination.offset, pagination.offset + pagination.limit);
  return {
    rows: page,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    hasMore: pagination.offset + page.length < total,
  };
}

/**
 * Normalize a date-ish sort field (Date, ISO string, date-only string) to a
 * comparable epoch value so a cursor round-trips through JSON unchanged.
 */
export function sortTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(time) ? null : time;
}

function compareValues(left: SortValue, right: SortValue): number {
  if (left === right) return 0;
  // A missing sort value sorts before every present one, matching the
  // "" / epoch placeholders the list comparators use for absent dates.
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  // Text is compared exactly the way the list comparators compare it, so a
  // cursor resolves to the same position the sort put the anchor in even for
  // non-ASCII names, where code-unit order and locale order disagree.
  return String(left).localeCompare(String(right));
}

function compareToCursor<T>(row: T, cursor: PageCursor, keyset: Keyset<T>): number {
  const values = keyset.sortValues(row);
  const count = Math.max(values.length, cursor.sort.length);
  for (let index = 0; index < count; index += 1) {
    const direction = keyset.directions[index] ?? "asc";
    const compared = compareValues(
      values[index] ?? null,
      cursor.sort[index] ?? null,
    );
    if (compared !== 0) return direction === "desc" ? -compared : compared;
  }
  const byId = compareValues(keyset.id(row), cursor.id);
  if (byId === 0) return 0;
  return (keyset.idDirection ?? "asc") === "desc" ? -byId : byId;
}

/**
 * Resolve a cursor to the index of the first row that belongs to the next
 * batch: the first row that sorts strictly after the recorded anchor position.
 *
 * The position is decided by the anchor's recorded sort tuple, never by where
 * the anchor row happens to sit now. That distinction matters when the
 * anchor's own sort field changed between the two requests: resolving from its
 * new position would jump the window past every unseen row it moved beyond.
 * Resolving from the tuple always continues exactly where the previous batch
 * stopped, whether or not the anchor still exists in the list.
 *
 * Because the tuple ends in the row id, and every list this pages is sorted in
 * a total order, the comparison is exact rather than approximate.
 */
function resolveCursorStart<T>(
  rows: T[],
  cursor: PageCursor,
  keyset: Keyset<T>,
): number {
  for (let index = 0; index < rows.length; index += 1) {
    if (compareToCursor(rows[index], cursor, keyset) > 0) return index;
  }
  return rows.length;
}

/**
 * Page an already-sorted list, honouring a keyset cursor when one was sent
 * and falling back to the requested offset otherwise. `offset` in the
 * response is the resolved position of the batch within the current list, so
 * "showing X of Y" counters stay meaningful for both paging styles.
 */
export function pageRowsKeyset<T>(
  rows: T[],
  pagination: Pagination,
  keyset: Keyset<T>,
): KeysetPagedResult<T> {
  const total = rows.length;
  const start = pagination.cursor
    ? resolveCursorStart(rows, pagination.cursor, keyset)
    : pagination.offset;
  const page = rows.slice(start, start + pagination.limit);
  const last = page.length ? page[page.length - 1] : null;
  return {
    rows: page,
    total,
    limit: pagination.limit,
    offset: start,
    hasMore: start + page.length < total,
    nextCursor:
      last === null
        ? null
        : encodeCursor({ sort: keyset.sortValues(last), id: keyset.id(last) }),
  };
}
