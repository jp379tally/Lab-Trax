import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";

const state = vi.hoisted(() => ({
  refetch: vi.fn(async () => ({})), invalidate: vi.fn(async () => undefined),
  fetch: vi.fn(), keys: [] as unknown[][],
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ currentUserId: "provider_actor" }) }));
vi.mock("@/lib/query-client", () => ({
  resilientFetch: state.fetch, getApiUrl: () => "https://app.test/",
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    state.keys.push(options.queryKey);
    return { data: { status: "onboarding_pending", providerPlan: "standard", reuseSubscriptionCard: false }, refetch: state.refetch, error: null };
  },
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
import ProviderSignupRecovery from "@/components/ProviderSignupRecovery";
beforeEach(() => { vi.clearAllMocks(); state.keys = []; });
afterEach(() => vi.restoreAllMocks());
describe("resumable native provider signup", () => {
  it("restores pending tier from authenticated server state and blocks an unapproved native purchase route", async () => {
    const ui = await render(<ProviderSignupRecovery />);
    await waitFor(() => expect(ui.getByTestId("provider-plan-standard").props.accessibilityState.checked).toBe(true));
    expect(ui.getByTestId("provider-card-reuse").props.accessibilityState.checked).toBe(false);
    expect(state.keys[0]).toEqual(["provider-signup-state", "provider_actor"]);
    await fireEvent.press(ui.getByTestId("provider-signup-resume"));
    await waitFor(() => expect(ui.getByText(/Paid subscription purchases are not approved/)).toBeTruthy());
    expect(state.fetch).not.toHaveBeenCalled();
    expect(ui.getByTestId("provider-signup-recovery")).toBeTruthy();
  });
  it("requires explicit Free confirmation and refreshes authoritative state without another account", async () => {
    state.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const ui = await render(<ProviderSignupRecovery />);
    await fireEvent.press(ui.getByTestId("provider-plan-free"));
    await fireEvent.press(ui.getByTestId("provider-signup-resume"));
    await waitFor(() => expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["billing", "subscription"] }));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.fetch.mock.calls[0][0]).toBe("/api/billing/provider-plan");
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({ providerPlan: "free", reuseSubscriptionCard: false });
  });
  it("reconciles on foreground without trusting a redirect or re-launching checkout", async () => {
    const listener = vi.spyOn(AppState, "addEventListener");
    await render(<ProviderSignupRecovery />);
    const callback = listener.mock.calls.find((call) => call[0] === "change")?.[1];
    expect(callback).toBeDefined();
    callback!("active");
    await waitFor(() => expect(state.refetch).toHaveBeenCalled());
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["billing", "subscription"] });
  });
});
