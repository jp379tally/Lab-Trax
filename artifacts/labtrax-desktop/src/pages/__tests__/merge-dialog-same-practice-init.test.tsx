/** @vitest-environment jsdom */
/**
 * Regression suite: "Merge button disabled on same-practice duplicate doctors"
 *
 * In the Customer Center, opening "Merge doctors" on a suggested-duplicate
 * cluster whose doctors all share the same practice used to auto-pick the first
 * doctor as the TARGET while ALSO leaving that same doctor in the SOURCES list.
 * That tripped the "Same as a source" self-merge guard and permanently disabled
 * the Merge button.
 *
 * The fix excludes the auto-picked target (matched by name +
 * providerOrganizationId) from the initial sources on the same-practice path,
 * mirroring what the mixed known/unknown-practice path already did.
 *
 * These tests pin:
 * - a same-practice cluster opens with the first doctor as target, NOT present
 *   in sources, no "Same as a source" warning, and an enabled Merge button;
 * - the mixed known/unknown-practice initialization is unchanged;
 * - the self-merge guard still blocks genuinely re-adding the target as source.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const previewMutate = vi.fn();
const mergeMutate = vi.fn();
// Captures the options object passed to useMergeDoctors on every render so a
// test can drive the success/error handlers exactly as the real mutation would.
const mergeHookCalls: Array<{
  mutation?: {
    onSuccess?: (res: unknown) => void;
    onError?: (err: unknown) => void;
  };
}> = [];

vi.mock("@workspace/api-client-react", () => ({
  useMergeDoctors: (opts: {
    mutation?: {
      onSuccess?: (res: unknown) => void;
      onError?: (err: unknown) => void;
    };
  }) => {
    mergeHookCalls.push(opts);
    return { mutate: mergeMutate, isPending: false };
  },
  usePreviewDoctorMerge: () => ({ mutate: previewMutate, data: undefined }),
  useUndoDoctorMerge: () => ({ mutate: vi.fn(), isPending: false }),
  useListUnassignedDoctors: () => ({ data: { ok: true, data: [] } }),
  searchDoctors: async () => ({ data: { entries: [], total: 0 } }),
}));

const LAB_ID = "lab_abc123";
const PROVIDER_ID = "org-985";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    // The target-practice picker reads the lab's provider practices from
    // `/organizations`; expose the cluster's practice so "Create new" mode can
    // re-select it and reproduce a genuine target==source self-merge.
    apiFetch: vi.fn(async () => [
      {
        id: PROVIDER_ID,
        name: "Mahan Village Dental Care",
        displayName: "Mahan Village Dental Care",
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
  mergeHookCalls.length = 0;
});

function renderDialog(
  initialSources: MergeSourceInput[],
  onMerged: (r: unknown) => void = () => {},
) {
  return render(
    <MergeDialog
      labOrganizationId={LAB_ID}
      initialSources={initialSources}
      onClose={() => {}}
      onMerged={onMerged}
    />,
    { wrapper: makeAuthWrapper() },
  );
}

describe("MergeDialog — same-practice duplicate initialization", () => {
  it("opens a same-practice cluster with target excluded from sources and Merge enabled", async () => {
    renderDialog([
      {
        doctorName: "Dr. Kanesha Cole",
        providerOrganizationId: PROVIDER_ID,
        practiceName: "Mahan Village Dental Care",
      },
      {
        doctorName: "Kanesha Cole",
        providerOrganizationId: PROVIDER_ID,
        practiceName: "Mahan Village Dental Care",
      },
    ]);

    // First doctor is promoted to TARGET and must NOT remain in SOURCES.
    expect(screen.getByText("Sources (1)")).toBeInTheDocument();

    const sourcesList = screen.getByRole("list");
    expect(
      within(sourcesList).getByText("Kanesha Cole"),
    ).toBeInTheDocument();
    expect(
      within(sourcesList).queryByText("Dr. Kanesha Cole"),
    ).not.toBeInTheDocument();

    // No self-merge warning on first open.
    expect(screen.queryByText(/Same as a source/i)).not.toBeInTheDocument();

    // Merge button is enabled.
    const mergeBtn = screen.getByRole("button", { name: "Merge" });
    expect(mergeBtn).toBeEnabled();
  });

  it("keeps the mixed known/unknown-practice initialization (only unknown stays a source)", () => {
    renderDialog([
      {
        doctorName: "Dr. Real Doctor",
        providerOrganizationId: PROVIDER_ID,
        practiceName: "Real Practice",
      },
      {
        doctorName: "Ghost Doctor",
        providerOrganizationId: null,
        practiceName: "",
      },
    ]);

    // Known-practice doctor is the target; only the unknown-practice ghost
    // remains as a source.
    expect(screen.getByText("Sources (1)")).toBeInTheDocument();
    const sourcesList = screen.getByRole("list");
    expect(within(sourcesList).getByText("Ghost Doctor")).toBeInTheDocument();
    expect(
      within(sourcesList).queryByText("Dr. Real Doctor"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Same as a source/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("still blocks a genuine self-merge when the target is re-added as a source", async () => {
    renderDialog([
      {
        doctorName: "Dr. Kanesha Cole",
        providerOrganizationId: PROVIDER_ID,
        practiceName: "Mahan Village Dental Care",
      },
      {
        doctorName: "Kanesha Cole",
        providerOrganizationId: PROVIDER_ID,
        practiceName: "Mahan Village Dental Care",
      },
    ]);

    // Re-create the target as "Kanesha Cole" at the SAME practice as the lone
    // remaining source, so the self-merge guard must fire and disable Merge.
    fireEvent.click(screen.getByRole("button", { name: "Create new" }));
    const nameInput = screen.getByPlaceholderText("e.g. Dr. Jane Smith");
    fireEvent.change(nameInput, { target: { value: "Kanesha Cole" } });
    // Pick the cluster's practice from the (async-loaded) practice dropdown.
    const practiceSelect = await screen.findByRole("combobox");
    await waitFor(() =>
      expect(
        within(practiceSelect).getByRole("option", {
          name: "Mahan Village Dental Care",
        }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(practiceSelect, { target: { value: PROVIDER_ID } });

    await waitFor(() =>
      expect(screen.getByText(/Same as a source/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });
});

describe("MergeDialog — submitting an enabled merge", () => {
  it("sends the expected DoctorMergeRequest body and fires onMerged on success", async () => {
    const onMerged = vi.fn();
    renderDialog(
      [
        {
          doctorName: "Dr. Kanesha Cole",
          providerOrganizationId: PROVIDER_ID,
          practiceName: "Mahan Village Dental Care",
        },
        {
          doctorName: "Kanesha Cole",
          providerOrganizationId: PROVIDER_ID,
          practiceName: "Mahan Village Dental Care",
        },
      ],
      onMerged,
    );

    const mergeBtn = screen.getByRole("button", { name: "Merge" });
    await waitFor(() => expect(mergeBtn).toBeEnabled());

    fireEvent.click(mergeBtn);

    // The mutation is invoked exactly once with the merge request body: the
    // first doctor is the target (excluded from sources) and the duplicate
    // remains the lone source.
    expect(mergeMutate).toHaveBeenCalledTimes(1);
    expect(mergeMutate).toHaveBeenCalledWith({
      data: {
        labOrganizationId: LAB_ID,
        sources: [
          { doctorName: "Kanesha Cole", providerOrganizationId: PROVIDER_ID },
        ],
        targetDoctorName: "Dr. Kanesha Cole",
        targetProviderOrganizationId: PROVIDER_ID,
        includeSoftDeleted: false,
      },
    });

    // Drive the mutation's success handler the way the real hook would, and
    // confirm onMerged surfaces a sensible message + server undo window.
    const onSuccess =
      mergeHookCalls[mergeHookCalls.length - 1]?.mutation?.onSuccess;
    expect(onSuccess).toBeTypeOf("function");
    onSuccess?.({
      data: {
        targetDoctorName: "Dr. Kanesha Cole",
        casesMoved: 3,
        overridesMoved: 1,
        overridesCollapsed: 0,
        undoWindowMs: 5 * 60 * 1000,
        entries: [{ auditLogId: "audit-1" }],
      },
    });

    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(onMerged).toHaveBeenCalledWith({
      auditLogIds: ["audit-1"],
      message:
        "3 cases merged + 1 pricing override into Dr. Kanesha Cole.",
      undoWindowMs: 5 * 60 * 1000,
    });
  });
});
