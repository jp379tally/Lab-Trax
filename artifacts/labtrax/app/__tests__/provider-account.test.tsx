// Provider portal → My Account, on mobile.
//
// Covers what the desktop ProviderMyAccount is responsible for, phrased as
// outcomes a provider would notice: their own details arrive pre-filled and
// save, each linked lab shows its card state and the practice contact fields
// that write it, subscription auto-pay saves (and puts the controls back when
// it does not), and a return from Stripe card setup lands in My Account with
// the card state re-read rather than assumed.
//
// Settings reachability for a provider is asserted in
// provider-portal-shell.test.tsx ("reaches notification and doctor preferences
// from the settings entry"); it is not repeated here.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { resetMockAppState, resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";
import type { InAppNotification } from "@/lib/in-app-notifications";

// ── Local mocks ────────────────────────────────────────────────────────────
// The global setup stubs useQuery/useQueryClient. My Account is built on real
// React Query caches (a save writes the cache and invalidates a sibling key),
// so this file uses the library for real.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

// The global setup signs in as a lab user; My Account is a provider surface.
const authState = { currentUser: "dr.smith", currentUserId: "user-1", userType: "provider", logout: vi.fn() };
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: React.PropsWithChildren<unknown>) => children ?? null,
}));

// The signature pad draws with react-native-svg and captures strokes through
// PanResponder, neither of which the test renderer provides. What the card
// reads is the handle, so the stub answers with a signature.
vi.mock("@/components/settings/SignaturePad", async () => {
  const react = await import("react");
  return {
    SignaturePad: react.forwardRef(
      (_props: unknown, ref: React.Ref<{ toDataUrl: () => string | null; clear: () => void }>) => {
        react.useImperativeHandle(ref, () => ({
          toDataUrl: () => "data:image/png;base64,SIGNATURE",
          clear: () => undefined,
        }));
        return null;
      },
    ),
  };
});

const notificationState: { items: InAppNotification[] } = { items: [] };
vi.mock("@/lib/in-app-notifications", () => ({
  IN_APP_NOTIFICATIONS_QUERY_KEY: ["in-app-notifications"],
  useInAppNotifications: () => ({
    items: notificationState.items,
    unreadCount: 0,
    isLoading: false,
  }),
  useNotificationActions: () => ({
    markRead: vi.fn(async () => undefined),
    markAllRead: vi.fn(async () => undefined),
  }),
}));

import { ProviderAccountSection } from "@/components/provider-portal/sections/ProviderAccountSection";
import { ProviderPortalShell } from "@/components/provider-portal/ProviderPortalShell";
import { ProviderPracticeProvider } from "@/lib/provider-practice";
import {
  resetProviderCardSetupRouting,
  routeProviderCardSetupReturn,
  setProviderCardSetupShell,
} from "@/lib/provider-card-setup-return";

// ── Fixtures ───────────────────────────────────────────────────────────────
const PRACTICE = { id: "prac-north", name: "North Dental", accountNumber: "ACCT-1001" };
let membershipRole: string | null = null;
const LAB = { id: "lab-bright", name: "Bright Dental Lab" };

const USER = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Nguyen",
  email: "ada@north.example",
  phone: "555-0100",
  practiceName: "North Dental",
  practiceAddress: "1 Main St, Shelbyville, IL 62565",
  practicePhone: "555-0101",
  practiceAccountNumber: "ACCT-1001",
};

const CONTACT = {
  name: "North Dental PLLC",
  displayName: "North Dental",
  billingEmail: "billing@north.example",
  phone: "555-0101",
  addressLine1: "1 Main St",
  addressLine2: null,
  city: "Shelbyville",
  state: "IL",
  zip: "62565",
  source: "provider_organization" as const,
  updatedAt: "2026-01-04T00:00:00.000Z",
};

const CARD = {
  brand: "visa",
  last4: "4242",
  expMonth: 4,
  expYear: 2027,
  status: "active" as const,
  updatedAt: "2026-01-04T00:00:00.000Z",
  source: "processor" as const,
};

/** Mutable stand-in for the server, so a save is observable on the next read. */
interface Server {
  user: Record<string, unknown>;
  contact: typeof CONTACT;
  card: typeof CARD | null;
  subscription: {
    enabled: boolean;
    chargeDay: number | null;
    authorization?: Record<string, unknown>;
  };
  /** Stripe's answer for a setup session, and the card it leaves behind. */
  setupStatus: "pending" | "succeeded" | "expired";
  cardAfterSetup: typeof CARD | null;
  /** The signed auto-pay authorization, once the provider signs one. */
  authorization: Record<string, unknown> | null;
  failures: Partial<
    Record<"profile" | "contact" | "subscription" | "authorization", { status: number; body: unknown }>
  >;
}
let server: Server;
let sent: Array<{ url: string; method: string; body: string | null }>;

function requests(fragment: string) {
  return sent.filter((entry) => entry.url.includes(fragment));
}

function installHandler(): void {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/api/provider/organizations")) {
      return json({ ok: true, data: [PRACTICE] });
    }
    if (url.includes("/api/provider/selection")) {
      return json({ ok: true, data: { ok: true } });
    }
    if (url.includes("/profile") && url.includes("/api/auth/users/")) {
      if (server.failures.profile) {
        return json(server.failures.profile.body, server.failures.profile.status);
      }
      server.user = { ...server.user, ...(body ? JSON.parse(body) : {}) };
      return json({ success: true, user: server.user });
    }
    if (url.includes("/api/auth/me")) {
      return json({ success: true, user: server.user, memberships: membershipRole ? [{
        organizationId: PRACTICE.id, role: membershipRole, status: "active", organization: { ...PRACTICE, type: "provider" },
      }] : [] });
    }
    if (url.includes("/api/provider/billing-preferences")) {
      return json({
        data: {
          subscription: server.subscription,
          labs: [
            {
              providerOrganizationId: PRACTICE.id,
              labOrganizationId: LAB.id,
              labName: LAB.name,
              providerName: PRACTICE.name,
            },
          ],
        },
      });
    }
    if (url.includes("/api/organizations/provider-portal-contact")) {
      if (server.failures.contact) {
        return json(server.failures.contact.body, server.failures.contact.status);
      }
      server.contact = { ...server.contact, ...(body ? JSON.parse(body) : {}) };
      return json({ ok: true, data: server.contact });
    }
    if (url.includes("/api/organizations/shared-accounts")) {
      return json({
        data: {
          relationship: {
            labOrganizationId: LAB.id,
            providerOrganizationId: PRACTICE.id,
          },
          contact: server.contact,
          card: server.card,
          profileChangeRequests: [],
        },
      });
    }
    if (url.includes("/api/provider/payment-method/setup-checkout")) {
      return json({ data: { url: "https://checkout.stripe.test/session" } });
    }
    if (url.includes("/api/provider/payment-method/setup-status/")) {
      // Stripe attaches the card before it reports success.
      if (server.setupStatus === "succeeded") server.card = server.cardAfterSetup;
      return json({ data: { status: server.setupStatus, card: null } });
    }
    if (url.includes("/api/provider/subscription-autopay")) {
      if (server.failures.subscription) {
        return json(server.failures.subscription.body, server.failures.subscription.status);
      }
      const patch = (body ? JSON.parse(body) : {}) as { enabled?: boolean; chargeDay?: number };
      server.subscription = {
        ...server.subscription,
        enabled: patch.enabled ?? server.subscription.enabled,
        chargeDay: patch.chargeDay ?? server.subscription.chargeDay,
      };
      return json({ data: { subscription: server.subscription } });
    }
    // The auto-pay agreement the provider signs in place, and the two reads
    // the card makes around it.
    if (url.includes("/api/provider/autopay-authorization/prepare")) {
      return json({
        data: {
          agreementVersion: "2026-02",
          agreementSha256: "sha-2026-02",
          agreementText: "LabTrax may charge the card on file for the amounts authorized below.",
          card: { brand: "VISA", last4: "4242" },
          labs: [{ labOrganizationId: LAB.id, labName: LAB.name }],
        },
      });
    }
    if (url.includes("/api/provider/autopay-authorization/current")) {
      if (!server.authorization) return json({ error: "Not found" }, 404);
      return json({ data: server.authorization });
    }
    if (url.includes("/api/provider/autopay-authorization")) {
      if (server.failures.authorization) {
        return json(server.failures.authorization.body, server.failures.authorization.status);
      }
      const signed = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
      server.authorization = { ...signed, id: "auth-signed", status: "active" };
      server.subscription = {
        ...server.subscription,
        authorization: {
          ...server.subscription.authorization,
          authorizationId: "auth-signed",
          authorizationStatus: "active",
        },
      };
      return json({ data: server.authorization }, 201);
    }
    return json({ ok: true, data: null });
  });
}

// ── Harness ────────────────────────────────────────────────────────────────
function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Let queued promises and the state updates they cause settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    await fireEvent.press(element);
  });
  await flush();
}

async function type(element: Parameters<typeof fireEvent.changeText>[0], text: string): Promise<void> {
  await act(async () => {
    await fireEvent.changeText(element, text);
  });
}

async function renderAccount() {
  const utils = await render(
    <QueryClientProvider client={makeClient()}>
      <ProviderPracticeProvider>
        <ProviderAccountSection />
      </ProviderPracticeProvider>
    </QueryClientProvider>,
  );
  // The practice list, the profile and the per-lab billing all load in
  // effects; wait for the lab block rather than guessing at tick counts.
  await waitFor(() => expect(utils.getByTestId(`provider-account-lab-${PRACTICE.id}`)).toBeTruthy());
  await flush();
  return utils;
}

async function renderShell() {
  const utils = await render(
    <QueryClientProvider client={makeClient()}>
      <ProviderPracticeProvider>
        <ProviderPortalShell />
      </ProviderPracticeProvider>
    </QueryClientProvider>,
  );
  await flush();
  return utils;
}

function noticeText(utils: { getByTestId: (id: string) => { props: Record<string, any> } }): string {
  const notice = utils.getByTestId("provider-account-notice");
  // Notice = icon + message + dismiss; the message is the only text child.
  const children = notice.props.children as unknown[];
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") texts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "props" in (node as Record<string, unknown>)) {
      walk((node as { props?: { children?: unknown } }).props?.children);
    }
  };
  children.forEach(walk);
  return texts.join("");
}

beforeEach(async () => {
  membershipRole = null;
  resetMockAppState();
  resetMockFetchHandler();
  resetProviderCardSetupRouting();
  sent = [];
  server = {
    user: { ...USER },
    contact: { ...CONTACT },
    card: CARD,
    subscription: {
      enabled: false,
      chargeDay: 10,
      authorization: {
        authorizationId: null,
        authorizationStatus: null,
        nextRunAt: null,
        lastResult: null,
        lastFailureReason: null,
        updateCardRequired: false,
      },
    },
    setupStatus: "succeeded",
    cardAfterSetup: CARD,
    authorization: null,
    failures: {},
  };
  installHandler();
  (router.push as ReturnType<typeof vi.fn>).mockClear();
  vi.spyOn(Linking, "canOpenURL").mockResolvedValue(true);
  vi.spyOn(Linking, "openURL").mockResolvedValue(true);
  await AsyncStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetMockFetchHandler();
  resetProviderCardSetupRouting();
});

// ── The provider's own details ─────────────────────────────────────────────
describe("my account — the provider's own details", () => {
  it("lets a direct active practice Owner reach team and ownership management", async () => {
    membershipRole = "owner";
    const ui = await renderAccount();
    await waitFor(() => expect(ui.getByTestId("provider-practice-ownership")).toBeTruthy());
    await fireEvent.press(ui.getByTestId("provider-practice-ownership"));
    expect(router.push).toHaveBeenCalledWith("/settings/organizations");
  });
  it("does not expose practice ownership management to an Administrator", async () => {
    membershipRole = "admin";
    const ui = await renderAccount();
    await waitFor(() => expect(ui.getByDisplayValue(USER.firstName)).toBeTruthy());
    expect(ui.queryByTestId("provider-practice-ownership")).toBeNull();
  });
  it("arrives pre-filled from the provider's account, account number included", async () => {
    const utils = await renderAccount();

    expect(utils.getByTestId("provider-account-profile-firstName").props.value).toBe("Ada");
    expect(utils.getByTestId("provider-account-profile-lastName").props.value).toBe("Nguyen");
    expect(utils.getByTestId("provider-account-profile-practiceName").props.value).toBe("North Dental");
    expect(utils.getByTestId("provider-account-profile-practiceAddress").props.value).toBe(
      "1 Main St, Shelbyville, IL 62565",
    );
    expect(utils.getByTestId("provider-account-profile-email").props.value).toBe("ada@north.example");
    expect(utils.getByTestId("provider-account-profile-phone").props.value).toBe("555-0100");
    expect(utils.getByTestId("provider-account-profile-practicePhone").props.value).toBe("555-0101");
    expect(utils.getByTestId("provider-account-number").props.children).toBe("ACCT-1001");
  });

  it("saves edited details and says so", async () => {
    const utils = await renderAccount();

    await type(utils.getByTestId("provider-account-profile-practicePhone"), "555-0999");
    await press(utils.getByTestId("provider-account-profile-save"));

    const saves = requests("/api/auth/users/user-1/profile");
    expect(saves).toHaveLength(1);
    expect(saves[0].method).toBe("PUT");
    expect(JSON.parse(saves[0].body as string)).toMatchObject({
      firstName: "Ada",
      lastName: "Nguyen",
      email: "ada@north.example",
      practicePhone: "555-0999",
    });
    expect(noticeText(utils)).toContain("Profile updated.");
    expect(server.user.practicePhone).toBe("555-0999");
  });

  it("keeps the typed values and shows the server's reason when the save fails", async () => {
    server.failures.profile = { status: 409, body: { message: "That email is already in use." } };
    const utils = await renderAccount();

    await type(utils.getByTestId("provider-account-profile-email"), "taken@north.example");
    await press(utils.getByTestId("provider-account-profile-save"));

    expect(noticeText(utils)).toContain("That email is already in use.");
    // Nothing was saved, so the attempt must still be on screen to correct.
    expect(utils.getByTestId("provider-account-profile-email").props.value).toBe("taken@north.example");
    expect(server.user.email).toBe("ada@north.example");
  });
});

// ── Shared lab accounts ────────────────────────────────────────────────────
describe("my account — shared lab accounts", () => {
  it("shows the card on file for the linked lab and offers to replace it", async () => {
    const utils = await renderAccount();

    expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`).props.children).toBe(
      "VISA •••• 4242 · Expires 04/27",
    );
    expect(utils.getByTestId(`provider-account-card-setup-${PRACTICE.id}`)).toBeTruthy();
    expect(utils.getByText("Replace card")).toBeTruthy();
  });

  it("offers to add a card when the lab has none", async () => {
    server.card = null;
    const utils = await renderAccount();

    expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`).props.children).toBe(
      "No shared card on file",
    );
    expect(utils.getByText("Add card")).toBeTruthy();
  });

  it("opens Stripe's secure card setup for that lab", async () => {
    const utils = await renderAccount();

    await press(utils.getByTestId(`provider-account-card-setup-${PRACTICE.id}`));

    const checkout = requests("/api/provider/payment-method/setup-checkout");
    expect(checkout).toHaveLength(1);
    expect(JSON.parse(checkout[0].body as string)).toMatchObject({
      providerOrganizationId: PRACTICE.id,
    });
    expect(Linking.openURL).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("shows the billing contact for the lab and saves only what changed", async () => {
    const utils = await renderAccount();

    expect(utils.getByTestId(`provider-account-contact-city-${PRACTICE.id}`).props.value).toBe("Shelbyville");
    await type(utils.getByTestId(`provider-account-contact-city-${PRACTICE.id}`), "Springfield");
    await type(utils.getByTestId(`provider-account-contact-addressLine2-${PRACTICE.id}`), "Suite 200");
    await press(utils.getByTestId(`provider-account-contact-save-${PRACTICE.id}`));

    const saves = requests("/api/organizations/provider-portal-contact");
    expect(saves).toHaveLength(1);
    expect(saves[0].method).toBe("PATCH");
    expect(JSON.parse(saves[0].body as string)).toEqual({
      city: "Springfield",
      addressLine2: "Suite 200",
    });
    expect(noticeText(utils)).toContain("Practice contact details were updated.");
    // Re-read from the server, not from the draft that was sent.
    expect(utils.getByTestId(`provider-account-contact-city-${PRACTICE.id}`).props.value).toBe("Springfield");
    expect(server.contact.city).toBe("Springfield");
  });

  it("refuses to clear the legal practice name", async () => {
    const utils = await renderAccount();

    await type(utils.getByTestId(`provider-account-contact-name-${PRACTICE.id}`), "   ");
    await press(utils.getByTestId(`provider-account-contact-save-${PRACTICE.id}`));

    expect(noticeText(utils)).toContain("Legal practice name cannot be blank.");
    expect(requests("/api/organizations/provider-portal-contact")).toHaveLength(0);
  });

  it("does not send a save when nothing changed", async () => {
    const utils = await renderAccount();

    await press(utils.getByTestId(`provider-account-contact-save-${PRACTICE.id}`));

    expect(noticeText(utils)).toContain("No contact changes to save.");
    expect(requests("/api/organizations/provider-portal-contact")).toHaveLength(0);
  });

  it("keeps the edited contact on screen when the save is rejected", async () => {
    server.failures.contact = { status: 422, body: { message: "Billing email is not valid." } };
    const utils = await renderAccount();

    await type(utils.getByTestId(`provider-account-contact-billingEmail-${PRACTICE.id}`), "not-an-email");
    await press(utils.getByTestId(`provider-account-contact-save-${PRACTICE.id}`));

    expect(noticeText(utils)).toContain("Billing email is not valid.");
    expect(utils.getByTestId(`provider-account-contact-billingEmail-${PRACTICE.id}`).props.value).toBe(
      "not-an-email",
    );
    expect(server.contact.billingEmail).toBe("billing@north.example");
  });
});

// ── Subscription auto-pay ──────────────────────────────────────────────────
describe("my account — subscription auto-pay", () => {
  it("saves the switch and the charge day", async () => {
    const utils = await renderAccount();

    await act(async () => {
      await fireEvent(utils.getByTestId("provider-account-subscription-toggle"), "valueChange", true);
    });
    await type(utils.getByTestId("provider-account-subscription-day"), "5");
    await press(utils.getByTestId("provider-account-subscription-save"));

    const saves = requests("/api/provider/subscription-autopay");
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0].body as string)).toEqual({ enabled: true, chargeDay: 5 });
    expect(noticeText(utils)).toContain("Subscription auto-pay preference saved.");
    expect(utils.getByTestId("provider-account-subscription-toggle").props.value).toBe(true);
    expect(utils.getByTestId("provider-account-subscription-day").props.value).toBe("5");
  });

  it("refuses a charge day outside 1 through 10", async () => {
    const utils = await renderAccount();

    await type(utils.getByTestId("provider-account-subscription-day"), "22");
    await press(utils.getByTestId("provider-account-subscription-save"));

    expect(noticeText(utils)).toContain("Subscription charge day must be from 1 through 10.");
    expect(requests("/api/provider/subscription-autopay")).toHaveLength(0);
  });

  it("puts the controls back to the saved preference when the save fails", async () => {
    server.failures.subscription = { status: 500, body: { error: "Auto-pay is temporarily unavailable." } };
    const utils = await renderAccount();

    await act(async () => {
      await fireEvent(utils.getByTestId("provider-account-subscription-toggle"), "valueChange", true);
    });
    await press(utils.getByTestId("provider-account-subscription-save"));

    expect(noticeText(utils)).toContain("Auto-pay is temporarily unavailable.");
    // Nothing saved: the switch must not sit in the state that was refused.
    expect(utils.getByTestId("provider-account-subscription-toggle").props.value).toBe(false);
    expect(server.subscription.enabled).toBe(false);
  });

  it("says whether a signed authorization is in place, and signs it without leaving My Account", async () => {
    const utils = await renderAccount();

    expect(
      utils.getByTestId("provider-account-subscription-authorization-state").props.children,
    ).toBe("A signed authorization is required before charges can run.");
    // The agreement is right here, the way desktop presents it.
    expect(utils.getByTestId("provider-account-subscription-authorization")).toBeTruthy();
    await waitFor(() =>
      expect(
        utils.getByText("LabTrax may charge the card on file for the amounts authorized below."),
      ).toBeTruthy(),
    );

    await press(utils.getByTestId("provider-authorization-subscription-fees"));
    await type(utils.getByTestId("provider-authorization-legal-name"), "Ada Nguyen");
    await press(utils.getByTestId("provider-authorization-consent"));
    await press(utils.getByTestId("submit-provider-authorization"));

    const signed = requests("/api/provider/autopay-authorization").filter(
      (entry) => entry.method === "POST",
    );
    expect(signed).toHaveLength(1);
    expect(JSON.parse(signed[0].body as string)).toMatchObject({
      providerOrganizationId: PRACTICE.id,
      agreementVersion: "2026-02",
      agreementSha256: "sha-2026-02",
      subscriptionFees: true,
      labBills: false,
      labOrganizationIds: [],
      labChargeDay: null,
      typedLegalName: "Ada Nguyen",
      consent: true,
      signatureData: "data:image/png;base64,SIGNATURE",
    });
    // Nothing navigated away, and the state line the provider reads is the
    // one that has to catch up.
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        utils.getByTestId("provider-account-subscription-authorization-state").props.children,
      ).toBe("Signed authorization active"),
    );
  });

  it("keeps the provider in My Account when the signature is refused", async () => {
    const utils = await renderAccount();

    await press(utils.getByTestId("provider-authorization-subscription-fees"));
    await type(utils.getByTestId("provider-authorization-legal-name"), "Ada Nguyen");
    await press(utils.getByTestId("provider-authorization-consent"));
    server.failures.authorization = {
      status: 422,
      body: { error: "The card on file expired. Update it before authorizing." },
    };
    await press(utils.getByTestId("submit-provider-authorization"));

    expect(utils.getByTestId("provider-authorization-error").props.children).toBe(
      "The card on file expired. Update it before authorizing.",
    );
    expect(
      utils.getByTestId("provider-account-subscription-authorization-state").props.children,
    ).toBe("A signed authorization is required before charges can run.");
    // The typed name survives, so the provider can sign again after fixing it.
    expect(utils.getByTestId("provider-authorization-legal-name").props.value).toBe("Ada Nguyen");
  });

  it("warns when a new card means the authorization has to be signed again", async () => {
    server.subscription = {
      enabled: true,
      chargeDay: 3,
      authorization: {
        authorizationId: "auth-1",
        authorizationStatus: "active",
        nextRunAt: null,
        lastResult: "failed",
        lastFailureReason: "Card declined",
        updateCardRequired: true,
      },
    };
    const utils = await renderAccount();

    expect(utils.getByTestId("provider-account-subscription-card-warning")).toBeTruthy();
    expect(utils.getByText("Last attempt failed: Card declined")).toBeTruthy();
    expect(
      utils.getByTestId("provider-account-subscription-authorization-state").props.children,
    ).toBe("Signed authorization active");
  });
});

// ── Coming back from Stripe ────────────────────────────────────────────────
describe("my account — returning from card setup", () => {
  it("lands back in My Account with the card state re-read", async () => {
    server.card = null;
    const utils = await renderShell();
    expect(utils.queryByTestId("provider-portal-section-account")).toBeNull();

    await act(async () => {
      routeProviderCardSetupReturn({ sessionId: "cs_test_123", cancelled: false });
      setProviderCardSetupShell("provider");
    });
    await waitFor(() => expect(utils.getByTestId("provider-portal-section-account")).toBeTruthy());
    await waitFor(() =>
      expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`).props.children).toBe(
        "VISA •••• 4242 · Expires 04/27",
      ),
    );

    expect(requests("/api/provider/payment-method/setup-status/cs_test_123")).toHaveLength(1);
    expect(noticeText(utils)).toContain("Your shared card was updated securely.");
  });

  it("says the card is unchanged when the provider backed out of Stripe", async () => {
    server.card = null;
    const utils = await renderShell();

    await act(async () => {
      routeProviderCardSetupReturn({ sessionId: "cs_test_456", cancelled: true });
      setProviderCardSetupShell("provider");
    });
    await waitFor(() => expect(utils.getByTestId("provider-portal-section-account")).toBeTruthy());
    await waitFor(() =>
      expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`)).toBeTruthy(),
    );

    expect(noticeText(utils)).toContain("Card setup was cancelled. No card was changed.");
    expect(requests("/api/provider/payment-method/setup-status/")).toHaveLength(0);
    expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`).props.children).toBe(
      "No shared card on file",
    );
  });

  it("tells the provider to start again when the setup session expired", async () => {
    server.card = null;
    server.setupStatus = "expired";
    const utils = await renderShell();

    await act(async () => {
      setProviderCardSetupShell("provider");
      routeProviderCardSetupReturn({ sessionId: "cs_test_789", cancelled: false });
    });
    await waitFor(() => expect(utils.getByTestId("provider-portal-section-account")).toBeTruthy());
    await waitFor(() =>
      expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`)).toBeTruthy(),
    );

    expect(noticeText(utils)).toContain("That card setup session expired. Please start again.");
    expect(utils.getByTestId(`provider-account-card-state-${PRACTICE.id}`).props.children).toBe(
      "No shared card on file",
    );
  });
});
