import { trackEvent } from "@/lib/analytics";

export type InlineCardSource = "saved" | "new";
export type InlineCardHelpReason = "authentication_required" | "declined";

export function trackInlineCardPaymentStarted(cardSource: InlineCardSource): void {
  trackEvent("inline_card_payment_started", { card_source: cardSource });
}

export function trackInlineCardPaymentSucceeded(cardSource: InlineCardSource): void {
  trackEvent("inline_card_payment_succeeded", { card_source: cardSource });
}

export function trackInlineCardPaymentNeedsHelp(
  cardSource: InlineCardSource,
  reason: InlineCardHelpReason,
): void {
  trackEvent("inline_card_payment_needs_help", {
    card_source: cardSource,
    reason,
  });
}

export function trackInlineCardPaymentCancelled(cardSource: InlineCardSource): void {
  trackEvent("inline_card_payment_cancelled", { card_source: cardSource });
}

export function cardHelpReason(error: unknown): InlineCardHelpReason | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.toLowerCase();
  if (message.includes("additional authentication") || message.includes("requires_action")) {
    return "authentication_required";
  }
  if (message.includes("declin") || message.includes("card was not completed")) {
    return "declined";
  }
  return null;
}