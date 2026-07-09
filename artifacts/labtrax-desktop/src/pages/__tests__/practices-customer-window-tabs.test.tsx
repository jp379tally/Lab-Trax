/** @vitest-environment jsdom */
/**
 * Regression suite: "Customer window 4-tab bar" (PracticeEditor).
 *
 * The customer slide-in window opened from the Accounts page carries a 4-tab
 * bar: Basic Info, Invoices, Statements, Card on File. Nothing else pinned
 * this, so a future refactor of `PracticeEditor` could silently drop a tab,
 * break tab switching, or break the Basic Info Save flow without any gate
 * failing. These tests lock:
 *  - all 4 tabs render in the tab bar,
 *  - switching to Invoices / Statements / Card on File mounts each tab's
 *    real content (fed by its own endpoint where applicable),
 *  - switching back to Basic Info keeps the form (it is hidden, not
 *    unmounted, while another tab is active),
 *  - the Basic Info form still saves via PATCH /organizations/:id and closes
 *    the window on success.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { PracticeEditor } from "@/pages/practices";
import type { Organization } from "@/lib/types";

const LAB_ID = "lab_abc123";
const ORG_ID = "org-provider-1";

const ORG = {
  id: ORG_ID,
  type: "provider",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
  parentLabOrganizationId: LAB_ID,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
} as unknown as Organization;

const ADMIN_USER = {
  id: "u1",
  username: "labadmin",
  role: "admin",
} as unknown as SessionUser;

const ADMIN_ME = {
  memberships: [
    {
      organizationId: LAB_ID,
      status: "active",
      role: "admin",
      organization: { id: LAB_ID, type: "lab", name: "Acme Dental Lab" },
    },
  ],
};

const CONNECTION = {
  id: "conn-1",
  labOrganizationId: LAB_ID,
  providerOrganizationId: ORG_ID,
  status: "active",
  tierName: null,
  labOrganization: { id: LAB_ID, name: "Acme Dental Lab", displayName: null },
};

const INVOICE = {
  id: "inv-1",
  invoiceNumber: "INV-1001",
  status: "open",
  total: "120",
  balanceDue: "120",
  issuedAt: "2026-06-15T00:00:00.000Z",
};

const STATEMENT = {
  id: "stmt-1",
  periodStart: "2026-06-01T00:00:00.000Z",
  periodEnd: "2026-06-30T23:59:59.000Z",
  invoiceCount: 3,
  totalBilled: "500",
  totalPaid: "200",
  balanceDue: "300",
  createdAt: "2026-07-01T00:00:00.000Z",
};

type Call = { url: string; method?: string; body?: string };
let calls: Call[] = [];

function installDefaultMock() {
  apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    calls.push({ url, method: opts?.method, body: opts?.body as string });

    // Tab-content endpoints (query strings — match with startsWith).
    if (url.startsWith("/invoices/practice-statements")) {
      return Promise.resolve([STATEMENT]);
    }
    if (url.startsWith("/invoices?")) {
      return Promise.resolve([INVOICE]);
    }

    // PracticeEditor core queries.
    if (url === `/organizations/${ORG_ID}` && opts?.method === "PATCH") {
      return Promise.resolve({ ...ORG, ...JSON.parse((opts?.body as string) || "{}") });
    }
    if (url === `/organizations/${ORG_ID}`) {
      // Distinct name so tests can wait for the detail query to hydrate the
      // form (the sync effect overwrites `fields` when this data arrives).
      return Promise.resolve({ ...ORG, name: "Bright Smiles Hydrated" });
    }
    if (url === `/organizations/${ORG_ID}/members`) {
      return Promise.resolve([]);
    }
    if (url === `/organizations/${ORG_ID}/statement-history`) {
      return Promise.resolve({ history: [] });
    }
    if (url === "/auth/me") {
      return Promise.resolve(ADMIN_ME);
    }

    // ConnectionTierSection / PracticeDoctorsSection (Basic Info tab).
    if (url.startsWith("/organizations/connections")) {
      return Promise.resolve([CONNECTION]);
    }
    if (url.startsWith("/organizations?")) {
      // InvoicesTab admin "Reassign all…" destination list.
      return Promise.resolve([]);
    }
    if (url.startsWith("/pricing/tiers")) {
      return Promise.resolve({ labOrganizationId: LAB_ID, tiers: [] });
    }
    if (url.startsWith("/pricing/overrides")) {
      return Promise.resolve({ overrides: [] });
    }
    if (url === "/cases" || url.startsWith("/cases?")) {
      return Promise.resolve([]);
    }
    return Promise.resolve(null);
  });
}

function renderEditor(onClose = vi.fn()) {
  render(<PracticeEditor org={ORG} onClose={onClose} />, {
    wrapper: makeAuthWrapper("/", { user: ADMIN_USER, status: "authed" }),
  });
  return onClose;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  calls = [];
  window.localStorage.clear();
  installDefaultMock();
});

describe("PracticeEditor — customer window tab bar", () => {
  it("renders all 4 tabs: Basic Info, Invoices, Statements, Card on File", async () => {
    renderEditor();

    expect(
      await screen.findByRole("button", { name: "Basic Info" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Statements" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Card on File" }),
    ).toBeInTheDocument();

    // Basic Info is the default tab — the form is visible with the org's data.
    expect(
      await screen.findByDisplayValue("Bright Smiles Hydrated"),
    ).toBeInTheDocument();
  });

  it("switching to Invoices renders the Invoices tab content from /invoices?practiceId=", async () => {
    renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Invoices" }));

    // The tab fetched this practice's invoices and rendered the row.
    expect(await screen.findByText("INV-1001")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Export PDF/i }),
    ).toBeInTheDocument();
    expect(
      calls.some((c) =>
        c.url.startsWith(`/invoices?practiceId=${encodeURIComponent(ORG_ID)}`),
      ),
    ).toBe(true);
  });

  it("switching to Statements renders the Statements tab content from /invoices/practice-statements", async () => {
    renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Statements" }));

    // Statement table rendered with the fetched row.
    expect(await screen.findByText("Balance Due")).toBeInTheDocument();
    expect(screen.getByText("$300.00")).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.url.startsWith("/invoices/practice-statements") &&
          c.url.includes(`providerOrganizationId=${encodeURIComponent(ORG_ID)}`) &&
          c.url.includes(`labOrganizationId=${encodeURIComponent(LAB_ID)}`),
      ),
    ).toBe(true);
  });

  it("switching to Card on File renders the Card on File tab content", async () => {
    renderEditor();

    fireEvent.click(
      await screen.findByRole("button", { name: "Card on File" }),
    );

    expect(await screen.findByText("Saved Card")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Card on File Authorization/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Auto-Pay Authorization/i }),
    ).toBeInTheDocument();
  });

  it("switching away and back to Basic Info keeps the form intact", async () => {
    renderEditor();

    // Default tab shows the form.
    expect(
      await screen.findByDisplayValue("Bright Smiles Hydrated"),
    ).toBeInTheDocument();

    // Away…
    fireEvent.click(screen.getByRole("button", { name: "Invoices" }));
    expect(await screen.findByText("INV-1001")).toBeInTheDocument();

    // …and back. The form (with any pending edits) is still there.
    fireEvent.click(screen.getByRole("button", { name: "Basic Info" }));
    expect(screen.getByDisplayValue("Bright Smiles Hydrated")).toBeInTheDocument();
  });
});

describe("PracticeEditor — Basic Info Save flow", () => {
  it("saves edits via PATCH /organizations/:id and closes the window on success", async () => {
    const onClose = renderEditor();

    // Wait for the detail query to hydrate the form before editing, or the
    // sync effect would overwrite our typed value.
    const nameInput = await screen.findByDisplayValue("Bright Smiles Hydrated");
    fireEvent.change(nameInput, { target: { value: "Bright Smiles Renamed" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch!.url).toBe(`/organizations/${ORG_ID}`);
    });

    const patch = calls.find((c) => c.method === "PATCH")!;
    const body = JSON.parse(patch.body!);
    expect(body.name).toBe("Bright Smiles Renamed");
    // Provider with a parent lab — accountNumber stays in the payload.
    expect("accountNumber" in body).toBe(true);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("surfaces a save error instead of closing the window", async () => {
    const onClose = vi.fn();
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, method: opts?.method, body: opts?.body as string });
      if (url === `/organizations/${ORG_ID}` && opts?.method === "PATCH") {
        return Promise.reject(new Error("boom-save-failed"));
      }
      if (url === `/organizations/${ORG_ID}`) {
        return Promise.resolve({ ...ORG, name: "Bright Smiles Hydrated" });
      }
      if (url === `/organizations/${ORG_ID}/members`) return Promise.resolve([]);
      if (url === `/organizations/${ORG_ID}/statement-history`) {
        return Promise.resolve({ history: [] });
      }
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({ labOrganizationId: LAB_ID, tiers: [] });
      }
      if (url.startsWith("/pricing/overrides")) {
        return Promise.resolve({ overrides: [] });
      }
      if (url === "/cases" || url.startsWith("/cases?")) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    render(<PracticeEditor org={ORG} onClose={onClose} />, {
      wrapper: makeAuthWrapper("/", { user: ADMIN_USER, status: "authed" }),
    });

    await screen.findByDisplayValue("Bright Smiles Hydrated");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByText(/boom-save-failed/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
