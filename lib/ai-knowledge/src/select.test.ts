import { describe, it, expect } from "vitest";
import { selectKnowledge, selectKnowledgeSections } from "./select";
import { ALL_SECTIONS } from "./packs/index";

describe("selectKnowledge", () => {
  it("returns relevant LabTrax sections for a how-to query", () => {
    const sections = selectKnowledgeSections(
      "How do I create an invoice and bill the practice for a case?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("labtrax.invoicing");
    expect(sections[0]!.group).toBe("labtrax");
  });

  it("returns dental-domain sections for a material question", () => {
    const sections = selectKnowledgeSections(
      "When should I use zirconia versus Emax for a posterior crown?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("dental.zirconia");
    expect(ids).toContain("dental.emax");
  });

  it("returns HIPAA sections for a compliance question", () => {
    const sections = selectKnowledgeSections(
      "What counts as PHI and how should we securely handle patient data?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.phi");
    expect(ids).toContain("hipaa.secure-handling");
    expect(sections[0]!.group).toBe("hipaa");
  });

  it("ranks the most relevant section first", () => {
    const sections = selectKnowledgeSections("surgical guide for guided implant surgery");
    expect(sections[0]!.id).toBe("dental.surgical-guides");
  });

  it("respects the maxChars budget and never exceeds it", () => {
    const big = selectKnowledge("zirconia emax pfm crown bridge implant denture");
    const small = selectKnowledge(
      "zirconia emax pfm crown bridge implant denture",
      { maxChars: 600 },
    );
    expect(small.length).toBeLessThanOrEqual(600);
    expect(small.length).toBeLessThan(big.length);
    expect(small.length).toBeGreaterThan(0);
  });

  it("restricts to requested groups", () => {
    const sections = selectKnowledgeSections(
      "patient data access permissions for a case",
      { groups: ["hipaa"] },
    );
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.group === "hipaa")).toBe(true);
  });

  it("returns an empty string for an empty or stop-word-only query", () => {
    expect(selectKnowledge("")).toBe("");
    expect(selectKnowledge("the and of to")).toBe("");
  });

  it("returns nothing when the budget is zero or negative", () => {
    expect(selectKnowledgeSections("zirconia crown", { maxChars: 0 })).toEqual([]);
    expect(selectKnowledgeSections("zirconia crown", { maxChars: -10 })).toEqual([]);
  });

  it("returns empty for an off-topic query with no keyword overlap", () => {
    expect(selectKnowledgeSections("quarterly weather forecast skiing")).toEqual([]);
  });

  it("produces deterministic output for the same query", () => {
    const a = selectKnowledge("crown bridge zirconia");
    const b = selectKnowledge("crown bridge zirconia");
    expect(a).toBe(b);
  });

  it("renders sections with a heading and body", () => {
    const out = selectKnowledge("what is PHI");
    expect(out).toContain("### What is PHI");
  });

  it("every curated section has a unique id and non-empty content", () => {
    const ids = ALL_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });
});
