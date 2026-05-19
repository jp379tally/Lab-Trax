import { useState, useEffect, useCallback, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { resilientFetch } from "./query-client";

export type AccessLevel = "full" | "read_only" | "locked";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "locked"
  | "canceled"
  | "legacy_free";

export interface Entitlement {
  status: SubscriptionStatus;
  accessLevel: AccessLevel;
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  hasPaymentMethod: boolean;
  subjectType: string;
  subjectId: string;
  subscriptionId: string | null;
}

interface UseEntitlementResult {
  entitlement: Entitlement | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function useEntitlement(isAuthenticated: boolean): UseEntitlementResult {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const resp = await resilientFetch("/api/billing/subscription");
      if (resp.ok) {
        const json = await resp.json().catch(() => ({}));
        if (json?.entitlement) {
          setEntitlement(json.entitlement as Entitlement);
        }
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setEntitlement(null);
      return;
    }

    refresh();

    intervalRef.current = setInterval(refresh, POLL_INTERVAL_MS);

    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (
        appStateRef.current.match(/inactive|background/) &&
        next === "active"
      ) {
        refresh();
      }
      appStateRef.current = next;
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      sub.remove();
    };
  }, [isAuthenticated, refresh]);

  return { entitlement, loading, refresh };
}
