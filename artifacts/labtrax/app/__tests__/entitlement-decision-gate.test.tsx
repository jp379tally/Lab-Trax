import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EntitlementDecisionGate from "@/components/EntitlementDecisionGate";

const mocks = vi.hoisted(() => ({
  fetchEntitlement: vi.fn(),
  refetch: vi.fn(),
  declined: vi.fn(),
  hasDeclined: vi.fn(),
  push: vi.fn(),
  userId: "user-1" as string | null,
  logout: vi.fn(),
}));
const { fetchEntitlement, refetch, declined, hasDeclined, push } = mocks;

vi.mock("@/lib/query-client", () => ({ resilientFetch: mocks.fetchEntitlement }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ currentUserId: mocks.userId, logout: mocks.logout }) }));
vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      surface: "#fff", warning: "#a60", text: "#111", textSecondary: "#555",
      tint: "#06c",
    },
  }),
}));
vi.mock("@/lib/entitlement-decision", () => ({
  hasDeclinedReadOnly: (...args: unknown[]) => mocks.hasDeclined(...args),
  declineToReadOnly: (...args: unknown[]) => mocks.declined(...args),
}));
vi.mock("expo-router", () => ({ router: { push: mocks.push } }));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: () => null,
}));

function response(entitlement: Record<string, unknown>, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => ({ entitlement }) };
}

async function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <EntitlementDecisionGate><></></EntitlementDecisionGate>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return { ...view, client };
}

describe("mobile entitlement decision gate", () => {
  beforeEach(() => {
    mocks.userId = "user-1";
    fetchEntitlement.mockImplementation(async (url: string) => url === "/api/billing/decline-renewal"
      ? response({})
      : response({
      status: "deactivated", accessLevel: "read_only",
      subjectType: "subscription", subjectId: "sub-1", planType: "lab",
    }));
    hasDeclined.mockResolvedValue(false);
    declined.mockResolvedValue(undefined);
    refetch.mockResolvedValue({});
    push.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the first-login decision for a deactivated read-only account", async () => {
    const view = await renderGate();
    expect(await view.findByTestId("entitlement-renew-now")).toBeTruthy();
    expect(view.getByTestId("entitlement-decline")).toBeTruthy();
  });

  it("calls the server before persisting a successful, scoped decline", async () => {
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-decline"));
    await waitFor(() => expect(declined).toHaveBeenCalled());
    expect(declined.mock.calls[0][0]).toBe("user-1");
    expect(String(declined.mock.calls[0][1])).toMatch(/^subscription:/);
    expect(fetchEntitlement).toHaveBeenCalledWith("/api/billing/decline-renewal", expect.objectContaining({ method: "POST" }));
  });

  it("does not persist a decline when the server rejects it", async () => {
    fetchEntitlement.mockImplementation(async (url: string) => url === "/api/billing/decline-renewal"
      ? response({}, false)
      : response({ status: "deactivated", accessLevel: "read_only", subjectType: "subscription", subjectId: "sub-1" }));
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-decline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(declined).not.toHaveBeenCalled();
  });

  it("routes Renew now to subscription billing and hides the prompt while renewal is pending", async () => {
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-renew-now"));
    expect(push).toHaveBeenCalledWith("/settings/subscriptions");
    await waitFor(() =>
      expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false),
    );
    await waitFor(() => expect(view.getByTestId("read-only-entitlement-banner")).toBeTruthy());
  });

  it("shows a persistent banner after a scoped decline", async () => {
    hasDeclined.mockResolvedValue(true);
    const view = await renderGate();
    await view.findByTestId("read-only-entitlement-banner");
    expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false);
  });

  it("does not prompt active/full-access accounts", async () => {
    fetchEntitlement.mockResolvedValue(response({ status: "active", accessLevel: "full" }));
    const view = await renderGate();
    await waitFor(() =>
      expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false),
    );
    expect(view.queryByTestId("read-only-entitlement-banner")).toBeNull();
    expect(view.queryByTestId("provider-signup-recovery")).toBeNull();
  });

  it("shows signup recovery only while the authenticated entitlement is pending", async () => {
    fetchEntitlement.mockResolvedValue(response({
      status: "onboarding_pending", accessLevel: "locked", planType: "provider",
      providerPlan: "standard",
    }));
    const view = await renderGate();
    expect(await view.findByTestId("provider-signup-recovery")).toBeTruthy();
    expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false);

    fetchEntitlement.mockResolvedValue(response({
      status: "trialing", accessLevel: "full", planType: "provider",
    }));
    await view.client.invalidateQueries({ queryKey: ["billing", "subscription"] });
    await waitFor(() => expect(view.queryByTestId("provider-signup-recovery")).toBeNull());
  });

  it("fails open when entitlement cannot be fetched", async () => {
    fetchEntitlement.mockRejectedValue(new Error("offline"));
    const view = await renderGate();
    await waitFor(() =>
      expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false),
    );
    expect(view.queryByTestId("read-only-entitlement-banner")).toBeNull();
    expect(view.queryByTestId("provider-signup-recovery")).toBeNull();
    expect(await view.findByTestId("entitlement-status-retry")).toBeTruthy();
  });
  it.each(["trialing", "active", "waived", "locked", "grace"])("does not intercept taps for canonical %s full access without a selected organization", async (status) => {
    fetchEntitlement.mockResolvedValue(response({ status, accessLevel: "full", subjectType: "provider_user", planType: null }));
    const view = await renderGate();
    await waitFor(() => expect(fetchEntitlement).toHaveBeenCalled());
    expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(false);
  });
  it("keeps logout usable during the mandatory read-only decision", async () => {
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-sign-out"));
    expect(mocks.logout).toHaveBeenCalled();
  });
  it("shows a retryable decline failure without acknowledging access", async () => {
    fetchEntitlement.mockImplementation(async (url: string) => url === "/api/billing/decline-renewal"
      ? response({}, false)
      : response({ accessLevel: "read_only" }));
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-decline"));
    expect(await view.findByTestId("entitlement-decision-error")).toBeTruthy();
    expect(declined).not.toHaveBeenCalled();
    expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true);
  });
  it("does not let an outgoing account's late decline hide the new account's mandatory decision", async () => {
    let finish!: (result: ReturnType<typeof response>) => void;
    fetchEntitlement.mockImplementation((url: string) => url === "/api/billing/decline-renewal"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(response({ accessLevel: "read_only", subjectType: "provider_user", subjectId: mocks.userId })));
    const view = await renderGate();
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    await fireEvent.press(view.getByTestId("entitlement-decline"));
    mocks.userId = "user-2";
    await view.rerender(
      <QueryClientProvider client={view.client}>
        <EntitlementDecisionGate><React.Fragment /></EntitlementDecisionGate>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true));
    finish(response({ accessLevel: "read_only" }));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(declined).not.toHaveBeenCalled();
    expect(view.getByTestId("entitlement-decision-modal").props.visible).toBe(true);
  });
});