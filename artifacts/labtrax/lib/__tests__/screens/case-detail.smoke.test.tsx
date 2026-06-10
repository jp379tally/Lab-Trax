import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
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
      // Provide needsAiReview + aiImportSource in the mock case so the canonical
      // useCase hook (mocked via @workspace/api-client-react) returns these flags
      // and the "AI-imported — needs review" banner renders.
      setMockAppState({
        cases: [{ ...aiImportedCase, needsAiReview: true, aiImportSource: "itero" }],
        invoices: [],
        clients: [sampleClient],
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

  describe("renders safely when notes is not a string", () => {
    // The API sometimes returns case `notes` as something other than a string
    // (null, undefined, an array, or an object). The screen must not crash when
    // it normalizes/reads notes (e.g. the Rx Summary `.trim()` check). See the
    // narrow `normalizeNotes` guard in app/case/[id].tsx.
    const renderWithNotes = (notes: unknown) => {
      const caseWithBadNotes = {
        ...inProgressCase,
        id: "case-bad-notes",
        caseNumber: "#5099",
        // Empty the activity log so `hasNotes` cannot short-circuit on a
        // note-type entry — this forces the `normalizeNotes(...).trim()`
        // branch (the original crash locus) and the notes-fallback render
        // branch to actually execute.
        activityLog: [],
        // Cast: we intentionally inject a non-string to reproduce the crash.
        notes: notes as unknown as string,
      };
      setMockSearchParams({ id: caseWithBadNotes.id });
      setMockAppState({
        cases: [caseWithBadNotes],
        invoices: [],
        clients: [sampleClient],
      });
      return render(<CaseDetailScreen />);
    };

    it("renders when notes is undefined", () => {
      expect(() => renderWithNotes(undefined)).not.toThrow();
    });

    it("renders when notes is null", () => {
      expect(() => renderWithNotes(null)).not.toThrow();
    });

    it("renders when notes is an array", () => {
      expect(() => renderWithNotes(["a", "b"])).not.toThrow();
    });

    it("renders when notes is an object", () => {
      expect(() => renderWithNotes({ text: "hi" })).not.toThrow();
    });

    it("still renders the case (no crash) with non-string notes", () => {
      const { getAllByText } = renderWithNotes({ foo: 1 });
      expect(getAllByText(/#5099/).length).toBeGreaterThan(0);
    });
  });

  describe("edit save updating the linked invoice", () => {
    it("calls updateInvoice with a recomputed caseType when the material changes", async () => {
      const updateInvoice = vi.fn();
      const updateCase = vi.fn();
      const addCaseNote = vi.fn();
      const caseWithInvoice = {
        ...inProgressCase,
        id: "case-edit",
        caseNumber: "#5010",
        invoiceId: sampleInvoice.id,
      };
      setMockSearchParams({ id: caseWithInvoice.id });
      setMockAppState({
        cases: [caseWithInvoice],
        invoices: [sampleInvoice],
        clients: [sampleClient],
        role: "admin",
        adminUnlocked: true,
        updateInvoice,
        updateCase,
        addCaseNote,
      });

      const { getAllByText, getByDisplayValue } = render(<CaseDetailScreen />);

      // The screen renders an "Edit Case" action button. The Modal stub
      // also renders the modal title, so there are multiple matches —
      // pressing the first text bubbles to the action Pressable.
      fireEvent.press(getAllByText("Edit Case")[0]);

      // EditCaseModal mounts the current material as a TextInput value.
      const materialInput = getByDisplayValue("Zirconia");
      fireEvent.changeText(materialInput, "E.max");

      fireEvent.press(getAllByText("Save Changes")[0]);

      expect(updateCase).toHaveBeenCalledWith(
        caseWithInvoice.id,
        expect.objectContaining({ material: "E.max" }),
      );
      expect(updateInvoice).toHaveBeenCalledWith(
        sampleInvoice.id,
        expect.objectContaining({ caseType: "E.max Restoration" }),
      );
    });
  });

  describe("add-item appliance flow", () => {
    it("invokes addCaseItem and updateInvoice when adding a Snore Guard appliance", async () => {
      const addCaseItem = vi.fn();
      const updateInvoice = vi.fn();
      const caseWithInvoice = {
        ...inProgressCase,
        id: "case-add-item",
        caseNumber: "#5011",
        invoiceId: sampleInvoice.id,
        // addApplianceToInvoice resolves the client via
        // `clients.find((c) => c.practiceName === caseItem.clientName)`,
        // so the case must carry the client's practice name for the
        // pricing tier lookup to land on a non-zero price.
        clientName: sampleClient.practiceName,
      };
      setMockSearchParams({ id: caseWithInvoice.id });
      setMockAppState({
        cases: [caseWithInvoice],
        invoices: [sampleInvoice],
        clients: [sampleClient],
        role: "admin",
        adminUnlocked: true,
        pricingTiers: [
          { name: "Standard", prices: { snore_guard: 250 } },
        ],
        addCaseItem,
        updateInvoice,
      });

      const { getAllByText, findAllByText } = render(<CaseDetailScreen />);

      // Open the "Add Something" sheet.
      fireEvent.press(getAllByText("Add Something to This Case")[0]);

      // The sheet's "Item" entry calls openAddItemModal via setTimeout(200).
      // The Modal stub renders all modal contents regardless of `visible`,
      // so we can advance to the case-type step directly.
      fireEvent.press(getAllByText("Item")[0]);

      // Step 1 — pick the Appliance case type. There can be multiple
      // "Appliance" labels in the tree (case-type list + sub-headers in
      // sibling appliance steps), so press the first which is the
      // top-level case-type Pressable.
      const applianceLabels = await findAllByText("Appliance");
      fireEvent.press(applianceLabels[0]);

      // Step 2 — Snore Guard has no arch/variant, so it should fire
      // addCaseItem + updateInvoice immediately.
      const snoreGuard = await findAllByText("Snore Guard");
      fireEvent.press(snoreGuard[0]);

      expect(addCaseItem).toHaveBeenCalledWith(
        caseWithInvoice.id,
        "Appliance",
        [],
        {},
        "Snore Guard",
        expect.objectContaining({ applianceSubType: "Snore Guard" }),
      );
      expect(updateInvoice).toHaveBeenCalledWith(
        sampleInvoice.id,
        expect.objectContaining({
          lineItems: expect.arrayContaining([
            expect.objectContaining({
              item: "Snore Guard",
              rate: 250,
              amount: 250,
            }),
          ]),
        }),
      );
    });
  });
});
