import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  BadgeCheck,
  CreditCard,
  Loader2,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Timer,
  Zap,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Entitlement {
  status:
    | "trialing"
    | "active"
    | "past_due"
    | "grace"
    | "locked"
    | "canceled"
    | "legacy_free";
  accessLevel: "full" | "read_only" | "locked";
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  hasPaymentMethod: boolean;
  subjectType: string;
  subjectId: string;
  subscriptionId: string | null;
}

type StatusConfig = {
  label: string;
  icon: typeof BadgeCheck;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  description: string;
};

const STATUS_CONFIG: Record<string, StatusConfig> = {
  trialing: {
    label: "Free Trial",
    icon: Timer,
    iconColor: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    description: "You're on a free trial. Add a payment method to keep your access after the trial ends.",
  },
  active: {
    label: "Active",
    icon: BadgeCheck,
    iconColor: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
    description: "Your subscription is active and in good standing.",
  },
  past_due: {
    label: "Payment Issue",
    icon: AlertCircle,
    iconColor: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-200",
    description: "Your last payment failed. Please update your payment method to avoid losing access.",
  },
  grace: {
    label: "Grace Period",
    icon: ShieldAlert,
    iconColor: "text-orange-600",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-200",
    description: "Your trial has ended. You have read-only access during the grace period. Add a payment method to restore full access.",
  },
  locked: {
    label: "Locked",
    icon: Lock,
    iconColor: "text-red-600",
    bgColor: "bg-red-50",
    borderColor: "border-red-200",
    description: "Your account has been locked. Please subscribe to restore access to your data.",
  },
  canceled: {
    label: "Canceled",
    icon: RefreshCcw,
    iconColor: "text-zinc-500",
    bgColor: "bg-zinc-50",
    borderColor: "border-zinc-200",
    description: "Your subscription has been canceled. Subscribe again to restore access.",
  },
  legacy_free: {
    label: "Legacy Access",
    icon: Zap,
    iconColor: "text-purple-600",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-200",
    description: "You have legacy free access. Subscription billing does not apply to your account.",
  },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export default function BillingPage() {
  const qc = useQueryClient();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: () => apiFetch<{ ok: boolean; entitlement: Entitlement }>("/billing/subscription"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const entitlement = data?.entitlement;
  const cfg = entitlement ? (STATUS_CONFIG[entitlement.status] ?? STATUS_CONFIG.legacy_free) : null;
  const StatusIcon = cfg?.icon ?? BadgeCheck;

  const { data: plansData } = useQuery({
    queryKey: ["billing", "plans"],
    queryFn: () => apiFetch<{ ok: boolean; plans: Array<{ id: string; currency: string; unitAmount: number | null; interval: string | null; intervalCount: number | null; productName: string | null }> }>("/billing/plans"),
    staleTime: 60_000,
  });
  const plans = plansData?.plans ?? [];

  const checkoutMutation = useMutation({
    mutationFn: async (priceId?: string) => {
      setCheckoutError(null);
      const body = priceId ? { priceId } : {};
      const result = await apiFetch<{ ok: boolean; url: string }>("/billing/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return result;
    },
    onSuccess: (result) => {
      if (result.url) {
        window.open(result.url, "_blank");
      }
    },
    onError: (err: any) => {
      setCheckoutError(err?.message ?? "Failed to start checkout");
    },
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      setPortalError(null);
      const result = await apiFetch<{ ok: boolean; url: string }>("/billing/portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      return result;
    },
    onSuccess: (result) => {
      if (result.url) {
        window.open(result.url, "_blank");
      }
    },
    onError: (err: any) => {
      setPortalError(err?.message ?? "Failed to open billing portal");
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
    }
  }, [qc]);

  const needsPayment =
    entitlement?.status === "trialing" ||
    entitlement?.status === "grace" ||
    entitlement?.status === "locked" ||
    entitlement?.status === "past_due" ||
    entitlement?.status === "canceled";

  const canManage =
    entitlement?.status === "active" ||
    entitlement?.status === "past_due";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
      </div>
    );
  }

  if (error || !entitlement) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 p-4 bg-destructive/10 text-destructive rounded-lg">
          <AlertCircle size={20} />
          <span className="text-sm">Failed to load billing information. Please refresh the page.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subscription &amp; Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your LabTrax subscription and payment method.
        </p>
      </div>

      {/* Status card */}
      <div
        className={`rounded-xl border p-6 ${cfg?.bgColor ?? "bg-card"} ${cfg?.borderColor ?? "border-border"}`}
      >
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-full bg-white/80 shadow-sm ${cfg?.iconColor ?? ""}`}>
            <StatusIcon size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold">{cfg?.label ?? entitlement.status}</span>
              {entitlement.status === "trialing" && entitlement.trialDaysRemaining !== null && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                  {entitlement.trialDaysRemaining} day{entitlement.trialDaysRemaining !== 1 ? "s" : ""} left
                </span>
              )}
              {entitlement.status === "grace" && entitlement.graceDaysRemaining !== null && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                  {entitlement.graceDaysRemaining} day{entitlement.graceDaysRemaining !== 1 ? "s" : ""} of read-only left
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              {cfg?.description ?? ""}
            </p>
          </div>
        </div>

        {entitlement.currentPeriodEnd && (
          <div className="mt-4 pt-4 border-t border-black/10 flex items-center gap-2 text-sm text-muted-foreground">
            <CreditCard size={14} />
            <span>
              {entitlement.status === "active"
                ? `Next renewal: ${fmtDate(entitlement.currentPeriodEnd)}`
                : `Period ends: ${fmtDate(entitlement.currentPeriodEnd)}`}
            </span>
          </div>
        )}
      </div>

      {/* CTA area */}
      {needsPayment && (
        <div className="space-y-4">
          {plans.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Choose a plan</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {plans.map((plan) => {
                  const price = plan.unitAmount != null ? (plan.unitAmount / 100).toFixed(2) : "—";
                  const interval = plan.interval === "month" ? "/mo" : plan.interval === "year" ? "/yr" : "";
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      disabled={checkoutMutation.isPending}
                      onClick={() => checkoutMutation.mutate(plan.id)}
                      className="flex flex-col gap-1 p-4 rounded-lg border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors text-left disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <span className="text-sm font-medium">
                        {plan.productName ?? "LabTrax Pro"}
                      </span>
                      <span className="text-xl font-bold text-foreground">
                        ${price}
                        <span className="text-sm font-normal text-muted-foreground">{interval}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={checkoutMutation.isPending}
              onClick={() => checkoutMutation.mutate(undefined)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {checkoutMutation.isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUpRight size={16} />
              )}
              {entitlement.status === "locked" || entitlement.status === "canceled"
                ? "Reactivate Subscription"
                : "Start Subscription"}
            </button>
          )}
          {checkoutError && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle size={14} />
              {checkoutError}
            </p>
          )}
        </div>
      )}

      {canManage && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Manage subscription</h2>
          <button
            type="button"
            disabled={portalMutation.isPending}
            onClick={() => portalMutation.mutate()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border bg-card hover:bg-secondary font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {portalMutation.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <CreditCard size={16} />
            )}
            Open Customer Portal
          </button>
          {portalError && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle size={14} />
              {portalError}
            </p>
          )}
        </div>
      )}

      {/* Details table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-3 text-muted-foreground font-medium w-40">Status</td>
              <td className="px-4 py-3 font-medium">
                {cfg?.label ?? entitlement.status}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-3 text-muted-foreground font-medium">Payment method</td>
              <td className="px-4 py-3">
                {entitlement.hasPaymentMethod ? (
                  <span className="text-emerald-600 font-medium flex items-center gap-1">
                    <BadgeCheck size={14} /> On file
                  </span>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </td>
            </tr>
            {entitlement.status === "trialing" && entitlement.trialDaysRemaining !== null && (
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground font-medium">Trial ends</td>
                <td className="px-4 py-3">
                  {entitlement.trialDaysRemaining > 0
                    ? `In ${entitlement.trialDaysRemaining} day${entitlement.trialDaysRemaining !== 1 ? "s" : ""}`
                    : "Today"}
                </td>
              </tr>
            )}
            {entitlement.currentPeriodEnd && (
              <tr>
                <td className="px-4 py-3 text-muted-foreground font-medium">
                  {entitlement.status === "active" ? "Next renewal" : "Period end"}
                </td>
                <td className="px-4 py-3">{fmtDate(entitlement.currentPeriodEnd)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
