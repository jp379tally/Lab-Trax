import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth-context";
import ProviderPlanChoices from "./ProviderPlanChoices";
import type { ProviderSignupTier } from "@workspace/api-client-react";

interface Entitlement {
  status: string;
  accessLevel?: string;
  planType: "lab" | "provider" | null;
  subjectType?: string | null;
  subjectId?: string | null;
  providerPlan?: ProviderSignupTier | null;
  reuseSubscriptionCard?: boolean;
}

interface Plan {
  id: string;
  currency: string;
  unitAmount: number | null;
  interval: string | null;
  productName: string | null;
  productDescription: string | null;
  planType: "lab" | "provider" | null;
}

const DECISION_KEY_PREFIX = "labtrax_read_only_decision_v1";

function decisionKey(userId: string, entitlement: Entitlement): string {
  const subject = `${entitlement.subjectType ?? "account"}:${entitlement.subjectId ?? "default"}`;
  return `${DECISION_KEY_PREFIX}:${userId}:${subject}`;
}

function groupPlans(plans: Plan[]): { lab: Plan[]; provider: Plan[] } {
  return {
    lab: plans.filter((p) => p.planType === "lab"),
    provider: plans.filter((p) => p.planType === "provider"),
  };
}

export default function PlanPickerOnboarding() {
  const { user } = useAuth();
  const [entitlement, setEntitlement] = useState<Entitlement | null | "loading">("loading");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansFailed, setPlansFailed] = useState(false);
  const [trialDismissed, setTrialDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("labtrax_plan_picker_skipped_v1") === "1";
    } catch {
      return false;
    }
  });
  const [decision, setDecision] = useState<"undecided" | "renew" | "declined">("undecided");
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [selectedProviderPlan, setSelectedProviderPlan] = useState<ProviderSignupTier | null>(null);
  const [reuseCard, setReuseCard] = useState(false);
  const providerPending = entitlement !== "loading" && entitlement?.status === "onboarding_pending";

  useEffect(() => {
    if (!providerPending || !user) return;
    setSelectedProviderPlan((current) => current ?? entitlement?.providerPlan ?? null);
    setReuseCard(entitlement?.reuseSubscriptionCard === true);
    const refresh = () => {
      void apiFetch<{ entitlement: Entitlement }>("/billing/subscription")
        .then((r) => setEntitlement(r.entitlement))
        .catch((err: Error) => setCheckoutError(err.message));
    };
    window.addEventListener("focus", refresh);
    const interval = setInterval(refresh, 10_000);
    return () => { window.removeEventListener("focus", refresh); clearInterval(interval); };
    // Initialize consent once on entering the resumable signup, not every poll.
  }, [providerPending, user?.id]);

  useEffect(() => {
    apiFetch<{ ok: boolean; entitlement: Entitlement }>("/billing/subscription")
      .then((r) => setEntitlement(r.entitlement))
      .catch(() => setEntitlement(null));
  }, []);

  useEffect(() => {
    if (!user || !entitlement || entitlement === "loading") return;
    try {
      setDecision(localStorage.getItem(decisionKey(user.id, entitlement)) === "declined" ? "declined" : "undecided");
    } catch {
      setDecision("undecided");
    }
  }, [user, entitlement]);

  const isDeactivated =
    entitlement !== "loading" &&
    entitlement !== null &&
    entitlement.status !== "free" && !providerPending &&
    (entitlement.status === "deactivated" ||
      entitlement.accessLevel === "read_only");
  const showDecision = !!user && isDeactivated && decision === "undecided";
  const showPicker =
    !!user &&
    ((isDeactivated && decision === "renew") ||
    !trialDismissed &&
    entitlement !== "loading" &&
    entitlement !== null &&
    entitlement.planType === null &&
    entitlement.status === "trialing");

  useEffect(() => {
    if (!showPicker || plans.length > 0 || plansFailed) return;
    setPlansLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    apiFetch<{ ok: boolean; plans: Plan[] }>("/billing/plans", { signal: controller.signal })
      .then((r) => setPlans(r.plans ?? []))
      .catch(() => {
        setPlans([]);
        setPlansFailed(true);
      })
      .finally(() => {
        clearTimeout(timer);
        setPlansLoading(false);
      });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Loading is set inside this effect; depending on it would immediately
    // clean up and abort the in-flight request on the next render.
  }, [showPicker, plans.length, plansFailed]);

  async function decline() {
    if (isDeactivated) {
      try {
        const result = await apiFetch<{
          status: string;
          accessLevel: string;
        }>("/billing/decline-renewal", { method: "POST" });
        setEntitlement((current) =>
          current && current !== "loading"
            ? { ...current, status: result.status, accessLevel: result.accessLevel }
            : current,
        );
      } catch (err: unknown) {
        setCheckoutError(
          (err as Error)?.message ?? "Could not save your renewal decision.",
        );
        return;
      }
    }
    try {
      if (user && entitlement && entitlement !== "loading") {
        if (isDeactivated) localStorage.setItem(decisionKey(user.id, entitlement), "declined");
        else sessionStorage.setItem("labtrax_plan_picker_skipped_v1", "1");
      }
    } catch {
      /* ignore */
    }
    if (!isDeactivated) setTrialDismissed(true);
    setDecision("declined");
  }

  async function choosePlan(priceId: string) {
    setCheckoutError(null);
    setCheckoutPending(true);
    try {
      const result = await apiFetch<{ ok: boolean; url: string }>("/billing/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      if (result.url) window.open(result.url, "_blank");
    } catch (err: unknown) {
      setCheckoutError((err as Error)?.message ?? "Failed to start checkout. Please try from the Billing page.");
      setCheckoutPending(false);
    }
  }

  async function resumeProviderSignup() {
    if (!selectedProviderPlan || checkoutPending) return;
    setCheckoutPending(true);
    setCheckoutError(null);
    try {
      await apiFetch("/billing/provider-plan", {
        method: "POST", body: JSON.stringify({ providerPlan: selectedProviderPlan, reuseSubscriptionCard: reuseCard }),
        headers: { "Content-Type": "application/json" },
      });
      if (selectedProviderPlan !== "free") {
        const result = await apiFetch<{ url: string }>("/billing/checkout-session", { method: "POST", body: JSON.stringify({ purchaseChannel: "web" }), headers: { "Content-Type": "application/json" } });
        if (!result.url) throw new Error("Stripe did not return a secure checkout link. Retry.");
        if (!window.open(result.url, "_blank")) throw new Error("Your browser blocked checkout. Allow pop-ups and retry; your account is already saved.");
        setCheckoutError("Card collection is not yet confirmed. Finish Stripe checkout, then refresh. If cancelled, retry or explicitly choose Free.");
      }
      const result = await apiFetch<{ entitlement: Entitlement }>("/billing/subscription");
      setEntitlement(result.entitlement);
    } catch (err) {
      setCheckoutError((err as Error).message || "Checkout could not be started. Your account is saved; retry without registering again.");
    } finally { setCheckoutPending(false); }
  }

  if (providerPending) return <div className="fixed inset-0 z-50 bg-background/95 flex items-start justify-center overflow-auto p-4 sm:p-8">
    <div className="w-full max-w-xl my-auto bg-card border rounded-xl p-5 space-y-5">
      <h1 className="text-xl font-semibold">Finish provider signup</h1>
      <p className="text-sm text-muted-foreground">Your account is saved, but your paid plan is not active until Stripe verifies card collection. You can retry or explicitly choose permanent Free access.</p>
      <ProviderPlanChoices selected={selectedProviderPlan} onSelect={setSelectedProviderPlan} reuseCard={reuseCard} onReuseChange={setReuseCard} disabled={checkoutPending} />
      {checkoutError && <p role="alert" className="text-sm text-destructive">{checkoutError}</p>}
      <button type="button" disabled={checkoutPending || !selectedProviderPlan} onClick={() => void resumeProviderSignup()} className="w-full rounded-md bg-primary text-primary-foreground p-3 disabled:opacity-50">
        {checkoutPending ? "Checking…" : selectedProviderPlan === "free" ? "Confirm permanent Free plan" : "Continue to secure card collection"}
      </button>
    </div>
  </div>;

  if (showDecision) {
    return (
      <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-lg p-7 space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your access is read-only</h1>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              Your previous subscription is deactivated. Renew now to restore full access, or decline to continue with permanent read-only access.
            </p>
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
            <button type="button" data-testid="button-decline-read-only" onClick={() => void decline()}
              className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted transition-colors">
              Decline — keep read-only access
            </button>
            <button type="button" data-testid="button-renew-now" onClick={() => setDecision("renew")}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              Renew now
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!showPicker) {
    if (isDeactivated && decision === "declined") {
      return (
        <div className="fixed bottom-4 right-4 z-40 rounded-lg border border-border bg-card shadow-lg px-4 py-3 text-sm">
          <span className="text-muted-foreground">Read-only access</span>{" "}
          <button
            type="button"
            onClick={() => setDecision("renew")}
            className="font-medium text-primary underline underline-offset-2"
            data-testid="link-billing-after-decline"
          >
            Renew now
          </button>
        </div>
      );
    }
    return null;
  }

  const grouped = groupPlans(plans);
  const relevantPlanType =
    (entitlement.subjectType === "provider_org" ||
      entitlement.subjectType === "provider_user" ||
      entitlement.planType === "provider")
      ? "provider"
      : "lab";

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-auto">
      <div className="w-full max-w-xl my-auto">
        <div className="bg-card border border-border rounded-xl shadow-lg p-7 space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Choose your plan</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isDeactivated
                ? "Select a plan to open secure Stripe checkout. Full access returns only after the server confirms the immediate payment."
                : "Your free trial is active — no credit card charged today. Pick the plan that matches how you use LabTrax."}
            </p>
          </div>

          {checkoutError && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {checkoutError}
            </div>
          )}

          {plansLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="animate-spin text-muted-foreground" size={24} />
            </div>
          )}

          {!plansLoading && plans.length === 0 && (
            <div className="text-sm text-muted-foreground bg-muted/40 rounded-lg p-4 text-center">
              Billing plans are not yet configured. You can choose a plan later from the Billing page.
            </div>
          )}

          {!plansLoading && plans.length > 0 && (
            <div className="space-y-4">
              {([relevantPlanType] as const).map((type) => {
                const typePlans = grouped[type];
                if (typePlans.length === 0) return null;
                return (
                  <div key={type} className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
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
                        return (
                          <button
                            key={plan.id}
                            type="button"
                            data-testid={`button-plan-${plan.id}`}
                            disabled={checkoutPending}
                            onClick={() => void choosePlan(plan.id)}
                            className="flex flex-col gap-1 p-4 rounded-lg border border-border bg-card hover:border-primary hover:bg-primary/5 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            <span className="text-sm font-medium">
                              {plan.productName ?? "LabTrax"}
                            </span>
                            <span className="text-xl font-bold text-foreground">
                              ${price}
                              <span className="text-sm font-normal text-muted-foreground">
                                {interval}
                              </span>
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
            </div>
          )}

          <div className="pt-1 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground text-center">
              Clicking a plan opens secure Stripe checkout in a new tab.
            </p>
            <button
              type="button"
              onClick={() => void decline()}
              className="w-full text-sm text-muted-foreground hover:text-foreground underline py-1"
            >
              {isDeactivated
                ? "Return to read-only access"
                : "Skip for now — I'll choose a plan later"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
