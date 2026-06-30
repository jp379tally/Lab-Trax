/** @vitest-environment jsdom */
/**
 * Regression suite: "Reassign a case's doctor (single-reassign mode)"
 *
 * From case detail, staff can fix a wrong doctor choice by reassigning the
 * case onto an existing doctor in the SAME practice. This reuses MergeDialog
 * with `singleReassign`, which reuses the duplicate-doctor merge endpoints.
 *
 * The core constraint is that a reassignment must land on an EXISTING doctor
 * in the case's OWN practice — it must never create a new doctor and never
 * cross-link to another practice. These tests pin:
 * - the target picker only offers same-practice doctors (cross-practice
 *   candidates are filtered out);
 * - the current (wrong) doctor is excluded from the picker;
 * - picking a same-practice doctor whose preview confirms it exists enables
 *   "Reassign" and submits the expected body (source = current doctor,
 *   target = pick, practice pinned to the case's practice);
 * - if the preview reports the target does NOT exist, "Reassign" stays
 *   disabled (defense against implicit new-doctor creation).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const previewMutate = vi.fn();
const mergeMutate = vi.fn();

const LAB_ID = "lab_abc123";
const PRACTICE_ID = "org-practice-1";
const OTHER_PRACTICE_ID = "org-practice-2";

// Server search returns matches across the whole lab; the dialog is responsible
// for narrowing to the case's own practice in reassign mode.
const SEARCH_ENTRIES = [
  {
    doctorName: "Wrong Name",
    providerOrganizationId: PRACTICE_ID,
    practiceName: "Bright Smiles",
    totalCases: 4,
    similarity: 1,
  },
  {
    doctorName: "Correct Name",
    providerOrganizationId: PRACTICE_ID,
    practiceName: "Bright Smiles",
    totalCases: 9,
    similarity: 0.9,
  },
  {
    doctorName: "Other Practice Doc",
    providerOrganizationId: OTHER_PRACTICE_ID,
    practiceName: "Faraway Dental",
    totalCases: 2,
    similarity: 0.95,
  },
];

// Mutable so each test can simulate the server preview verdict.
let previewData: unknown = undefined;

vi.mock("@workspace/api-client-react", () => ({
  useMergeDoctors: () => ({ mutate: mergeMutate, isPending: false }),
  usePreviewDoctorMerge: () => ({ mutate: previewMutate, data: previewData }),
  useUndoDoctorMerge: () => ({ mutate: vi.fn(), isPending: false }),
  useListUnassignedDoctors: () => ({ data: { ok: true, data: [] } }),
  searchDoctors: async () => ({
    data: { entries: SEARCH_ENTRIES, total: SEARCH_ENTRIES.length },
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: vi.fn(async () => [
      {
        id: PRACTICE_ID,
        name: "Bright Smiles",
        displayName: "Bright Smiles",
        type: "provider",
        parentLabOrganizationId: LAB_ID,
      },
    ]),
  };
});

import { MergeDialog, type MergeSourceInput } from "@/pages/doctors";

beforeEach(() => {
  previewMutate.mockReset();
  mergeMutate.mockReset();
  previewData = undefined;
});

function renderReassign(onMerged: (r: unknown) => void = () => {}) {
  const initialSources: MergeSourceInput[] = [
    {
      doctorName: "Wrong Name",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Bright Smiles",
    },
  ];
  return render(
    <MergeDialog
      labOrganizationId={LAB_ID}
      initialSources={initialSources}
      onClose={() => {}}
      onMerged={onMerged}
      singleReassign
    />,
    { wrapper: makeAuthWrapper() },
  );
}

describe("MergeDialog — single-reassign mode", () => {
  it("offers only same-practice doctors and excludes the current doctor", async () => {
    renderReassign();

    // The correct same-practice doctor is a selectable target.
    await waitFor(() =>
      expect(screen.getByText("Correct Name")).toBeInTheDocument(),
    );

    // A cross-practice doctor is never offered as a target.
    expect(screen.queryByText("Other Practice Doc")).not.toBeInTheDocument();

    // Exactly one candidate ("Correct Name") is offered: the current/wrong
    // doctor is excluded from the picker even though search returned it.
    expect(screen.getAllByRole("button", { name: "Set target" })).toHaveLength(
      1,
    );
  });

  it("enables Reassign and submits the expected body for an existing same-practice target", async () => {
    previewData = {
      data: { targetExists: true, totalCases: 4, totalOverrides: 0, targetCases: 9 },
    };
    const onMerged = vi.fn();
    renderReassign(onMerged);

    await waitFor(() =>
      expect(screen.getByText("Correct Name")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set target" }));

    const reassignBtn = screen.getByRole("button", { name: "Reassign" });
    await waitFor(() => expect(reassignBtn).toBeEnabled());

    fireEvent.click(reassignBtn);

    expect(mergeMutate).toHaveBeenCalledTimes(1);
    expect(mergeMutate).toHaveBeenCalledWith({
      data: {
        labOrganizationId: LAB_ID,
        sources: [
          { doctorName: "Wrong Name", providerOrganizationId: PRACTICE_ID },
        ],
        targetDoctorName: "Correct Name",
        targetProviderOrganizationId: PRACTICE_ID,
        includeSoftDeleted: false,
      },
    });
  });

  it("keeps Reassign disabled when the preview says the target does not exist", async () => {
    previewData = {
      data: { targetExists: false, totalCases: 4, totalOverrides: 0, targetCases: 0 },
    };
    renderReassign();

    await waitFor(() =>
      expect(screen.getByText("Correct Name")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set target" }));

    // Even with a target name selected, an implicit new-doctor creation must
    // never be allowed in reassign mode.
    expect(screen.getByRole("button", { name: "Reassign" })).toBeDisabled();
  });
});
