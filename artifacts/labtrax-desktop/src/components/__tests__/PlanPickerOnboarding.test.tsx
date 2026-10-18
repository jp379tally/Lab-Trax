/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlanPickerOnboarding from "@/components/PlanPickerOnboarding";
import { AuthContext } from "@/lib/auth-context";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";

const mockedApiFetch = vi.mocked(apiFetch);
const user = { id: "user-1", username: "reader", userType: "lab" };
const auth = {
  user,
  status: "authed" as const,
  restoreStatus: "empty" as const,
  acknowledgeRestoreNotice: vi.fn(),
  restoreNoticeDismissed: false,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
};

function renderPicker(context = auth) {
  return render(
    <AuthContext.Provider value={context}>
      <PlanPickerOnboarding />
    </AuthContext.Provider>,
  );
}

function response(
  status: string,
  accessLevel: string,
  subjectId = "lab-1",
  subjectType = "lab",
) {
  return {
    ok: true,
    entitlement: {
      status,
      accessLevel,
      planType: "lab" as const,
      subjectType,
      subjectId,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockedApiFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanPickerOnboarding deactivated decision", () => {
  it("does not prompt permanent Free providers to renew or choose a paid plan", async () => {
    mockedApiFetch.mockResolvedValue({ entitlement: { status: "free", accessLevel: "read_only", planType: "provider", providerPlan: "free" } });
    const ui = renderPicker({ ...auth, user: { ...user, userType: "provider" } });
    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith("/billing/subscription"));
    expect(ui.queryByText("Finish provider signup")).toBeNull();
    expect(ui.queryByTestId("button-renew-now")).toBeNull();
    expect(mockedApiFetch).not.toHaveBeenCalledWith("/billing/plans");
  });
  it("keeps failed checkout incomplete and supports explicit permanent Free recovery", async () => {
    let selectedFree = false;
    mockedApiFetch.mockImplementation(async (path, options) => {
      if (path === "/billing/provider-plan") {
        selectedFree = JSON.parse(options!.body as string).providerPlan === "free";
        return { ok: true };
      }
      if (path === "/billing/checkout-session") throw new Error("Stripe temporarily unavailable");
      return { entitlement: { status: selectedFree ? "free" : "onboarding_pending", accessLevel: "read_only", planType: "provider", providerPlan: selectedFree ? "free" : "standard" } };
    });
    renderPicker({ ...auth, user: { ...user, userType: "provider" } });
    await screen.findByText("Finish provider signup");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to secure card collection" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue to secure card collection" }));
    await screen.findByText("Stripe temporarily unavailable");
    expect(screen.getByText("Finish provider signup")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("provider-plan-free"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm permanent Free plan" }));
    await waitFor(() => expect(screen.queryByText("Finish provider signup")).toBeNull());
  });
  it("prompts for deactivated and grace read-only entitlements", async () => {
    mockedApiFetch.mockResolvedValue(response("grace", "read_only"));
    renderPicker();

    expect(await screen.findByText("Your access is read-only")).toBeInTheDocument();
    expect(screen.getByTestId("button-renew-now")).toBeInTheDocument();
    expect(screen.getByTestId("button-decline-read-only")).toBeInTheDocument();
  });

  it("declines through the server and stores a user/subject-scoped acknowledgement", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only"))
      .mockResolvedValueOnce({ status: "deactivated", accessLevel: "read_only" });
    renderPicker();
    fireEvent.click(await screen.findByTestId("button-decline-read-only"));

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith("/billing/decline-renewal", { method: "POST" }),
    );
    expect(localStorage.getItem("labtrax_read_only_decision_v1:user-1:lab:lab-1")).toBe("declined");
    expect(await screen.findByTestId("link-billing-after-decline")).toBeInTheDocument();
  });

  it("opens plan selection on renew and starts checkout without persisting decline", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only"))
      .mockResolvedValueOnce({
        ok: true,
        plans: [{
          id: "price-lab",
          currency: "usd",
          unitAmount: 1000,
          interval: "month",
          productName: "Lab plan",
          productDescription: null,
          planType: "lab",
        }],
      })
      .mockResolvedValueOnce({ ok: true, url: "https://checkout.example/session" });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderPicker();

    fireEvent.click(await screen.findByTestId("button-renew-now"));
    const plan = await screen.findByTestId("button-plan-price-lab");
    expect(screen.getByText("Choose your plan")).toBeInTheDocument();
    fireEvent.click(plan);

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        "/billing/checkout-session",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ priceId: "price-lab" }) }),
      ),
    );
    expect(localStorage.length).toBe(0);
    expect(open).toHaveBeenCalledWith("https://checkout.example/session", "_blank");
    open.mockRestore();
  });

  it("keeps a visible renew affordance after a decline and does not prompt active users", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only"))
      .mockResolvedValueOnce({ status: "deactivated", accessLevel: "read_only" });
    renderPicker();
    fireEvent.click(await screen.findByTestId("button-decline-read-only"));
    const renew = await screen.findByTestId("link-billing-after-decline");
    expect(renew).toBeInTheDocument();

    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(response("active", "full"));
    renderPicker();
    await waitFor(() => expect(screen.queryByText("Your access is read-only")).not.toBeInTheDocument());
    expect(screen.queryByTestId("button-renew-now")).not.toBeInTheDocument();
  });

  it("only offers provider prices for a provider billing subject", async () => {
    const providerAuth = { ...auth, user: { ...user, id: "provider-user", userType: "provider" } };
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only", "provider-1", "provider_org"))
      .mockResolvedValueOnce({
        ok: true,
        plans: [
          { id: "price-lab", currency: "usd", unitAmount: 1000, interval: "month", productName: "Lab", productDescription: null, planType: "lab" },
          { id: "price-provider", currency: "usd", unitAmount: 2000, interval: "month", productName: "Provider", productDescription: null, planType: "provider" },
        ],
      });
    renderPicker(providerAuth);
    fireEvent.click(await screen.findByTestId("button-renew-now"));

    expect(await screen.findByTestId("button-plan-price-provider", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId("button-plan-price-lab")).not.toBeInTheDocument();
  });

  it("only offers lab prices for a lab billing subject", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only", "lab-1", "lab"))
      .mockResolvedValueOnce({
        ok: true,
        plans: [
          { id: "price-lab", currency: "usd", unitAmount: 1000, interval: "month", productName: "Lab", productDescription: null, planType: "lab" },
          { id: "price-provider", currency: "usd", unitAmount: 2000, interval: "month", productName: "Provider", productDescription: null, planType: "provider" },
        ],
      });
    renderPicker();
    fireEvent.click(await screen.findByTestId("button-renew-now"));

    expect(await screen.findByTestId("button-plan-price-lab")).toBeInTheDocument();
    expect(screen.queryByTestId("button-plan-price-provider")).not.toBeInTheDocument();
  });

  it("does not cancel the plan request when its loading indicator renders", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(response("deactivated", "read_only"))
      .mockImplementationOnce(() => new Promise<never>(() => {}));
    renderPicker();
    fireEvent.click(await screen.findByTestId("button-renew-now"));

    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith(
      "/billing/plans",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(document.querySelector(".animate-spin")).not.toBeNull());
    const signal = mockedApiFetch.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
  });
});