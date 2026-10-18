import type { ProviderSignupChoice } from "./generated/api.schemas";

// Offline descriptions are deliberate: an outage must never hide Free or the
// advertised plans. The server still validates Stripe mappings at checkout.
export const PROVIDER_SIGNUP_CHOICES: readonly ProviderSignupChoice[] = [
  { id: "free", name: "Free", monthlyPriceUsd: 0, description: "Permanent read-only access to cases shared by approved partner labs.", currency: "usd", interval: null, cardRequired: false, trialDays: 0, checkoutConfigured: true },
  { id: "basic", name: "Basic", monthlyPriceUsd: 99, description: "View active cases shared by approved partner labs.", currency: "usd", interval: "month", cardRequired: true, trialDays: 30, checkoutConfigured: false },
  { id: "standard", name: "Standard", monthlyPriceUsd: 149, description: "View active cases and view and pay online lab bills.", currency: "usd", interval: "month", cardRequired: true, trialDays: 30, checkoutConfigured: false },
  { id: "premium", name: "Premium", monthlyPriceUsd: 199, description: "All provider features, including lab communication.", currency: "usd", interval: "month", cardRequired: true, trialDays: 30, checkoutConfigured: false },
];
export const PROVIDER_CARD_REUSE_WORDING = "Do you want to save this for future lab bill payments or other financial transactions within LabTrax?";
export const PROVIDER_CARD_REUSE_EXPLANATION = "Stripe retains the subscription card for renewal regardless. This optional permission only allows reuse for other supported transactions. It does not enable invoice auto-pay.";
export const PROVIDER_TRIAL_DISCLOSURE = "Card required. No subscription charge today. Your first charge is after a 30-day free trial, then the selected USD monthly price.";
