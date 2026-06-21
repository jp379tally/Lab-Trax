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

  it("returns gypsum-materials for a die-stone selection query", () => {
    const sections = selectKnowledgeSections(
      "what gypsum type should I use to pour an accurate die for a crown preparation?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("dental.gypsum-materials");
  });

  it("returns investment-materials for a burnout and casting query", () => {
    const sections = selectKnowledgeSections(
      "what burnout temperature and investment material do I need for casting a high-fusing base metal alloy?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("dental.investment-materials");
  });

  it("returns dental-alloys for a chrome cobalt framework query", () => {
    const sections = selectKnowledgeSections(
      "which cobalt chromium alloy is used for casting an RPD framework?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("dental.dental-alloys");
  });

  it("ranks infection-control-lab first for a disinfection and PPE query", () => {
    const sections = selectKnowledgeSections(
      "what PPE and disinfection steps are required in the lab receiving area?",
    );
    expect(sections[0]!.id).toBe("dental.infection-control-lab");
  });

  it("ranks complete-denture-fabrication first for a flasking and packing query", () => {
    const sections = selectKnowledgeSections(
      "describe the flasking and packing steps when processing a complete denture",
    );
    expect(sections[0]!.id).toBe("dental.complete-denture-fabrication");
  });

  it("returns rpd-fabrication for a surveying and path-of-insertion query", () => {
    const sections = selectKnowledgeSections(
      "how does surveying determine the path of insertion when designing an RPD framework?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("dental.rpd-fabrication");
  });

  it("ranks orthodontic-appliances first for a Hawley retainer query", () => {
    const sections = selectKnowledgeSections(
      "how do I fabricate a Hawley retainer for an orthodontic patient?",
    );
    expect(sections[0]!.id).toBe("dental.orthodontic-appliances");
  });

  it("surfaces lab-slip-rx-phi for a lab slip PHI query", () => {
    const sections = selectKnowledgeSections(
      "what PHI is included on a dental lab slip or Rx work order?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.lab-slip-rx-phi");
  });

  it("surfaces deidentification-demos for a demo de-identification query", () => {
    const sections = selectKnowledgeSections(
      "can I use a real patient photo for a software demo or training?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.deidentification-demos");
  });

  it("surfaces baa-lab-practice for a BAA query", () => {
    const sections = selectKnowledgeSections(
      "do I need a business associate agreement with every dental practice I work with?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.baa-lab-practice");
  });

  it("surfaces case-media-minimum-necessary for a case media / photo query", () => {
    const sections = selectKnowledgeSections(
      "what counts as minimum necessary when sharing case photos and attachments?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.case-media-minimum-necessary");
  });

  it("returns retention-dental-lab for a state record-retention query", () => {
    const sections = selectKnowledgeSections(
      "How long do I need to keep dental lab records and case Rx forms in California and Texas?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
  });

  it("returns retention-dental-lab for a minor-patient retention question", () => {
    const sections = selectKnowledgeSections(
      "What are the record retention rules for minor patients in the dental lab?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
  });

  it("returns retention-dental-lab when asking about the federal HIPAA retention baseline", () => {
    const sections = selectKnowledgeSections(
      "Does federal HIPAA law specify how long a dental lab must retain records?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
  });

  it("returns retention-dental-lab for a Washington state retention query", () => {
    const sections = selectKnowledgeSections(
      "How long do I need to keep dental lab records in Washington state?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
  });

  it("returns retention-dental-lab for a Michigan minor-patient retention query", () => {
    const sections = selectKnowledgeSections(
      "What are the record retention rules for minor patients in Michigan?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
  });

  it("returns retention-dental-lab for a Virginia, Massachusetts, or Colorado retention query", () => {
    const sections = selectKnowledgeSections(
      "How many years must a dental lab keep records in Virginia, Massachusetts, and Colorado?",
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("hipaa.retention-dental-lab");
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
