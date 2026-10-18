import { describe, expect, it } from "vitest";
import { IMPLANT_RETENTIONS, IMPLANT_MANUFACTURERS, IMPLANT_PLATFORM_PLACEHOLDER, implantFieldText } from "./implant-details";
import { renderSharedSlip, withImplantElements, type SlipElement } from "./case-slip-renderer";

describe("per-line implant details and shared slip rendering", () => {
  it("uses exactly the requested choices and placeholder", () => {
    expect(IMPLANT_RETENTIONS).toEqual(["Screw retained", "Cementable"]);
    expect(IMPLANT_MANUFACTURERS).toEqual(["Straumann", "BioHorizons", "Implant Direct", "Other"]);
    expect(IMPLANT_PLATFORM_PLACEHOLDER).toBe("Platform size, RC, RN, WB, etc.");
  });
  it("labels independent lines and suppresses inactive and legacy blanks", () => {
    const rows = [
      { toothNumber: "14", restorationType: "Implant", implantPlatformNotes: "RC" },
      { toothNumber: "15", restorationType: "Crown", implantPlatformNotes: "hidden" },
      { toothNumber: "29", restorationType: "Implant", implantPlatformNotes: "WB" },
      { toothNumber: "30", restorationType: "Implant" },
    ];
    expect(implantFieldText(rows, "implantPlatformNotes")).toBe("Line 1 · Tooth 14 · Implant: RC\nLine 3 · Tooth 29 · Implant: WB");
  });
  const element: SlipElement = { id: "implantPlatformNotes", kind: "implantPlatformNotes", x: 48, y: 400, w: 350, h: 46, visible: true, fontSize: 17, bold: true, italic: true, fontFamily: "Georgia", align: "right" };
  it("adds separate fields without changing existing geometry, visibility or typography", () => {
    const existing = [{ ...element, visible: false }];
    const upgraded = withImplantElements(existing);
    expect(upgraded[0]).toBe(existing[0]);
    expect(upgraded.map((el) => el.kind)).toEqual(["implantPlatformNotes", "implantRetention", "implantManufacturer"]);
    expect(withImplantElements(upgraded)).toEqual(upgraded);
  });
  it("honors hidden fields and escapes content", () => {
    expect(renderSharedSlip({ version: 2, elements: [{ ...element, visible: false }] }, () => ({ text: "SECRET" }))).not.toContain("SECRET");
    expect(renderSharedSlip({ version: 2, elements: [{ ...element, h: 180 }] }, () => ({ text: "<script>" }))).toContain("&lt;script&gt;");
  });
  it("moves long or overlapping implant notes to readable continuation pages, retaining typography", () => {
    const text = "RC <clinical> ".repeat(1000);
    const html = renderSharedSlip({ version: 2, elements: [element] }, () => ({ caption: "Platform", text }));
    expect(html).toContain("lt-slip-continuation");
    expect(html).toContain("font-family:Georgia;font-size:17px;font-weight:700;font-style:italic;text-align:right");
    expect(html).toContain(text.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    const overlapping = renderSharedSlip({ version: 2, elements: [element, { ...element, id: "other", kind: "rxNotes" }] }, (el) => ({ text: el.id }));
    expect(overlapping).toContain("lt-slip-continuation");
    expect(overlapping.match(/data-kind="implantPlatformNotes"/)).toBeNull();
  });
});
