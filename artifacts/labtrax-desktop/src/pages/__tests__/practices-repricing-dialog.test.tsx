/** @vitest-environment jsdom */
/**
 * Regression suite: "Repricing confirmation dialog in DoctorPricingRow"
 *
 * Guards the flow that asks admins whether to apply new pricing to open
 * invoices when they save a per-doctor pricing override:
 *
 *  - When the pending-repricing-count endpoint returns > 0, a confirmation
 *    dialog appears before the save request is sent.
 *  - Clicking "Yes, update invoices" sends repriceDraftInvoices: true.
 *  - Clicking "No, keep as-is" sends repriceDraftInvoices: false.
 *  - When the count is 0 (or the fetch fails), the dialog is skipped and
 *    the save proceeds immediately with repriceDraftInvoices: false.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { PracticeDoctorsSection } from "@/pages/practices";
import type { Organization } from "@/lib/types";

const LAB_ID = "lab_repricing_test";

const PROVIDER_ORG: Organization = {
  id: "org-provider-repricing",
  name: "Repricing Test Dental",
  displayName: "Repricing Test Dental",
  parentLabOrganizationId: LAB_ID,
} as unknown as Organization;

const CONNECTION = {
  id: "conn-repricing",
  labOrganizationId: LAB_ID,
  providerOrganizationId: "org-provider-repricing",
  status: "active",
  tierName: "Standard",
  labOrganization: { id: LAB_ID, name: "Repricing Test Lab", displayName: null },
};

const TIERS = [
  { id: "t1", labOrganizationId: LAB_ID, name: "Standard", prices: { pfm_crown: 100 } },
];

const DOCTOR_MEMBER = {
  userId: "u-doctor-repricing",
  user: {
    username: "drrepricing",
    firstName: "Anna",
    lastName: "Repricing",
    platformAccountNumber: "9999AR",
  },
};

const ADMIN_ME = {
  memberships: [
    {
      organizationId: LAB_ID,
      status: "active",
      role: "admin",
      organization: { id: LAB_ID, type: "lab", name: "Repricing Test Lab" },
    },
  ],
};

const MOCK_OVERRIDE = {
  id: "ov-1",
  labOrganizationId: LAB_ID,
  doctorName: "Anna Repricing",
  tierName: "Standard",
  prices: {},
  defaultDiscountPercent: null,
  discountPercents: {},
  notes: null,
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

function setupBaseHandlers(overrides?: { count?: number; saveShouldFail?: boolean }) {
  const { count = 2, saveShouldFail = false } = overrides ?? {};
  apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (url.startsWith("/organizations/connections")) {
      return Promise.resolve([CONNECTION]);
    }
    if (url === "/auth/me") {
      return Promise.resolve(ADMIN_ME);
    }
    if (url.startsWith("/pricing/tiers")) {
      return Promise.resolve({ labOrganizationId: LAB_ID, tiers: TIERS });
    }
    if (url.startsWith("/pricing/overrides/pending-repricing-count")) {
      return Promise.resolve({ count });
    }
    if (url.startsWith("/pricing/overrides") && !opts?.method) {
      return Promise.resolve({ overrides: [] });
    }
    if (url === "/cases") {
      return Promise.resolve([]);
    }
    if (url.endsWith("/members")) {
      return Promise.resolve([DOCTOR_MEMBER]);
    }
    if (
      url.startsWith("/pricing/overrides") &&
      (opts?.method === "POST" || opts?.method === "PATCH")
    ) {
      if (saveShouldFail) return Promise.reject(new Error("save-failed"));
      return Promise.resolve(MOCK_OVERRIDE);
    }
    return Promise.resolve(null);
  });
}

async function expandDoctorRow() {
  const expandBtn = await screen.findByRole("button", { name: /Adjust pricing/i });
  fireEvent.click(expandBtn);
  await screen.findByTestId("save-pricing-btn");
}

describe("DoctorPricingRow — repricing confirmation dialog", () => {
  it("shows the dialog when pending-repricing-count > 0 and save is clicked", async () => {
    setupBaseHandlers({ count: 3 });

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u-doctor-repricing"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    await expandDoctorRow();
    fireEvent.click(screen.getByTestId("save-pricing-btn"));

    await waitFor(() =>
      expect(screen.getByText(/Update open invoices\?/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/3 open invoices/i)).toBeInTheDocument();
    expect(screen.getByTestId("repricing-yes-btn")).toBeInTheDocument();
    expect(screen.getByTestId("repricing-no-btn")).toBeInTheDocument();
  });

  it("does NOT show the dialog when pending-repricing-count is 0", async () => {
    setupBaseHandlers({ count: 0 });

    const calls: { url: string; body?: string }[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, body: opts?.body as string | undefined });
      if (url.startsWith("/organizations/connections")) return Promise.resolve([CONNECTION]);
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) return Promise.resolve({ labOrganizationId: LAB_ID, tiers: TIERS });
      if (url.startsWith("/pricing/overrides/pending-repricing-count")) return Promise.resolve({ count: 0 });
      if (url.startsWith("/pricing/overrides") && !opts?.method) return Promise.resolve({ overrides: [] });
      if (url === "/cases") return Promise.resolve([]);
      if (url.endsWith("/members")) return Promise.resolve([DOCTOR_MEMBER]);
      if (url.startsWith("/pricing/overrides") && opts?.method === "POST") return Promise.resolve(MOCK_OVERRIDE);
      return Promise.resolve(null);
    });

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u-doctor-repricing"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    await expandDoctorRow();
    fireEvent.click(screen.getByTestId("save-pricing-btn"));

    // Dialog must NOT appear.
    await waitFor(() => {
      const saveCall = calls.find(
        (c) => c.url.startsWith("/pricing/overrides") && c.url !== "/pricing/overrides" && !c.url.includes("pending-repricing") ||
               (c.url === "/pricing/overrides" && c.body),
      );
      expect(saveCall).toBeTruthy();
    });
    expect(screen.queryByText(/Update open invoices\?/i)).not.toBeInTheDocument();

    const saveCall = calls.find((c) => c.body && c.url.startsWith("/pricing/overrides"));
    expect(saveCall).toBeTruthy();
    const body = JSON.parse(saveCall!.body!);
    expect(body.repriceDraftInvoices).toBe(false);
  });

  it("clicking Yes sends repriceDraftInvoices: true in the save payload", async () => {
    setupBaseHandlers({ count: 2 });

    const calls: { url: string; opts?: RequestInit }[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, opts });
      if (url.startsWith("/organizations/connections")) return Promise.resolve([CONNECTION]);
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) return Promise.resolve({ labOrganizationId: LAB_ID, tiers: TIERS });
      if (url.startsWith("/pricing/overrides/pending-repricing-count")) return Promise.resolve({ count: 2 });
      if (url.startsWith("/pricing/overrides") && !opts?.method) return Promise.resolve({ overrides: [] });
      if (url === "/cases") return Promise.resolve([]);
      if (url.endsWith("/members")) return Promise.resolve([DOCTOR_MEMBER]);
      if (url.startsWith("/pricing/overrides") && (opts?.method === "POST" || opts?.method === "PATCH")) {
        return Promise.resolve(MOCK_OVERRIDE);
      }
      return Promise.resolve(null);
    });

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u-doctor-repricing"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    await expandDoctorRow();
    fireEvent.click(screen.getByTestId("save-pricing-btn"));

    await screen.findByTestId("repricing-yes-btn");
    fireEvent.click(screen.getByTestId("repricing-yes-btn"));

    await waitFor(() => {
      const saveCall = calls.find(
        (c) =>
          c.url.startsWith("/pricing/overrides") &&
          (c.opts?.method === "POST" || c.opts?.method === "PATCH"),
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(saveCall!.opts!.body as string);
      expect(body.repriceDraftInvoices).toBe(true);
    });
    expect(screen.queryByText(/Update open invoices\?/i)).not.toBeInTheDocument();
  });

  it("clicking No sends repriceDraftInvoices: false in the save payload", async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, opts });
      if (url.startsWith("/organizations/connections")) return Promise.resolve([CONNECTION]);
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) return Promise.resolve({ labOrganizationId: LAB_ID, tiers: TIERS });
      if (url.startsWith("/pricing/overrides/pending-repricing-count")) return Promise.resolve({ count: 5 });
      if (url.startsWith("/pricing/overrides") && !opts?.method) return Promise.resolve({ overrides: [] });
      if (url === "/cases") return Promise.resolve([]);
      if (url.endsWith("/members")) return Promise.resolve([DOCTOR_MEMBER]);
      if (url.startsWith("/pricing/overrides") && (opts?.method === "POST" || opts?.method === "PATCH")) {
        return Promise.resolve(MOCK_OVERRIDE);
      }
      return Promise.resolve(null);
    });

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u-doctor-repricing"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    await expandDoctorRow();
    fireEvent.click(screen.getByTestId("save-pricing-btn"));

    await screen.findByTestId("repricing-no-btn");
    fireEvent.click(screen.getByTestId("repricing-no-btn"));

    await waitFor(() => {
      const saveCall = calls.find(
        (c) =>
          c.url.startsWith("/pricing/overrides") &&
          (c.opts?.method === "POST" || c.opts?.method === "PATCH"),
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(saveCall!.opts!.body as string);
      expect(body.repriceDraftInvoices).toBe(false);
    });
    expect(screen.queryByText(/Update open invoices\?/i)).not.toBeInTheDocument();
  });

  it("proceeds without the dialog when the count fetch fails (non-fatal fallback)", async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, opts });
      if (url.startsWith("/organizations/connections")) return Promise.resolve([CONNECTION]);
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) return Promise.resolve({ labOrganizationId: LAB_ID, tiers: TIERS });
      if (url.startsWith("/pricing/overrides/pending-repricing-count")) {
        return Promise.reject(new Error("network-error"));
      }
      if (url.startsWith("/pricing/overrides") && !opts?.method) return Promise.resolve({ overrides: [] });
      if (url === "/cases") return Promise.resolve([]);
      if (url.endsWith("/members")) return Promise.resolve([DOCTOR_MEMBER]);
      if (url.startsWith("/pricing/overrides") && opts?.method === "POST") {
        return Promise.resolve(MOCK_OVERRIDE);
      }
      return Promise.resolve(null);
    });

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u-doctor-repricing"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    await expandDoctorRow();
    fireEvent.click(screen.getByTestId("save-pricing-btn"));

    // No dialog — the count fetch failed so we fall back to save without repricing.
    await waitFor(() => {
      const saveCall = calls.find(
        (c) => c.url.startsWith("/pricing/overrides") && c.opts?.method === "POST",
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(saveCall!.opts!.body as string);
      expect(body.repriceDraftInvoices).toBe(false);
    });
    expect(screen.queryByText(/Update open invoices\?/i)).not.toBeInTheDocument();
  });
});
