/**
 * Helpers for parsing the `GET /api/cases/barcode/:code` lookup response.
 *
 * The API wraps every response as `{ ok: true, data: <payload> }` (see the
 * api-server `ok()` helper in `lib/http.ts`). The barcode-lookup payload is
 * `{ case }`, so the case lives at `body.data.case` — NOT `body.case`. Reading
 * the wrong path made successful 200 lookups look like misses on mobile
 * ("No case found for that pan"). We also accept a top-level `{ case }` shape
 * for resilience against any older/unwrapped responses.
 */
export type LookupCase = {
  id?: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseNumber?: string | null;
  status?: string | null;
};

export function extractLookupCase(body: unknown): LookupCase | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { case?: LookupCase; data?: { case?: LookupCase } };
  return b.data?.case ?? b.case;
}
