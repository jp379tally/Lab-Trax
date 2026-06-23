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
