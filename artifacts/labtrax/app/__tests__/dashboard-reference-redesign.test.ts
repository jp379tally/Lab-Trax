import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../(tabs)/dashboard.tsx"), "utf8");
const card = readFileSync(join(__dirname, "../../components/UnassignedDocumentsCard.tsx"), "utf8");

describe("mobile dashboard reference redesign", () => {
  it("has summary cards with truthful states and stacked phone layout", () => {
    for (const id of ["past-due", "due-today", "unassigned"]) expect(src).toContain(`id: "${id}"`);
    expect(src).toContain('card.error ? "--"');
    expect(src).toContain("summaryCardPhone");
    expect(src).toContain("useWindowDimensions");
  });
  it("unassigned summary scrolls to the real documents section and reveals it", () => {
    expect(src).toContain("unassignedYRef.current");
    expect(src).toContain('requestRxIntake("reveal")');
    expect(card).toContain('action === "reveal"');
  });
  it("RX intake and Add case reuse existing workflows; quick actions remain", () => {
    expect(src).toContain('"/new-case"');
    expect(src).toContain('requestRxIntake("browse")');
    expect(src).toContain('requestRxIntake("photo")');
    for (const id of ["dashboard-batch-locate-btn", "dashboard-case-lookup-btn", "dashboard-ai-reader-btn", "dashboard-ai-assistant-btn"]) expect(src).toContain(id);
  });
  it("shares the inbox query key and keeps safe-area header", () => {
    expect(src).toContain("getListLabInboxFilesQueryKey({ labOrganizationId: inboxLabOrgId })");
    expect(src).toContain("insets.top + Spacing.sm");
  });
});
