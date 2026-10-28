import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dash = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");
const layout = readFileSync(join(__dirname, "../../components/AppLayout.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../../index.css"), "utf8");
const inbox = readFileSync(join(__dirname, "../../components/UnassignedDocumentsCard.tsx"), "utf8");

describe("dashboard reference redesign", () => {
  it("summary cards expose truthful loading/error counts and reveal queues", () => {
    for (const id of ["past-due", "due-today", "due-tomorrow", "unassigned"]) expect(dash).toContain(`id: "${id}"`);
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
    for (const t of ["LabTrax Assistant", "Today's sales", "scrollToFirstRushSection", "Due tomorrow", "/reports?tab=sales&preset=today"]) expect(dash).toContain(t);
  });
  it("pairs identical primary action styles before sales and places tomorrow after today", () => {
    const actions = dash.slice(dash.indexOf('data-testid="dashboard-primary-actions"'), dash.indexOf('data-testid="dashboard-secondary-strip"'));
    const styles = [...actions.matchAll(/className="([^"]+)"/g)].map((match) => match[1]).filter((style) => style.includes("h-12"));
    expect(styles).toHaveLength(2);
    expect(styles[0]).toBe(styles[1]);
    expect(styles[0]).toContain("h-12 w-full");
    expect(actions.indexOf("button-ai-assistant")).toBeGreaterThan(actions.indexOf("button-add-case"));
    expect(dash.indexOf('data-testid="dashboard-today-sales"')).toBeGreaterThan(dash.indexOf('data-testid="dashboard-primary-actions"'));
    expect(dash).toContain('grid-cols-1 md:grid-cols-4');
    expect(dash.indexOf('id: "due-tomorrow"')).toBeGreaterThan(dash.indexOf('id: "due-today"'));
    expect(dash.indexOf('id: "unassigned"')).toBeGreaterThan(dash.indexOf('id: "due-tomorrow"'));
    expect(dash).toContain("revealQueue(dueTomorrowRef, setDueTomorrowOpen)");
    const reveal = dash.slice(dash.indexOf("function revealQueue("), dash.indexOf("const dueTodayCases ="));
    expect(reveal.indexOf("setOpen?.(true)")).toBeLessThan(reveal.indexOf("setTimeout("));
  });
});
