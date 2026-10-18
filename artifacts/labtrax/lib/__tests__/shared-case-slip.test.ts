import { describe, expect, it, vi } from "vitest";
import { IMPLANT_FIELDS, withImplantElements, type SlipElement } from "@workspace/case-taxonomy";
const resilientFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query-client", () => ({ resilientFetch }));
vi.mock("expo-print", () => ({ printAsync: vi.fn(), printToFileAsync: vi.fn() }));
vi.mock("expo-sharing", () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
import { buildSharedCaseSlipHtml } from "../shared-case-slip";
const data = {
  caseNumber: "IMPLANT-1",
  restorations: [
    { toothNumber: "14", restorationType: "Implant", implantRetention: "Screw retained", implantManufacturer: "Straumann", implantPlatformNotes: "RC" },
    { toothNumber: "29", restorationType: "Implant", implantRetention: "Cementable", implantManufacturer: "Other", implantPlatformNotes: "WB" },
    { toothNumber: "15", restorationType: "Crown", implantPlatformNotes: "DO NOT PRINT" },
  ],
};
describe("mobile shared lab slip", () => {
  it("uses row contextual implant details in the default fallback without placeholder or inactive metadata", async () => {
    const html = await buildSharedCaseSlipHtml(data, null);
    expect(html).toContain("Line 1 · Tooth 14 · Implant: RC");
    expect(html).toContain("Line 2 · Tooth 29 · Implant: WB");
    expect(html).not.toContain("DO NOT PRINT");
    expect(html).not.toContain("Platform size, RC, RN, WB, etc.");
  });
  it("keeps the existing default slip capabilities when no custom template was saved", async () => {
    const html = await buildSharedCaseSlipHtml({ ...data, remakeNotes: "Existing remake instruction" }, { template: { version: 2, elements: [] }, isCustom: false });
    expect(html).toContain("Existing remake instruction");
    expect(html).toContain("Implant Platform Notes");
  });
  it("keeps case details printable without granting a viewer invoice access", async () => {
    vi.mocked(resilientFetch).mockResolvedValue({ ok: false, status: 403 } as Response);
    const template = { version: 2, elements: withImplantElements<SlipElement>([
      { id: "invoice", kind: "invoiceNumber", x: 50, y: 100, w: 300, h: 100, visible: true },
    ]) };
    const html = await buildSharedCaseSlipHtml(data, { template, isCustom: true }, { caseId: "c1" });
    expect(html).toContain("Invoice access restricted");
    expect(html).toContain("Tooth 14 · Implant: RC");
  });
  it("honors each saved field's visibility, position and typography", async () => {
    const elements = withImplantElements<SlipElement>([]).map((el) => ({ ...el, x: 100, y: 100, w: 300, h: 200, fontFamily: "Georgia", fontSize: 18, bold: true, italic: true, align: "right", visible: el.kind !== "implantManufacturer" }));
    const html = await buildSharedCaseSlipHtml(data, { isCustom: true, template: { version: 2, elements } });
    expect(html).toContain("left:100px;top:100px;width:300px;height:200px");
    expect(html).toContain("font-family:Georgia;font-size:18px;font-weight:700;font-style:italic;text-align:right");
    expect(html).not.toContain("Straumann");
    expect(html).toContain("Screw retained");
  });
  it("supports independently hidden and empty implant fields and continuation pages", async () => {
    const template = { version: 2, elements: withImplantElements([]) };
    const html = await buildSharedCaseSlipHtml({ ...data, restorations: [{ ...data.restorations[0], implantPlatformNotes: "Long notes ".repeat(1500) }] }, { template });
    expect(html).toContain("lt-slip-continuation");
    expect(html).toContain("Long notes ".repeat(1500).trim());
    const empty = await buildSharedCaseSlipHtml({ caseNumber: "OLD" }, { template });
    for (const field of IMPLANT_FIELDS) expect(empty).not.toContain(`data-kind="${field}"`);
  });
  it("prints dated Rx entries in order and carries long notes onto continuation pages", async () => {
    const longNote = `Original details ${"with readable wrapping ".repeat(180)}`;
    const template = {
      version: 2,
      elements: [
        { id: "rx", kind: "rxNotes", x: 24, y: 24, w: 260, h: 60, visible: true },
      ],
    };
    const html = await buildSharedCaseSlipHtml({
      caseNumber: "RX-2",
      rxNoteEntries: [
        { id: "legacy", caseId: "c1", noteText: longNote, scannedAt: null, provenance: "legacy" },
        { id: "scan", caseId: "c1", noteText: "Follow-up prescription", scannedAt: "2026-02-03T22:00:00.000Z", provenance: "ai_reader" },
      ],
    }, { template });
    expect(html).toContain("lt-slip-continuation");
    expect(html).toContain("Date unknown");
    expect(html).toContain("02/03/2026");
    expect(html).toContain(longNote);
    expect(html.indexOf("Date unknown")).toBeLessThan(html.indexOf("02/03/2026"));
  });
  it("loads protected images through the case-authorized route and fails explicitly if unavailable", async () => {
    const template = { version: 2, elements: [{ id: "logo", kind: "image", visible: true, x: 24, y: 24, w: 100, h: 100 }] };
    resilientFetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "Content-Type": "image/png" }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const html = await buildSharedCaseSlipHtml(data, { template }, { caseId: "c1", labOrganizationId: "lab1" });
    expect(resilientFetch).toHaveBeenCalledWith("/api/organizations/lab1/case-print-template/images/logo?caseId=c1");
    expect(html).toContain("data:image/png;base64,AQID");
    resilientFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(buildSharedCaseSlipHtml(data, { template }, { caseId: "c1", labOrganizationId: "lab1" })).rejects.toThrow("protected template image");
  });
});
