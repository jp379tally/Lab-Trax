import { useQuery } from "@tanstack/react-query";
import { queryClient, resilientFetch } from "@/lib/query-client";
import { useAuth } from "@/lib/auth-context";

import type { CreatorAccess } from "@workspace/api-client-react";
export type { CreatorAccess };
/** Minor-unit aware formatting: digits come from Intl (JPY 0, USD 2, KWD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch { return 2; }
}
export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}
export function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorToMajor(minor, currency));
  } catch { return `${minorToMajor(minor, currency)} ${currency}`; }
}

export const CREATOR_ACCESS_KEY = ["creator", "access"] as const;
export const creatorAccessKey = (userId: string | number | null | undefined) =>
  ["creator", "access", userId ?? "anon"] as const;
export const CREATOR_SETUP_MESSAGE =
  "The Creator PIN has not been provisioned. It is set securely on the server (CREATOR_INITIAL_PIN) and cannot be created from this app. Contact the platform operator, then reopen this screen.";

export class CreatorApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
  }
}
export const CREATOR_PIN_LENGTH = 7;

export async function creatorJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await resilientFetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    // Expired or revoked unlock: re-read capability immediately so the gate re-locks.
    if (res.status === 403 && path !== "/creator/access") {
      void queryClient.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
    }
    const retry = Number(res.headers?.get?.("Retry-After"));
    throw new CreatorApiError(data.error || data.message || `Request failed (${res.status}).`, res.status, retry > 0 ? retry : undefined);
  }
  return data as T;
}

export function useCreatorAccess() {
  const { currentUserId, isAuthenticated } = useAuth();
  return useQuery<CreatorAccess>({
    queryKey: creatorAccessKey(currentUserId),
    enabled: isAuthenticated,
    queryFn: () => creatorJson<CreatorAccess>("GET", "/creator/access"),
    retry: false,
    staleTime: 30_000,
  });
}

export function creatorErrorMessage(err: unknown): string {
  if (err instanceof CreatorApiError && err.status === 429) {
    const r = err.retryAfter;
    return `Too many attempts. ${r ? `Try again in ${r >= 60 ? Math.ceil(r / 60) + " min" : r + " sec"}.` : "Wait a while before trying again."}`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
