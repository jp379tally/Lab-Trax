/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderMyAccount } from "../ProviderMyAccount";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getProviderOrganizationId: () => "provider-1",
}));
vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), toasts: [] }),
}));

const me = {
  user: {
    id: "user-1",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "555-1234",
    practiceName: "Sunny Dental",
    practiceAddress: "123 Main St",
    practicePhone: "555-9999",
    practiceAccountNumber: "ACC-1",
  },
};
const preferences = {
  subscription: { enabled: false, chargeDay: 8 },
  labs: [
    {
      providerOrganizationId: "provider-1",
      labOrganizationId: "lab-1",
      labName: "Sunrise Lab",
      providerName: "Sunny Dental",
      enabled: false,
      chargeDay: 10,
    },
  ],
};

function mockApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve(me);
    if (path.startsWith("/organizations/shared-accounts?")) {
      return Promise.resolve({
        relationship: {
          labOrganizationId: "lab-1",
          providerOrganizationId: "provider-1",
        },
        contact: {
          name: "Sunny Dental",
          displayName: "Sunny Dental",
          billingEmail: "billing@sunny.example",
          phone: "555-9999",
          addressLine1: "123 Main St",
          addressLine2: null,
          city: "Austin",
          state: "TX",
          zip: "78701",
          source: "provider_organization",
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
        card: {
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          status: "active",
          updatedAt: "2026-09-03T00:00:00.000Z",
          source: "processor",
        },
        profileChangeRequests: [],
      });
    }
    if (path === "/provider/billing-preferences") return Promise.resolve(preferences);
    if (path === "/provider/subscription-autopay") {
      return Promise.resolve({ subscription: { enabled: true, chargeDay: 8 } });
    }
    if (path === "/provider/payment-method/setup-checkout") {
      return Promise.resolve({ url: "https://checkout.stripe.test/setup" });
    }
    return Promise.resolve({ ok: true });
  });
}

function renderAccount() {
  return render(<ProviderMyAccount />, {
    wrapper: makeAuthWrapper("/", {
      user: { id: "user-1", username: "jane", email: "jane@example.com" },
      status: "authed",
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  mockApi();
});

describe("ProviderMyAccount billing controls", () => {
  it("shows only safe masked card metadata and replacement control", async () => {
    renderAccount();
    expect(
      await screen.findByText((content) => content.includes("VISA •••• 4242")),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) => content.includes("Expires 12/30")),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace card" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("4242424242424242");
  });

  it("starts hosted card setup without rendering card-number fields", async () => {
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Replace card" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/provider/payment-method/setup-checkout",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ providerOrganizationId: "provider-1" }),
        }),
      ),
    );
    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
  });

  it("updates the selected practice contact record, including legal name", async () => {
    renderAccount();
    fireEvent.change(
      await screen.findByLabelText("Legal practice name for Sunrise Lab"),
      { target: { value: "Sunny Dental Group" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Request contact update" }),
    );
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/organizations/provider-portal-contact",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"name":"Sunny Dental Group"'),
        }),
      ),
    );
  });

  it("saves subscription auto-pay and a day from 1 through 10", async () => {
    renderAccount();
    fireEvent.click(await screen.findByLabelText("Enable subscription auto-pay"));
    fireEvent.click(screen.getByRole("button", { name: "Save subscription auto-pay" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/provider/subscription-autopay",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true, chargeDay: 8 }),
        }),
      ),
    );
  });

  it("rejects invalid subscription charge days client-side", async () => {
    renderAccount();
    fireEvent.change(await screen.findByLabelText("Charge day"), {
      target: { value: "11" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save subscription auto-pay" }));
    expect(await screen.findByText(/must be from 1 through 10/i)).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.some(([path]) => path === "/provider/subscription-autopay"),
    ).toBe(false);
  });
});