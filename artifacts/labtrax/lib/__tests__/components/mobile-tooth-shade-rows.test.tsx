import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native/pure";

const { mockUpdateRestoration, mockRefetchVocabulary, mockVocabularyResult } =
  vi.hoisted(() => ({
  mockUpdateRestoration: vi.fn(),
  mockRefetchVocabulary: vi.fn(),
  mockVocabularyResult: {} as Record<string, any>,
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetVocabularyQueryKey: (params: unknown) => ["/api/vocabulary", params],
  useGetVocabulary: () => ({ ...mockVocabularyResult }),
  useUpdateCaseRestoration: () => ({
    mutateAsync: mockUpdateRestoration,
  }),
}));

import { MobileToothShadeRows } from "@/components/case-detail/MobileToothShadeRows";
import type { CanonicalRestoration } from "@workspace/api-client-react";

const row = (
  overrides: Partial<CanonicalRestoration> = {},
): CanonicalRestoration => ({
  id: "rest-1",
  toothNumber: "4",
  restorationType: "Crown",
  shade: "A1",
  ...overrides,
});

afterEach(async () => {
  await cleanup();
});

beforeEach(() => {
  mockUpdateRestoration.mockReset();
  mockUpdateRestoration.mockResolvedValue({ ok: true });
  mockRefetchVocabulary.mockReset();
  mockRefetchVocabulary.mockResolvedValue(undefined);
  Object.assign(mockVocabularyResult, {
    data: {
      ok: true,
      data: [
        { id: "shade-a2", kind: "shade", value: "A2", isDefault: false },
        { id: "shade-pink", kind: "shade", value: "Light Pink", isDefault: false },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: mockRefetchVocabulary,
  });
});

async function openShade(
  getByTestId: (testId: string) => any,
  id: string,
) {
  await fireEvent.press(getByTestId(`tooth-shade-select-${id}`));
}

describe("MobileToothShadeRows", () => {
  it("saves and refetches shades against each persisted restoration identity", async () => {
    const onSaved = vi.fn();
    const firstRows = [
      row({ id: "rest-4", toothNumber: "4", shade: "A1" }),
      row({ id: "rest-29", toothNumber: "29", shade: "B1" }),
    ];
    const utils = await render(
      <MobileToothShadeRows
        restorations={firstRows}
        caseId="case-1"
        labOrganizationId="lab-1"
        canEdit
        onSaved={onSaved}
      />,
    );

    expect(utils.getByTestId("tooth-shade-label-rest-4").props.children).toBe("4");
    expect(utils.getByTestId("tooth-shade-label-rest-29").props.children).toBe("29");
    await openShade(utils.getByTestId, "rest-4");
    await fireEvent.press(utils.getByTestId("tooth-shade-option-rest-4-A2"));

    expect(mockUpdateRestoration).toHaveBeenCalledTimes(1);
    expect(mockUpdateRestoration).toHaveBeenCalledWith({
      caseId: "case-1",
      restorationId: "rest-4",
      data: { shade: "A2", syncLinkedArch: false },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(utils.getByTestId("tooth-shade-select-rest-4").props.children).toBeDefined();
    expect(utils.getByTestId("tooth-shade-select-rest-29").props.children).toBeDefined();

    // A successful parent refetch updates only the matching persisted row.
    await utils.rerender(
      <MobileToothShadeRows
        restorations={[
          row({ id: "rest-4", toothNumber: "4", shade: "A2" }),
          row({ id: "rest-29", toothNumber: "29", shade: "B1" }),
        ]}
        caseId="case-1"
        labOrganizationId="lab-1"
        canEdit
        onSaved={onSaved}
      />,
    );
    expect(utils.getByText("A2")).toBeTruthy();
    expect(utils.getByText("B1")).toBeTruthy();
  });

  it("prefers recorded upper/lower arch labels and edits their shades independently", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[
          row({ id: "upper", toothNumber: "", arch: "upper", shade: "A1" }),
          row({ id: "lower", toothNumber: "", arch: "lower", shade: "B1" }),
        ]}
        caseId="case-arches"
        labOrganizationId="lab-arches"
        canEdit
      />,
    );
    expect(utils.getByTestId("tooth-shade-label-upper").props.children).toBe(
      "Upper arch",
    );
    expect(utils.getByTestId("tooth-shade-label-lower").props.children).toBe(
      "Lower arch",
    );

    await openShade(utils.getByTestId, "upper");
    await fireEvent.press(utils.getByTestId("tooth-shade-option-upper-A2"));
    expect(mockUpdateRestoration).toHaveBeenCalledWith({
      caseId: "case-arches",
      restorationId: "upper",
      data: { shade: "A2", syncLinkedArch: false },
    });
    expect(utils.getByTestId("tooth-shade-select-lower").props.children).toBeDefined();
    expect(mockUpdateRestoration).toHaveBeenCalledTimes(1);
  });

  it("uses desktop-compatible free-text arch detection after explicit arch", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[
          row({ id: "legacy-upper", toothNumber: "U/D", restorationType: "Crown" }),
          row({
            id: "legacy-denture",
            toothNumber: "",
            restorationType: "Full Denture",
          }),
          row({
            id: "explicit-lower",
            toothNumber: "U/D",
            arch: "lower",
            restorationType: "Crown",
          }),
        ]}
        caseId="case-labels"
        canEdit={false}
      />,
    );
    expect(utils.getByTestId("tooth-shade-label-legacy-upper").props.children).toBe(
      "Upper arch",
    );
    expect(utils.getByTestId("tooth-shade-label-legacy-denture").props.children).toBe(
      "Full arch (upper & lower)",
    );
    expect(utils.getByTestId("tooth-shade-label-explicit-lower").props.children).toBe(
      "Lower arch",
    );
  });

  it("keeps range text and duplicate-tooth restorations as separate rows", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[
          row({ id: "range-one", toothNumber: "3-5", shade: "A1" }),
          row({ id: "range-two", toothNumber: "3-5", shade: "B1" }),
        ]}
        caseId="case-range"
        canEdit
      />,
    );

    expect(utils.getByTestId("tooth-shade-label-range-one").props.children).toBe(
      "3-5",
    );
    expect(utils.getByTestId("tooth-shade-label-range-two").props.children).toBe(
      "3-5",
    );
    expect(utils.getByTestId("tooth-shade-select-range-one")).toBeTruthy();
    expect(utils.getByTestId("tooth-shade-select-range-two")).toBeTruthy();
  });

  it("retains an existing nonstandard shade and persists an empty selection as a clear", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "custom", shade: "My Lab Pearl" })]}
        caseId="case-custom"
        canEdit
      />,
    );
    await openShade(utils.getByTestId, "custom");
    expect(utils.getByTestId("tooth-shade-option-custom-My Lab Pearl")).toBeTruthy();
    await fireEvent.press(utils.getByTestId("tooth-shade-option-clear-custom"));
    expect(mockUpdateRestoration).toHaveBeenCalledWith({
      caseId: "case-custom",
      restorationId: "custom",
      data: { shade: "", syncLinkedArch: false },
    });
  });

  it("uses populated lab vocabulary without unioning absent standard shades", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "vocabulary", shade: "A1" })]}
        caseId="case-vocabulary"
        labOrganizationId="lab-vocabulary"
        canEdit
      />,
    );
    await openShade(utils.getByTestId, "vocabulary");
    expect(
      utils.getByTestId("tooth-shade-option-vocabulary-A2"),
    ).toBeTruthy();
    expect(
      utils.queryByTestId("tooth-shade-option-vocabulary-A3"),
    ).toBeNull();
  });

  it("uses standard shades only after an empty lab vocabulary successfully loads", async () => {
    mockVocabularyResult.data = { ok: true, data: [] };
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "empty-vocabulary", shade: "" })]}
        caseId="case-empty-vocabulary"
        labOrganizationId="lab-empty-vocabulary"
        canEdit
      />,
    );
    await openShade(utils.getByTestId, "empty-vocabulary");
    expect(
      utils.getByTestId("tooth-shade-option-empty-vocabulary-A3"),
    ).toBeTruthy();
  });

  it("surfaces loading/failure for lab shades and allows retry", async () => {
    mockVocabularyResult.data = undefined;
    mockVocabularyResult.isLoading = true;
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "vocabulary-status" })]}
        caseId="case-vocabulary-status"
        labOrganizationId="lab-vocabulary-status"
        canEdit
      />,
    );
    expect(utils.getByTestId("tooth-shade-vocabulary-loading")).toBeTruthy();

    mockVocabularyResult.isLoading = false;
    mockVocabularyResult.isError = true;
    await utils.rerender(
      <MobileToothShadeRows
        restorations={[row({ id: "vocabulary-status" })]}
        caseId="case-vocabulary-status"
        labOrganizationId="lab-vocabulary-status"
        canEdit
      />,
    );
    expect(utils.getByTestId("tooth-shade-vocabulary-error")).toBeTruthy();
    await fireEvent.press(utils.getByTestId("tooth-shade-vocabulary-retry"));
    expect(mockRefetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it("reverts a failed shade change to the confirmed value and shows the reason", async () => {
    mockUpdateRestoration.mockRejectedValueOnce(new Error("Shade is not allowed"));
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "failed", shade: "A1" })]}
        caseId="case-failure"
        labOrganizationId="lab-failure"
        canEdit
      />,
    );
    await openShade(utils.getByTestId, "failed");
    await fireEvent.press(utils.getByTestId("tooth-shade-option-failed-A2"));
    expect(utils.getByTestId("tooth-shade-select-failed").props.children).toBeDefined();
    expect(utils.getByTestId("tooth-shade-error-failed").props.children).toBe(
      "Shade is not allowed",
    );
  });

  it("keeps a committed local confirmation through refresh failure and rolls a refused revert back to it", async () => {
    mockUpdateRestoration
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Revert refused"));
    const onSaved = vi.fn().mockRejectedValueOnce(new Error("Refresh failed"));
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "committed", shade: "A1" })]}
        caseId="case-committed"
        labOrganizationId="lab-committed"
        canEdit
        onSaved={onSaved}
      />,
    );

    await openShade(utils.getByTestId, "committed");
    await fireEvent.press(utils.getByTestId("tooth-shade-option-committed-A2"));
    expect(utils.getByText("A2")).toBeTruthy();
    expect(utils.queryByTestId("tooth-shade-error-committed")).toBeNull();

    // Props still carry stale A1 because the best-effort refresh failed. The
    // user can still choose that last-observed value to request a true revert.
    await openShade(utils.getByTestId, "committed");
    await fireEvent.press(utils.getByTestId("tooth-shade-option-committed-A1"));
    expect(mockUpdateRestoration).toHaveBeenCalledTimes(2);
    expect(mockUpdateRestoration).toHaveBeenLastCalledWith({
      caseId: "case-committed",
      restorationId: "committed",
      data: { shade: "A1", syncLinkedArch: false },
    });
    expect(utils.getByText("A2")).toBeTruthy();
    expect(utils.getByTestId("tooth-shade-error-committed").props.children).toBe(
      "Revert refused",
    );
  });

  it("shows read-only legacy case values without mapping them to restorations", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[]}
        legacyTeeth="4, 29"
        legacyShade="Legacy shade"
        caseId="legacy-case"
        canEdit
      />,
    );
    expect(utils.getByTestId("tooth-shade-legacy-fallback").props.children).toBeDefined();
    expect(utils.getByText(/Recorded on the case: 4, 29 — Legacy shade/)).toBeTruthy();
    expect(utils.queryByTestId("tooth-shade-select-legacy-case")).toBeNull();
    expect(mockUpdateRestoration).not.toHaveBeenCalled();
  });

  it("renders persisted restoration shades as read-only when editing is disabled", async () => {
    const utils = await render(
      <MobileToothShadeRows
        restorations={[row({ id: "read-only", shade: "A1" })]}
        caseId="readonly-case"
        canEdit={false}
      />,
    );
    expect(utils.getByTestId("tooth-shade-value-read-only").props.children).toBe(
      "A1",
    );
    expect(utils.queryByTestId("tooth-shade-select-read-only")).toBeNull();
    expect(mockUpdateRestoration).not.toHaveBeenCalled();
  });
});