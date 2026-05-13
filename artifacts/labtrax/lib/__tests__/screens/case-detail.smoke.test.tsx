import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
} from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";
import {
  aiImportedCase,
  completedCaseWithInvoice,
  inProgressCase,
  sampleClient,
  sampleInvoice,
} from "./__fixtures__/cases";

afterEach(() => {
  // Unmount the rendered tree FIRST so any pending fetch microtask runs
  // its cleanup (cancelled = true) before we tear down the mocked
  // app/fetch state. Without this the case-detail screen can re-render
  // after we've cleared `cases`, hit the early-return path, and trip
  // React's "Rendered fewer hooks than expected" guard.
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
});

describe("CaseDetailScreen (smoke)", () => {
  describe("when the case id does not match anything", () => {
    beforeEach(() => {
      setMockSearchParams({ id: "nonexistent-case-id" });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it('renders the "Case not found" empty state', () => {
      const { getByText } = render(<CaseDetailScreen />);
      expect(getByText("Case not found")).toBeTruthy();
    });
  });

  describe("with a normal in-progress case", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        clients: [sampleClient],
      });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the case header (case number + patient)", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
    });

    it("renders activity log entries from local state", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      // Note-type entries render their description verbatim in the timeline.
      expect(
        getAllByText(/Initial impression looks good/).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("with a completed case that has a real invoice", () => {
    beforeEach(() => {
      setMockSearchParams({ id: completedCaseWithInvoice.id });
      setMockAppState({
        cases: [completedCaseWithInvoice],
        invoices: [sampleInvoice],
        clients: [sampleClient],
      });
    });

    it("renders without throwing for a paid invoice attached to a complete case", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the completed case number", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });
  });

  describe("with an AI-imported case from iTero", () => {
    beforeEach(() => {
      setMockSearchParams({ id: aiImportedCase.id });
      setMockAppState({
        cases: [aiImportedCase],
        invoices: [],
        clients: [sampleClient],
      });
      // The case detail screen pulls heavy fields (incl. needsAiReview /
      // aiImportSource) from `/api/legacy/cases/:id`. Stub that response
      // so the "needs review" banner branch actually runs.
      setMockFetchHandler((url: string) => {
        if (url.includes("/api/legacy/cases/")) {
          return new Response(
            JSON.stringify({
              case: {
                ...aiImportedCase,
                needsAiReview: true,
                aiImportSource: "itero",
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it('shows the "AI-imported — needs review" banner once full case data hydrates', async () => {
      const { findByText } = render(<CaseDetailScreen />);
      expect(await findByText(/AI-imported — needs review/)).toBeTruthy();
      await waitFor(async () => {
        expect(await findByText(/auto-created from itero/)).toBeTruthy();
      });
    });
  });
});
