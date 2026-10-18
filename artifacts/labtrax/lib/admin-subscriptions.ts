import type { CreatorSubscriptionSummary } from "@workspace/api-client-react";
import { queryClient, resilientFetch } from "@/lib/query-client";

export const ADMIN_SUBSCRIPTIONS_QUERY_KEY = ["admin", "provider-subscriptions"] as const;
export const SUBSCRIPTION_STATUSES = [
  "trialing", "active", "past_due", "grace", "locked", "canceled", "legacy_free",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface ProviderPlan {
  id: string;
  monthlyPriceUsd: number;
  capabilities: string[];
}

export interface AdminSubscription {
  id: string;
  subjectType: string;
  subjectId: string;
  accountHolderName: string;
  accountType: "Provider" | "Lab" | null;
  canonicalAccountNumber: string | null;
  /** Server-formatted provider/practice address; null for older records. */
  formattedAddress: string | null;
  organization?: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
  canonicalSubjectType: string;
  provider: string;
  providerPlan: string | null;
  monthlyPriceUsd: number | null;
  status: SubscriptionStatus;
  waiverReason: string | null;
  waiverStartsAt: string | null;
  waiverEndsAt: string | null;
  waiverActive: boolean;
  currentPeriodEnd: string | null;
  trialEndAt: string | null;
  canceledAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionDirectory {
  items: AdminSubscription[];
  summary?: CreatorSubscriptionSummary;
  total: number;
  plans: ProviderPlan[];
}

export interface SubscriptionHistory {
  events: Array<{
    id: string;
    eventType: string;
    statusBefore?: string | null;
    statusAfter?: string | null;
    createdAt: string;
  }>;
  audits: Array<{ id: string; action: string; createdAt: string }>;
}

export class AdminSubscriptionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit) {
  const res = await resilientFetch(path, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403) void queryClient.invalidateQueries({ queryKey: ["creator", "access"] });
    throw new AdminSubscriptionError(
      (body as { error?: string }).error || (res.status === 403
        ? "Unlock the Creator console to manage subscriptions."
        : `Request failed (${res.status}).`),
      res.status,
    );
  }
  return body;
}

export async function getAdminSubscriptions(filters: {
  q?: string;
  status?: string;
  plan?: string;
} = {}): Promise<SubscriptionDirectory> {
  const items: AdminSubscription[] = [];
  let summary: CreatorSubscriptionSummary | undefined;
  let offset = 0;
  let total = 0;
  let plans: ProviderPlan[] = [];
  do {
    const params = new URLSearchParams({ limit: "100", offset: String(offset) });
    // Search is intentionally applied after all pages are loaded. The server's
    // current q filter runs after pagination and can otherwise miss older accounts.
    if (filters.status) params.set("status", filters.status);
    if (filters.plan) params.set("plan", filters.plan);
    const body = await request(`/api/admin/provider-subscriptions?${params.toString()}`) as Partial<SubscriptionDirectory>;
    const page = Array.isArray(body.items) ? body.items : [];
    items.push(...page);
    total = Number(body.total ?? page.length);
    if (!summary && body.summary) summary = body.summary;
    plans = Array.isArray(body.plans) ? body.plans : plans;
    offset += page.length;
    if (page.length === 0) break;
  } while (offset < total);
  const needle = filters.q?.trim().toLowerCase();
  const filtered = needle
    ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle))
    : items;
  return {
    items: filtered,
    summary,
    total: filtered.length,
    plans,
  };
}

export async function getAdminSubscriptionHistory(id: string): Promise<SubscriptionHistory> {
  const body = await request(`/api/admin/provider-subscriptions/${encodeURIComponent(id)}/history`) as Partial<SubscriptionHistory>;
  return {
    events: Array.isArray(body.events) ? body.events : [],
    audits: Array.isArray(body.audits) ? body.audits : [],
  };
}

export async function updateAdminSubscription(id: string, changes: { providerPlan?: string; status?: string }) {
  return request(`/api/admin/provider-subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(changes),
  });
}

export async function correctAdminSubscriptionAccountNumber(id: string, accountNumber: string) {
  return request(`/api/admin/provider-subscriptions/${encodeURIComponent(id)}/account-number`, {
    method: "PATCH", body: JSON.stringify({ accountNumber }),
  });
}

export async function saveAdminSubscriptionWaiver(
  id: string,
  waiver: { reason: string; startsAt?: string; endsAt?: string | null },
) {
  return request(`/api/admin/provider-subscriptions/${encodeURIComponent(id)}/waiver`, {
    method: "PUT", body: JSON.stringify(waiver),
  });
}

export async function endAdminSubscriptionWaiver(id: string) {
  return request(`/api/admin/provider-subscriptions/${encodeURIComponent(id)}/waiver`, {
    method: "DELETE",
  });
}

export function subscriptionAccessLabel(subscription: Pick<AdminSubscription, "status" | "waiverActive" | "waiverEndsAt">) {
  if (subscription.waiverActive) return subscription.waiverEndsAt ? "Waived" : "Waived indefinitely";
  const labels: Record<SubscriptionStatus, string> = {
    trialing: "Trial", active: "Paid", past_due: "Past due", grace: "In grace",
    locked: "Locked", canceled: "Canceled", legacy_free: "Legacy free",
  };
  return labels[subscription.status] ?? subscription.status;
}

export function parseFutureWaiverEnd(value: string, now = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed <= now
  ) return null;
  return parsed.toISOString();
}