/** @vitest-environment jsdom */
/**
 * Regression suite: "Practices Page Pricing Tier Dropdown Populated"
 *
 * Guards the fix for empty pricing-tier dropdowns on the Practices page. The
 * root cause was a React Query cache-key collision: ConnectionTierSection and
 * PracticeDoctorsSection both keyed their `/pricing/tiers` query on the same
 * lab id but cached different response shapes, so React Query handed one
 * section the other's data and the dropdown silently resolved to `[]`.
 *
 * These tests pin ConnectionTierSection's behaviour:
 * - tiers returned by the API actually render as <option>s in the dropdown,
 * - a clear empty-state hint is shown when the lab has zero tiers,
 * - a fetch error is surfaced to the user instead of being swallowed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { ConnectionTierSection, PracticeDoctorsSection } from "@/pages/practices";
import type { Organization } from "@/lib/types";

const PROVIDER_ORG = {
  id: "org-provider-1",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
} as unknown as Organization;
const LAB_ID = "lab_abc123";

const CONNECTION = {
  id: "conn-1",
  labOrganizationId: LAB_ID,
  providerOrganizationId: "org-provider-1",
  status: "active",
  tierName: null,
  labOrganization: { id: LAB_ID, name: "Acme Dental Lab", displayName: null },
};

const DOCTOR_MEMBER = {
  userId: "u-doc-1",
  user: {
    username: "drsmith",
    firstName: "Jane",
    lastName: "Smith",
    platformAccountNumber: "2926JS",
  },
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("ConnectionTierSection — pricing tier dropdown", () => {
  it("renders the lab's tiers as options in the default-tier dropdown", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        // Shape that ConnectionTierSection consumes per-lab.
        return Promise.resolve({
          labOrganizationId: LAB_ID,
          tiers: [
            { id: "t1", labOrganizationId: LAB_ID, name: "Standard" },
            { id: "t2", labOrganizationId: LAB_ID, name: "Premium" },
          ],
        });
      }
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />,
      { wrapper: makeAuthWrapper() },
    );

    expect(
      await screen.findByRole("option", { name: "Standard" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Premium" }),
    ).toBeInTheDocument();
  });

  it("shows an empty-state hint when the lab has no tiers", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({ labOrganizationId: LAB_ID, tiers: [] });
      }
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />,
      { wrapper: makeAuthWrapper() },
    );

    expect(
      await screen.findByText(/No tiers yet/i),
    ).toBeInTheDocument();
  });

  it("surfaces an error instead of swallowing it when the tiers fetch fails", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.reject(new Error("boom-tiers-failed"));
      }
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />,
      { wrapper: makeAuthWrapper() },
    );

    await waitFor(() =>
      expect(screen.getByText(/boom-tiers-failed/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Couldn't load pricing tiers/i),
    ).toBeInTheDocument();
  });
});

/**
 * Direct-set regression: a practice that already belongs to one of the admin's
 * labs must expose the default-tier dropdown immediately (no "Connect to lab"
 * wall). Selecting a tier when no connection row exists yet must transparently
 * create + approve the connection, then PATCH the chosen tier.
 */
const PROVIDER_WITH_PARENT = {
  id: "org-provider-1",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
  parentLabOrganizationId: LAB_ID,
} as unknown as Organization;

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

describe("ConnectionTierSection — set tier without a prior connection", () => {
  it("renders the dropdown directly and creates+approves+sets the tier on select", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      calls.push({ url, method: opts?.method, body: opts?.body as string });
      if (url.startsWith("/organizations/connections")) {
        if (opts?.method === "POST" && url.endsWith("/connections")) {
          return Promise.resolve({ id: "new-conn" });
        }
        if (opts?.method === "POST" && url.endsWith("/approve")) {
          return Promise.resolve({});
        }
        if (opts?.method === "PATCH") {
          return Promise.resolve({
            id: "new-conn",
            labOrganizationId: LAB_ID,
            providerOrganizationId: "org-provider-1",
            status: "active",
            tierName: "Premium",
          });
        }
        // GET connections — none exist yet.
        return Promise.resolve([]);
      }
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({
          labOrganizationId: LAB_ID,
          tiers: [
            { id: "t1", labOrganizationId: LAB_ID, name: "Standard" },
            { id: "t2", labOrganizationId: LAB_ID, name: "Premium" },
          ],
        });
      }
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection
        providerOrg={PROVIDER_WITH_PARENT}
        currentUserId="u1"
      />,
      { wrapper: makeAuthWrapper() },
    );

    // Dropdown is shown directly — no "Connect to lab" button anywhere.
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(
      await screen.findByRole("option", { name: "Premium" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connect to lab/i)).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "Premium" } });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch!.url).toBe("/organizations/connections/new-conn");
      expect(JSON.parse(patch!.body!)).toEqual({ tierName: "Premium" });
    });
    // Connection was created then approved before the tier was set.
    expect(
      calls.some(
        (c) => c.method === "POST" && c.url.endsWith("/connections"),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/approve")),
    ).toBe(true);
  });

  it("shows a non-blocking message when there is no parent or admin lab", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([]);
      }
      if (url === "/auth/me") return Promise.resolve({ memberships: [] });
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />,
      { wrapper: makeAuthWrapper() },
    );

    expect(
      await screen.findByText(/isn't linked to any of your labs yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the non-blocking message when the practice has no parent lab even though the user administers a lab", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([]);
      }
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({
          labOrganizationId: LAB_ID,
          tiers: [{ id: "t1", labOrganizationId: LAB_ID, name: "Standard" }],
        });
      }
      return Promise.resolve(null);
    });

    // PROVIDER_ORG has no parentLabOrganizationId; ADMIN_ME administers LAB_ID.
    render(
      <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />,
      { wrapper: makeAuthWrapper() },
    );

    expect(
      await screen.findByText(/isn't linked to any of your labs yet/i),
    ).toBeInTheDocument();
    // It must NOT auto-connect to the user's unrelated admin lab.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the non-blocking message when the parent lab is not administered by the current user", async () => {
    const OTHER_ADMIN_LAB = "lab_other_999";
    const PROVIDER_PARENT_NOT_ADMINED = {
      id: "org-provider-1",
      name: "Bright Smiles",
      displayName: "Bright Smiles Dental",
      parentLabOrganizationId: LAB_ID, // user does NOT administer this lab
    } as unknown as Organization;

    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.startsWith("/organizations/connections")) {
        // Fail loudly if anything tries to auto-connect.
        if (opts?.method) {
          return Promise.reject(new Error("must-not-auto-connect"));
        }
        return Promise.resolve([]);
      }
      if (url === "/auth/me") {
        return Promise.resolve({
          memberships: [
            {
              organizationId: OTHER_ADMIN_LAB,
              status: "active",
              role: "admin",
              organization: {
                id: OTHER_ADMIN_LAB,
                type: "lab",
                name: "Other Lab",
              },
            },
          ],
        });
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({
          labOrganizationId: OTHER_ADMIN_LAB,
          tiers: [
            { id: "t1", labOrganizationId: OTHER_ADMIN_LAB, name: "Standard" },
          ],
        });
      }
      return Promise.resolve(null);
    });

    render(
      <ConnectionTierSection
        providerOrg={PROVIDER_PARENT_NOT_ADMINED}
        currentUserId="u1"
      />,
      { wrapper: makeAuthWrapper() },
    );

    expect(
      await screen.findByText(/isn't linked to any of your labs yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

/**
 * Cross-section regression: mount ConnectionTierSection (practice default tier)
 * and PracticeDoctorsSection (per-doctor tier) together under a single
 * QueryClient. Both read the same `/pricing/tiers` endpoint; the original bug
 * was a shared React Query key that deduped the two and silently emptied one
 * dropdown. These tests would fail if the keys ever re-collide because the two
 * sections cache different response shapes.
 */
function renderBothSections() {
  return render(
    <>
      <div data-testid="default-tier-section">
        <ConnectionTierSection providerOrg={PROVIDER_ORG} currentUserId="u1" />
      </div>
      <div data-testid="doctors-section">
        <PracticeDoctorsSection
          providerOrg={PROVIDER_ORG}
          currentUserId="u1"
          isArchived={false}
        />
      </div>
    </>,
    { wrapper: makeAuthWrapper() },
  );
}

describe("Practices page — both tier dropdowns share one QueryClient", () => {
  it("populates the practice-default AND per-doctor dropdowns from the same tiers endpoint", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({
          labOrganizationId: LAB_ID,
          tiers: [
            { id: "t1", labOrganizationId: LAB_ID, name: "Standard" },
            { id: "t2", labOrganizationId: LAB_ID, name: "Premium" },
          ],
        });
      }
      if (url.startsWith("/pricing/overrides")) {
        return Promise.resolve({ overrides: [] });
      }
      if (url === "/cases") {
        return Promise.resolve([]);
      }
      if (url.endsWith("/members")) {
        return Promise.resolve([DOCTOR_MEMBER]);
      }
      return Promise.resolve(null);
    });

    renderBothSections();

    // Practice-default dropdown (ConnectionTierSection)
    const defaultSection = within(
      await screen.findByTestId("default-tier-section"),
    );
    expect(
      await defaultSection.findByRole("option", { name: "Standard" }),
    ).toBeInTheDocument();
    expect(
      defaultSection.getByRole("option", { name: "Premium" }),
    ).toBeInTheDocument();

    // Per-doctor dropdown (PracticeDoctorsSection) — expand the doctor row first.
    const doctorsSection = within(screen.getByTestId("doctors-section"));
    const expandBtn = await doctorsSection.findByRole("button", {
      name: /Adjust pricing/i,
    });
    fireEvent.click(expandBtn);

    expect(
      await doctorsSection.findByRole("option", { name: "Standard" }),
    ).toBeInTheDocument();
    expect(
      doctorsSection.getByRole("option", { name: "Premium" }),
    ).toBeInTheDocument();
  });

  it("shows the doctor section's empty-state hint when the lab has no tiers", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.resolve({ labOrganizationId: LAB_ID, tiers: [] });
      }
      if (url.startsWith("/pricing/overrides")) {
        return Promise.resolve({ overrides: [] });
      }
      if (url === "/cases") {
        return Promise.resolve([]);
      }
      if (url.endsWith("/members")) {
        return Promise.resolve([DOCTOR_MEMBER]);
      }
      return Promise.resolve(null);
    });

    renderBothSections();

    const doctorsSection = within(
      await screen.findByTestId("doctors-section"),
    );
    expect(
      await doctorsSection.findByText(
        /Doctors can still get individual item prices/i,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces the doctor section's error when the tiers fetch fails", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations/connections")) {
        return Promise.resolve([CONNECTION]);
      }
      if (url.startsWith("/pricing/tiers")) {
        return Promise.reject(new Error("boom-doctor-tiers-failed"));
      }
      if (url.startsWith("/pricing/overrides")) {
        return Promise.resolve({ overrides: [] });
      }
      if (url === "/cases") {
        return Promise.resolve([]);
      }
      if (url.endsWith("/members")) {
        return Promise.resolve([DOCTOR_MEMBER]);
      }
      return Promise.resolve(null);
    });

    renderBothSections();

    const doctorsSection = within(
      await screen.findByTestId("doctors-section"),
    );
    await waitFor(() =>
      expect(
        doctorsSection.getByText(/boom-doctor-tiers-failed/i),
      ).toBeInTheDocument(),
    );
    expect(
      doctorsSection.getByText(/Couldn't load pricing tiers/i),
    ).toBeInTheDocument();
  });
});
