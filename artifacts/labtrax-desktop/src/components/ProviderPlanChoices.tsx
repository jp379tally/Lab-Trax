import {
  PROVIDER_SIGNUP_CHOICES, PROVIDER_CARD_REUSE_WORDING,
  PROVIDER_CARD_REUSE_EXPLANATION, PROVIDER_TRIAL_DISCLOSURE,
  type ProviderSignupTier,
} from "@workspace/api-client-react";

export default function ProviderPlanChoices({ selected, onSelect, reuseCard, onReuseChange, disabled = false }: {
  selected: ProviderSignupTier | null; onSelect: (plan: ProviderSignupTier) => void;
  reuseCard: boolean; onReuseChange: (value: boolean) => void; disabled?: boolean;
}) {
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Provider plan">
      {PROVIDER_SIGNUP_CHOICES.map((plan) => <button
        type="button" role="radio" aria-checked={selected === plan.id}
        data-testid={`provider-plan-${plan.id}`} key={plan.id} disabled={disabled}
        onClick={() => { onSelect(plan.id); if (plan.id === "free") onReuseChange(false); }}
        className={`p-4 rounded-lg border text-left space-y-2 disabled:opacity-60 ${selected === plan.id ? "border-primary bg-primary/5" : "border-border hover:border-primary"}`}>
        <span className="flex justify-between gap-2 font-semibold">{plan.name}{selected === plan.id && <span className="text-primary text-xs">Selected</span>}</span>
        <span className="block text-xl font-bold">${plan.monthlyPriceUsd}<span className="text-sm font-normal text-muted-foreground">{plan.cardRequired ? "/month USD" : " — permanent"}</span></span>
        <span className="block text-xs text-muted-foreground">{plan.description}</span>
        <span className="block text-xs">{plan.cardRequired ? "Card required · First charge after a 30-day trial" : "No card required · No trial expiry"}</span>
      </button>)}
    </div>
    {selected && selected !== "free" && <>
      <p className="text-sm text-muted-foreground">{PROVIDER_TRIAL_DISCLOSURE}</p>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={reuseCard} disabled={disabled} onChange={(e) => onReuseChange(e.target.checked)} className="mt-1 shrink-0" />
        <span>{PROVIDER_CARD_REUSE_WORDING}</span>
      </label>
      <p className="text-xs text-muted-foreground">{PROVIDER_CARD_REUSE_EXPLANATION}</p>
    </>}
  </div>;
}
