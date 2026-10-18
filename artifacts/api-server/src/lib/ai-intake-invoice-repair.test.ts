import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { repairRecentCaseInvoices } from "./ai-intake-invoice-repair";

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("AI intake invoice repair (database integration)", () => {
  let dbMod: typeof import("@workspace/db");
  const labOrgId = rid("repair_lab");
  const otherLabOrgId = rid("repair_other_lab");
  const providerOrgId = rid("repair_provider");
  const otherProviderOrgId = rid("repair_other_provider");
  const userId = rid("repair_user");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const older = new Date(Date.now() - 172_800_000).toISOString().slice(0, 10);
  const caseIds: string[] = [];

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    const { db, users, organizations, organizationMemberships } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `repair_${userId}`,
      password: "testpass",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Repair Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Repair Other Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Repair Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: otherProviderOrgId,
        type: "provider",
        name: "Other Repair Practice",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("repair_membership"),
      labId: labOrgId,
      userId,
      role: "owner",
      status: "active",
    });
  });

  afterAll(async () => {
    if (!dbMod) return;
    const { db, invoiceLineItems, invoices, cases, caseRestorations,
      organizationMemberships, organizations, users } = dbMod as any;
    const invoiceRows = await db.select({ id: invoices.id })
      .from(invoices).where(inArray(invoices.caseId, caseIds));
    if (invoiceRows.length) {
      await db.delete(invoiceLineItems).where(
        inArray(invoiceLineItems.invoiceId, invoiceRows.map((r: any) => r.id)),
      );
      await db.delete(invoices).where(
        inArray(invoices.id, invoiceRows.map((r: any) => r.id)),
      );
    }
    if (caseIds.length) {
      await db.delete(caseRestorations).where(inArray(caseRestorations.caseId, caseIds));
      await db.delete(cases).where(inArray(cases.id, caseIds));
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, otherLabOrgId, providerOrgId, otherProviderOrgId]),
    );
    await db.delete(users).where(eq(users.id, userId));
  });

  it("repairs yesterday and today across sources, preserving tenant, patient and saved zero pricing", async () => {
    const { db, cases, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const todayCaseId = rid("repair_today");
    const otherTenantCaseId = rid("repair_other_tenant");
    const oldCaseId = rid("repair_old");
    const manualCaseId = rid("repair_manual");
    caseIds.push(todayCaseId, otherTenantCaseId, oldCaseId, manualCaseId);
    await db.insert(cases).values([
      {
        id: todayCaseId,
        caseNumber: rid("RT"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
         patientFirstName: "Synthetic070",
         patientLastName: "Patient070",
        doctorName: "Dr. Repair",
        status: "received",
        priority: "normal",
        receivedAt: today,
        createdByUserId: userId,
        aiImportSource: "itero",
      },
      {
        id: otherTenantCaseId,
        caseNumber: rid("ROT"),
        labOrganizationId: otherLabOrgId,
        providerOrganizationId: otherProviderOrgId,
        patientFirstName: "Other",
        patientLastName: "Tenant",
        doctorName: "Dr. Other",
        status: "received",
        priority: "normal",
        receivedAt: today,
        createdByUserId: userId,
        aiImportSource: "itero",
      },
      {
        id: oldCaseId,
        caseNumber: rid("ROLD"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Old",
        patientLastName: "Import",
        doctorName: "Dr. Repair",
        status: "received",
        priority: "normal",
         receivedAt: older,
        createdByUserId: userId,
        aiImportSource: "itero",
      },
       {
         id: manualCaseId,
         caseNumber: rid("RMAN"),
         labOrganizationId: labOrgId,
         providerOrganizationId: providerOrgId,
         patientFirstName: "Manual",
         patientLastName: "Yesterday",
         doctorName: "Dr. Repair",
         status: "received",
         priority: "normal",
         receivedAt: yesterday,
         createdByUserId: userId,
       },
    ]);
     await db.insert(caseRestorations).values([{
      caseId: todayCaseId,
      toothNumber: "14",
      restorationType: "Removable",
      restorationSubtype: null,
      arch: null,
      material: "Zirconia",
      shade: "A2",
      quantity: 1,
       unitPrice: "0.00",
       priceSource: "manual",
     }, {
       caseId: manualCaseId,
       toothNumber: "12",
       restorationType: "Crown",
       material: "Zirconia",
       quantity: 1,
       unitPrice: "0.00",
       priceSource: "manual",
     }, {
       caseId: manualCaseId,
       toothNumber: "13",
       restorationType: "Crown",
       material: "Zirconia",
       quantity: 1,
       unitPrice: "83.00",
       priceSource: "manual",
     }]);

     const first = await repairRecentCaseInvoices();
     expect(first.repaired).toBeGreaterThanOrEqual(3);
    const todayInvoices = await db.select().from(invoices).where(
       inArray(invoices.caseId, [todayCaseId, otherTenantCaseId, oldCaseId, manualCaseId]),
    );
     expect(todayInvoices).toHaveLength(3);
    expect(todayInvoices.map((row: any) => row.caseId)).toEqual(
       expect.arrayContaining([todayCaseId, otherTenantCaseId, manualCaseId]),
    );
    const repaired = todayInvoices.find((row: any) => row.caseId === todayCaseId);
    expect(repaired.aiPricingWarning).toContain("Arch is missing");
     expect(repaired.displayMetadataJson.patientName).toBe("Synthetic070 Patient070");
     expect(repaired.providerOrganizationId).toBe(providerOrgId);
     expect(repaired.issuedAt.toISOString()).toBe(`${today}T12:00:00.000Z`);
    const oldInvoices = todayInvoices.filter((row: any) => row.caseId === oldCaseId);
    expect(oldInvoices).toHaveLength(0);

     const manualInvoice = todayInvoices.find((row: any) => row.caseId === manualCaseId);
     const manualLines = await db.select().from(invoiceLineItems)
       .where(eq(invoiceLineItems.invoiceId, manualInvoice.id));
     expect(manualLines.map((line: any) => line.unitPrice).sort()).toEqual(["0.00", "83.00"]);
     expect(manualInvoice.total).toBe("83.00");
     expect(manualLines.every((line: any) => line.sourceRestorationIdsJson?.length === 1)).toBe(true);
     await db.update(invoices).set({ notes: "Reviewed and retained" })
       .where(eq(invoices.id, manualInvoice.id));
     const second = await repairRecentCaseInvoices();
    expect(second.repaired).toBe(0);
     const [retained] = await db.select().from(invoices).where(eq(invoices.id, manualInvoice.id));
     expect(retained.notes).toBe("Reviewed and retained");
     expect(retained.total).toBe("83.00");
    const count = await db.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.caseId, todayCaseId));
    expect(count).toHaveLength(1);
    const lines = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, repaired!.id));
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(todayInvoices.map((row: any) => row.labOrganizationId)).size).toBe(2);
  });

   it("reports a number collision and continues to repair the next case without modifying the owner", async () => {
     const { db, cases, invoices } = dbMod as any;
     const collisionId = rid("repair_collision");
     const nextId = rid("repair_next");
     const invalidProviderId = rid("repair_invalid_provider");
     caseIds.push(collisionId, invalidProviderId, nextId);
     const collisionNumber = rid("RCONFLICT");
     await db.insert(cases).values([
       { id: collisionId, caseNumber: collisionNumber, labOrganizationId: labOrgId,
         providerOrganizationId: providerOrgId, patientFirstName: "Wrong", patientLastName: "Case",
         doctorName: "Dr. Repair", status: "received", priority: "normal",
         receivedAt: yesterday, createdByUserId: userId },
       { id: invalidProviderId, caseNumber: rid("RINVALID"), labOrganizationId: labOrgId,
         providerOrganizationId: otherProviderOrgId, patientFirstName: "Invalid", patientLastName: "Practice",
         doctorName: "Dr. Other", status: "received", priority: "normal",
         receivedAt: today, createdByUserId: userId },
       { id: nextId, caseNumber: rid("RNEXT"), labOrganizationId: labOrgId,
         providerOrganizationId: providerOrgId, patientFirstName: "Next", patientLastName: "Case",
         doctorName: "Dr. Repair", status: "received", priority: "normal",
         receivedAt: today, createdByUserId: userId },
     ]);
     // An unlinked legacy invoice holds the number. It is not safe to adopt.
     const [owner] = await db.insert(invoices).values({
       invoiceNumber: `INV-${collisionNumber}`, caseId: null,
       labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
       createdByUserId: userId, status: "open",
       displayMetadataJson: { patientName: "Another Patient" },
     }).returning();
     try {
       const result = await repairRecentCaseInvoices();
       expect(result.conflicting).toBeGreaterThanOrEqual(1);
       expect(result.failed).toBeGreaterThanOrEqual(1);
       expect(result.repaired).toBeGreaterThanOrEqual(1);
       expect(await db.select().from(invoices).where(eq(invoices.caseId, collisionId))).toHaveLength(0);
       expect(await db.select().from(invoices).where(eq(invoices.caseId, invalidProviderId))).toHaveLength(0);
       expect(await db.select().from(invoices).where(eq(invoices.caseId, nextId))).toHaveLength(1);
       const [unchanged] = await db.select().from(invoices).where(eq(invoices.id, owner.id));
       expect(unchanged.caseId).toBeNull();
       expect(unchanged.displayMetadataJson.patientName).toBe("Another Patient");
     } finally {
       await db.delete(invoices).where(eq(invoices.id, owner.id));
     }
   });
});