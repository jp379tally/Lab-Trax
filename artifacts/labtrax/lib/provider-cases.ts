// The provider's own case list, loaded once for the whole portal.
//
// Desktop fetches GET /cases/provider a single time at the portal entry point
// (pages/provider-cases.tsx) and hands the rows to every consumer, so the
// Dashboard and Message My Lab never disagree about what the provider has.
// Mobile gets the same property from one React Query entry: every caller of
// `useProviderCases` reads the same cache slot, so the section can be composed
// from several components without any of them issuing its own request.
//
// The key sits under the practice-scoped "provider-cases" prefix
// (PRACTICE_SCOPED_QUERY_PREFIXES), so switching practice drops these rows
// with the rest of the outgoing practice's data rather than repainting them
// under the incoming one.
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { providerRequest } from "@/lib/provider-api";

/**
 * A row of GET /api/cases/provider.
 *
 * Only the fields the portal actually reads are declared. The server sends the
 * whole case row plus the provider-portal enrichments (restorationTypes,
 * labName, openInvoiceAmount); anything not listed here is deliberately not
 * part of the portal's contract.
 */
export interface ProviderCase {
  id: string;
  caseNumber: string;
  status: string;
  dueDate?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  patientInitials?: string | null;
  restorationTypes?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
}

export const PROVIDER_CASES_QUERY_KEY = ["provider-cases"] as const;

export interface ProviderCasesValue {
  /** The provider's cases, or null until a load has actually succeeded. */
  cases: ProviderCase[] | null;
  /** Load failure message, using the same fallback copy desktop shows. */
  error: string | null;
  /** A re-fetch is in flight over cases that are already on screen. */
  isRefreshing: boolean;
  refetch: () => void;
}

/**
 * The case a provider is assigned. `cases` is null until the first response
 * arrives — the portal distinguishes "still loading" from "loaded, and there
 * are none", exactly as the desktop dashboard does.
 */
export function useProviderCases(): ProviderCasesValue {
  const query = useQuery<ProviderCase[]>({
    queryKey: PROVIDER_CASES_QUERY_KEY,
    queryFn: () => providerRequest<ProviderCase[]>("/api/cases/provider"),
    staleTime: 30_000,
  });

  // `cases` follows the last response that actually arrived, not the current
  // request: a failed re-fetch keeps the rows the provider is already looking
  // at instead of dropping them, and only a load that has never succeeded
  // reads as null. A non-array body (an empty envelope, say) is treated as
  // "no cases" rather than as a permanent loading state, so a thin response
  // can never leave the dashboard stuck on its spinner.
  const cases =
    query.data === undefined ? null : Array.isArray(query.data) ? query.data : [];

  const { refetch } = query;
  // Stable across renders so a caller can hand it straight to a refresh
  // control or an effect without re-arming on every render.
  const requestRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    cases,
    error: query.isError
      ? query.error instanceof Error && query.error.message
        ? query.error.message
        : "Failed to load cases."
      : null,
    // The first load has its own "Loading cases…" copy, so the pull-to-refresh
    // indicator is reserved for re-fetches over a list that is already up.
    isRefreshing: query.isFetching && !query.isPending,
    refetch: requestRefresh,
  };
}
