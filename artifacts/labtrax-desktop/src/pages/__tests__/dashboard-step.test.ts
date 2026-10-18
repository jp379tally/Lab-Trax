import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardStepLabel } from "../dashboard";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * The due-date dashboard tables opt into the Step column while all other
 * dashboard table variants keep their existing Pan column. The pure label
 * helper also pins the removable-only display contract independently of the
 * page's data-fetching and drawer dependencies.
 */
describe("Desktop dashboard — removable Step column", () => {
  it.each([
    ["custom_tray", "Custom Tray"],
    ["rims_and_plates", "Rims and Plates"],
    ["wax_setup", "Wax Setup"],
    ["process", "Process"],
  ])("renders %s as %s for a removable case", (step, label) => {
    expect(
      dashboardStepLabel({
        step,
        restorationTypes: "Full Denture",
        restorationMaterials: null,
        firstRestorationSubtype: null,
      }),
    ).toBe(label);
  });

  it("renders an em dash when a removable case has no selected step", () => {
    expect(
      dashboardStepLabel({
        step: null,
        restorationTypes: "Partial Denture",
        restorationMaterials: null,
        firstRestorationSubtype: null,
      }),
    ).toBe("—");
  });

  it("renders an em dash instead of exposing a non-removable case step", () => {
    expect(
      dashboardStepLabel({
        step: "process",
        restorationTypes: "Crown",
        restorationMaterials: null,
        firstRestorationSubtype: "restorative/crowns/full",
      }),
    ).toBe("—");
  });

  it("uses the authoritative removable taxonomy when free-text fields are absent", () => {
    expect(
      dashboardStepLabel({
        step: "wax_setup",
        restorationTypes: null,
        restorationMaterials: null,
        firstRestorationSubtype: "removable/dentures/acrylic",
      }),
    ).toBe("Wax Setup");
  });
});

describe("Desktop dashboard — Step column wiring", () => {
  const source = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");

  it.each([
    ["Past Due", "pastDueCases.length > 0"],
    ["Due Today", "dueTodayCases.length > 0"],
    ["Due Tomorrow", "dueTomorrowCases.length > 0"],
  ])("enables Step mode for %s", (_section, marker) => {
    const sectionStart = source.indexOf(marker);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(source.slice(sectionStart)).toContain("showStep");
  });

  it("keeps Step as a targeted replacement for Pan and preserves Due and Type", () => {
    expect(source).toContain('details.push(`Step ${step}`)');
    expect(source).toContain(">Due date<");
    expect(source).toContain(">Type<");
  });

  it("does not enable Step mode for Recent Cases or No Due Date", () => {
    const recentStart = source.indexOf("<CasesTable", source.indexOf("recentCasesOpen"));
    const noDueDateStart = source.indexOf("<CasesTable", source.indexOf("noDueDateOpen"));
    expect(source.slice(recentStart, recentStart + 300)).not.toContain("showStep");
    expect(source.slice(noDueDateStart, noDueDateStart + 300)).not.toContain("showStep");
  });
});