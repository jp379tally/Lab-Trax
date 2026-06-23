/** @vitest-environment jsdom */
/**
 * Regression suite: "Removed doctor disappears from the Practices page"
 *
 * PracticeDoctorsSection builds its Doctors list by merging three sources:
 * registered members, case-history doctor names, and pricing overrides.
 * Removing a doctor to the per-lab "Unassigned" holding area leaves their
 * cases behind, so the case-history-derived name used to keep the doctor
 * visible — the removal looked like it did nothing.
 *
 * The fix excludes doctors who are in the Unassigned holding area from the
 * merged list. These tests pin two behaviours:
 * - a name-only doctor (case history) who is now Unassigned is hidden, and
 * - an actively-registered doctor is NOT hidden merely because some OTHER
 *   Unassigned doctor shares the same name (no same-name false positive).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

// Controllable per-test Unassigned holding-area contents.
let unassignedData: Array<Record<string, unknown>> = [];

vi.mock("@workspace/api-client-react", () => ({
  useListUnassignedDoctors: () => ({ data: { ok: true, data: unassignedData } }),
  getListUnassignedDoctorsQueryKey: (labId: string) => [
    `/api/organizations/${labId}/unassigned-doctors`,
  ],
  useRemoveDoctorFromPractice: () => ({ mutate: vi.fn(), isPending: false }),
  useReassignUnassignedDoctor: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { PracticeDoctorsSection } from "@/pages/practices";
import type { Organization } from "@/lib/types";

const PROVIDER_ORG = {
  id: "org-provider-1",
  name: "Blissful Dental",
  displayName: "Blissful Dental",
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

function mockApi(opts: {
  members?: Array<Record<string, unknown>>;
  cases?: Array<Record<string, unknown>>;
}) {
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
      return Promise.resolve(opts.cases ?? []);
    }
    if (url.endsWith("/members")) {
      return Promise.resolve(opts.members ?? []);
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  unassignedData = [];
});

describe("PracticeDoctorsSection — Unassigned holding-area exclusion", () => {
  it("hides a case-history-only doctor who has been moved to Unassigned", async () => {
    mockApi({
      members: [],
      cases: [
        {
          providerOrganizationId: "org-provider-1",
          doctorName: "Dr. Byrne",
        },
      ],
    });
    unassignedData = [{ userId: "u-byrne", doctorName: "Dr. Byrne" }];

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u1"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    // Wait until the cases query has resolved, then confirm Byrne is absent.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/cases"));
    await waitFor(() =>
      expect(screen.queryByText(/Byrne/i)).not.toBeInTheDocument(),
    );
  });

  it("keeps an active registered doctor even if another Unassigned doctor shares the name", async () => {
    mockApi({
      members: [
        {
          userId: "u-active-byrne",
          user: {
            username: "drbyrne",
            firstName: "Dr.",
            lastName: "Byrne",
            platformAccountNumber: "2926DB",
          },
        },
      ],
      cases: [],
    });
    // A DIFFERENT person, same name, sitting in Unassigned — must not hide the
    // actively-registered Dr. Byrne above.
    unassignedData = [{ userId: "u-other-byrne", doctorName: "Byrne" }];

    render(
      <PracticeDoctorsSection
        providerOrg={PROVIDER_ORG}
        currentUserId="u1"
        isArchived={false}
      />,
      { wrapper: makeAuthWrapper() },
    );

    expect(await screen.findByText(/Byrne/i)).toBeInTheDocument();
  });
});
