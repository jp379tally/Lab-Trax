/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardHelpReason,
  trackInlineCardPaymentCancelled,
  trackInlineCardPaymentNeedsHelp,
  trackInlineCardPaymentStarted,
  trackInlineCardPaymentSucceeded,
} from "@/lib/inline-card-payment-analytics";

describe("inline card payment analytics", () => {
  afterEach(() => {
    delete window.umami;
  });

  it("emits only privacy-safe funnel dimensions", () => {
    const track = vi.fn();
    window.umami = { track };

    trackInlineCardPaymentStarted("saved");
    trackInlineCardPaymentStarted("new");
    trackInlineCardPaymentSucceeded("saved");
    trackInlineCardPaymentNeedsHelp("new", "authentication_required");
    trackInlineCardPaymentNeedsHelp("saved", "declined");
    trackInlineCardPaymentCancelled("new");

    expect(track.mock.calls).toEqual([
      ["inline_card_payment_started", { card_source: "saved" }],
      ["inline_card_payment_started", { card_source: "new" }],
      ["inline_card_payment_succeeded", { card_source: "saved" }],
      ["inline_card_payment_needs_help", { card_source: "new", reason: "authentication_required" }],
      ["inline_card_payment_needs_help", { card_source: "saved", reason: "declined" }],
      ["inline_card_payment_cancelled", { card_source: "new" }],
    ]);
  });

  it("classifies fixed help outcomes without returning error text", () => {
    expect(cardHelpReason(new Error("The card requires additional authentication. Complete the Stripe prompt, then retry.")))
      .toBe("authentication_required");
    expect(cardHelpReason(new Error("Your card was declined."))).toBe("declined");
    expect(cardHelpReason(new Error("The card was not completed. Check the card details and try again."))).toBe("declined");
    expect(cardHelpReason(new Error("The network is unavailable."))).toBeNull();
  });

  it("does not throw when the analytics tracker fails", () => {
    window.umami = { track: vi.fn(() => { throw new Error("tracker unavailable"); }) };

    expect(() => trackInlineCardPaymentStarted("saved")).not.toThrow();
    expect(() => trackInlineCardPaymentSucceeded("new")).not.toThrow();
  });
});