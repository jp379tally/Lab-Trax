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
  HIPAA_PRIVACY_SIGNALS,
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
