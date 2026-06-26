/**
 * Task #2479 — Verify iTero imports link to the right practice end to end.
 *
 * Task #2474 added pure unit tests for the practice-name
 * normalization/similarity helpers (`_normalizePracticeForSim`,
 * `_practiceBigramSimilarity`). Those prove the scoring function in
 * isolation but do NOT prove that a real iTero Rx import actually resolves
 * a brand-prefixed extracted practice name to an existing provider org in
 * the same lab.
 *
 * This DB-integration test drives the real practice matcher
 * (`_findProviderOrgByPracticeName`) against seeded organizations and
 * asserts that a brand-prefixed, bracket-suffixed extracted name links to
 * the existing provider org instead of spawning a duplicate, while an
 * unrelated extracted name does not mislink.
 *
 * Skipped when no DATABASE_URL is configured (matches the convention used
 * by cases-similarity.test.ts and other api-server integration tests).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Task #2479 iTero practice-name linking (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let helpers: typeof import("./cases.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab");
  // Existing manually-created practice in `labOrgId`.
  const southwoodOrgId = rid("prov");
  // A different practice in the same lab used to confirm we pick the best
  // (correct) match rather than just the first qualifying org.
  const eastsideOrgId = rid("prov");
  // A same-named practice but under a DIFFERENT lab — must never be matched.
  const foreignSouthwoodOrgId = rid("prov");

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    dbMod = await import("@workspace/db");
    helpers = await import("./cases.js");
    const { db, organizations } = dbMod as any;

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: southwoodOrgId,
        type: "provider",
        name: "Family Dentistry at SouthWood",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: eastsideOrgId,
        type: "provider",
        name: "Eastside Smiles Orthodontics",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: foreignSouthwoodOrgId,
        type: "provider",
        name: "Family Dentistry at SouthWood",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations } = dbMod as any;
    await db.delete(organizations).where(eq(organizations.id, southwoodOrgId));
    await db.delete(organizations).where(eq(organizations.id, eastsideOrgId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, foreignSouthwoodOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, otherLabOrgId));
  });

  it("links a brand-prefixed, bracket-suffixed iTero name to the existing practice", async () => {
    // This is exactly the shape an iTero Rx extraction produces:
    // "<brand/lab> - <practice> [<code>]".
    const extracted = "Heartland Dental - Family Dentistry at SouthWood [565]";
    const matched = await helpers._findProviderOrgByPracticeName(
      labOrgId,
      extracted,
    );
    expect(matched).toBe(southwoodOrgId);
  });

  it("links an exact practice name (no brand prefix) to the existing practice", async () => {
    const matched = await helpers._findProviderOrgByPracticeName(
      labOrgId,
      "Family Dentistry at SouthWood",
    );
    expect(matched).toBe(southwoodOrgId);
  });

  it("does not mislink an unrelated extracted practice name", async () => {
    const matched = await helpers._findProviderOrgByPracticeName(
      labOrgId,
      "Bright Valley Pediatric Dental [902]",
    );
    expect(matched).toBeNull();
  });

  it("does not match a same-named practice that belongs to a different lab", async () => {
    // foreignSouthwoodOrgId has the identical name but parent lab is
    // otherLabOrgId; scoping by parentLabOrganizationId must exclude it,
    // and labOrgId has no other "SouthWood" org... so within otherLabOrgId
    // the only match is the foreign one, and within labOrgId the only
    // SouthWood is the legitimate practice.
    const inLab = await helpers._findProviderOrgByPracticeName(
      otherLabOrgId,
      "Heartland Dental - Family Dentistry at SouthWood [565]",
    );
    expect(inLab).toBe(foreignSouthwoodOrgId);

    // Cross-check: matching within labOrgId never returns the foreign org.
    const inOwnLab = await helpers._findProviderOrgByPracticeName(
      labOrgId,
      "Family Dentistry at SouthWood",
    );
    expect(inOwnLab).not.toBe(foreignSouthwoodOrgId);
    expect(inOwnLab).toBe(southwoodOrgId);
  });

  it("returns null for a blank extracted practice name", async () => {
    expect(await helpers._findProviderOrgByPracticeName(labOrgId, "")).toBeNull();
    expect(
      await helpers._findProviderOrgByPracticeName(labOrgId, "   "),
    ).toBeNull();
  });
});
