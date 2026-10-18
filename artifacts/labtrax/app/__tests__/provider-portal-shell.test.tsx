// Mobile provider portal shell.
//
// Covers the outcomes the portal is responsible for: providers land on the
// portal and lab users do not, the heads-up display shows the practice account
// number and only offers a switcher when there is something to switch to,
// switching re-scopes every later request (and drops the previous practice's
// cached data), the server asking for a practice shows the picker instead of an
// error, notifications deep-link to the right section, and the settings entry
// reaches the same two preference screens the desktop gear opens.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppState, Text } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import {
  mockProviderOrganizationId,
  resetMockAppState,
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";
import type { InAppNotification } from "@/lib/in-app-notifications";

// ── Local mocks ────────────────────────────────────────────────────────────
// The global setup replaces `useQueryClient` with a two-method stub. The
// practice provider needs a genuine client (it removes practice-scoped cache
// entries on a switch), and nothing rendered here reads a globally-mocked
// query hook, so this file uses React Query for real.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

// The global setup signs in as a lab user; the portal is a provider surface,
// so auth and memberships are driven from mutable slots this file owns.
const authState: { currentUser: string; userType: string; logout: ReturnType<typeof vi.fn> } = {
  currentUser: "dr.smith",
  userType: "provider",
  logout: vi.fn(),
};
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: React.PropsWithChildren<unknown>) => children ?? null,
}));

const meState: { data: unknown; isError: boolean } = { data: undefined, isError: false };
vi.mock("@/lib/auth-me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-me")>();
  return { ...actual, useMe: () => meState };
});

const notificationState: { items: InAppNotification[] } = { items: [] };
const markRead = vi.fn(async () => undefined);
const markAllRead = vi.fn(async () => undefined);
vi.mock("@/lib/in-app-notifications", () => ({
  IN_APP_NOTIFICATIONS_QUERY_KEY: ["in-app-notifications"],
  useInAppNotifications: () => ({
    items: notificationState.items,
    unreadCount: notificationState.items.filter((item) => !item.readAt).length,
    isLoading: false,
  }),
  useNotificationActions: () => ({ markRead, markAllRead }),
}));

import { ProviderPortalShell } from "@/components/provider-portal/ProviderPortalShell";
import {
  publishProviderCheckoutReturn,
  resetProviderCheckoutReturn,
} from "@/lib/provider-checkout-return";
import { ProviderPracticeProvider, PROVIDER_PRACTICE_STORAGE_KEY } from "@/lib/provider-practice";
import { useProviderPortalDecision } from "@/lib/provider-portal";

// ── Fixtures ───────────────────────────────────────────────────────────────
const NORTH = { id: "prac-north", name: "North Dental", accountNumber: "ACCT-1001" };
const SOUTH = { id: "prac-south", name: "South Dental", accountNumber: "ACCT-2002" };

function notification(overrides: Partial<InAppNotification>): InAppNotification {
  return {
    id: "n1",
    type: "lab_payment_recorded",
    title: "Payment recorded",
    body: "$120.00",
    dataJson: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Requests the portal made, so tests can assert what was sent and in what order. */
let sent: Array<{ url: string; method: string; body: string | null }> = [];

interface HandlerOptions {
  practices: Array<{ id: string; name: string; accountNumber?: string }>;
  /** Practice ids whose selection confirm should fail, and how. */
  selectionFailures?: Record<string, { status: number; body: unknown }>;
  organizationsError?: { status: number; body: unknown };
}

function installHandler({
  practices,
  selectionFailures = {},
  organizationsError,
}: HandlerOptions): void {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ url, method, body });

    if (url.includes("/api/provider/organizations")) {
      if (organizationsError) {
        return new Response(JSON.stringify(organizationsError.body), {
          status: organizationsError.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: practices }), { status: 200 });
    }

    if (url.includes("/api/provider/selection")) {
      const requested = body ? (JSON.parse(body) as { providerOrganizationId?: string }) : {};
      const failure = requested.providerOrganizationId
        ? selectionFailures[requested.providerOrganizationId]
        : undefined;
      if (failure) {
        return new Response(JSON.stringify(failure.body), {
          status: failure.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { ok: true } }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
  });
}

async function renderPortal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <ProviderPracticeProvider>
        <ProviderPortalShell />
      </ProviderPracticeProvider>
    </QueryClientProvider>
  );
  const utils = await render(tree);
  // The provider loads its practice list (and any stored selection) in an
  // effect; flush that before the assertions look at the portal.
  await flush();
  return { ...utils, client };
}

/** Let queued promises and the state updates they cause settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Press a control and let the resulting async work settle. */
async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    await fireEvent.press(element);
  });
}

function selectionRequests(): Array<{ providerOrganizationId?: string }> {
  return sent
    .filter((r) => r.url.includes("/api/provider/selection") && r.body)
    .map((r) => JSON.parse(r.body as string) as { providerOrganizationId?: string });
}

beforeEach(async () => {
  resetMockAppState();
  resetMockFetchHandler();
  resetProviderCheckoutReturn();
  sent = [];
  authState.currentUser = "dr.smith";
  authState.userType = "provider";
  authState.logout = vi.fn();
  meState.data = { user: { firstName: "Ada", username: "dr.smith" }, memberships: [] };
  meState.isError = false;
  notificationState.items = [];
  markRead.mockClear();
  markAllRead.mockClear();
  (router.push as ReturnType<typeof vi.fn>).mockClear();
  await AsyncStorage.clear();
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
});

// ── Routing ────────────────────────────────────────────────────────────────
describe("who gets the provider portal", () => {
  function Decision() {
    return <Text testID="decision">{useProviderPortalDecision()}</Text>;
  }

  it("routes a provider account with no lab membership to the portal", async () => {
    meState.data = {
      user: {},
      memberships: [
        { organizationId: "prac-north", role: "owner", status: "active", organization: { type: "practice" } },
      ],
    };
    const { getByTestId } = await render(<Decision />);
    expect(String(getByTestId("decision").props.children)).toBe("provider");
  });

  it("keeps lab users, and dual lab+provider users, on the lab shell", async () => {
    authState.userType = "lab";
    const { getByTestId, rerender } = await render(<Decision />);
    expect(String(getByTestId("decision").props.children)).toBe("lab");

    authState.userType = "provider";
    meState.data = {
      user: {},
      memberships: [
        { organizationId: "prac-north", role: "owner", status: "active", organization: { type: "practice" } },
        { organizationId: "lab-1", role: "admin", status: "active", organization: { type: "lab" } },
      ],
    };
    await rerender(<Decision />);
    expect(String(getByTestId("decision").props.children)).toBe("lab");
  });

  it("gates the two shells on that decision in the root layout", async () => {
    // The guard lives in the navigator so the lab tab screens never mount for
    // a provider. Asserted against the source because the navigator itself is
    // mocked away in this environment.
    const layout = fs.readFileSync(
      path.join(__dirname, "..", "_layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("useProviderPortalDecision()");
    expect(layout).toMatch(
      /<Stack\.Protected guard=\{shell === "provider"\}>\s*<Stack\.Screen name="provider-portal"/,
    );
    expect(layout).toMatch(
      /<Stack\.Protected guard=\{shell === "lab"\}>\s*<Stack\.Screen name="\(tabs\)"/,
    );
  });
});

// ── Header ─────────────────────────────────────────────────────────────────
describe("portal header", () => {
  it("shows the provider's name and practice account number, with no switcher for a single practice", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId, queryByTestId } = await renderPortal();

    const identity = getByTestId("provider-portal-identity");
    expect(JSON.stringify(identity.props.children)).toContain("Ada");
    expect(JSON.stringify(identity.props.children)).toContain("ACCT-1001");
    expect(queryByTestId("provider-practice-switcher")).toBeNull();
    // A single practice is selected for the user — no picker, no prompt.
    expect(queryByTestId("provider-practice-picker")).toBeNull();
    expect(mockProviderOrganizationId.current).toBe("prac-north");
  });

  it("falls back to the username when the account has no first name", async () => {
    meState.data = { user: { username: "dr.smith" }, memberships: [] };
    installHandler({ practices: [NORTH] });
    const { getByTestId } = await renderPortal();
    expect(JSON.stringify(getByTestId("provider-portal-identity").props.children)).toContain(
      "dr.smith",
    );
  });

  it("offers a switcher only when the account is linked to more than one practice", async () => {
    await AsyncStorage.setItem(PROVIDER_PRACTICE_STORAGE_KEY, NORTH.id);
    installHandler({ practices: [NORTH, SOUTH] });
    const { getByTestId } = await renderPortal();

    expect(getByTestId("provider-practice-switcher")).toBeTruthy();
    expect(JSON.stringify(getByTestId("provider-portal-identity").props.children)).toContain(
      "ACCT-1001",
    );
  });

  const payment = (readAt: string | null): InAppNotification => ({
    id: "n1",
    type: "lab_payment_recorded",
    title: "Payment recorded",
    body: "$120.00",
    dataJson: null,
    readAt,
    createdAt: new Date().toISOString(),
  });

  it("marks the bell unread while something is unread", async () => {
    notificationState.items = [payment(null)];
    installHandler({ practices: [NORTH] });
    const { queryByTestId } = await renderPortal();
    expect(queryByTestId("provider-portal-bell-unread")).toBeTruthy();
  });

  it("drops the unread mark once everything has been read", async () => {
    notificationState.items = [payment(new Date().toISOString())];
    installHandler({ practices: [NORTH] });
    const { queryByTestId } = await renderPortal();
    expect(queryByTestId("provider-portal-bell")).toBeTruthy();
    expect(queryByTestId("provider-portal-bell-unread")).toBeNull();
  });

  it("signs the provider out from the header", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId } = await renderPortal();
    await press(getByTestId("provider-portal-sign-out"));
    expect(authState.logout).toHaveBeenCalled();
  });
});

// ── Navigation ─────────────────────────────────────────────────────────────
describe("portal navigation", () => {
  it("opens a drawer with the five full desktop labels in order and renders each section", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId, queryByTestId } = await renderPortal();

    expect(getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
    expect(queryByTestId("provider-portal-tabbar")).toBeNull();
    await press(getByTestId("provider-portal-menu"));

    expect(
      ["dashboard", "account", "billing", "messages", "stats"].map(
        (key) => getByTestId(`provider-portal-drawer-${key}`).props.accessibilityLabel,
      ),
    ).toEqual(["Dashboard", "My Account", "View and Pay My Bill", "Message My Lab", "Stats"]);
    for (const key of ["dashboard", "account", "billing", "messages", "stats"]) {
      expect(getByTestId(`provider-portal-drawer-${key}`).props.accessibilityRole).toBe(
        "menuitem",
      );
    }
    expect(getByTestId("provider-portal-drawer-dashboard").props.accessibilityState).toEqual({
      selected: true,
    });

    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();
    for (const key of ["account", "billing", "messages", "stats"] as const) {
      await press(getByTestId(`provider-portal-drawer-${key}`));
      expect(getByTestId(`provider-portal-section-${key}`)).toBeTruthy();
      expect(getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
      await press(getByTestId("provider-portal-menu"));
    }
    await press(getByTestId("provider-portal-drawer-dashboard"));
    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();
  });

  it("dismisses the drawer from the close control, backdrop, and platform back without changing sections", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId, queryByTestId } = await renderPortal();

    await press(getByTestId("provider-portal-menu"));
    await press(getByTestId("provider-portal-drawer-close"));
    expect(getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();

    await press(getByTestId("provider-portal-menu"));
    await press(getByTestId("provider-portal-drawer-backdrop"));
    expect(getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();

    await press(getByTestId("provider-portal-menu"));
    await act(async () => {
      fireEvent(getByTestId("provider-portal-drawer-modal"), "requestClose");
    });
    expect(getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();
  });

  it("reaches notification and doctor preferences from the settings entry", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId } = await renderPortal();

    await press(getByTestId("provider-portal-settings"));
    expect(getByTestId("provider-portal-section-settings")).toBeTruthy();

    await press(getByTestId("provider-portal-settings-notifications"));
    expect(router.push).toHaveBeenCalledWith("/settings/notifications");
    await press(getByTestId("provider-portal-settings-doctor-preferences"));
    expect(router.push).toHaveBeenCalledWith("/settings/doctor-preferences");
  });
});

// ── Notifications ──────────────────────────────────────────────────────────
describe("notification deep links", () => {
  it("opens billing from a payment notification", async () => {
    notificationState.items = [notification({ id: "pay-1" })];
    installHandler({ practices: [NORTH] });
    const { getByTestId } = await renderPortal();

    await press(getByTestId("provider-portal-bell"));
    await press(getByTestId("provider-portal-notification-pay-1"));

    expect(getByTestId("provider-portal-section-billing")).toBeTruthy();
    expect(markRead).toHaveBeenCalledWith("pay-1");
  });

  it("opens the Dashboard on the shared case from a shared-note notification", async () => {
    notificationState.items = [
      notification({
        id: "note-1",
        type: "shared_note_added",
        title: "New note",
        dataJson: { caseId: "case-42" },
      }),
    ];
    installHandler({ practices: [NORTH] });
    const { getByTestId } = await renderPortal();

    // Start somewhere else so the deep-link has to move the portal.
    await press(getByTestId("provider-portal-menu"));
    await press(getByTestId("provider-portal-drawer-stats"));
    await press(getByTestId("provider-portal-bell"));
    await press(getByTestId("provider-portal-notification-note-1"));

    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();
    await press(getByTestId("provider-portal-menu"));
    expect(getByTestId("provider-portal-drawer-dashboard").props.accessibilityState).toEqual({
      selected: true,
    });
    // The shell hands the section the case the notification pointed at, and
    // the Dashboard opens the mobile provider case detail route for it.
    expect(router.push).toHaveBeenCalledWith("/case/provider/case-42");
  });
});

// ── Practice selection ─────────────────────────────────────────────────────
describe("practice selection", () => {
  it("shows actionable pending-access content rather than switching forever with zero practices", async () => {
    installHandler({ practices: [] });
    const view = await renderPortal();
    expect(view.getByTestId("provider-portal-no-practice")).toBeTruthy();
    expect(view.queryByTestId("provider-portal-switching")).toBeNull();
    for (const section of ["dashboard", "billing", "messages", "stats"]) {
      await press(view.getByTestId("provider-portal-menu"));
      await press(view.getByTestId(`provider-portal-drawer-${section}`));
      expect(view.getByTestId("provider-portal-no-practice")).toBeTruthy();
      expect(view.getByTestId("provider-portal-drawer-modal").props.visible).toBe(false);
    }
    await press(view.getByTestId("provider-portal-menu"));
    await press(view.getByTestId("provider-portal-drawer-account"));
    expect(view.getByTestId("provider-portal-section-account")).toBeTruthy();
    await press(view.getByTestId("provider-portal-settings"));
    expect(view.getByTestId("provider-portal-section-settings")).toBeTruthy();
    await press(view.getByTestId("provider-portal-bell"));
    await press(view.getByTestId("provider-portal-notifications-close"));
    expect(markAllRead).toHaveBeenCalled();
    await press(view.getByTestId("provider-portal-sign-out"));
    expect(authState.logout).toHaveBeenCalled();
  });
  it("refreshes access after approval", async () => {
    installHandler({ practices: [] });
    const view = await renderPortal();
    installHandler({ practices: [NORTH] });
    await press(view.getByTestId("provider-portal-access-refresh"));
    await flush();
    expect(view.getByTestId("provider-portal-section-dashboard")).toBeTruthy();
    expect(mockProviderOrganizationId.current).toBe(NORTH.id);
  });
  it("requires confirmed initial selection and offers a retry when it fails", async () => {
    installHandler({ practices: [NORTH], selectionFailures: {
      [NORTH.id]: { status: 503, body: { message: "Selection unavailable" } },
    } });
    const view = await renderPortal();
    expect(mockProviderOrganizationId.current).toBeNull();
    expect(view.queryByTestId("provider-portal-section-dashboard")).toBeNull();
    expect(view.getByTestId("provider-practice-picker")).toBeTruthy();
    installHandler({ practices: [NORTH] });
    await press(view.getByTestId(`provider-practice-choice-${NORTH.id}`));
    expect(mockProviderOrganizationId.current).toBe(NORTH.id);
  });
  it("removes revoked persisted selection and validates again on foreground", async () => {
    await AsyncStorage.setItem(PROVIDER_PRACTICE_STORAGE_KEY, SOUTH.id);
    installHandler({ practices: [NORTH, SOUTH] });
    const view = await renderPortal();
    expect(mockProviderOrganizationId.current).toBe(SOUTH.id);
    installHandler({ practices: [] });
    const listener = vi.mocked(AppState.addEventListener).mock.calls.filter(([name]) => name === "change").at(-1)![1];
    await act(async () => listener("active"));
    await flush();
    expect(view.getByTestId("provider-portal-no-practice")).toBeTruthy();
    expect(mockProviderOrganizationId.current).toBeNull();
    expect(await AsyncStorage.getItem(PROVIDER_PRACTICE_STORAGE_KEY)).toBeNull();
  });
  it("rejects stale list results after a reload", async () => {
    let finish!: (response: Response) => void;
    setMockFetchHandler((url) => url.includes("/organizations") ? new Promise<Response>((resolve) => { finish = resolve; }) :
      new Response(JSON.stringify({ ok: true, data: {} })));
    const view = await renderPortal();
    installHandler({ practices: [] });
    const listener = vi.mocked(AppState.addEventListener).mock.calls.filter(([name]) => name === "change").at(-1)![1];
    await act(async () => listener("active"));
    await flush();
    await act(async () => finish(new Response(JSON.stringify({ ok: true, data: [NORTH] }))));
    expect(view.getByTestId("provider-portal-no-practice")).toBeTruthy();
    expect(mockProviderOrganizationId.current).toBeNull();
  });
  it("shows the picker when several practices exist and none is stored", async () => {
    installHandler({ practices: [NORTH, SOUTH] });
    const { getByTestId, queryByTestId } = await renderPortal();

    expect(getByTestId("provider-practice-picker")).toBeTruthy();
    expect(queryByTestId("provider-portal-section-dashboard")).toBeNull();
    expect(mockProviderOrganizationId.current).toBeNull();

    await press(getByTestId(`provider-practice-choice-${SOUTH.id}`));
    expect(mockProviderOrganizationId.current).toBe(SOUTH.id);
    expect(getByTestId("provider-portal-section-dashboard")).toBeTruthy();
  });

  it("restores the stored practice on a later launch", async () => {
    await AsyncStorage.setItem(PROVIDER_PRACTICE_STORAGE_KEY, SOUTH.id);
    installHandler({ practices: [NORTH, SOUTH] });
    const { queryByTestId } = await renderPortal();

    expect(queryByTestId("provider-practice-picker")).toBeNull();
    expect(mockProviderOrganizationId.current).toBe(SOUTH.id);
  });

  it("re-scopes every later request to the newly selected practice and drops the old data", async () => {
    await AsyncStorage.setItem(PROVIDER_PRACTICE_STORAGE_KEY, NORTH.id);
    installHandler({ practices: [NORTH, SOUTH] });
    const { getByTestId, client } = await renderPortal();

    client.setQueryData(["provider-cases", { status: "all" }], [{ id: "north-case" }]);
    expect(mockProviderOrganizationId.current).toBe(NORTH.id);

    await press(getByTestId(`provider-practice-option-${SOUTH.id}`));

    // The active practice every subsequent request is stamped with.
    expect(mockProviderOrganizationId.current).toBe(SOUTH.id);
    expect(selectionRequests().at(-1)).toEqual({ providerOrganizationId: SOUTH.id });
    // Nothing from the previous practice is left to paint.
    expect(client.getQueryData(["provider-cases", { status: "all" }])).toBeUndefined();
    expect(JSON.stringify(getByTestId("provider-portal-identity").props.children)).toContain(
      "ACCT-2002",
    );
    expect(await AsyncStorage.getItem(PROVIDER_PRACTICE_STORAGE_KEY)).toBe(SOUTH.id);
  });

  it("reports a failed switch and rolls back instead of half-switching", async () => {
    await AsyncStorage.setItem(PROVIDER_PRACTICE_STORAGE_KEY, NORTH.id);
    installHandler({
      practices: [NORTH, SOUTH],
      selectionFailures: {
        [SOUTH.id]: { status: 500, body: { message: "Practice unavailable." } },
      },
    });
    const { getByTestId, getByText } = await renderPortal();

    await press(getByTestId(`provider-practice-option-${SOUTH.id}`));
    expect(getByTestId("provider-portal-switch-error")).toBeTruthy();
    expect(getByText(/Practice unavailable\./)).toBeTruthy();
    expect(mockProviderOrganizationId.current).toBe(NORTH.id);
    expect(JSON.stringify(getByTestId("provider-portal-identity").props.children)).toContain(
      "ACCT-1001",
    );
  });
});

// ── Returning from Stripe ──────────────────────────────────────────────────
// A provider who pays from the portal leaves the app for Stripe's hosted page.
// Whatever state the app is in when they come back, they land on the section
// that started the payment rather than on the dashboard.
describe("returning from a hosted checkout", () => {
  it("opens Billing when the return arrived before the portal was mounted", async () => {
    installHandler({ practices: [NORTH] });
    publishProviderCheckoutReturn({
      checkoutId: "co_1",
      cardSetupSession: null,
      cancelled: false,
    });

    const { getByTestId, queryByTestId } = await renderPortal();

    expect(getByTestId("provider-portal-section-billing")).toBeTruthy();
    expect(queryByTestId("provider-practice-picker")).toBeNull();
    expect(queryByTestId("provider-portal-load-error")).toBeNull();
    expect(mockProviderOrganizationId.current).toBe(NORTH.id);
  });

  it("opens Billing when the return arrives after the portal is mounted", async () => {
    installHandler({ practices: [NORTH] });
    const { getByTestId, queryByTestId } = await renderPortal();
    expect(queryByTestId("provider-portal-section-billing")).toBeNull();

    await act(async () => {
      publishProviderCheckoutReturn({
        checkoutId: "co_2",
        cardSetupSession: null,
        cancelled: true,
      });
    });
    await flush();

    expect(getByTestId("provider-portal-section-billing")).toBeTruthy();
  });
});
