/** @vitest-environment jsdom */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SubscriptionsPanel } from "../settings-subscriptions";
import SettingsPage from "../settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { ApiError, apiFetch } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const future = () => new Date(Date.now() + 3_600_000).toISOString();
let ACCESS: { isCreator: boolean; pinConfigured: boolean; unlocked: boolean; expiresAt: string | null };
let access: typeof ACCESS;
const AUTHED = { user: { id: "u1", username: "creator" } as never, status: "authed" as const };
function respondWith(fn: (url: unknown, ...rest: unknown[]) => Promise<unknown>) {
  vi.mocked(apiFetch).mockImplementation((async (url: unknown, ...rest: unknown[]) =>
    String(url) === "/creator/access" ? access : fn(url, ...rest)) as never);
}
function respond(value: unknown) { respondWith(async () => value); }

describe("SubscriptionsPanel", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    ACCESS = { isCreator: true, pinConfigured: true, unlocked: true, expiresAt: future() };
    access = ACCESS;
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  const mockSub = {
    id: "sub_1",
    subjectType: "provider_org",
    subjectId: "org_1",
    provider: "stripe",
    providerPlan: "standard",
    monthlyPriceUsd: 99,
    capabilities: ["all"],
    status: "active",
    waiverReason: null,
    waiverStartsAt: null,
    waiverEndsAt: null,
    waiverGrantedAt: null,
    waiverGrantedByUserId: null,
    waiverActive: false,
    currentPeriodEnd: new Date().toISOString(),
    trialEndAt: null,
    canceledAt: null,
    cancelAtPeriodEnd: false,
    paymentMethodOnFile: true,
    processorState: {
      provider: "stripe",
      hasStripeCustomer: true,
      hasStripeSubscription: true,
      hasRevenueCatAccount: false,
    },
    accountHolderName: "Dr. Smith DDS",
    accountType: "Provider",
    canonicalAccountNumber: "ACCT-123",
    canonicalSubjectType: "provider_org",
    canonicalSubjectId: "org_1",
    formattedAddress: "123 Main St, Suite 4, Austin, TX 78701",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    organization: {
      id: "org_1",
      name: "Dr. Smith DDS",
      type: "provider",
      accountNumber: "ACCT-123",
    },
    account: null,
  };

  const mockPlans = [
    { id: "basic", monthlyPriceUsd: 49, capabilities: [] },
    { id: "standard", monthlyPriceUsd: 99, capabilities: [] }
  ];

  it("renders the table and filters", async () => {
    respond({
      ok: true,
      items: [mockSub],
      total: 1,
      limit: 100,
      offset: 0,
      plans: mockPlans
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);

    await waitFor(() => {
      expect(screen.getByText("Dr. Smith DDS")).toBeInTheDocument();
    });
    expect(screen.getByText("123 Main St, Suite 4, Austin, TX 78701")).toBeInTheDocument();
    expect(screen.getByText("ACCT-123")).toBeInTheDocument();

    // Check filters exist
    expect(screen.getByTestId("input-search-subscriptions")).toBeInTheDocument();
    expect(screen.getByTestId("select-filter-provider")).toBeInTheDocument();
    expect(screen.getByTestId("select-filter-status")).toBeInTheDocument();
    expect(screen.getByTestId("select-filter-type")).toBeInTheDocument();
  });

  it("opens details sheet when Manage is clicked", async () => {
    respondWith(async (url: unknown) => {
      if (typeof url === 'string' && url.includes("/history")) {
        return { ok: true, subscription: mockSub, events: [], audits: [] };
      }
      return {
        ok: true,
        items: [mockSub],
        total: 1,
        limit: 100,
        offset: 0,
        plans: mockPlans
      };
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);

    const manageBtn = await screen.findByTestId("button-details-sub_1");
    fireEvent.click(manageBtn);

    await waitFor(() => {
      expect(screen.getByTestId("sheet-subscription-detail")).toBeInTheDocument();
      expect(screen.getByText("Subscription Details")).toBeInTheDocument();
      expect(screen.getByTestId("btn-edit-plan-status")).toBeInTheDocument();
    });
  });

  it("allows granting a waiver", async () => {
    respondWith(async (url: unknown, opts: unknown) => {
      if (typeof url === 'string' && url.includes("/history")) return { ok: true, subscription: mockSub, events: [], audits: [] };
      if (typeof url === 'string' && url.includes("/waiver") && (opts as any)?.method === "PUT") return { ok: true, subscription: { ...mockSub, waiverReason: "test", waiverActive: true } };
      return { ok: true, items: [mockSub], total: 1, limit: 100, offset: 0, plans: mockPlans };
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);

    fireEvent.click(await screen.findByTestId("button-details-sub_1"));
    
    await waitFor(() => expect(screen.getByTestId("btn-grant-waiver")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("btn-grant-waiver"));
    
    await waitFor(() => expect(screen.getByTestId("input-waiver-reason")).toBeInTheDocument());
    
    const input = screen.getByTestId("input-waiver-reason") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Special deal" } });
    
    fireEvent.click(screen.getByTestId("btn-save-waiver"));
    
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining("/waiver"),
        expect.objectContaining({ method: "PUT", body: expect.stringContaining("Special deal") })
      );
    });
  });

  it("sends only changed plan and status fields", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    respondWith(async (url: unknown, opts?: RequestInit) => {
      calls.push({ url: String(url), body: opts?.body as string | undefined });
      if (String(url).includes("/history")) {
        return { ok: true, subscription: mockSub, events: [], audits: [] };
      }
      if (opts?.method === "PATCH") {
        return { ok: true, subscription: { ...mockSub, status: "grace" } };
      }
      return { ok: true, items: [mockSub], total: 1, limit: 100, offset: 0, plans: mockPlans };
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);
    fireEvent.click(await screen.findByTestId("button-details-sub_1"));
    fireEvent.click(await screen.findByTestId("btn-edit-plan-status"));
    fireEvent.change(screen.getByTestId("select-edit-status"), {
      target: { value: "grace" },
    });
    fireEvent.click(screen.getByTestId("btn-save-plan-status"));

    await waitFor(() => {
      const update = calls.find(
        (call) => call.url.endsWith("/sub_1") && call.body,
      );
      expect(JSON.parse(update!.body!)).toEqual({ status: "grace" });
    });
  });

  it("shows an account-number conflict verbatim in the detail form", async () => {
    const conflict = "Account number is already assigned.";
    respondWith(async (url: unknown, opts?: RequestInit) => {
      if (String(url).includes("/history")) {
        return { ok: true, subscription: mockSub, events: [], audits: [] };
      }
      if (String(url).includes("/account-number") && opts?.method === "PATCH") {
        throw new ApiError(conflict, 409, { error: conflict });
      }
      return { ok: true, items: [mockSub], total: 1, limit: 100, offset: 0, plans: mockPlans };
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);
    fireEvent.click(await screen.findByTestId("button-details-sub_1"));
    fireEvent.click(await screen.findByTestId("btn-edit-account-number"));
    fireEvent.change(screen.getByTestId("input-edit-account-number"), {
      target: { value: "DUP-001" },
    });
    fireEvent.click(screen.getByTestId("btn-save-account-number"));

    expect(await screen.findByText(conflict)).toBeInTheDocument();
  });

  it("filters the loaded directory by account type and waiver state", async () => {
    const labSub = {
      ...mockSub,
      id: "sub_lab",
      subjectType: "lab_org",
      canonicalSubjectType: "lab_org",
      accountHolderName: "Precision Lab",
      accountType: "Lab",
      providerPlan: null,
      monthlyPriceUsd: null,
      waiverReason: "Launch partner",
      waiverStartsAt: "2026-01-01T00:00:00.000Z",
      waiverEndsAt: null,
      waiverActive: true,
    };
    respond({
      ok: true,
      items: [mockSub, labSub],
      total: 2,
      limit: 100,
      offset: 0,
      plans: mockPlans,
    });

    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);
    await screen.findByText("Precision Lab");

    fireEvent.change(screen.getByTestId("select-filter-type"), {
      target: { value: "Lab" },
    });
    fireEvent.change(screen.getByTestId("select-filter-waiver"), {
      target: { value: "active" },
    });

    await waitFor(() => {
      const lastListCall = vi.mocked(apiFetch).mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith("/admin/provider-subscriptions?"))
        .at(-1);
      expect(lastListCall).toContain("accountType=Lab");
      expect(lastListCall).toContain("waiver=active");
    });
  });

  it("Settings no longer lists Subscriptions (moved to Creator)", async () => {
    window.history.replaceState({}, "", "/settings");
    respondWith(async () => ({}));
    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    const view = render(<Wrapper><SettingsPage /></Wrapper>);
    expect(screen.queryByRole("button", { name: "Subscriptions" })).not.toBeInTheDocument();
    view.unmount();
  });

  it("gates the directory behind the Creator PIN and never fetches while locked", async () => {
    access = { ...ACCESS, unlocked: false };
    respond({});
    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);
    expect(await screen.findByTestId("creator-gate")).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.some((c) => String(c[0]).startsWith("/admin/provider-subscriptions"))).toBe(false);
  });

  it("shows the full summary with byStatus and byProvider breakdowns", async () => {
    respond({ ok: true, items: [], total: 0, limit: 100, offset: 0, plans: mockPlans,
      summary: { totalAccounts: 5, paidSubscribers: 2, trial: 1, free: 1, waived: 1, other: 0, byStatus: { active: 3, grace: 2 }, byProvider: { stripe: 4 } } });
    const Wrapper = makeAuthWrapper("/settings", AUTHED);
    render(<Wrapper><SubscriptionsPanel /></Wrapper>);
    expect(await screen.findByTestId("subscription-byStatus")).toHaveTextContent("grace 2");
    expect(screen.getByTestId("subscription-byProvider")).toHaveTextContent("stripe 4");
  });
});
