/** @vitest-environment jsdom */
/**
 * Regression guard for the DuplicatePromptPanel "Link as remake" flow.
 *
 * Invariant protected:
 *  - A remake original from EITHER source — canonical (desktop/web) OR legacy
 *    (mobile-created) — can be linked. The "Link as remake" button used to be
 *    gated on `selectedMatch?.source === "canonical"`, which silently blocked
 *    mobile-created originals. The server's resolveRemakeOriginal helper
 *    supports both sources, so the UI must too.
 *
 * If that gate (or any equivalent source check) ever re-appears in a refactor,
 * the legacy-source test below will fail before release.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { DuplicatePromptPanel, type DuplicatePromptPhase } from "../DashboardDropZone";

type Match = DuplicatePromptPhase["matches"][number];

function makeMatch(overrides: Partial<Match> & { id: string; source: Match["source"] }): Match {
  return {
    caseNumber: "C-1001",
    matchKind: "exact",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    status: "in_progress",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePhase(matches: Match[]): DuplicatePromptPhase {
  return {
    kind: "duplicatePrompt",
    file: new File(["x"], "rx.pdf", { type: "application/pdf" }),
    caseNumber: "C-2002",
    matches,
    patientName: "Jane Doe",
  };
}

function renderPanel(matches: Match[]) {
  const onCreateAsRemake = vi.fn();
  const onCreateAsNew = vi.fn();
  const onBack = vi.fn();
  const onCancel = vi.fn();
  render(
    <DuplicatePromptPanel
      phase={makePhase(matches)}
      onBack={onBack}
      onCancel={onCancel}
      onCreateAsNew={onCreateAsNew}
      onCreateAsRemake={onCreateAsRemake}
    />,
  );
  return { onCreateAsRemake, onCreateAsNew, onBack, onCancel };
}

function fillReasonAndCharge(reason: string, charge: "yes" | "no") {
  fireEvent.change(screen.getByPlaceholderText(/Shade B1 came back too dark/i), {
    target: { value: reason },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: charge === "yes" ? /Yes — invoice as usual/i : /No — no-charge remake/i,
    }),
  );
}

describe("DuplicatePromptPanel — Link as remake", () => {
  it("links a legacy (mobile-created) original as a remake", () => {
    const legacyMatch = makeMatch({ id: "legacy-77", source: "legacy", caseNumber: "M-9001" });
    const { onCreateAsRemake } = renderPanel([legacyMatch]);

    // The legacy match is the only one, so it is selected by default. Confirm it
    // is rendered (the "mobile" tag identifies legacy source).
    expect(screen.getByText("mobile")).toBeInTheDocument();

    fillReasonAndCharge("Margins were short on the mobile-created case", "no");
    fireEvent.click(screen.getByRole("button", { name: /^Link as remake$/i }));

    expect(onCreateAsRemake).toHaveBeenCalledTimes(1);
    expect(onCreateAsRemake).toHaveBeenCalledWith({
      remakeOfCaseId: "legacy-77",
      remakeReason: "Margins were short on the mobile-created case",
      remakeCharged: false,
    });
  });

  it("links a canonical (desktop/web) original as a remake (regression guard)", () => {
    const canonicalMatch = makeMatch({ id: "canon-42", source: "canonical", caseNumber: "C-3003" });
    const { onCreateAsRemake } = renderPanel([canonicalMatch]);

    fillReasonAndCharge("Shade mismatch, redo", "yes");
    fireEvent.click(screen.getByRole("button", { name: /^Link as remake$/i }));

    expect(onCreateAsRemake).toHaveBeenCalledTimes(1);
    expect(onCreateAsRemake).toHaveBeenCalledWith({
      remakeOfCaseId: "canon-42",
      remakeReason: "Shade mismatch, redo",
      remakeCharged: true,
    });
  });

  it("links the legacy original even when a canonical match is also present", () => {
    // With a canonical match present, it is selected by default — so explicitly
    // selecting the legacy radio must still allow linking it.
    const canonicalMatch = makeMatch({ id: "canon-1", source: "canonical", caseNumber: "C-1" });
    const legacyMatch = makeMatch({ id: "legacy-2", source: "legacy", caseNumber: "M-2" });
    const { onCreateAsRemake } = renderPanel([canonicalMatch, legacyMatch]);

    // Select the legacy radio (second match).
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[1]);

    fillReasonAndCharge("Linking the mobile original", "no");
    fireEvent.click(screen.getByRole("button", { name: /^Link as remake$/i }));

    expect(onCreateAsRemake).toHaveBeenCalledTimes(1);
    expect(onCreateAsRemake).toHaveBeenCalledWith({
      remakeOfCaseId: "legacy-2",
      remakeReason: "Linking the mobile original",
      remakeCharged: false,
    });
  });

  it("blocks submit until reason and charge are provided", () => {
    const legacyMatch = makeMatch({ id: "legacy-77", source: "legacy" });
    const { onCreateAsRemake } = renderPanel([legacyMatch]);

    // No reason / charge yet.
    fireEvent.click(screen.getByRole("button", { name: /^Link as remake$/i }));
    expect(onCreateAsRemake).not.toHaveBeenCalled();
    expect(screen.getByText(/Reason is required to link as a remake/i)).toBeInTheDocument();
  });
});
