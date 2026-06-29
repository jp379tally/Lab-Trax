/**
 * Regression guard: per-doctor percentage-discount fallback in pricing.ts.
 *
 * Locks the behavior added so that the discount price shown in the UI matches
 * what gets charged on invoices. The specific path under test is:
 *
 *   - a per-doctor override exists with a default `discountPercent` set
 *   - the override has NO exact dollar price for the item key
 *   - the practice has NO lab↔provider connection tier
 *   - the doctor IS assigned to a named tier (override.tierName)
 *
 * In this case both `resolveServerPriceWithSource` (used when charging an
 * invoice line) and `resolveAllPricesForContext` (used by the invoice-editor
 * item catalog) must return the DISCOUNTED amount off the doctor's effective
 * tier price — never the full tier price and never $0.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB. These
 * functions read directly from the database, so we call them in-process rather
 * than going through the HTTP layer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Per-doctor discount fallback off the doctor's named tier (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let pricing: typeof import("./pricing.js");

  const labOrgId = rid("lab");
  // A provider org with NO organization_connections row, so the
  // connection-tier lookup resolves to null (i.e. "no practice default tier").
  const providerOrgId = rid("prov");
  const doctorName = rid("DiscFallbackDr");
  const tierName = rid("PremiumTier");

  // Base tier prices the discount must be computed off of.
  const PFM_BASE = 100; // discounted via the override's default percent
  const ZIR_BASE = 300; // discounted via a per-item percent
  const DEFAULT_PCT = 20; // override default discount
  const ZIR_PCT = 50; // per-item discount beats the default for zirconia

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    pricing = await import("./pricing.js");

    const {
      db,
      organizations,
      pricingTiers,
      pricingOverrides,
    } = dbMod as any;

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("DiscFallbackLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("DiscFallbackProv"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    // The doctor's named tier. No lab↔provider connection is created, so this
    // tier is reachable only through override.tierName.
    await db.insert(pricingTiers).values({
      id: rid("tier"),
      labOrganizationId: labOrgId,
      name: tierName,
      pricesJson: { pfm_crown: PFM_BASE, zirconia_crown: ZIR_BASE },
    });

    // Per-doctor override: default 20% off, zirconia 50% off, no exact dollar
    // prices, assigned to the named tier above.
    await db.insert(pricingOverrides).values({
      id: rid("ov"),
      labOrganizationId: labOrgId,
      doctorName,
      providerOrganizationId: providerOrgId,
      tierName,
      pricesJson: {},
      discountPercent: String(DEFAULT_PCT),
      discountPercentsJson: { zirconia_crown: ZIR_PCT },
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, pricingTiers, pricingOverrides } = dbMod as any;
    await db
      .delete(pricingOverrides)
      .where(eq(pricingOverrides.labOrganizationId, labOrgId));
    await db
      .delete(pricingTiers)
      .where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [providerOrgId, labOrgId]));
  });

  it("resolveServerPriceWithSource discounts off the doctor's tier (default %)", async () => {
    const details = await pricing.resolveServerPriceWithSource(
      {
        labOrganizationId: labOrgId,
        doctorName,
        providerOrganizationId: providerOrgId,
      },
      "PFM Crown",
      null,
    );
    expect(details).not.toBeNull();
    expect(details?.key).toBe("pfm_crown");
    // 20% off 100 = 80 — not the full tier price (100), not $0.
    expect(details?.amount).toBe(80);
    expect(details?.amount).not.toBe(PFM_BASE);
    expect(details?.amount).not.toBe(0);
    expect(details?.source).toBe("discount");
  });

  it("resolveServerPriceWithSource honors a per-item discount over the default", async () => {
    const details = await pricing.resolveServerPriceWithSource(
      {
        labOrganizationId: labOrgId,
        doctorName,
        providerOrganizationId: providerOrgId,
      },
      "Zirconia Crown",
      null,
    );
    expect(details?.key).toBe("zirconia_crown");
    // 50% off 300 = 150 (per-item beats the 20% default).
    expect(details?.amount).toBe(150);
    expect(details?.source).toBe("discount");
  });

  it("resolveAllPricesForContext returns the same discounted prices for the item catalog", async () => {
    const rows = await pricing.resolveAllPricesForContext({
      labOrganizationId: labOrgId,
      doctorName,
      providerOrganizationId: providerOrgId,
    });

    const pfm = rows.find((r) => r.key === "pfm_crown");
    expect(pfm?.unitPrice).toBe(80);
    expect(pfm?.unitPrice).not.toBe(PFM_BASE);
    expect(pfm?.unitPrice).not.toBe(0);
    expect(pfm?.source).toBe("discount");

    const zir = rows.find((r) => r.key === "zirconia_crown");
    expect(zir?.unitPrice).toBe(150);
    expect(zir?.source).toBe("discount");
  });

  it("the catalog price matches the per-line charge price (UI === invoice)", async () => {
    const charged = await pricing.resolveServerPriceWithSource(
      {
        labOrganizationId: labOrgId,
        doctorName,
        providerOrganizationId: providerOrgId,
      },
      "PFM Crown",
      null,
    );
    const rows = await pricing.resolveAllPricesForContext({
      labOrganizationId: labOrgId,
      doctorName,
      providerOrganizationId: providerOrgId,
    });
    const shown = rows.find((r) => r.key === "pfm_crown");
    expect(shown?.unitPrice).toBe(charged?.amount);
  });
});
