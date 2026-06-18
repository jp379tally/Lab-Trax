import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { AlertTriangle, X, Zap } from "lucide-react";

interface Entitlement {
  status: string;
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  hasPaymentMethod: boolean;
}

interface SubscriptionResponse {
  ok: boolean;
  entitlement: Entitlement;
}


function useSubscription() {
  return useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: () => apiFetch<SubscriptionResponse>("/billing/subscription"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * TrialBanner — surfaces on the cases list and dashboard.
 * Shows at ≤7 days (info) or ≤3 days (warning) remaining in the trial,
 * and a hard "Subscription Required" block when expired/locked.
 * Hidden once the subscription is active or for legacy-free accounts.
 */
export function TrialBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data } = useSubscription();
  const entitlement = data?.entitlement;

  if (dismissed || !entitlement) return null;

  const { status, trialDaysRemaining } = entitlement;

  if (status === "active" || status === "legacy_free") return null;

  if (status === "locked" || status === "canceled") {
    return (
      <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="flex-1 font-medium text-destructive">
          Subscription Required
        </span>
        <Link href="/billing">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 transition-colors cursor-pointer">
            <Zap size={12} />
            Upgrade Now
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (status === "grace") {
    return (
      <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="flex-1 font-medium text-destructive">
          Subscription Required
        </span>
        <Link href="/billing">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 transition-colors cursor-pointer">
            <Zap size={12} />
            Upgrade Now
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (status === "trialing" && trialDaysRemaining !== null) {
    if (trialDaysRemaining <= 0) {
      return (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <span className="flex-1 font-medium text-destructive">
            Subscription Required
          </span>
          <Link href="/billing">
            <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 transition-colors cursor-pointer">
              <Zap size={12} />
              Upgrade Now
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      );
    }

    if (trialDaysRemaining <= 3) {
      return (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1 text-amber-800 dark:text-amber-200">
            Your trial expires in{" "}
            <strong>
              {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
            </strong>
            . Add billing information to avoid interruption.{" "}
            <Link
              href="/billing"
              className="underline underline-offset-2 hover:opacity-80 font-medium"
            >
              Add now →
            </Link>
          </span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      );
    }

    if (trialDaysRemaining <= 7) {
      return (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-sm">
          <Zap size={15} className="shrink-0 text-blue-500 dark:text-blue-400" />
          <span className="flex-1 text-blue-800 dark:text-blue-200">
            Your free trial expires in{" "}
            <strong>
              {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
            </strong>
            .{" "}
            <Link
              href="/billing"
              className="underline underline-offset-2 hover:opacity-80"
            >
              View subscription →
            </Link>
          </span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      );
    }
  }

  return null;
}

/**
 * DashboardSubscriptionBanner — shown at the top of the dashboard.
 *
 * - trialing: "30-Day Free Trial — X Days Remaining" with "Choose a plan" CTA (dismissible per-session)
 * - grace / trialing-expired: amber urgency with "Choose a plan" CTA (dismissible per-session)
 * - locked / canceled: red urgency with "Upgrade Now" CTA (dismissible per-session)
 * - past_due: amber urgency with "Update Billing" CTA (dismissible per-session)
 * - active / legacy_free: suppressed (null)
 */
export function DashboardSubscriptionBanner() {
  const DISMISS_KEY = "labtrax_dashboard_sub_banner_dismissed";
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const { data } = useSubscription();
  const entitlement = data?.entitlement;

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  if (dismissed || !entitlement) return null;

  const { status, trialDaysRemaining } = entitlement;

  if (status === "active" || status === "legacy_free") return null;

  if (status === "locked" || status === "canceled") {
    return (
      <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="flex-1 font-medium text-destructive">
          Account locked — a subscription is required to continue using LabTrax.
        </span>
        <Link href="/billing">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 transition-colors cursor-pointer shrink-0">
            <Zap size={12} />
            Upgrade Now
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (status === "grace") {
    return (
      <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 text-sm">
        <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="flex-1 font-medium text-amber-800 dark:text-amber-200">
          Your trial has ended. Choose a plan to keep full access before your account is locked.
        </span>
        <Link href="/billing">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition-colors cursor-pointer shrink-0">
            <Zap size={12} />
            Choose a plan
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (status === "past_due") {
    return (
      <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 text-sm">
        <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="flex-1 font-medium text-amber-800 dark:text-amber-200">
          Your last payment failed. Update your billing information to avoid losing access.
        </span>
        <Link href="/billing">
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition-colors cursor-pointer shrink-0">
            Update Billing
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (status === "trialing") {
    const days = trialDaysRemaining ?? 0;

    if (days <= 0) {
      return (
        <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1 font-medium text-amber-800 dark:text-amber-200">
            Your trial has ended. Choose a plan to keep full access before your account is locked.
          </span>
          <Link href="/billing">
            <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition-colors cursor-pointer shrink-0">
              <Zap size={12} />
              Choose a plan
            </span>
          </Link>
          <button
            type="button"
            onClick={dismiss}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      );
    }

    const urgency = days <= 3;
    return (
      <div
        className={
          urgency
            ? "mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 text-sm"
            : "mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-sm"
        }
      >
        {urgency ? (
          <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <Zap size={15} className="shrink-0 text-blue-500 dark:text-blue-400" />
        )}
        <span
          className={
            urgency
              ? "flex-1 font-medium text-amber-800 dark:text-amber-200"
              : "flex-1 font-medium text-blue-800 dark:text-blue-200"
          }
        >
          30-Day Free Trial &mdash;{" "}
          <strong>
            {days} day{days !== 1 ? "s" : ""} remaining
          </strong>
          {urgency ? ". Add a plan before your account is locked." : "."}
        </span>
        <Link href="/billing">
          <span
            className={
              urgency
                ? "inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition-colors cursor-pointer shrink-0"
                : "inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors cursor-pointer shrink-0"
            }
          >
            <Zap size={12} />
            Choose a plan
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return null;
}
