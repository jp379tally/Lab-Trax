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
  /**
   * Poll aggressively (every 3 s for up to 30 s) after a purchase or
   * restore. Resolves as soon as the entitlement clears to a non-locked /
   * non-read_only level, or after the 30-second window elapses.
   * The caller should keep the paywall hidden for the entire duration of
   * this promise so users never see a stale "still locked" flash.
   */
  startAggressivePoll: () => Promise<void>;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const AGGRESSIVE_POLL_INTERVAL_MS = 3_000;
const AGGRESSIVE_POLL_DURATION_MS = 30_000;

export function useEntitlement(isAuthenticated: boolean): UseEntitlementResult {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aggressivePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const entitlementRef = useRef<Entitlement | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    entitlementRef.current = entitlement;
  }, [entitlement]);

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

  const stopAggressivePoll = useCallback(() => {
    if (aggressivePollRef.current) {
      clearInterval(aggressivePollRef.current);
      aggressivePollRef.current = null;
    }
  }, []);

  const startAggressivePoll = useCallback((): Promise<void> => {
    stopAggressivePoll();
    return new Promise<void>((resolve) => {
      const endTime = Date.now() + AGGRESSIVE_POLL_DURATION_MS;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        stopAggressivePoll();
        resolve();
      };

      const attempt = async () => {
        if (settled) return;
        if (Date.now() >= endTime) {
          finish();
          return;
        }
        await refresh();
        const curr = entitlementRef.current;
        if (
          curr &&
          curr.accessLevel !== "locked" &&
          curr.accessLevel !== "read_only"
        ) {
          finish();
        }
      };

      attempt();
      aggressivePollRef.current = setInterval(attempt, AGGRESSIVE_POLL_INTERVAL_MS);
    });
  }, [refresh, stopAggressivePoll]);

  useEffect(() => {
    if (!isAuthenticated) {
      setEntitlement(null);
      stopAggressivePoll();
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
      stopAggressivePoll();
      sub.remove();
    };
  }, [isAuthenticated, refresh, stopAggressivePoll]);

  return { entitlement, loading, refresh, startAggressivePoll };
}
