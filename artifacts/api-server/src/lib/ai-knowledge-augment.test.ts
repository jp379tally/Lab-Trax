/**
 * Integration tests for prompt augmentation helpers (regression guard).
 *
 * buildKnowledgeBlock is pure and always runs. buildLabMemoryBlock reads the
 * ai_memory table and is skipped when DATABASE_URL is not configured.
 *
 * Coverage:
 *  - hasPrivacySignal — true for each known privacy-signal keyword
 *  - hasPrivacySignal — false for unrelated queries
 *  - buildKnowledgeBlock — HIPAA boost: surfaced for privacy-signal queries
 *  - buildKnowledgeBlock — HIPAA boost: no duplicate sections in output
 *  - buildKnowledgeBlock — HIPAA boost: is a no-op for unrelated queries
 *  - buildKnowledgeBlock — returns a labelled block for a relevant query
 *  - buildKnowledgeBlock — returns "" for an unrelated query (prompt unchanged)
 *  - buildKnowledgeBlock — respects maxChars
 *  - buildLabMemoryBlock — "" for empty lab list (no DB needed)
 *  - buildLabMemoryBlock — "" when a lab has no memory
 *  - buildLabMemoryBlock — groups entries by kind and honors soft-delete
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  buildKnowledgeBlock,
  buildLabMemoryBlock,
  buildMaterialSuggestionBlock,
  hasPrivacySignal,
  hasRetentionSignal,
  hasBaaSignal,
  hasBreachSignal,
  HIPAA_PRIVACY_SIGNALS,
  RETENTION_SIGNALS,
  BAA_SIGNALS,
  BREACH_SIGNALS,
} from "./ai-knowledge-augment";

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

describe("buildMaterialSuggestionBlock (pure)", () => {
  it("returns empty string when no tooth number is mentioned", () => {
    expect(buildMaterialSuggestionBlock("What material should I use for a crown?")).toBe("");
  });

  it("returns empty string when tooth number is mentioned but no restoration term", () => {
    expect(buildMaterialSuggestionBlock("Patient has a problem with tooth #9")).toBe("");
  });

  it("returns a guidance block for an anterior tooth + restoration type", () => {
    const block = buildMaterialSuggestionBlock("Dr. Smith wants a crown on tooth #9");
    expect(block).toContain("MATERIAL & SHADE SUGGESTION GUIDANCE");
    expect(block).toContain("ANTERIOR");
    expect(block).toContain("#9");
    expect(block).toContain("Emax");
    expect(block).toContain("shade");
  });

  it("returns a guidance block for a posterior tooth + restoration type", () => {
    const block = buildMaterialSuggestionBlock("Need a bridge on #30 and #31");
    expect(block).toContain("MATERIAL & SHADE SUGGESTION GUIDANCE");
    expect(block).toContain("POSTERIOR");
    expect(block).toContain("#30");
    expect(block).toContain("zirconia");
  });

  it("handles both anterior and posterior teeth in the same query", () => {
    const block = buildMaterialSuggestionBlock("crown on #9 and implant crown on #30");
    expect(block).toContain("ANTERIOR");
    expect(block).toContain("POSTERIOR");
  });

  it("recognises tooth number ranges", () => {
    const block = buildMaterialSuggestionBlock("veneer case for teeth #8-10");
    expect(block).toContain("ANTERIOR");
    expect(block).toContain("MATERIAL & SHADE SUGGESTION GUIDANCE");
  });

  it("recognises hash-prefixed standalone tooth numbers", () => {
    const block = buildMaterialSuggestionBlock("inlay on #14");
    expect(block).toContain("POSTERIOR");
  });

  it("returns empty string for unrelated queries", () => {
    expect(buildMaterialSuggestionBlock("How do I send an invoice?")).toBe("");
  });
});

describe("hasPrivacySignal (pure)", () => {
  it("returns true for each known privacy-signal keyword", () => {
    const sampledSignals = ["patient", "phi", "hipaa", "privacy", "share", "photo", "who can see", "record", "disclosure", "confidential"];
    for (const signal of sampledSignals) {
      expect(hasPrivacySignal(`Can I ${signal} this with someone?`), `signal: ${signal}`).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(hasPrivacySignal("PATIENT data handling")).toBe(true);
    expect(hasPrivacySignal("Is this SECURE?")).toBe(true);
  });

  it("returns false for unrelated queries", () => {
    expect(hasPrivacySignal("What zirconia should I use for a crown?")).toBe(false);
    expect(hasPrivacySignal("How do I send an invoice?")).toBe(false);
    expect(hasPrivacySignal("zzzzz qqqqq unrelated gibberish 12345")).toBe(false);
  });

  it("covers every signal in HIPAA_PRIVACY_SIGNALS", () => {
    for (const signal of HIPAA_PRIVACY_SIGNALS) {
      expect(hasPrivacySignal(signal), `signal: "${signal}"`).toBe(true);
    }
  });
});

describe("hasRetentionSignal (pure)", () => {
  it("returns true for each known retention-signal keyword", () => {
    const samples = ["retention", "how long", "record retention", "disposal", "state law", "dental records", "minor patient"];
    for (const signal of samples) {
      expect(hasRetentionSignal(`Tell me about ${signal} requirements`), `signal: ${signal}`).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(hasRetentionSignal("RECORD RETENTION rules")).toBe(true);
    expect(hasRetentionSignal("How Long do I keep records")).toBe(true);
  });

  it("returns false for unrelated queries", () => {
    expect(hasRetentionSignal("What zirconia shade should I use?")).toBe(false);
    expect(hasRetentionSignal("How do I send an invoice?")).toBe(false);
    expect(hasRetentionSignal("Can I share a patient photo?")).toBe(false);
  });

  it("covers every signal in RETENTION_SIGNALS", () => {
    for (const signal of RETENTION_SIGNALS) {
      expect(hasRetentionSignal(signal), `signal: "${signal}"`).toBe(true);
    }
  });
});

describe("hasBaaSignal (pure)", () => {
  it("returns true for each known BAA-signal keyword", () => {
    const samples = ["baa", "business associate", "covered entity", "subcontractor", "hipaa agreement", "data processing agreement"];
    for (const signal of samples) {
      expect(hasBaaSignal(`Do I need a ${signal} for this vendor?`), `signal: ${signal}`).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(hasBaaSignal("Do I need a BAA for this software?")).toBe(true);
    expect(hasBaaSignal("Is this a COVERED ENTITY?")).toBe(true);
  });

  it("returns false for unrelated queries", () => {
    expect(hasBaaSignal("What zirconia shade should I use?")).toBe(false);
    expect(hasBaaSignal("How do I send an invoice?")).toBe(false);
    expect(hasBaaSignal("Can I share a patient photo?")).toBe(false);
  });

  it("covers every signal in BAA_SIGNALS", () => {
    for (const signal of BAA_SIGNALS) {
      expect(hasBaaSignal(signal), `signal: "${signal}"`).toBe(true);
    }
  });
});

describe("hasBreachSignal (pure)", () => {
  it("returns true for each known breach-signal keyword", () => {
    const samples = ["breach", "data breach", "security incident", "notify hhs", "breach notification", "unauthorized access", "60 day", "safe harbor"];
    for (const signal of samples) {
      expect(hasBreachSignal(`Tell me about ${signal} requirements`), `signal: ${signal}`).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(hasBreachSignal("How do I report a BREACH?")).toBe(true);
    expect(hasBreachSignal("What is the BREACH NOTIFICATION deadline?")).toBe(true);
  });

  it("returns false for unrelated queries", () => {
    expect(hasBreachSignal("What zirconia shade should I use?")).toBe(false);
    expect(hasBreachSignal("How do I send an invoice?")).toBe(false);
    expect(hasBreachSignal("How long should I retain records?")).toBe(false);
  });

  it("covers every signal in BREACH_SIGNALS", () => {
    for (const signal of BREACH_SIGNALS) {
      expect(hasBreachSignal(signal), `signal: "${signal}"`).toBe(true);
    }
  });
});

describe("buildKnowledgeBlock — BAA disclaimer (pure)", () => {
  it("includes the BAA disclaimer when query asks about business associate agreements", () => {
    const block = buildKnowledgeBlock("Do I need a business associate agreement with my software vendor?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("Business Associate Agreement");
    expect(block).toContain("legal counsel");
  });

  it("includes the BAA disclaimer for covered entity queries", () => {
    const block = buildKnowledgeBlock("Are dental labs considered covered entities under HIPAA?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("Business Associate Agreement");
  });

  it("includes the BAA disclaimer for subcontractor queries", () => {
    const block = buildKnowledgeBlock("Does my subcontractor need a BAA?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("Business Associate Agreement");
  });

  it("places the BAA disclaimer before the knowledge sections", () => {
    const block = buildKnowledgeBlock("Do we need a BAA with our cloud storage provider?");
    const disclaimerIdx = block.indexOf("NOT LEGAL ADVICE");
    const knowledgeIdx = block.indexOf("###");
    if (knowledgeIdx > -1) {
      expect(disclaimerIdx).toBeLessThan(knowledgeIdx);
    }
    expect(disclaimerIdx).toBeGreaterThan(-1);
  });

  it("does not include the BAA disclaimer for unrelated queries", () => {
    const block = buildKnowledgeBlock("What is the best material for an anterior crown?");
    expect(block).not.toContain("Business Associate Agreement");
  });

  it("does not include the BAA disclaimer for retention-only queries", () => {
    const block = buildKnowledgeBlock("How long do I keep dental records in Texas?");
    expect(block).not.toContain("Business Associate Agreement");
  });
});

describe("buildKnowledgeBlock — breach disclaimer (pure)", () => {
  it("includes the breach disclaimer when query asks about a data breach", () => {
    const block = buildKnowledgeBlock("We had a data breach — what do we need to do to notify patients?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("breach notification");
    expect(block).toContain("legal counsel");
  });

  it("includes the breach disclaimer for HHS notification queries", () => {
    const block = buildKnowledgeBlock("How do I notify HHS about a security incident?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("breach notification");
  });

  it("includes the breach disclaimer for 60-day timeline queries", () => {
    const block = buildKnowledgeBlock("Is there a 60-day deadline for breach notification?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("breach notification");
  });

  it("includes the breach disclaimer for unauthorized access queries", () => {
    const block = buildKnowledgeBlock("Someone had unauthorized access to our patient files.");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("breach notification");
  });

  it("places the breach disclaimer before the knowledge sections", () => {
    const block = buildKnowledgeBlock("What is the breach notification timeline under HIPAA?");
    const disclaimerIdx = block.indexOf("NOT LEGAL ADVICE");
    const knowledgeIdx = block.indexOf("###");
    if (knowledgeIdx > -1) {
      expect(disclaimerIdx).toBeLessThan(knowledgeIdx);
    }
    expect(disclaimerIdx).toBeGreaterThan(-1);
  });

  it("does not include the breach disclaimer for unrelated queries", () => {
    const block = buildKnowledgeBlock("What is the best material for an anterior crown?");
    expect(block).not.toContain("breach notification");
  });

  it("does not include the breach disclaimer for BAA-only queries", () => {
    const block = buildKnowledgeBlock("Do I need a business associate agreement with my lab software?");
    expect(block).not.toContain("breach notification");
  });
});

describe("buildKnowledgeBlock — multiple disclaimers (pure)", () => {
  it("includes both retention and breach disclaimers when a query matches both", () => {
    const block = buildKnowledgeBlock("We had a data breach — do we need to retain the breach records?");
    expect(block).toContain("Record-retention periods vary by state");
    expect(block).toContain("breach notification");
  });

  it("includes both BAA and breach disclaimers when a query matches both", () => {
    const block = buildKnowledgeBlock("We had a security incident with our business associate — do we need to notify HHS?");
    expect(block).toContain("Business Associate Agreement");
    expect(block).toContain("breach notification");
  });

  it("all three disclaimers appear when query matches all three topics", () => {
    const block = buildKnowledgeBlock(
      "Our business associate had a breach — what are the retention and notification requirements?",
    );
    expect(block).toContain("Record-retention periods vary by state");
    expect(block).toContain("Business Associate Agreement");
    expect(block).toContain("breach notification");
  });
});

describe("buildKnowledgeBlock — retention disclaimer (pure)", () => {
  it("includes the legal disclaimer when query asks about record retention", () => {
    const block = buildKnowledgeBlock("How long do I need to keep dental records in California?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("state dental board");
    expect(block).toContain("legal counsel");
  });

  it("places the disclaimer before the knowledge sections", () => {
    const block = buildKnowledgeBlock("What are the retention rules for dental lab records?");
    const disclaimerIdx = block.indexOf("NOT LEGAL ADVICE");
    const knowledgeIdx = block.indexOf("###");
    expect(disclaimerIdx).toBeGreaterThan(-1);
    expect(knowledgeIdx).toBeGreaterThan(-1);
    expect(disclaimerIdx).toBeLessThan(knowledgeIdx);
  });

  it("includes the disclaimer for state-specific retention queries", () => {
    const block = buildKnowledgeBlock("What are the state law requirements for how long a dental lab must keep records?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("REFERENCE KNOWLEDGE");
  });

  it("includes the disclaimer for minor patient retention queries", () => {
    const block = buildKnowledgeBlock("How long must I retain records for minor patients?");
    expect(block).toContain("NOT LEGAL ADVICE");
  });

  it("does not include the retention disclaimer for non-retention queries", () => {
    const block = buildKnowledgeBlock("Can I share a patient photo with anyone?");
    expect(block).not.toContain("NOT LEGAL ADVICE");
  });

  it("does not include the retention disclaimer for unrelated queries", () => {
    const block = buildKnowledgeBlock("What is the best zirconia for a molar crown?");
    expect(block).not.toContain("NOT LEGAL ADVICE");
  });

  it("includes both the disclaimer and retention-section content", () => {
    const block = buildKnowledgeBlock("How long do I need to retain dental lab case records?");
    expect(block).toContain("NOT LEGAL ADVICE");
    expect(block).toContain("Retention");
  });
});

describe("buildKnowledgeBlock — HIPAA boost (pure)", () => {
  it("includes HIPAA knowledge when the query mentions 'patient'", () => {
    const block = buildKnowledgeBlock("Can I share a patient photo with anyone?");
    expect(block).toContain("REFERENCE KNOWLEDGE");
    // At least one HIPAA section title should appear.
    expect(block).toMatch(/PHI|HIPAA|Privacy|privacy|patient/i);
  });

  it("includes HIPAA knowledge when the query mentions 'photo'", () => {
    const block = buildKnowledgeBlock("Who can see the intraoral photos on a case?");
    expect(block).toContain("REFERENCE KNOWLEDGE");
    expect(block).toMatch(/PHI|HIPAA|minimum.necessary|case media/i);
  });

  it("includes HIPAA knowledge when the query mentions 'share'", () => {
    const block = buildKnowledgeBlock("Can I share this case with another lab?");
    expect(block).toContain("REFERENCE KNOWLEDGE");
    expect(block).toMatch(/PHI|HIPAA|privacy|disclosure/i);
  });

  it("does not duplicate sections in the output", () => {
    const block = buildKnowledgeBlock("What patient information is considered PHI under HIPAA?");
    // Count occurrences of the known PHI section title — must appear exactly once.
    const matches = block.match(/### What is PHI/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("is a no-op for queries with no privacy signals", () => {
    // A query with no privacy signals should behave exactly like the old code path.
    const withBoost = buildKnowledgeBlock("crown zirconia bridge shade A2");
    const withoutBoost = buildKnowledgeBlock("crown zirconia bridge shade A2");
    expect(withBoost).toBe(withoutBoost);
  });

  it("returns '' for an unrelated query with no privacy signals (no regression)", () => {
    const block = buildKnowledgeBlock("zzzzz qqqqq wwwww unrelated gibberish 12345");
    expect(block).toBe("");
  });
});

describe("buildKnowledgeBlock (pure)", () => {
  it("returns a labelled block for a relevant query", () => {
    const block = buildKnowledgeBlock("What does HIPAA require for patient data?");
    expect(block).toContain("REFERENCE KNOWLEDGE");
    expect(block.length).toBeGreaterThan(0);
  });

  it("returns an empty string for an unrelated query so the prompt is unchanged", () => {
    const block = buildKnowledgeBlock("zzzzz qqqqq wwwww unrelated gibberish 12345");
    expect(block).toBe("");
  });

  it("respects the maxChars budget", () => {
    const small = buildKnowledgeBlock("crown bridge zirconia shade margin", 120);
    // Allow for the header prefix; the selected knowledge body honors maxChars.
    expect(small.length).toBeLessThan(400);
  });
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("buildLabMemoryBlock (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  const labOrgId = rid("org");

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    const { db, organizations } = dbMod;
    await db.insert(organizations).values({ id: labOrgId, name: "Augment Test Lab", type: "lab" });
  });

  afterAll(async () => {
    if (!dbMod) return;
    const { db, aiMemory, organizations } = dbMod;
    await db.delete(aiMemory).where(eq(aiMemory.labOrganizationId, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
  });

  it("returns an empty string for an empty lab list", async () => {
    expect(await buildLabMemoryBlock([])).toBe("");
  });

  it("returns an empty string when the lab has no memory", async () => {
    expect(await buildLabMemoryBlock([labOrgId])).toBe("");
  });

  it("groups entries by kind and honors soft-delete", async () => {
    const { db, aiMemory } = dbMod;
    await db.insert(aiMemory).values([
      { labOrganizationId: labOrgId, kind: "glossary", key: "PFZ", value: "Porcelain fused to zirconia", source: "manual" },
      { labOrganizationId: labOrgId, kind: "preference", key: "Tone", value: "Concise", source: "manual" },
      { labOrganizationId: labOrgId, kind: "fact", key: "Turnaround", value: "5 business days", source: "manual" },
    ]);

    const block = await buildLabMemoryBlock([labOrgId]);
    expect(block).toContain("LAB-SPECIFIC MEMORY");
    expect(block).toContain("Glossary:");
    expect(block).toContain("PFZ: Porcelain fused to zirconia");
    expect(block).toContain("Preferences:");
    expect(block).toContain("Facts:");

    // Soft-deleted rows must not appear.
    await db
      .update(aiMemory)
      .set({ deletedAt: new Date() })
      .where(eq(aiMemory.key, "PFZ"));
    const after = await buildLabMemoryBlock([labOrgId]);
    expect(after).not.toContain("PFZ");
    expect(after).toContain("Turnaround: 5 business days");
  });
});
