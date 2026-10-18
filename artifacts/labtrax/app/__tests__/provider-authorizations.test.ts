import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getApiUrl } from "@/lib/query-client";
import {
  prepareLabAuthorizationRequest,
  providerAutopayDesktopHandoffUrl,
} from "@/lib/provider-autopay-authorization";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

const screen = readFileSync(join(__dirname, "../finance/provider-authorizations.tsx"), "utf8");
const billing = readFileSync(join(__dirname, "../settings/provider-billing.tsx"), "utf8");
// The signing card the provider uses. One component behind both provider
// entry points (the billing screen and the portal's My Account), so the
// agreement contract is asserted here rather than on either screen.
const authorizationCard = readFileSync(
  join(__dirname, "../../components/autopay/ProviderAutoPayAuthorization.tsx"),
  "utf8",
);
const accountSection = readFileSync(
  join(__dirname, "../../components/provider-portal/sections/ProviderAccountSection.tsx"),
  "utf8",
);

afterEach(() => resetMockFetchHandler());

describe("mobile provider authorization contracts", () => {
  it("blocks invalid email before request and surfaces an error", async () => {
    expect(screen).toContain("Enter a valid recipient email.");
    expect(screen).toContain("/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/");
    expect(screen).toContain("setActionError");
  });

  it("keeps email delivery failure out of the handoff success path", async () => {
    expect(screen).toContain('deliveryMode: "email"');
    expect(screen).toContain("catch (error)");
    expect(screen).toContain("Could not create request.");
    expect(screen).toContain("setHandoffUrl");
  });

  it("sends a tokenized in-person handoff with no email field", async () => {
    let body: Record<string, unknown> | undefined;
    setMockFetchHandler(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, data: { id: "req-1", status: "prepared", requestToken: "token-1" } }), { status: 201 });
    });
    const created = await prepareLabAuthorizationRequest({
      labOrganizationId: "lab-1", providerOrganizationId: "provider-1",
      subscriptionFees: false, labBills: true, labOrganizationIds: ["lab-1"],
      labChargeDay: 5, presentInPerson: true, deliveryMode: "in_person",
    });
    expect(body).toMatchObject({ presentInPerson: true, deliveryMode: "in_person" });
    expect(body).not.toHaveProperty("recipientEmail");
    expect(created.requestToken).toBe("token-1");
    const handoff = new URL(providerAutopayDesktopHandoffUrl(created.id, created.requestToken!));
    expect(handoff.pathname).toBe("/desktop/");
    expect(handoff.search).toBe("?providerAutopayRequest=req-1&providerAutopayToken=token-1");
    expect(screen).toContain("Open");
    expect(screen).toContain("Copy");
    expect(screen).toContain("Share");
    expect(getApiUrl()).toBeTruthy();
  });

  it("does not expose signature controls on the lab screen", async () => {
    expect(screen).not.toMatch(/SignaturePad|signatureData|typedLegalName|Sign and authorize/);
    expect(screen).toContain("provider must sign");
  });

  it("supports subscription-only, lab-only, and combined provider authorizations", async () => {
    expect(authorizationCard).toContain("setSubscriptionFees");
    expect(authorizationCard).toContain("setLabBills");
    expect(authorizationCard).toContain("!subscriptionFees && !labBills");
    const submitted = authorizationCard.slice(
      authorizationCard.indexOf("await submitProviderAuthorization({"),
      authorizationCard.indexOf("pad.current?.clear()"),
    );
    expect(submitted).toContain("subscriptionFees,");
    expect(submitted).toContain("labBills,");
    expect(submitted).toContain("labChargeDay: labBills ? day : null");
  });

  it("offers the same signing card on both provider surfaces", async () => {
    expect(billing).toContain("<ProviderAutoPayAuthorization");
    expect(accountSection).toContain("<ProviderAutoPayAuthorization");
    // Neither surface keeps its own copy of the agreement.
    expect(billing).not.toMatch(/SignaturePad|signatureData|typedLegalName/);
    expect(accountSection).not.toMatch(/SignaturePad|signatureData|typedLegalName/);
  });
});