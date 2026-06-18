import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  BadgeCheck,
  Calendar,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  ExternalLink,
  FileText,
  History,
  Loader2,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Timer,
  TrendingUp,
  X,
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
  planType: "lab" | "provider" | null;
  billingInterval: "month" | "year" | null;
  stripePriceId: string | null;
  cancelAtPeriodEnd: boolean;
  hasStripeSubscription: boolean;
}

interface Plan {
  id: string;
  currency: string;
  unitAmount: number | null;
  interval: string | null;
  intervalCount: number | null;
  productName: string | null;
  productDescription: string | null;
  planType: "lab" | "provider" | null;
  nickname: string | null;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  description: string | null;
}

interface SubscriptionEvent {
  id: string;
  eventType: string;
  statusBefore: string | null;
  statusAfter: string | null;
  provider: string | null;
  createdAt: string;
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

const EVENT_LABELS: Record<string, string> = {
  trial_started: "Trial started",
  status_changed_to_trialing: "Status: trialing",
  status_changed_to_active: "Subscription activated",
  status_changed_to_past_due: "Payment failed",
  status_changed_to_grace: "Entered grace period",
  status_changed_to_locked: "Account locked",
  status_changed_to_canceled: "Subscription canceled",
  checkout_completed: "Checkout completed",
  invoice_payment_succeeded: "Payment succeeded",
  invoice_payment_failed: "Payment failed",
  stripe_subscription_updated: "Subscription updated",
  stripe_subscription_deleted: "Subscription deleted",
  plan_switched: "Plan changed",
  cancel_scheduled: "Cancellation scheduled",
  cancel_reversed: "Cancellation reversed",
  trial_reminder_sent: "Reminder sent",
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

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `$${(amount / 100).toFixed(2)}`;
  }
}

function planLabel(planType: string | null, interval: string | null): string {
  const type = planType === "lab" ? "Lab" : planType === "provider" ? "Provider" : null;
  const cycle = interval === "month" ? "Monthly" : interval === "year" ? "Annual" : null;
  if (type && cycle) return `${type} — ${cycle}`;
  if (type) return type;
  if (cycle) return cycle;
  return "LabTrax";
}

function groupPlansByType(plans: Plan[]): { lab: Plan[]; provider: Plan[] } {
  return {
    lab: plans.filter((p) => p.planType === "lab"),
    provider: plans.filter((p) => p.planType === "provider"),
  };
}

export default function BillingPage() {
  const qc = useQueryClient();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showSwitchPanel, setShowSwitchPanel] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<"invoices" | "history">("invoices");

  const { data, isLoading, error } = useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: () =>
      apiFetch<{ ok: boolean; entitlement: Entitlement }>("/billing/subscription"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const entitlement = data?.entitlement;
  const cfg = entitlement
    ? (STATUS_CONFIG[entitlement.status] ?? STATUS_CONFIG.legacy_free)
    : null;
  const StatusIcon = cfg?.icon ?? BadgeCheck;

  const { data: plansData } = useQuery({
    queryKey: ["billing", "plans"],
    queryFn: () =>
      apiFetch<{ ok: boolean; plans: Plan[] }>("/billing/plans"),
    staleTime: 60_000,
  });
  const plans = plansData?.plans ?? [];
  const grouped = groupPlansByType(plans);

  const { data: invoicesData, isLoading: invoicesLoading } = useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: () =>
      apiFetch<{ ok: boolean; invoices: StripeInvoice[] }>("/billing/invoices"),
    staleTime: 60_000,
    enabled: activeTab === "invoices",
  });
  const invoices = invoicesData?.invoices ?? [];

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ["billing", "history"],
    queryFn: () =>
      apiFetch<{ ok: boolean; events: SubscriptionEvent[] }>("/billing/history"),
    staleTime: 60_000,
    enabled: activeTab === "history",
  });
  const events = historyData?.events ?? [];

  const checkoutMutation = useMutation({
    mutationFn: async (priceId?: string) => {
      setCheckoutError(null);
      const body = priceId ? { priceId } : {};
      return apiFetch<{ ok: boolean; url: string }>("/billing/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: (result) => {
      if (result.url) window.open(result.url, "_blank");
    },
    onError: (err: any) => {
      setCheckoutError(err?.message ?? "Failed to start checkout");
    },
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      setPortalError(null);
      return apiFetch<{ ok: boolean; url: string }>("/billing/portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    },
    onSuccess: (result) => {
      if (result.url) window.open(result.url, "_blank");
    },
    onError: (err: any) => {
      setPortalError(err?.message ?? "Failed to open billing portal");
    },
  });

  const switchPlanMutation = useMutation({
    mutationFn: async (priceId: string) => {
      setSwitchError(null);
      return apiFetch<{ ok: boolean; message: string }>("/billing/switch-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
    },
    onSuccess: () => {
      setShowSwitchPanel(false);
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
      qc.invalidateQueries({ queryKey: ["billing", "history"] });
    },
    onError: (err: any) => {
      setSwitchError(err?.message ?? "Failed to switch plan");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (immediately: boolean) => {
      setCancelError(null);
      return apiFetch<{ ok: boolean; message: string }>("/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ immediately }),
      });
    },
    onSuccess: () => {
      setShowCancelConfirm(false);
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
      qc.invalidateQueries({ queryKey: ["billing", "history"] });
    },
    onError: (err: any) => {
      setCancelError(err?.message ?? "Failed to cancel subscription");
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      return apiFetch<{ ok: boolean; message: string }>("/billing/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
      qc.invalidateQueries({ queryKey: ["billing", "history"] });
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

  const canManage = entitlement?.status === "active" || entitlement?.status === "past_due";
  const canSwitchPlan = canManage && entitlement?.hasStripeSubscription;

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
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
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
              {entitlement.cancelAtPeriodEnd && entitlement.status === "active" && (
                <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full font-medium">
                  Cancels at period end
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
            <Calendar size={14} />
            <span>
              {entitlement.status === "active" && !entitlement.cancelAtPeriodEnd
                ? `Next renewal: ${fmtDate(entitlement.currentPeriodEnd)}`
                : entitlement.cancelAtPeriodEnd
                ? `Access until: ${fmtDate(entitlement.currentPeriodEnd)}`
                : `Period ends: ${fmtDate(entitlement.currentPeriodEnd)}`}
            </span>
          </div>
        )}
      </div>

      {/* Current plan summary */}
      {(entitlement.planType || entitlement.billingInterval) && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center gap-2">
            <TrendingUp size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium">Current Plan</span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground w-40">Plan</td>
                <td className="px-4 py-3 font-medium">
                  {planLabel(entitlement.planType, entitlement.billingInterval)}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground">Billing cycle</td>
                <td className="px-4 py-3">
                  {entitlement.billingInterval === "month"
                    ? "Monthly"
                    : entitlement.billingInterval === "year"
                    ? "Annual"
                    : "—"}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground">Payment method</td>
                <td className="px-4 py-3">
                  {entitlement.hasPaymentMethod ? (
                    <span className="text-emerald-600 font-medium flex items-center gap-1">
                      <CheckCircle2 size={14} /> On file
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
              </tr>
              {entitlement.status === "trialing" && entitlement.trialDaysRemaining !== null && (
                <tr className="border-b border-border">
                  <td className="px-4 py-3 text-muted-foreground">Trial ends</td>
                  <td className="px-4 py-3">
                    {entitlement.trialDaysRemaining > 0
                      ? `In ${entitlement.trialDaysRemaining} day${entitlement.trialDaysRemaining !== 1 ? "s" : ""}`
                      : "Today"}
                  </td>
                </tr>
              )}
              {entitlement.currentPeriodEnd && (
                <tr>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entitlement.status === "active" && !entitlement.cancelAtPeriodEnd
                      ? "Next renewal"
                      : "Period ends"}
                  </td>
                  <td className="px-4 py-3">{fmtDate(entitlement.currentPeriodEnd)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* No plan yet — details table */}
      {!entitlement.planType && !entitlement.billingInterval && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground font-medium w-40">Status</td>
                <td className="px-4 py-3 font-medium">{cfg?.label ?? entitlement.status}</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-3 text-muted-foreground font-medium">Payment method</td>
                <td className="px-4 py-3">
                  {entitlement.hasPaymentMethod ? (
                    <span className="text-emerald-600 font-medium flex items-center gap-1">
                      <CheckCircle2 size={14} /> On file
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
      )}

      {/* Checkout CTA — when payment is needed */}
      {needsPayment && (
        <div className="space-y-4">
          {plans.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Choose a plan</h2>
              {(["lab", "provider"] as const).map((type) => {
                const typePlans = grouped[type];
                if (typePlans.length === 0) return null;
                return (
                  <div key={type} className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-0.5">
                      {type === "lab" ? "Lab" : "Provider"}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {typePlans.map((plan) => {
                        const price =
                          plan.unitAmount != null
                            ? (plan.unitAmount / 100).toFixed(2)
                            : "—";
                        const interval =
                          plan.interval === "month"
                            ? "/mo"
                            : plan.interval === "year"
                            ? "/yr"
                            : "";
                        const isCurrentPlan = plan.id === entitlement.stripePriceId;
                        return (
                          <button
                            key={plan.id}
                            type="button"
                            disabled={checkoutMutation.isPending || isCurrentPlan}
                            onClick={() => checkoutMutation.mutate(plan.id)}
                            className={`flex flex-col gap-1 p-4 rounded-lg border transition-colors text-left ${
                              isCurrentPlan
                                ? "border-primary bg-primary/5 cursor-default"
                                : "border-border bg-card hover:border-primary hover:bg-primary/5 disabled:opacity-60 disabled:cursor-not-allowed"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">
                                {plan.productName ?? "LabTrax"}
                              </span>
                              {isCurrentPlan && (
                                <span className="text-xs text-primary font-medium">Current</span>
                              )}
                            </div>
                            <span className="text-xl font-bold text-foreground">
                              ${price}
                              <span className="text-sm font-normal text-muted-foreground">{interval}</span>
                            </span>
                            {plan.productDescription && (
                              <span className="text-xs text-muted-foreground leading-snug mt-0.5">
                                {plan.productDescription}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Coming Soon: Enterprise */}
              <div className="mt-2 p-4 rounded-lg border border-dashed border-border bg-muted/20">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Enterprise / Multi-location</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Volume pricing, dedicated support, and custom onboarding.
                    </p>
                  </div>
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                    Coming soon
                  </span>
                </div>
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

      {/* Active subscription actions */}
      {canManage && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Manage subscription</h2>
          <div className="flex flex-wrap gap-3">
            {/* Upgrade / Downgrade */}
            {canSwitchPlan && plans.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSwitchPanel((v) => !v)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-card hover:bg-secondary font-medium text-sm transition-colors"
              >
                <TrendingUp size={15} />
                Change Plan
                <ChevronDown size={14} className={`transition-transform ${showSwitchPanel ? "rotate-180" : ""}`} />
              </button>
            )}

            {/* Open Customer Portal */}
            <button
              type="button"
              disabled={portalMutation.isPending}
              onClick={() => portalMutation.mutate()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-card hover:bg-secondary font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {portalMutation.isPending ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <CreditCard size={15} />
              )}
              Billing Portal
              <ExternalLink size={12} className="text-muted-foreground" />
            </button>

            {/* Cancel or reactivate */}
            {entitlement.cancelAtPeriodEnd ? (
              <button
                type="button"
                disabled={reactivateMutation.isPending}
                onClick={() => reactivateMutation.mutate()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {reactivateMutation.isPending ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                Undo Cancellation
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowCancelConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-card hover:bg-destructive/5 hover:border-destructive/30 hover:text-destructive font-medium text-sm transition-colors text-muted-foreground"
              >
                <X size={15} />
                Cancel Plan
              </button>
            )}
          </div>
          {portalError && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle size={14} /> {portalError}
            </p>
          )}

          {/* Switch plan panel */}
          {showSwitchPanel && plans.length > 0 && (
            <div className="rounded-lg border border-border p-4 space-y-3 bg-card">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Switch plan</p>
                <button
                  type="button"
                  onClick={() => setShowSwitchPanel(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Prorations are calculated automatically. Your next invoice will reflect the change.
              </p>
              {(["lab", "provider"] as const).map((type) => {
                const typePlans = grouped[type];
                if (typePlans.length === 0) return null;
                return (
                  <div key={type} className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {type === "lab" ? "Lab" : "Provider"}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {typePlans.map((plan) => {
                        const price =
                          plan.unitAmount != null
                            ? fmtCurrency(plan.unitAmount, plan.currency)
                            : "—";
                        const interval =
                          plan.interval === "month" ? "/mo" : plan.interval === "year" ? "/yr" : "";
                        const isCurrent = plan.id === entitlement.stripePriceId;
                        return (
                          <button
                            key={plan.id}
                            type="button"
                            disabled={isCurrent || switchPlanMutation.isPending}
                            onClick={() => switchPlanMutation.mutate(plan.id)}
                            className={`flex items-center justify-between p-3 rounded-lg border text-sm transition-colors ${
                              isCurrent
                                ? "border-primary/40 bg-primary/5 cursor-default"
                                : "border-border hover:border-primary hover:bg-primary/5 disabled:opacity-60"
                            }`}
                          >
                            <span className="font-medium">
                              {plan.productName ?? "LabTrax"}
                              <span className="font-normal text-muted-foreground ml-1 text-xs">
                                {plan.interval === "month" ? "Monthly" : "Annual"}
                              </span>
                            </span>
                            {isCurrent ? (
                              <span className="text-xs text-primary font-medium">Current</span>
                            ) : switchPlanMutation.isPending ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {price}{interval}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {switchError && (
                <p className="text-sm text-destructive flex items-center gap-1.5">
                  <AlertCircle size={13} /> {switchError}
                </p>
              )}
            </div>
          )}

          {/* Cancel confirm */}
          {showCancelConfirm && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 space-y-3">
              <p className="text-sm font-medium text-destructive">Cancel your subscription?</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your subscription will remain active until{" "}
                <strong>{fmtDate(entitlement.currentPeriodEnd)}</strong>. After that, you'll enter a
                grace period before your account is locked.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60"
                >
                  {cancelMutation.isPending ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : null}
                  Cancel at period end
                </button>
                <button
                  type="button"
                  disabled={cancelMutation.isPending}
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-3 py-1.5 rounded border border-border bg-card text-sm hover:bg-secondary"
                >
                  Keep subscription
                </button>
              </div>
              {cancelError && (
                <p className="text-sm text-destructive flex items-center gap-1.5">
                  <AlertCircle size={13} /> {cancelError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tabs: Invoices / History */}
      {(entitlement.status !== "legacy_free") && (
        <div className="space-y-0">
          <div className="flex border-b border-border">
            {(["invoices", "history"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  activeTab === tab
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab === "invoices" ? (
                  <><FileText size={14} /> Invoices</>
                ) : (
                  <><History size={14} /> History</>
                )}
              </button>
            ))}
          </div>

          {/* Invoices tab */}
          {activeTab === "invoices" && (
            <div className="pt-4">
              {invoicesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="animate-spin text-muted-foreground" size={22} />
                </div>
              ) : invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No invoices yet.</p>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/30 border-b border-border">
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Invoice</th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Date</th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Amount</th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Status</th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv) => (
                        <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            {inv.number ?? inv.id.slice(-8)}
                          </td>
                          <td className="px-4 py-3">{fmtShortDate(inv.createdAt)}</td>
                          <td className="px-4 py-3 font-medium">
                            {fmtCurrency(inv.amountPaid, inv.currency)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                                inv.status === "paid"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : inv.status === "open"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-zinc-100 text-zinc-600"
                              }`}
                            >
                              {inv.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {inv.hostedInvoiceUrl && (
                              <a
                                href={inv.hostedInvoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                                title="View invoice"
                              >
                                <ExternalLink size={13} />
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* History tab */}
          {activeTab === "history" && (
            <div className="pt-4">
              {historyLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="animate-spin text-muted-foreground" size={22} />
                </div>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No history yet.</p>
              ) : (
                <div className="space-y-0">
                  {events.map((ev, idx) => (
                    <div
                      key={ev.id}
                      className={`flex items-start gap-3 py-3 ${idx !== events.length - 1 ? "border-b border-border" : ""}`}
                    >
                      <div className="w-2 h-2 rounded-full bg-border mt-1.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          {EVENT_LABELS[ev.eventType] ?? ev.eventType}
                        </p>
                        {(ev.statusBefore || ev.statusAfter) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {ev.statusBefore && <span>{ev.statusBefore}</span>}
                            {ev.statusBefore && ev.statusAfter && (
                              <span className="mx-1">→</span>
                            )}
                            {ev.statusAfter && <span>{ev.statusAfter}</span>}
                          </p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {fmtShortDate(ev.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
