import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSharedProviderAccountChange,
  decideSharedProviderAccountChange,
  getSharedProviderAccount,
} from "@/lib/shared-provider-account";
import {
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";

const screenSource = readFileSync(
  join(__dirname, "../settings/shared-account.tsx"),
  "utf8",
);
const notificationsSource = readFileSync(
  join(__dirname, "../notifications.tsx"),
  "utf8",
);
const doctorCasesSource = readFileSync(
  join(__dirname, "../finance/doctor-cases.tsx"),
  "utf8",
);
const accountSource = readFileSync(
  join(__dirname, "../(tabs)/account.tsx"),
  "utf8",
);

afterEach(() => resetMockFetchHandler());

describe("mobile shared provider account contract", () => {
  it("scopes account reads to both relationship ids and accepts only masked card metadata", async () => {
    let url = "";
    setMockFetchHandler(async (nextUrl) => {
      url = nextUrl;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            relationship: {
              labOrganizationId: "lab-1",
              providerOrganizationId: "provider-1",
            },
            contact: {
              name: "Practice",
              displayName: null,
              billingEmail: null,
              phone: null,
              addressLine1: null,
              addressLine2: null,
              city: null,
              state: null,
              zip: null,
              source: "provider_organization",
              updatedAt: "2026-09-03T00:00:00.000Z",
            },
            card: {
              brand: "visa",
              last4: "4242",
              expMonth: 12,
              expYear: 2032,
              status: "active",
              updatedAt: null,
              source: "processor",
            },
            profileChangeRequests: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const account = await getSharedProviderAccount("lab-1", "provider-1");
    expect(url).toContain("labOrganizationId=lab-1");
    expect(url).toContain("providerOrganizationId=provider-1");
    expect(account.card).toMatchObject({ brand: "visa", last4: "4242" });
    expect(JSON.stringify(account.card)).not.toMatch(/cardNumber|cvc|paymentMethod/i);
  });

  it("keeps profile proposals and counterpart decisions on dedicated endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    setMockFetchHandler(async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            id: "request-1",
            labOrganizationId: "lab-1",
            providerOrganizationId: "provider-1",
            requestedByOrganizationId: "provider-1",
            requestedByUserId: "user-1",
            source: "provider",
            status: "pending",
            changes: { phone: "555-0101" },
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    await createSharedProviderAccountChange("lab-1", "provider-1", {
      phone: "555-0101",
    });
    await decideSharedProviderAccountChange("request-1", "approve");
    expect(requests[0].url).toContain("/shared-accounts/profile-change-requests");
    expect(requests[0].init?.body).not.toMatch(/cardNumber|cvc|cvv/i);
    expect(requests[1].url).toContain("/request-1/approve");
  });

  it("shows offline, pending, approved, rejected, and stale states without mixing relationships", async () => {
    expect(screenSource).toContain("sharedProviderAccountQueryKey(labOrganizationId, providerOrganizationId)");
    expect(screenSource).toContain('"pending"');
    expect(screenSource).toContain('"approved"');
    expect(screenSource).toContain('"rejected"');
    expect(screenSource).toContain('"stale"');
    expect(screenSource).toContain("Check your connection and pull to refresh");
    expect(screenSource).toContain("This setting is read-only for the lab");
  });

  it("routes relationship notifications and lab financial context with both ids", async () => {
    expect(notificationsSource).toContain('"provider_account_change_requested"');
    expect(notificationsSource).toContain('"provider_account_change_decided"');
    expect(notificationsSource).toContain("labOrganizationId");
    expect(notificationsSource).toContain("providerOrganizationId");
    expect(doctorCasesSource).toContain('testID="lab-shared-account"');
    expect(accountSource).toContain("hasSharedAccountUpdate");
    expect(accountSource).toContain("badge={hasSharedAccountUpdate}");
  });
});