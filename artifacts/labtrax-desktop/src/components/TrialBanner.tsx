import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, X, Zap } from "lucide-react";

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

function formatBillingDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
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
 * Shows "30-Day Free Trial Active — XX Days Remaining" during trial,
 * and "Subscription Active — Next Billing Date: MM/DD/YYYY" when active.
 */
export function DashboardSubscriptionBanner() {
  const { data } = useSubscription();
  const entitlement = data?.entitlement;

  if (!entitlement) return null;

  const { status, trialDaysRemaining, currentPeriodEnd } = entitlement;

  if (status === "trialing") {
    const days = trialDaysRemaining ?? 0;
    return (
      <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-sm">
        <Zap size={15} className="shrink-0 text-blue-500 dark:text-blue-400" />
        <span className="text-blue-800 dark:text-blue-200 font-medium">
          30-Day Free Trial Active &mdash; {days} Day{days !== 1 ? "s" : ""}{" "}
          Remaining
        </span>
        <Link
          href="/billing"
          className="ml-auto text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:opacity-80 shrink-0"
        >
          Manage →
        </Link>
      </div>
    );
  }

  if (status === "active") {
    const billingDate = formatBillingDate(currentPeriodEnd);
    return (
      <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-sm">
        <CheckCircle2 size={15} className="shrink-0 text-green-600 dark:text-green-400" />
        <span className="text-green-800 dark:text-green-200 font-medium">
          Subscription Active
          {billingDate ? ` \u2014 Next Billing Date: ${billingDate}` : ""}
        </span>
      </div>
    );
  }

  return null;
}
