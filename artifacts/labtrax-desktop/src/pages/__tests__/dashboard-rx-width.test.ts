import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboard = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../../index.css"), "utf8");

describe("RX intake dashboard width", () => {
  it("uses the available main canvas rather than a centered, capped page", () => {
    const root = dashboard.match(/<div className="([^"]+)" data-testid="dashboard-root">/)?.[1];
    expect(root).toContain("w-full min-w-0 px-4");
    expect(root).not.toMatch(/max-w-|mx-auto|translate|absolute/);
    expect(dashboard).toContain('data-testid="rx-drop-zone-panel"');
    expect(dashboard).not.toContain("grid-cols-[250px_minmax(0,1fr)]");
    expect(dashboard).not.toContain("grid-cols-[320px_minmax(0,1fr)]");
  });

  it("sizes columns to the room remaining beside the resizable sidebar", () => {
    expect(css).toContain("container-name: lab-dashboard");
    expect(css).toContain("@container lab-dashboard (min-width: 1040px)");
    expect(css).toContain("minmax(420px, min(38%, 560px)) minmax(0, 1fr)");
    expect(dashboard).toContain('className="dashboard-workspace"');
    expect(css).toMatch(/\.dashboard-workspace\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
  });

  it("retains width-aware review fields and the existing intake component", () => {
    expect(dashboard).toContain("<DashboardDropZone />");
    expect(css).toContain("@container rx-confirm (max-width: 560px)");
    expect(css).toMatch(/\.rx-review-form-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toContain("@container rx-confirm (min-width: 720px)");
  });
});
