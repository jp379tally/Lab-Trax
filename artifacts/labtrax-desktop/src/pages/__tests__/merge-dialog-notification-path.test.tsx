/** @vitest-environment jsdom */
/**
 * Regression suite: "Merge doctors from the duplicate-doctor notification"
 *
 * The Customer Center surfaces a "Suggested merges" / possible-duplicate-doctor
 * notification. Clicking its "Review" button opens the Merge doctors modal with
 * the cluster's doctors pre-loaded. A past regression made the modal open with
 * SOURCES (0) while both duplicate rows were treated as the TARGET (compared by
 * lowercased display name instead of exact-cased identity), so the Merge button
 * could never activate.
 *
 * Unlike merge-dialog-same-practice-init.test.tsx (which renders MergeDialog
 * directly with hand-built initialSources), this suite exercises the REAL
 * launch path: it renders the whole DoctorsPage, lets buildDuplicateClusters
 * group two similar case-history doctors into a notification cluster, clicks the
 * cluster's "Review" button, and asserts the opened modal has exactly one target
 * and one selectable source with Merge enabled — no target/source overlap.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const LAB_ID = "lab_abc123";
const PROVIDER_ID = "org-985";

const previewMutate = vi.fn();
const mergeMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useMergeDoctors: () => ({ mutate: mergeMutate, isPending: false }),
  usePreviewDoctorMerge: () => ({ mutate: previewMutate, data: undefined }),
  useUndoDoctorMerge: () => ({ mutate: vi.fn(), isPending: false }),
  useListUnassignedDoctors: () => ({ data: { ok: true, data: [] } }),
  // The dialog's picker searches for names similar to the first source; return
  // both cluster doctors so the search list renders realistically.
  searchDoctors: async () => ({
    data: {
      entries: [
        {
          doctorName: "Dr. Kanesha Cole",
          providerOrganizationId: PROVIDER_ID,
          practiceName: "Mahan Village Dental Care",
          totalCases: 3,
          similarity: 1,
        },
        {
          doctorName: "Kanesha Cole",
          providerOrganizationId: PROVIDER_ID,
          practiceName: "Mahan Village Dental Care",
          totalCases: 2,
          similarity: 1,
        },
      ],
      total: 2,
    },
  }),
}));

const PROVIDER_ID_2 = "org-641";

// Per-test fixtures so each test can shape the cases/orgs the page reads. The
// apiFetch mock routes by endpoint using these mutable holders.
let casesData: Array<Record<string, unknown>> = [];
let orgsData: Array<Record<string, unknown>> = [];

function makeCase(
  id: string,
  doctorName: string,
  providerOrganizationId: string = PROVIDER_ID,
) {
  return {
    id,
    doctorName,
    providerOrganizationId,
    labOrganizationId: LAB_ID,
    status: "new",
    priority: "standard",
    totalPrice: "100",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const LAB_ORG = {
  id: LAB_ID,
  name: "Acme Dental Lab",
  displayName: "Acme Dental Lab",
  type: "lab",
};
function providerOrg(id: string, name: string) {
  return {
    id,
    name,
    displayName: name,
    type: "provider",
    parentLabOrganizationId: LAB_ID,
  };
}

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path === "/cases") return casesData;
      if (path === "/invoices") return [];
      if (path === "/organizations") return orgsData;
      if (path === "/auth/me") {
        return {
          user: { id: "u1", username: "owner", role: "owner" },
          memberships: [
            {
              id: "m1",
              role: "owner",
              status: "active",
              organizationId: LAB_ID,
              organization: { id: LAB_ID, type: "lab" },
            },
          ],
        };
      }
      return [];
    }),
  };
});

import DoctorsPage from "@/pages/doctors";

beforeEach(() => {
  previewMutate.mockReset();
  mergeMutate.mockReset();
  window.localStorage.clear();
  // Default fixture: two similar same-practice doctors that form one cluster.
  casesData = [
    makeCase("c1", "Dr. Kanesha Cole"),
    makeCase("c2", "Kanesha Cole"),
  ];
  orgsData = [LAB_ORG, providerOrg(PROVIDER_ID, "Mahan Village Dental Care")];
});

describe("MergeDialog — opened from the duplicate-doctor notification", () => {
  it("opens with one target + one selectable source and Merge enabled (no target/source overlap)", async () => {
    render(<DoctorsPage />, {
      wrapper: makeAuthWrapper("/doctors", {
        user: { id: "u1", username: "owner", role: "owner" } as never,
        status: "authed",
        restoreStatus: "ok",
        restoreNoticeDismissed: true,
      }),
    });

    // The suggested-duplicate notification renders a "Review" button once the
    // cluster is built from the two case-history doctors.
    const reviewBtn = await screen.findByRole("button", { name: /Review/i });
    fireEvent.click(reviewBtn);

    // The Merge doctors modal opens.
    expect(
      await screen.findByRole("heading", { name: "Merge doctors" }),
    ).toBeInTheDocument();

    // Exactly one source (the second duplicate); the auto-picked target is
    // excluded from SOURCES so the self-merge guard can't disable Merge.
    // Scope to the Sources <section> — the notification cluster list stays
    // mounted behind the modal, so a bare getByRole("list") is ambiguous.
    const sourcesSection = screen.getByText("Sources (1)").closest("section")!;
    expect(within(sourcesSection).getByText("Kanesha Cole")).toBeInTheDocument();
    expect(
      within(sourcesSection).queryByText("Dr. Kanesha Cole"),
    ).not.toBeInTheDocument();

    // No self-merge warning, and the Merge button is enabled.
    expect(screen.queryByText(/Same as a source/i)).not.toBeInTheDocument();
    const mergeBtn = screen.getByRole("button", { name: "Merge" });
    await waitFor(() => expect(mergeBtn).toBeEnabled());

    // Firing the merge sends exactly one target + one distinct source, with no
    // overlap between the two sets.
    fireEvent.click(mergeBtn);
    expect(mergeMutate).toHaveBeenCalledTimes(1);
    const body = (mergeMutate.mock.calls[0][0] as { data: DoctorMergeBody }).data;
    expect(body.targetDoctorName).toBe("Dr. Kanesha Cole");
    expect(body.targetProviderOrganizationId).toBe(PROVIDER_ID);
    expect(body.sources).toEqual([
      { doctorName: "Kanesha Cole", providerOrganizationId: PROVIDER_ID },
    ]);
    // Guardrail: the target must never also be a source.
    for (const s of body.sources) {
      const overlaps =
        s.doctorName === body.targetDoctorName &&
        (s.providerOrganizationId ?? null) ===
          (body.targetProviderOrganizationId ?? null);
      expect(overlaps).toBe(false);
    }
  });

  it("treats same display name at different practices as distinct identity (one target + one source)", async () => {
    // Two doctors share the exact display name but belong to different
    // practices, so their stable identity (name + providerOrganizationId)
    // differs. A regression to lowercased-name-only identity would collapse
    // them and disable Merge. Through the notification launch path we expect
    // one target and one distinct source.
    casesData = [
      makeCase("c1", "Ray Montalvo", PROVIDER_ID),
      makeCase("c2", "Ray Montalvo", PROVIDER_ID_2),
    ];
    orgsData = [
      LAB_ORG,
      providerOrg(PROVIDER_ID, "Mahan Village Dental Care"),
      providerOrg(PROVIDER_ID_2, "Riverside Family Dentistry"),
    ];

    render(<DoctorsPage />, {
      wrapper: makeAuthWrapper("/doctors", {
        user: { id: "u1", username: "owner", role: "owner" } as never,
        status: "authed",
        restoreStatus: "ok",
        restoreNoticeDismissed: true,
      }),
    });

    const reviewBtn = await screen.findByRole("button", { name: /Review/i });
    fireEvent.click(reviewBtn);

    expect(
      await screen.findByRole("heading", { name: "Merge doctors" }),
    ).toBeInTheDocument();

    // Exactly one source survives — the other same-named doctor at the other
    // practice — because identity is keyed on name + practice, not name alone.
    expect(screen.getByText("Sources (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Same as a source/i)).not.toBeInTheDocument();
    const mergeBtn = screen.getByRole("button", { name: "Merge" });
    await waitFor(() => expect(mergeBtn).toBeEnabled());

    fireEvent.click(mergeBtn);
    expect(mergeMutate).toHaveBeenCalledTimes(1);
    const body = (mergeMutate.mock.calls[0][0] as { data: DoctorMergeBody }).data;
    expect(body.targetDoctorName).toBe("Ray Montalvo");
    expect(body.sources).toHaveLength(1);
    const [source] = body.sources;
    expect(source.doctorName).toBe("Ray Montalvo");
    // Same name, but the source's practice differs from the target's — proving
    // the two are held distinct by practice-scoped identity, not overlapping.
    expect(source.providerOrganizationId).not.toBe(
      body.targetProviderOrganizationId,
    );
    expect(
      new Set([source.providerOrganizationId, body.targetProviderOrganizationId]),
    ).toEqual(new Set([PROVIDER_ID, PROVIDER_ID_2]));
  });
});

interface DoctorMergeBody {
  labOrganizationId: string;
  sources: Array<{ doctorName: string; providerOrganizationId: string | null }>;
  targetDoctorName: string;
  targetProviderOrganizationId: string | null;
  includeSoftDeleted: boolean;
}
