/** @vitest-environment jsdom */
/**
 * Regression guard: Forecast tab visibility by role on the Reports page.
 *
 * Protected workflows:
 *   - "Forecast tab hidden for billing-role user"
 *   - "Forecast tab visible for admin-role user"
 *
 * The Forecast tab carries `adminOnly: true` and is filtered out for any
 * membership whose role is neither "admin" nor "owner". Without this
 * coverage, a future refactor of the tab filter could silently re-expose
 * or re-hide the tab for billing-role users.
 *
 * Keep these tests permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const LAB_ORG = {
  id: "lab-1",
  type: "lab",
  name: "Main Lab",
  displayName: "Main Lab",
};

const BILLING_MEMBERSHIP = {
  id: "m-billing",
  role: "billing",
  status: "active",
  organization: LAB_ORG,
};

const ADMIN_MEMBERSHIP = {
  id: "m-admin",
  role: "admin",
  status: "active",
  organization: LAB_ORG,
};

let meMemberships: Array<Record<string, unknown>> = [];

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (endpoint: string) => {
    if (endpoint.startsWith("/auth/me")) {
      return { user: { id: "u1" }, memberships: meMemberships };
    }
    if (endpoint.startsWith("/cases") || endpoint.startsWith("/invoices")) {
      return [];
    }
    return {};
  }),
}));

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div>{children as React.ReactNode}</div>
    ),
  };
});

import ReportsPage from "@/pages/reports";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

describe("ReportsPage — Forecast tab role guard", () => {
  it("hides the Forecast tab for a billing-role lab membership", async () => {
    meMemberships = [BILLING_MEMBERSHIP];
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").some((b) => b.textContent === "Summary"),
      ).toBe(true);
    });

    const forecastBtn = screen
      .queryAllByRole("button")
      .find((b) => b.textContent === "Forecast");
    expect(forecastBtn).toBeUndefined();
  });

  it("shows the Forecast tab for an admin-role lab membership", async () => {
    meMemberships = [ADMIN_MEMBERSHIP];
    renderPage();

    await waitFor(() => {
      const forecastBtn = screen
        .queryAllByRole("button")
        .find((b) => b.textContent === "Forecast");
      expect(forecastBtn).toBeDefined();
    });
  });
});
