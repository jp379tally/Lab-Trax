import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dash = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");
const layout = readFileSync(join(__dirname, "../../components/AppLayout.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../../index.css"), "utf8");
const inbox = readFileSync(join(__dirname, "../../components/UnassignedDocumentsCard.tsx"), "utf8");

describe("dashboard reference redesign", () => {
  it("summary cards expose truthful loading/error counts and reveal queues", () => {
    for (const id of ["past-due", "due-today", "unassigned"]) expect(dash).toContain(`id: "${id}"`);
    expect(dash).toContain('c.loading ? "…" : c.error ? "—" : c.count');
    expect(dash).toContain("revealQueue(pastDueRef");
    expect(dash).toContain("pastDueRevealed");
    expect(dash).toContain("labtrax:reveal-unassigned");
    expect(inbox).toContain("labtrax:reveal-unassigned");
  });
  it("shares the inbox query key with the card (no duplicate request)", () => {
    expect(dash).toContain("getListLabInboxFilesQueryKey({ labOrganizationId: inboxLabId })");
  });
  it("tables use the six reference columns without nowrap clipping", () => {
    for (const h of ["Case #", "Patient", "Doctor", "Status", "Location", "Due date"]) expect(dash).toContain(`>${h}</th>`);
    const row = dash.slice(dash.indexOf("function CaseRow"), dash.indexOf("export function CasesTable"));
    expect(row).not.toContain("whitespace-nowrap");
    expect(row).toContain("Entered ");
    expect(css).toContain(".lab-dash td [class*=\"rounded-full\"]");
  });
  it("title is compact and shell has a responsive drawer", () => {
    expect(dash).not.toContain("user?.practiceName && (");
    expect(layout).toContain("button-open-nav");
    expect(layout).toContain("nav-drawer-backdrop");
    expect(layout).toContain("text-header-lab-name");
  });
  it("preserves sales, assistant, rush and tomorrow controls", () => {
    for (const t of ["LabTrax Assistant", "Today's sales", "scrollToFirstRushSection", "due tomorrow", "/reports?tab=sales&preset=today"]) expect(dash).toContain(t);
  });
});
