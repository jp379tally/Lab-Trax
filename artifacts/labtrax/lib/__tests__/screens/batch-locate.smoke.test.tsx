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

import BatchLocateScreen from "@/app/batch-locate/index";

// ── barcode-guide-box mock ────────────────────────────────────────────────────
// We stub pickBestBarcode to control the "out-of-box → ignored" and
// "in-box → lookup" paths independently from the real guide-box geometry.
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
  organizationId: "lab-org-batch-smoke",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

function renderScanner() {
  return render(<BatchLocateScreen />);
}

function simulateScannerLayout(utils: ReturnType<typeof render>) {
  const area = utils.getByTestId("batch-locate-scanner-area");
  fireEvent(area, "layout", {
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

describe("BatchLocateScreen — scanner step", () => {
  it("renders the scanning step without throwing", () => {
    expect(() => renderScanner()).not.toThrow();
  });

  it("shows the Batch Locate header and initial prompt", () => {
    const { getByText } = renderScanner();
    expect(getByText("Batch Locate")).toBeTruthy();
    expect(getByText("Scan case pans to build your batch")).toBeTruthy();
  });

  it("Continue button is disabled when no cases have been scanned", () => {
    const { getByTestId } = renderScanner();
    const btn = getByTestId("batch-locate-continue");
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
  });

  describe("guide-box filter wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    });

    it("does NOT issue a lookup when pickBestBarcode returns null (out-of-box barcode)", () => {
      mockPickBestBarcode.mockReturnValue(null);

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("OUT-OF-BOX-BATCH-001", null);

      // Run the 120 ms debounce synchronously; no async lookup should follow.
      act(() => { vi.runAllTimers(); });

      expect(resilientFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("barcode"),
      );
    });

    it("issues a lookup when pickBestBarcode returns a barcode (in-box barcode)", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "IN-BOX-BATCH-001" });
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("IN-BOX-BATCH-001", null);
      act(() => { vi.runAllTimers(); });

      // Switch back to real timers so waitFor polling works normally.
      vi.useRealTimers();

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("IN-BOX-BATCH-001"),
        );
      });
    });

    it("appends a found case to the scanned list after a successful in-box scan", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "PAN-ABC-123" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-batch-001",
                patientFirstName: "Bob",
                patientLastName: "Baker",
                caseNumber: "8001",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-ABC-123", null);
      act(() => { vi.runAllTimers(); });

      vi.useRealTimers();

      await waitFor(() => {
        expect(utils.getByText("Bob Baker")).toBeTruthy();
      });

      // Subtitle updates to show the count.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("does NOT append a duplicate barcode to the scanned list", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "PAN-DUP-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-dup-001",
                patientFirstName: "Carol",
                patientLastName: "Chen",
                caseNumber: "8002",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      // First scan — should succeed.
      triggerMockBarcodeScan("PAN-DUP-001", null);
      act(() => { vi.runAllTimers(); });

      vi.useRealTimers();
      await waitFor(() => expect(utils.getByText("Carol Chen")).toBeTruthy());

      // Second scan of the same barcode — should be rejected as a duplicate.
      vi.useFakeTimers();
      mockPickBestBarcode.mockReturnValue({ data: "PAN-DUP-001" });
      triggerMockBarcodeScan("PAN-DUP-001", null);
      act(() => { vi.runAllTimers(); });
      vi.useRealTimers();

      // Still only 1 case in the list.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });
  });
});
