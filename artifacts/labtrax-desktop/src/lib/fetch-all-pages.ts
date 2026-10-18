/**
 * Bounded-batch fetching for "export the whole filtered set" actions.
 *
 * The register and statements tables render in batches, but their CSV exports
 * must still contain every matching row. Asking the server for the complete
 * set in one unbounded request is what these helpers replace: on a lab with
 * years of history that single request is the slowest thing the page does and
 * can time out or exhaust memory.
 *
 * Paging on these list routes is opt-in, so a server that has not been
 * converted still answers with the legacy whole-array shape. That response is
 * already complete, so it is accepted as the final batch rather than treated
 * as an error.
 */

/** Server-side pagination caps `limit` at 100. */
export const EXPORT_BATCH_SIZE = 100;

/**
 * Hard ceiling on the number of requests one export may make. A server that
 * keeps reporting `hasMore` must never be able to spin the browser forever;
 * the export fails loudly instead of writing a truncated file.
 */
const MAX_EXPORT_BATCHES = 10_000;

export interface PagedResponse<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ExportProgress {
  /** Rows fetched so far. */
  loaded: number;
  /** Rows the server says match the filter, or null before it reports one. */
  total: number | null;
}

export interface FetchAllPagesOptions<T> {
  /** Requests one bounded batch. Rejections propagate to the caller. */
  fetchPage: (batch: { limit: number; offset: number }) => Promise<PagedResponse<T> | T[]>;
  batchSize?: number;
  /** Called after every batch so the caller can show export progress. */
  onProgress?: (progress: ExportProgress) => void;
  /** Stable row identity; a repeated id means the set shifted mid-export. */
  getId?: (row: T) => string | number | null | undefined;
  signal?: AbortSignal;
}

function abortError(): Error {
  const e = new Error("Export cancelled");
  e.name = "AbortError";
  return e;
}

/**
 * Walk a paginated list route batch by batch and return every matching row in
 * server order. Throws rather than returning a partial set: malformed
 * responses, a changing total, duplicate ids, or a terminal row count that
 * differs from the reported total all fail the export.
 */
export async function fetchAllPages<T>({
  fetchPage,
  batchSize = EXPORT_BATCH_SIZE,
  onProgress,
  getId,
  signal,
}: FetchAllPagesOptions<T>): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string | number>();
  let expectedTotal: number | null = null;
  for (let batches = 0; batches < MAX_EXPORT_BATCHES; batches += 1) {
    if (signal?.aborted) throw abortError();
    const response = await fetchPage({ limit: batchSize, offset: rows.length });
    if (signal?.aborted) throw abortError();
    if (Array.isArray(response)) {
      if (batches !== 0) throw new Error("The export stopped early: the server changed response format.");
      rows.push(...response);
      onProgress?.({ loaded: rows.length, total: rows.length });
      return rows;
    }
    const r = response as Partial<PagedResponse<T>> | null;
    if (!r || !Array.isArray(r.rows) || typeof r.total !== "number" || !Number.isInteger(r.total) || r.total < 0 || typeof r.hasMore !== "boolean") {
      throw new Error("The export stopped early: the server returned an unexpected response.");
    }
    if (expectedTotal === null) expectedTotal = r.total;
    else if (expectedTotal !== r.total) {
      throw new Error("The export stopped early: the invoice list changed while exporting. Try again.");
    }
    for (const row of r.rows) {
      if (!getId) continue;
      const id = getId(row);
      if (id == null) continue;
      if (seen.has(id)) throw new Error("The export stopped early: duplicate rows were returned. Try again.");
      seen.add(id);
    }
    rows.push(...r.rows);
    onProgress?.({ loaded: rows.length, total: expectedTotal });
    if (!r.hasMore) {
      if (rows.length !== expectedTotal) {
        throw new Error(`The export is incomplete: received ${rows.length} of ${expectedTotal} rows.`);
      }
      return rows;
    }
    if (r.rows.length === 0) {
      throw new Error("The export stopped early: the server reported more rows but returned none.");
    }
  }
  throw new Error("The export stopped early: too many batches were needed to load every row.");
}
