/**
 * Integration tests for prompt augmentation helpers (regression guard).
 *
 * buildKnowledgeBlock is pure and always runs. buildLabMemoryBlock reads the
 * ai_memory table and is skipped when DATABASE_URL is not configured.
 *
 * Coverage:
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
import { buildKnowledgeBlock, buildLabMemoryBlock } from "./ai-knowledge-augment";

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

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
