/**
 * Parse a single-range HTTP `Range` header of the form `bytes=start-end`.
 *
 * Returns:
 *   - `{ start, end }` (inclusive) on success
 *   - `"invalid"` if the header is malformed or unsatisfiable for `size`
 *     (caller should respond with 416)
 *   - `null` if there is no Range header (caller should serve the full file)
 *
 * Multi-range requests (`bytes=0-99,200-299`) are not supported and fall into
 * the "invalid" path.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return "invalid";
  const startStr = match[1];
  const endStr = match[2];
  if (size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (startStr === "" && endStr === "") return "invalid";
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  }
  if (start < 0 || end < start || start >= size) return "invalid";
  if (end >= size) end = size - 1;
  return { start, end };
}
