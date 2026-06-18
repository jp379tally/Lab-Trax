import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  triggerMockBarcodeScan,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import * as Haptics from "expo-haptics";

import CasesListScreen from "@/app/(tabs)/index";

// ── barcode-guide-box mock ────────────────────────────────────────────────────
// We stub pickBestBarcode so smoke tests can exercise the "out-of-box → ignored"
// and "in-box → lookup" paths without needing real barcode position data.
// guideBoxFromLayout is kept real to catch any import-time regressions.
//
// vi.hoisted is required: vi.mock factories are hoisted to the top of the file
// by Vitest, so any variable they reference must also be hoisted.
const mockPickBestBarcode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/barcode-guide-box", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/barcode-guide-box")>();
  return { ...actual, pickBestBarcode: mockPickBestBarcode };
});

// ── helpers ───────────────────────────────────────────────────────────────────

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-scan-smoke",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

function openScanModal() {
  const utils = render(<CasesListScreen />);
  fireEvent.press(utils.getByTestId("cases-scan-barcode"));
  return utils;
}

function simulateCameraLayout(utils: ReturnType<typeof render>) {
  const wrap = utils.getByTestId("scan-camera-wrap");
  fireEvent(wrap, "layout", {
    nativeEvent: { layout: { width: 400, height: 600 } },
  });
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The haptics mock (vi.mock in vitest.setup) returns undefined by default;
  // the production code calls .catch() on the return value, so we need a
  // real Promise here to avoid a "Cannot read properties of undefined" crash.
  vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
});

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("CasesListScreen — barcode scan modal", () => {
  it("opens when the scan button is pressed", () => {
    const { getByText } = openScanModal();
    expect(getByText("Scan Barcode")).toBeTruthy();
    expect(getByText("Find a case by pan barcode")).toBeTruthy();
  });

  it("renders Camera and Manual mode tabs once open", () => {
    const { getByText } = openScanModal();
    expect(getByText("Camera")).toBeTruthy();
    expect(getByText("Manual")).toBeTruthy();
  });

  describe("guide-box filter wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    });

    it("does NOT issue a lookup when pickBestBarcode returns null (out-of-box barcode)", () => {
      mockPickBestBarcode.mockReturnValue(null);

      const utils = openScanModal();
      simulateCameraLayout(utils);

      triggerMockBarcodeScan("OUT-OF-BOX-001", null);

      // Run the 120 ms debounce synchronously; no async lookup should follow.
      act(() => { vi.runAllTimers(); });

      expect(resilientFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("barcode"),
      );
    });

    it("issues a lookup when pickBestBarcode returns a barcode (in-box barcode)", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "IN-BOX-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({ ok: false }),
          { status: 404 },
        ),
      );

      const utils = openScanModal();
      simulateCameraLayout(utils);

      triggerMockBarcodeScan("IN-BOX-001", null);

      // Fire the debounce timer; the lookup is async so we advance real time too.
      act(() => { vi.runAllTimers(); });

      // Switch back to real timers so waitFor polling works normally.
      vi.useRealTimers();

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("IN-BOX-001"),
        );
      });
    });

    it("navigates to the case after a successful in-box scan", async () => {
      const { router } = await import("expo-router");
      mockPickBestBarcode.mockReturnValue({ data: "FOUND-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-found-001",
                patientFirstName: "Alice",
                patientLastName: "Smith",
                caseNumber: "9001",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

      const utils = openScanModal();
      simulateCameraLayout(utils);

      triggerMockBarcodeScan("FOUND-001", null);
      act(() => { vi.runAllTimers(); });

      // Switch to real timers so the 900 ms post-match nav delay and waitFor work.
      vi.useRealTimers();

      await waitFor(
        () => {
          expect(router.push).toHaveBeenCalledWith("/case/case-found-001");
        },
        { timeout: 3000 },
      );
    });
  });
});
