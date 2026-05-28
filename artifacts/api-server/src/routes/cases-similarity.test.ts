/**
 * Regression tests for Task #331 cross-provider scoping in
 * `getDoctorNameSetForProviderOrg` + `resolveRemakeOriginal`.
 *
 * Skipped when no DATABASE_URL is configured (matches the convention used
 * by other api-server integration tests).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Task #331 cross-provider scoping (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let helpers: typeof import("./cases.js");

  const labOrgId = rid("lab");
  const providerAOrgId = rid("provA");
  const providerBOrgId = rid("provB");
  const userId = rid("u");
  const canonicalForAId = rid("c");
  const canonicalForBId = rid("c");
  const legacyForAId = rid("lc");
  const legacyForBId = rid("lc");

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    helpers = await import("./cases.js");
    const { db, organizations, cases, labCases, users } = dbMod as any;

    await db.insert(users).values({
      id: userId,
      username: `testuser_${userId}`,
      password: "x",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab" },
      { id: providerAOrgId, type: "provider", name: "Provider A" },
      { id: providerBOrgId, type: "provider", name: "Provider B" },
    ]);

    // Canonical case for provider A with doctor "Dr. Alpha"
    await db.insert(cases).values({
      id: canonicalForAId,
      caseNumber: `A-1-${canonicalForAId}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerAOrgId,
      doctorName: "Dr. Alpha",
      patientFirstName: "Patty",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: userId,
    });

    // Legacy case in same lab whose doctorName matches provider A
    await db.insert(labCases).values({
      id: legacyForAId,
      ownerId: rid("u"),
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "LA-1",
        patientName: "Patty Test",
        doctorName: "Dr. Alpha",
      }),
    });

    // Legacy case in same lab whose doctorName matches provider B (NOT A)
    await db.insert(labCases).values({
      id: legacyForBId,
      ownerId: rid("u"),
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "LB-1",
        patientName: "Patty Test",
        doctorName: "Dr. Bravo",
      }),
    });

    // Canonical case for provider B with doctor "Dr. Bravo" so the
    // doctor-name set for B is non-empty.
    await db.insert(cases).values({
      id: canonicalForBId,
      caseNumber: `B-1-${canonicalForBId}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerBOrgId,
      doctorName: "Dr. Bravo",
      patientFirstName: "Other",
      patientLastName: "Patient",
      status: "draft",
      createdByUserId: userId,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, cases, labCases, users } = dbMod as any;
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, providerAOrgId));
    await db.delete(organizations).where(eq(organizations.id, providerBOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("getDoctorNameSetForProviderOrg returns only doctors for that provider", async () => {
    const setA = await helpers.getDoctorNameSetForProviderOrg(
      labOrgId,
      providerAOrgId,
    );
    expect(setA.has("dr. alpha")).toBe(true);
    expect(setA.has("dr. bravo")).toBe(false);
    // Org name itself is included as a fallback identity.
    expect(setA.has("provider a")).toBe(true);

    const setB = await helpers.getDoctorNameSetForProviderOrg(
      labOrgId,
      providerBOrgId,
    );
    expect(setB.has("dr. bravo")).toBe(true);
    expect(setB.has("dr. alpha")).toBe(false);
  });

  it("resolveRemakeOriginal rejects legacy original from a different provider", async () => {
    // Trying to link a new case under provider A to a legacy case whose
    // doctorName belongs to provider B must return null (cross-provider
    // isolation).
    const cross = await helpers.resolveRemakeOriginal(
      legacyForBId,
      labOrgId,
      providerAOrgId,
    );
    expect(cross).toBeNull();

    // Same legacy id, but the caller is provider B → allowed.
    const same = await helpers.resolveRemakeOriginal(
      legacyForBId,
      labOrgId,
      providerBOrgId,
    );
    expect(same).not.toBeNull();
    expect(same?.kind).toBe("legacy");

    // Legacy original whose doctor matches provider A → allowed.
    const ok = await helpers.resolveRemakeOriginal(
      legacyForAId,
      labOrgId,
      providerAOrgId,
    );
    expect(ok).not.toBeNull();
    expect(ok?.kind).toBe("legacy");
  });

  it("resolveRemakeOriginal rejects canonical original from a different provider", async () => {
    const cross = await helpers.resolveRemakeOriginal(
      canonicalForAId,
      labOrgId,
      providerBOrgId,
    );
    expect(cross).toBeNull();

    const ok = await helpers.resolveRemakeOriginal(
      canonicalForAId,
      labOrgId,
      providerAOrgId,
    );
    expect(ok).not.toBeNull();
    expect(ok?.kind).toBe("canonical");
  });

  it("resolveRemakeOriginal accepts legacy original via doctor-name fallback when provider has no canonical history", async () => {
    // Simulate a brand-new provider with zero canonical cases (only a
    // legacy mobile case in `lab_cases`). The derived doctor set is
    // empty; the caller must pass an `expectedDoctorName` that matches
    // the legacy doctorName for linking to succeed.
    const { db, organizations, labCases } = dbMod as any;
    const newProviderId = rid("provC");
    const legacyOnlyId = rid("lc");
    await db.insert(organizations).values({
      id: newProviderId,
      type: "provider",
      name: "Provider C",
    });
    await db.insert(labCases).values({
      id: legacyOnlyId,
      ownerId: rid("u"),
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "LC-1",
        patientName: "Patty Test",
        doctorName: "Dr. Charlie",
      }),
    });
    try {
      // Without doctor-name fallback → rejected (set is empty,
      // org-name doesn't match doctorName).
      const blocked = await helpers.resolveRemakeOriginal(
        legacyOnlyId,
        labOrgId,
        newProviderId,
      );
      expect(blocked).toBeNull();

      // With doctor-name fallback → accepted.
      const allowed = await helpers.resolveRemakeOriginal(
        legacyOnlyId,
        labOrgId,
        newProviderId,
        "Dr. Charlie",
      );
      expect(allowed).not.toBeNull();
      expect(allowed?.kind).toBe("legacy");
    } finally {
      await db.delete(labCases).where(eq(labCases.id, legacyOnlyId));
      await db
        .delete(organizations)
        .where(eq(organizations.id, newProviderId));
    }
  });

  it("resolveRemakeOriginal rejects originals from a different lab", async () => {
    const otherLabId = rid("lab");
    const { db, organizations } = dbMod as any;
    await db.insert(organizations).values({
      id: otherLabId,
      type: "lab",
      name: "Other Lab",
    });
    try {
      const r1 = await helpers.resolveRemakeOriginal(
        canonicalForAId,
        otherLabId,
        null,
      );
      expect(r1).toBeNull();
      const r2 = await helpers.resolveRemakeOriginal(
        legacyForAId,
        otherLabId,
        null,
      );
      expect(r2).toBeNull();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, otherLabId));
    }
  });
});
