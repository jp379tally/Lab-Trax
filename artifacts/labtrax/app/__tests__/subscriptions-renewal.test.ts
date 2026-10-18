import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterRenewalPlans } from "@/app/settings/subscriptions";

const source = readFileSync(join(__dirname, "../settings/subscriptions.tsx"), "utf8");

const plans = [
  { id: "lab-month", currency: "usd", unitAmount: 100, interval: "month", productName: "Lab", productDescription: null, planType: "lab" as const },
  { id: "provider-month", currency: "usd", unitAmount: 200, interval: "month", productName: "Provider", productDescription: null, planType: "provider" as const },
];

describe("mobile subscription renewal", () => {
  it("only exposes provider plans for deactivated provider subjects", async () => {
    expect(filterRenewalPlans(plans, "provider_org", null).map((p) => p.id)).toEqual(["provider-month"]);
    expect(filterRenewalPlans(plans, "provider_user", "lab").map((p) => p.id)).toEqual(["provider-month"]);
  });

  it("only exposes lab plans for deactivated lab subjects", async () => {
    expect(filterRenewalPlans(plans, "lab_org", "lab").map((p) => p.id)).toEqual(["lab-month"]);
    expect(filterRenewalPlans(plans, "account", null).map((p) => p.id)).toEqual(["lab-month"]);
  });

  it("starts hosted checkout with deep-link return URLs and waits for server entitlement", async () => {
    expect(source).toContain('"/api/billing/checkout-session"');
    expect(source).toContain("subscriptionBillingReturnUrl");
    expect(source).toContain("api/billing/mobile-return");
    expect(source).toContain("successUrl");
    expect(source).toContain("cancelUrl");
    expect(source).toContain('checkout !== "success" && checkout !== "cancel"');
    expect(source).toContain('invalidateQueries({ queryKey: ["billing", "subscription"] })');
    expect(source).toContain("Full access returns only after the server confirms payment.");
  });
});