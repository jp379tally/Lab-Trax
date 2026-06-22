import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Entitlement {
  status: string;
  planType: "lab" | "provider" | null;
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

const SESSION_SKIP_KEY = "labtrax_plan_picker_skipped_v1";

function groupPlans(plans: Plan[]): { lab: Plan[]; provider: Plan[] } {
  return {
    lab: plans.filter((p) => p.planType === "lab"),
    provider: plans.filter((p) => p.planType === "provider"),
  };
}

export default function PlanPickerOnboarding() {
  const [entitlement, setEntitlement] = useState<Entitlement | null | "loading">("loading");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansFailed, setPlansFailed] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return !!sessionStorage.getItem(SESSION_SKIP_KEY);
    } catch {
      return false;
    }
  });
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ ok: boolean; entitlement: Entitlement }>("/billing/subscription")
      .then((r) => setEntitlement(r.entitlement))
      .catch(() => setEntitlement(null));
  }, []);

  const showPicker =
    !dismissed &&
    entitlement !== "loading" &&
    entitlement !== null &&
    entitlement.planType === null &&
    entitlement.status === "trialing";

  useEffect(() => {
    if (!showPicker || plans.length > 0 || plansLoading || plansFailed) return;
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
  }, [showPicker, plans.length, plansLoading, plansFailed]);

  function dismiss() {
    try {
      sessionStorage.setItem(SESSION_SKIP_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
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
      dismiss();
    } catch (err: unknown) {
      setCheckoutError((err as Error)?.message ?? "Failed to start checkout. Please try from the Billing page.");
      setCheckoutPending(false);
    }
  }

  if (!showPicker) return null;

  const grouped = groupPlans(plans);

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-auto">
      <div className="w-full max-w-xl my-auto">
        <div className="bg-card border border-border rounded-xl shadow-lg p-7 space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Choose your plan</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Your 30-day free trial is active — no credit card charged today.
              Pick the plan that matches how you use LabTrax.
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
              {(["lab", "provider"] as const).map((type) => {
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
              Clicking a plan opens Stripe checkout in a new tab. Your trial continues uninterrupted.
            </p>
            <button
              type="button"
              onClick={dismiss}
              className="w-full text-sm text-muted-foreground hover:text-foreground underline py-1"
            >
              Skip for now — I'll choose a plan later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
