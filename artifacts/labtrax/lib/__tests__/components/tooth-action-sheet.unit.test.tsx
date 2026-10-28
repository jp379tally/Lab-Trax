/**
 * Unit tests for ToothActionSheet.
 *
 * These tests render the component directly (no CaseDetailScreen wrapper) so
 * the full crown wizard, pontic / missing fast-paths, and the error banner are
 * exercised without any screen-level noise.
 *
 * The mocks in vitest.setup.ts already cover every native dependency that
 * ToothActionSheet imports (react-native, safe-area-context, vector-icons,
 * theme-context), so no additional vi.mock() calls are needed here.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";

// The global setupFiles mock replaces ToothActionSheet with nullComponent so
// screen-level smoke tests aren't slowed by the chart wizard. Override it here
// so we get the real component for unit testing.
vi.mock("@/components/ToothActionSheet", async (importOriginal) => {
  return await importOriginal<typeof import("@/components/ToothActionSheet")>();
});

import { ToothActionSheet, type ToothActionPayload } from "@/components/ToothActionSheet";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function renderSheet(
  overrides: Partial<React.ComponentProps<typeof ToothActionSheet>> = {},
) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const utils = await render(
    <ToothActionSheet
      toothId="14"
      onClose={onClose}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onConfirm };
}

// ─── Crown wizard ─────────────────────────────────────────────────────────────

describe("ToothActionSheet — crown wizard", () => {
  it("labels and saves the existing assignment's veneer role explicitly", async () => {
    const { getByText, onConfirm } = await renderSheet({
      existingLabel: "Crown", existingRestorationId: "rest-14",
      existingAssignment: { toothNumber: "14", restorationType: "Crown", material: "Zirconia", shade: "A2" },
    });
    await fireEvent.press(getByText("Veneer"));
    await fireEvent.press(getByText("Save role"));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "change_role", role: "Veneer", restorationId: "rest-14", toothId: "14",
    });
  });
  it("assigns a veneer with its material and shade without changing it into a crown", async () => {
    const { getByTestId, onConfirm } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-veneer"));
    await fireEvent.press(getByTestId("tooth-material-Lithium Disilicate (Emax)"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-A1"));
    await fireEvent.press(getByTestId("tooth-shade-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      kind: "add_crown", restorationType: "Veneer", toothId: "14",
      material: "Lithium Disilicate (Emax)", shade: "A1",
    }));
  });
  it("renders the kind-selection step initially", async () => {
    const { getByTestId } = await renderSheet();
    expect(getByTestId("tooth-kind-crown")).toBeTruthy();
    expect(getByTestId("tooth-kind-pontic")).toBeTruthy();
    expect(getByTestId("tooth-kind-missing")).toBeTruthy();
  });

  it("advances to the material step when Crown is chosen", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    // Kind cards must be gone; at least one material chip must be visible.
    expect(queryByTestId("tooth-kind-crown")).toBeNull();
    expect(getByTestId("tooth-material-Zirconia")).toBeTruthy();
  });

  it("keeps the Next button disabled until a material is selected", async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    const nextBtn = getByTestId("tooth-material-next");
    // The button is rendered but marked disabled (prop check).
    expect(nextBtn.props.disabled).toBe(true);
  });

  it("enables the Next button once a material is selected", async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    expect(getByTestId("tooth-material-next").props.disabled).toBe(false);
  });

  it("advances to the shade step after selecting material and pressing Next", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Lithium Disilicate (Emax)"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    // Material chips gone; shade chips present.
    expect(queryByTestId("tooth-material-next")).toBeNull();
    expect(getByTestId("tooth-shade-A1")).toBeTruthy();
    expect(getByTestId("tooth-shade-skip")).toBeTruthy();
    expect(getByTestId("tooth-shade-confirm")).toBeTruthy();
  });

  it("emits the correct ToothActionPayload for crown + material + shade on Confirm", async () => {
    const { getByTestId, onConfirm } = await renderSheet();

    // kind → material → shade → confirm
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-A2"));
    await fireEvent.press(getByTestId("tooth-shade-confirm"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as ToothActionPayload;
    expect(payload).toMatchObject<ToothActionPayload>({
      kind: "add_crown",
      toothId: "14",
      material: "Zirconia",
      restorationType: "Crown",
      shade: "A2",
    });
  });

  it("emits a payload without shade when Skip is pressed", async () => {
    const { getByTestId, onConfirm } = await renderSheet();

    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-PFM"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-skip"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as ToothActionPayload;
    expect(payload.kind).toBe("add_crown");
    expect((payload as Extract<ToothActionPayload, { kind: "add_crown" }>).shade).toBeUndefined();
  });

  it("keeps Confirm disabled when no shade chip is selected", async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    expect(getByTestId("tooth-shade-confirm").props.disabled).toBe(true);
  });

  it("navigates back from shade to material via the back button", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    // We are on shade step — back button is present.
    await fireEvent.press(getByTestId("tooth-action-back"));
    // Shade controls gone; material chips back.
    expect(queryByTestId("tooth-shade-confirm")).toBeNull();
    expect(getByTestId("tooth-material-Zirconia")).toBeTruthy();
  });

  it("supports a custom 'Other' shade entered via text input", async () => {
    const { getByTestId, onConfirm } = await renderSheet();

    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-other"));
    await fireEvent.changeText(getByTestId("tooth-shade-custom"), "Vita 3L");
    await fireEvent.press(getByTestId("tooth-shade-confirm"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as Extract<ToothActionPayload, { kind: "add_crown" }>;
    expect(payload.shade).toBe("Vita 3L");
  });

  it("keeps Confirm disabled when 'Other' is selected but the text input is empty", async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-crown"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-other"));
    // text input is empty — confirm must remain disabled
    expect(getByTestId("tooth-shade-confirm").props.disabled).toBe(true);
  });
});

// ─── Pontic material selection / missing fast-paths ──────────────────────────

describe("ToothActionSheet — pontic material selection / missing", () => {
  it("requires an explicit material for a pontic before adding the unit", async () => {
    const { getByTestId, onConfirm } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-pontic"));
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-skip"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as Extract<ToothActionPayload, { kind: "add_pontic" }>;
    expect(payload).toMatchObject({ kind: "add_pontic", toothId: "14", material: "Zirconia" });
  });

  it("emits a mark_missing payload immediately when Missing is chosen", async () => {
    const { getByTestId, onConfirm } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-kind-missing"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0]).toEqual<ToothActionPayload>({
      kind: "mark_missing",
      toothId: "14",
    });
  });

  it("does not call onConfirm when toothId is null", async () => {
    const { getByTestId, onConfirm } = await renderSheet({ toothId: null });
    await fireEvent.press(getByTestId("tooth-kind-pontic"));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ─── Close / reset ────────────────────────────────────────────────────────────

describe("ToothActionSheet — close", () => {
  it("calls onClose when the X button is pressed", async () => {
    const { getByTestId, onClose } = await renderSheet();
    await fireEvent.press(getByTestId("tooth-action-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ─── Error banner ─────────────────────────────────────────────────────────────

describe("ToothActionSheet — error banner", () => {
  it("renders the error message when the error prop is provided", async () => {
    const { getByText } = await renderSheet({ error: "Server returned 500" });
    expect(getByText("Server returned 500")).toBeTruthy();
  });

  it("renders nothing for the error banner when error is null", async () => {
    const { queryByText } = await renderSheet({ error: null });
    expect(queryByText(/Server|error/i)).toBeNull();
  });
});

// ─── Existing-label prompt ────────────────────────────────────────────────────

describe("ToothActionSheet — existing restoration label", () => {
  it("shows the existing label in the prompt when provided", async () => {
    const { getByText } = await renderSheet({ existingLabel: "Crown" });
    expect(getByText(/already has Crown/i)).toBeTruthy();
  });

  it("shows the generic prompt when no existing label is present", async () => {
    const { getByText } = await renderSheet({ existingLabel: null });
    expect(getByText(/What are you adding to tooth 14/i)).toBeTruthy();
  });
});
