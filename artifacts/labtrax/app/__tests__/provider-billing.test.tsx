import AsyncStorage from "@react-native-async-storage/async-storage";
import { cleanup, render } from "@testing-library/react-native";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The signature pad draws with react-native-svg and captures strokes through
// PanResponder, neither of which the test renderer provides. Nothing here
// depends on the drawing itself.
vi.mock("@/components/settings/SignaturePad", () => ({
  SignaturePad: () => null,
}));

import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
} from "../../vitest.setup";
import {
  checkoutStatusMessage,
  clearPendingProviderCheckout,
  createProviderCheckout,
  prepareProviderCheckoutAttempt,
  readPendingProviderCheckout,
  savePendingProviderCheckout,
  validChargeDay,
} from "@/lib/provider-billing";
import { parseAutoPayChargeDay } from "@/lib/provider-portal-billing";

const accountSource = readFileSync(join(__dirname, "../(tabs)/account.tsx"), "utf8");
const billingSource = readFileSync(join(__dirname, "../settings/provider-billing.tsx"), "utf8");
// Billing itself is one surface now. The settings route keeps only the panels
// that exist nowhere else (shared card, authorization, subscription auto-pay)
// and renders the portal's billing section for everything else, so the
// statements, payment and per-lab auto-pay rules are asserted where they live.
const sectionSource = readFileSync(
  join(__dirname, "../../components/provider-portal/sections/ProviderBillingSection.tsx"),
  "utf8",
);
const sectionText = sectionSource.replace(/\s+/g, " ");
const paySheetSource = readFileSync(
  join(__dirname, "../../components/provider-portal/billing/PayMyBillSheet.tsx"),
  "utf8",
);
const portalBillingSource = readFileSync(
  join(__dirname, "../../lib/provider-portal-billing.ts"),
  "utf8",
);
const rootLayoutSource = readFileSync(join(__dirname, "../_layout.tsx"), "utf8");
const nativeIntentSource = readFileSync(join(__dirname, "../+native-intent.tsx"), "utf8");
const providerCaseSource = readFileSync(join(__dirname, "../case/provider/[id].tsx"), "utf8");
const billingClientSource = readFileSync(join(__dirname, "../../lib/provider-billing.ts"), "utf8");
// Parsing a Stripe return link, and choosing which billing surface it belongs
// to, moved out of the root layout when the provider portal gained its own
// billing section; the root layout now delegates to it.
const checkoutReturnSource = readFileSync(
  join(__dirname, "../../lib/provider-checkout-return.ts"),
  "utf8",
);

afterEach(async () => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe("provider billing navigation and authorization surface", () => {
  it("shows the dedicated billing row for an active provider membership", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "provider-1",
          role: "user",
          status: "active",
          organization: { id: "provider-1", type: "provider", name: "Practice" },
        },
      ],
    });
    const { default: AccountScreen } = await import("@/app/(tabs)/account");
    const view = await render(<AccountScreen />);
    expect(view.getByTestId("provider-billing-row")).toBeTruthy();
  });

  it("hides the billing row from users without an active provider membership", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Lab" },
        },
      ],
    });
    const { default: AccountScreen } = await import("@/app/(tabs)/account");
    const view = await render(<AccountScreen />);
    expect(view.queryByTestId("provider-billing-row")).toBeNull();
  });

  it("shows the shared billing surface from the Account entry point", async () => {
    const { default: ProviderBillingScreen } = await import("@/app/settings/provider-billing");
    const view = await render(<ProviderBillingScreen />);
    // The same section the provider portal renders, so neither route can show
    // its own version of the balances, auto-pay or payment actions.
    expect(view.getByTestId("provider-portal-section-billing")).toBeTruthy();
    expect(view.getByText("View and Pay My Bill")).toBeTruthy();
    // ...alongside the panels that exist only here.
    expect(view.getByText("Shared payment card")).toBeTruthy();
    expect(view.getByText("Subscription auto-pay")).toBeTruthy();
  });

  it("scopes each lab mutation to its authorized provider relationship", async () => {
    expect(billingClientSource).toContain("/api/provider/labs/${encodeURIComponent(providerOrganizationId)}/invoice-autopay");
    const labMutation = billingClientSource.slice(
      billingClientSource.indexOf("export async function updateLabAutoPay"),
      billingClientSource.indexOf("export async function createProviderCheckout"),
    );
    expect(labMutation).toContain("providerOrganizationId");
    expect(accountSource).toContain('m.status === "active"');
    expect(accountSource).toContain('.toLowerCase() === "provider"');
  });
});

describe("provider billing controls", () => {
  it("limits every auto-pay day to 1 through 10", async () => {
    expect(validChargeDay(1)).toBe(true);
    expect(validChargeDay(10)).toBe(true);
    expect(validChargeDay(0)).toBe(false);
    expect(validChargeDay(11)).toBe(false);
    expect(validChargeDay(null)).toBe(false);
    // Subscription auto-pay still picks its day from chips on the settings
    // screen; invoice auto-pay is typed, and both entry points parse it with
    // the one shared rule.
    expect(billingSource).toContain("Array.from({ length: 10 }");
    expect(parseAutoPayChargeDay("1")).toEqual({ ok: true, chargeDay: 1 });
    expect(parseAutoPayChargeDay("10")).toEqual({ ok: true, chargeDay: 10 });
    expect(parseAutoPayChargeDay("")).toEqual({ ok: true, chargeDay: null });
    expect(parseAutoPayChargeDay("0").ok).toBe(false);
    expect(parseAutoPayChargeDay("11").ok).toBe(false);
    expect(parseAutoPayChargeDay("3.5").ok).toBe(false);
  });

  it("uses masked card fields and explains the full-balance due date", async () => {
    expect(billingSource).toContain("card.last4");
    expect(billingSource).toContain("card.expMonth");
    expect(sectionText).toContain(
      "the full current balance for that lab is charged on your selected day",
    );
    expect(sectionText).toContain("Payments are due by the 10th");
    expect(billingSource).not.toMatch(/cardNumber|securityCode|cvc|cvv/i);
    expect(sectionSource).not.toMatch(/cardNumber|securityCode|cvc|cvv/i);
    expect(paySheetSource).not.toMatch(/cardNumber|securityCode|cvc|cvv/i);
  });

  it("keeps one billing implementation behind both provider entry points", async () => {
    // The settings route renders the shared section instead of a second copy
    // of statements, payments and per-lab auto-pay.
    expect(billingSource).toContain("<ProviderBillingSection");
    expect(billingSource).toContain('origin="settings"');
    for (const duplicated of [
      "getProviderStatements",
      "getProviderPaymentHistory",
      "getProviderCheckoutStatus",
      "createProviderCheckout",
      "updateLabAutoPay",
    ]) {
      expect(billingSource).not.toContain(duplicated);
    }
    // Shared behaviour lives in the shared modules, not in either screen.
    expect(portalBillingSource).toContain("export function parseAutoPayChargeDay");
    expect(portalBillingSource).toContain("export function autoPayDraftOf");
    expect(sectionSource).toContain("parseAutoPayChargeDay(draft.chargeDay)");
  });

  it("uses hosted setup and never creates a local card record", async () => {
    expect(billingClientSource).toContain('"/api/provider/payment-method/setup-checkout"');
    expect(billingSource).toContain("Linking.openURL(result.url)");
    expect(billingClientSource).not.toMatch(/AsyncStorage\.setItem\([^,]*card/i);
  });
});

describe("hosted provider checkout", () => {
  it("posts allocations to the authoritative hosted checkout endpoint", async () => {
    let request: { url: string; init?: RequestInit } | null = null;
    setMockFetchHandler(async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            checkoutId: "checkout-1",
            status: "pending",
            url: "https://checkout.stripe.test/session",
          },
        }),
        { status: 201 },
      );
    });

    const result = await createProviderCheckout({
      allocations: [{ invoiceId: "invoice-1", amount: "25.00" }],
      idempotencyKey: "mobile-test-1",
    });

    expect(result.checkoutId).toBe("checkout-1");
    expect(request).not.toBeNull();
    expect(request!.url).toBe("/api/provider/payment-checkout");
    expect(request!.init?.method).toBe("POST");
    expect(JSON.parse(String(request!.init?.body))).toMatchObject({
      allocations: [{ invoiceId: "invoice-1", amount: "25.00" }],
      idempotencyKey: "mobile-test-1",
    });
  });

  it("keeps every payment mode on hosted checkout", async () => {
    // Paying moved into the shared Pay My Bill sheet, which both entry points
    // open; the case screen still pays a single invoice its own way.
    expect(paySheetSource).toContain('type PayMode = "full" | "partial" | "individual"');
    expect(paySheetSource).toContain("allocatePayment(invoices, statementBalance)");
    expect(paySheetSource).toContain("allocatePayment(invoices, parsed)");
    expect(paySheetSource).toContain("createProviderCheckout");
    // Stripe's return link cannot say which surface launched the payment, so
    // the sheet records it and never assumes the portal.
    expect(paySheetSource).toContain("origin,");
    expect(paySheetSource).not.toContain('origin: "portal",');
    expect(providerCaseSource).toContain('mode: "case-invoice"');
    expect(providerCaseSource).toContain("createProviderCheckout");
    expect(providerCaseSource).toContain("paymentSubmitting");
  });

  it("persists only pending checkout context for interruption recovery", async () => {
    await savePendingProviderCheckout({
      checkoutId: "checkout-2",
      mode: "selected",
      invoiceIds: ["invoice-1"],
    });
    expect(await readPendingProviderCheckout()).toEqual({
      checkoutId: "checkout-2",
      mode: "selected",
      invoiceIds: ["invoice-1"],
    });
    await clearPendingProviderCheckout();
    expect(await readPendingProviderCheckout()).toBeNull();
  });

  it("reuses the durable attempt key after an ambiguous create interruption", async () => {
    const first = await prepareProviderCheckoutAttempt({
      mode: "selected",
      invoiceIds: ["invoice-2", "invoice-1"],
    });
    const retry = await prepareProviderCheckoutAttempt({
      mode: "selected",
      invoiceIds: ["invoice-1", "invoice-2"],
    });
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  });
});

describe("checkout return confirmation", () => {
  it.each([
    ["pending", "Payment still processing"],
    ["succeeded", "Payment confirmed"],
    ["cancelled", "Payment cancelled"],
    ["failed", "Payment declined"],
    ["expired", "Checkout expired"],
  ] as const)("renders a recoverable %s result", (status, title) => {
    expect(checkoutStatusMessage(status).title).toBe(title);
  });

  it("queries server status and invalidates balances only after confirmed success", async () => {
    const statusIndex = sectionSource.indexOf("getProviderCheckoutStatus(checkoutId)");
    const successIndex = sectionSource.indexOf('result.status === "succeeded"');
    const refreshIndex = sectionSource.indexOf("refreshBilling()", successIndex);
    expect(statusIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(statusIndex);
    expect(refreshIndex).toBeGreaterThan(successIndex);
    expect(sectionSource).not.toContain("cancelled ===");
    // One reconciler for both entry points, so a return is never confirmed
    // (or cancelled) twice.
    expect(billingSource).not.toContain("getProviderCheckoutStatus");
  });

  it("routes browser and native returns to billing without trusting URL status", async () => {
    // Both link shapes still reach the handler: the labtrax:// link the API
    // bridge redirects to, and the https link Stripe can return to directly.
    expect(rootLayoutSource).toContain("parseProviderCheckoutReturnUrl(url)");
    expect(rootLayoutSource).toContain("deliverProviderCheckoutReturn(");
    expect(checkoutReturnSource).toContain("providerPaymentCheckout");
    expect(checkoutReturnSource).toContain('params.get("returned") === "1"');
    expect(checkoutReturnSource).toContain("/settings/provider-billing?checkoutId=");
    expect(checkoutReturnSource).toContain('"/settings/provider-billing"');
    // A link can say a return happened, never that a payment settled.
    expect(checkoutReturnSource).not.toContain('"succeeded"');
    expect(nativeIntentSource).not.toContain("succeeded");
    expect(billingClientSource).toContain("api/provider/mobile-payment-return");
    expect(billingClientSource).toContain("/api/provider/payment-checkout/${encodeURIComponent(checkoutId)}");
  });

  it("disables billing writes when their authoritative data is unavailable", async () => {
    expect(billingSource).toContain("!!billing?.capabilities.autoPayScheduling");
    expect(billingSource).toContain(
      "disabled={!billingCapabilityAvailable || (!billing?.card.hasCard && !normalizePreference(billing?.subscriptionAutoPay).enabled)}",
    );
    expect(billingSource).toContain("disabled={setupLoading || !billing || billingQuery.isError}");
    expect(billingSource).toContain("Automatic payment scheduling is not available yet");
    // Invoice auto-pay is edited in the shared section, which reads the same
    // capability from the same query rather than offering a save that 503s.
    expect(sectionSource).toContain(
      "billingQuery.data?.capabilities.autoPayScheduling !== false",
    );
    expect(sectionSource).toContain(
      "const locked = autoPaySaving !== null || !autoPaySchedulingAvailable;",
    );
    expect(sectionText).toContain("Automatic payment scheduling is not available yet");
    expect(sectionText).toContain("Add a shared card before enabling auto-pay.");
  });
});