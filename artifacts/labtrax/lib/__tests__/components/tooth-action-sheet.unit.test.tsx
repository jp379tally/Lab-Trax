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

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof ToothActionSheet>> = {},
) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(
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
  it("renders the kind-selection step initially", () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId("tooth-kind-crown")).toBeTruthy();
    expect(getByTestId("tooth-kind-pontic")).toBeTruthy();
    expect(getByTestId("tooth-kind-missing")).toBeTruthy();
  });

  it("advances to the material step when Crown is chosen", () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    // Kind cards must be gone; at least one material chip must be visible.
    expect(queryByTestId("tooth-kind-crown")).toBeNull();
    expect(getByTestId("tooth-material-Zirconia")).toBeTruthy();
  });

  it("keeps the Next button disabled until a material is selected", () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    const nextBtn = getByTestId("tooth-material-next");
    // The button is rendered but marked disabled (prop check).
    expect(nextBtn.props.disabled).toBe(true);
  });

  it("enables the Next button once a material is selected", () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    expect(getByTestId("tooth-material-next").props.disabled).toBe(false);
  });

  it("advances to the shade step after selecting material and pressing Next", () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-E.max"));
    fireEvent.press(getByTestId("tooth-material-next"));
    // Material chips gone; shade chips present.
    expect(queryByTestId("tooth-material-next")).toBeNull();
    expect(getByTestId("tooth-shade-A1")).toBeTruthy();
    expect(getByTestId("tooth-shade-skip")).toBeTruthy();
    expect(getByTestId("tooth-shade-confirm")).toBeTruthy();
  });

  it("emits the correct ToothActionPayload for crown + material + shade on Confirm", () => {
    const { getByTestId, onConfirm } = renderSheet();

    // kind → material → shade → confirm
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));
    fireEvent.press(getByTestId("tooth-shade-A2"));
    fireEvent.press(getByTestId("tooth-shade-confirm"));

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

  it("emits a payload without shade when Skip is pressed", () => {
    const { getByTestId, onConfirm } = renderSheet();

    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-PFM"));
    fireEvent.press(getByTestId("tooth-material-next"));
    fireEvent.press(getByTestId("tooth-shade-skip"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as ToothActionPayload;
    expect(payload.kind).toBe("add_crown");
    expect((payload as Extract<ToothActionPayload, { kind: "add_crown" }>).shade).toBeUndefined();
  });

  it("keeps Confirm disabled when no shade chip is selected", () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));
    expect(getByTestId("tooth-shade-confirm").props.disabled).toBe(true);
  });

  it("navigates back from shade to material via the back button", () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));
    // We are on shade step — back button is present.
    fireEvent.press(getByTestId("tooth-action-back"));
    // Shade controls gone; material chips back.
    expect(queryByTestId("tooth-shade-confirm")).toBeNull();
    expect(getByTestId("tooth-material-Zirconia")).toBeTruthy();
  });

  it("supports a custom 'Other' shade entered via text input", () => {
    const { getByTestId, onConfirm } = renderSheet();

    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));
    fireEvent.press(getByTestId("tooth-shade-other"));
    fireEvent.changeText(getByTestId("tooth-shade-custom"), "Vita 3L");
    fireEvent.press(getByTestId("tooth-shade-confirm"));

    expect(onConfirm).toHaveBeenCalledOnce();
    const payload = onConfirm.mock.calls[0][0] as Extract<ToothActionPayload, { kind: "add_crown" }>;
    expect(payload.shade).toBe("Vita 3L");
  });

  it("keeps Confirm disabled when 'Other' is selected but the text input is empty", () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-crown"));
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));
    fireEvent.press(getByTestId("tooth-shade-other"));
    // text input is empty — confirm must remain disabled
    expect(getByTestId("tooth-shade-confirm").props.disabled).toBe(true);
  });
});

// ─── Pontic / missing fast-paths ─────────────────────────────────────────────

describe("ToothActionSheet — pontic / missing fast-paths", () => {
  it("emits an add_pontic payload immediately when Pontic is chosen", () => {
    const { getByTestId, onConfirm } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-pontic"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0]).toEqual<ToothActionPayload>({
      kind: "add_pontic",
      toothId: "14",
    });
  });

  it("emits a mark_missing payload immediately when Missing is chosen", () => {
    const { getByTestId, onConfirm } = renderSheet();
    fireEvent.press(getByTestId("tooth-kind-missing"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0]).toEqual<ToothActionPayload>({
      kind: "mark_missing",
      toothId: "14",
    });
  });

  it("does not call onConfirm when toothId is null", () => {
    const { getByTestId, onConfirm } = renderSheet({ toothId: null });
    fireEvent.press(getByTestId("tooth-kind-pontic"));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ─── Close / reset ────────────────────────────────────────────────────────────

describe("ToothActionSheet — close", () => {
  it("calls onClose when the X button is pressed", () => {
    const { getByTestId, onClose } = renderSheet();
    fireEvent.press(getByTestId("tooth-action-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ─── Error banner ─────────────────────────────────────────────────────────────

describe("ToothActionSheet — error banner", () => {
  it("renders the error message when the error prop is provided", () => {
    const { getByText } = renderSheet({ error: "Server returned 500" });
    expect(getByText("Server returned 500")).toBeTruthy();
  });

  it("renders nothing for the error banner when error is null", () => {
    const { queryByText } = renderSheet({ error: null });
    expect(queryByText(/Server|error/i)).toBeNull();
  });
});

// ─── Existing-label prompt ────────────────────────────────────────────────────

describe("ToothActionSheet — existing restoration label", () => {
  it("shows the existing label in the prompt when provided", () => {
    const { getByText } = renderSheet({ existingLabel: "Crown" });
    expect(getByText(/already has Crown/i)).toBeTruthy();
  });

  it("shows the generic prompt when no existing label is present", () => {
    const { getByText } = renderSheet({ existingLabel: null });
    expect(getByText(/What are you adding to tooth 14/i)).toBeTruthy();
  });
});
