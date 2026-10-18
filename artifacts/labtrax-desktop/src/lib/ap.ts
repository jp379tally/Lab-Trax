import { useQuery } from "@tanstack/react-query";
import type { TransactionCategory, Vendor } from "@workspace/api-client-react";
import { apiFetch } from "./api";

/** Today as YYYY-MM-DD in the browser's local zone. */
export function todayIsoDate(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * The browser's IANA zone, sent with dated reports so the server can resolve
 * a bare `YYYY-MM-DD` to the end of that day where the user actually is.
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `days` from today as YYYY-MM-DD in the browser's local zone. */
export function isoDateFromToday(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * Payees usable on a bill. Inactive ones are included so historical records
 * stay readable; the bill form labels them rather than hiding them.
 */
export function useApVendors(organizationId: string) {
  return useQuery({
    queryKey: ["finance", "vendors", organizationId, "ap"],
    queryFn: () =>
      apiFetch<Vendor[]>(
        `/finance/vendors?organizationId=${organizationId}&includeInactive=true`,
      ),
    enabled: !!organizationId,
  });
}

export function useApCategories(organizationId: string) {
  return useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<TransactionCategory[]>(
        `/finance/categories?organizationId=${organizationId}`,
      ),
    enabled: !!organizationId,
  });
}

/** A stable per-submission key so a double-click cannot pay twice. */
export function newIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
