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
  /**
   * The lab that owns the case. Returned by the barcode route on both the
   * canonical and legacy-mobile paths; batch locate scopes its location list
   * to it so scanned cases are never offered another lab's stations.
   */
  labOrganizationId?: string | null;
  labLocationId?: string | null;
  labLocationName?: string | null;
};

export function extractLookupCase(body: unknown): LookupCase | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { case?: LookupCase; data?: { case?: LookupCase } };
  return b.data?.case ?? b.case;
}

/**
 * User-facing wording for every barcode-lookup outcome. Exported so each
 * scanning surface (Cases list, dashboard lookup pop-up) shows identical
 * copy instead of re-typing the strings.
 */
export const BARCODE_LOOKUP_MESSAGES = {
  notFound: "No case found for that pan.",
  serverError: "Something went wrong. Please try again.",
  networkError: "Network error. Please try again.",
} as const;

/** Human-readable patient label for a looked-up case. */
export function lookupCasePatientName(found: LookupCase): string {
  return (
    [`${found.patientFirstName ?? ""}`, `${found.patientLastName ?? ""}`]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ") || "Unnamed patient"
  );
}

export type BarcodeLookupOutcome =
  | {
      status: "found";
      caseId: string;
      patientName: string;
      caseNumber: string | null;
      lookupCase: LookupCase;
    }
  | { status: "not_found"; message: string }
  | { status: "error"; message: string };

/**
 * Issue `GET /api/cases/barcode/:code` and normalize the response into a
 * discriminated outcome.
 *
 * Shared by the Cases-list scan modal and the dashboard case-lookup pop-up so
 * both surfaces agree on the request shape, the `{ ok, data: { case } }`
 * envelope parsing, and the user-facing wording. Callers own their own UI
 * state (spinner, lock flags, navigation) — this helper never touches it.
 */
export async function fetchCaseByBarcode(
  code: string,
  labOrganizationId: string,
  fetcher: (url: string) => Promise<Response>,
): Promise<BarcodeLookupOutcome> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { status: "not_found", message: BARCODE_LOOKUP_MESSAGES.notFound };
  }

  try {
    const qs = new URLSearchParams({ labOrganizationId });
    const res = await fetcher(
      `/api/cases/barcode/${encodeURIComponent(trimmed)}?${qs.toString()}`,
    );

    if (res.status === 404) {
      return { status: "not_found", message: BARCODE_LOOKUP_MESSAGES.notFound };
    }
    if (!res.ok) {
      return { status: "error", message: BARCODE_LOOKUP_MESSAGES.serverError };
    }

    const body = await res.json();
    const found = extractLookupCase(body);
    const caseId = found?.id;
    if (!found || !caseId) {
      return { status: "not_found", message: BARCODE_LOOKUP_MESSAGES.notFound };
    }

    return {
      status: "found",
      caseId,
      patientName: lookupCasePatientName(found),
      caseNumber: found.caseNumber ?? null,
      lookupCase: found,
    };
  } catch {
    return { status: "error", message: BARCODE_LOOKUP_MESSAGES.networkError };
  }
}
