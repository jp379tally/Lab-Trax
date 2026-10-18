import { describe, expect, it } from "vitest";
import type { Subscription } from "@workspace/db";
import {
  computeEntitlement,
  expiredTrialTransition,
  PROVIDER_PLANS,
  type BillingSubject,
} from "./entitlement";

const providerSubject: BillingSubject = {
  subjectType: "provider_org",
  subjectId: "provider-org-1",
};
const now = new Date("2026-01-15T12:00:00.000Z");

function providerSubscription(
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    id: "sub-1",
    subjectType: "provider_org",
    subjectId: "provider-org-1",
    provider: "none",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    revenueCatAppUserId: null,
    status: "active",
    trialStartAt: null,
    trialEndAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    paymentMethodOnFile: false,
    autoPayEnabled: false,
    autoPayChargeDay: 10,
    lastReminderSentAt: null,
    lastReminderKind: null,
    gracePeriodStartAt: null,
    canceledAt: null,
    stripePriceId: null,
    planType: "provider",
    billingInterval: "month",
    providerPlan: "basic",
    providerOnboardingJson: null,
    waiverReason: null,
    waiverStartsAt: null,
    waiverEndsAt: null,
    waiverGrantedByUserId: null,
    waiverGrantedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

describe("provider entitlement", () => {
  it.each(["free", "onboarding_pending"])("keeps %s permanent case-only/read-only even with a waiver", (status) => {
    const result = computeEntitlement(providerSubject, providerSubscription({
      status, providerPlan: status === "free" ? "free" : "premium",
      waiverReason: "creator_override", waiverStartsAt: new Date("2025-01-01"),
    }), now);
    expect(result.accessLevel).toBe("read_only");
    expect(result.capabilities).toEqual({ active_case_view: true, billing_view_pay: false, lab_communication: false });
    expect(result.trialDaysRemaining).toBeNull();
  });
  it("keeps an unexpired canonical trial usable without selecting a price or storing a card", () => {
    const entitlement = computeEntitlement(
      providerSubject,
      providerSubscription({
        status: "trialing",
        trialEndAt: new Date("2026-02-01T12:00:00.000Z"),
        stripePriceId: null,
      }),
      now,
    );
    expect(entitlement.status).toBe("trialing");
    expect(entitlement.accessLevel).toBe("full");
    expect(entitlement.hasPaymentMethod).toBe(false);
  });
  it("defines the fixed provider plan prices and cumulative capabilities", () => {
    expect(PROVIDER_PLANS.basic.monthlyPriceUsd).toBe(99);
    expect(PROVIDER_PLANS.standard.monthlyPriceUsd).toBe(149);
    expect(PROVIDER_PLANS.premium.monthlyPriceUsd).toBe(199);

    expect(
      computeEntitlement(
        providerSubject,
        providerSubscription({ providerPlan: "standard" }),
        now
      ).capabilities
    ).toEqual({
      active_case_view: true,
      billing_view_pay: true,
      lab_communication: false,
    });
  });

  it("lets an effective waiver suppress lockout without implying payment", () => {
    const entitlement = computeEntitlement(
      providerSubject,
      providerSubscription({
        status: "locked",
        providerPlan: "premium",
        waiverReason: "Approved account hold",
        waiverStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        waiverEndsAt: null,
        waiverGrantedByUserId: "admin-1",
        waiverGrantedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      now
    );

    expect(entitlement.status).toBe("locked");
    expect(entitlement.accessLevel).toBe("full");
    expect(entitlement.providerPlan).toBe("premium");
    expect(entitlement.hasActiveWaiver).toBe(true);
    expect(entitlement.hasPaymentMethod).toBe(false);
  });

  it("lets an effective waiver suppress grace read-only restrictions", () => {
    const entitlement = computeEntitlement(
      providerSubject,
      providerSubscription({
        status: "grace",
        providerPlan: "standard",
        waiverReason: "Approved transition access",
        waiverStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        waiverEndsAt: null,
      }),
      now
    );

    expect(entitlement.status).toBe("grace");
    expect(entitlement.hasActiveWaiver).toBe(true);
    expect(entitlement.accessLevel).toBe("full");
    expect(entitlement.hasPaymentMethod).toBe(false);
  });

  it("does not activate a future or expired waiver", () => {
    const entitlement = computeEntitlement(
      providerSubject,
      providerSubscription({
        status: "locked",
        waiverReason: "Expired exception",
        waiverStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        waiverEndsAt: new Date("2026-01-10T00:00:00.000Z"),
      }),
      now
    );

    expect(entitlement.hasActiveWaiver).toBe(false);
    // Legacy locked rows are durable read-only, not authentication lockouts.
    expect(entitlement.accessLevel).toBe("read_only");
  });

  it("makes an expired trial read-only immediately, before the billing job runs", () => {
    const entitlement = computeEntitlement(
      providerSubject,
      providerSubscription({
        status: "trialing",
        trialEndAt: new Date("2026-01-14T12:00:00.000Z"),
        paymentMethodOnFile: true,
      }),
      now,
    );

    expect(entitlement.status).toBe("trialing");
    expect(entitlement.accessLevel).toBe("read_only");
    expect(entitlement.trialDaysRemaining).toBe(0);
  });

  it("keeps expired trials read-only until payment is authoritatively confirmed", () => {
    expect(expiredTrialTransition(false)).toEqual({
      status: "grace",
      reason: "trial_ended_no_payment",
    });
    expect(expiredTrialTransition(true)).toEqual({
      status: "grace",
      reason: "trial_ended_awaiting_payment_confirmation",
    });
  });
});