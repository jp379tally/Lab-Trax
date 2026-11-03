import { and, desc, eq, ilike, isNull, notInArray } from "drizzle-orm";
import { db, cases, invoices } from "@workspace/db";
import { requireSelectedProviderOrganization } from "./provider-selection";
import { assertProviderOrganizationCapability } from "./provider-capabilities";
import { HttpError } from "./http";

export interface SupportScope { userId: string; providerOrganizationId: string }

export async function resolveSupportScope(userId: string, selectedId?: string): Promise<SupportScope> {
  const selected = await requireSelectedProviderOrganization(userId, selectedId);
  await assertProviderOrganizationCapability(selected.id, "case_read");
  return { userId, providerOrganizationId: selected.id };
}

function literalSearch(query: string): string {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function lookupSupportData(name: string, query: string, scope: SupportScope) {
  // Re-check membership and entitlements for each tool, including mid-turn revocation.
  const current = await resolveSupportScope(scope.userId, scope.providerOrganizationId);
  const organizationId = current.providerOrganizationId;
  if (name === "assigned_cases") {
    let includeClosed = true;
    try { await assertProviderOrganizationCapability(organizationId, "provider_portal"); }
    catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 403) throw error;
      includeClosed = false;
    }
    const rows = await db.select({
      caseNumber: cases.caseNumber, status: cases.status,
      dueDate: cases.dueDate, expectedDeliveryDate: cases.expectedDeliveryDate,
    }).from(cases).where(and(
      eq(cases.providerOrganizationId, organizationId), isNull(cases.deletedAt),
      ...(query ? [ilike(cases.caseNumber, literalSearch(query))] : []),
      ...(!includeClosed ? [notInArray(cases.status, ["complete", "delivered", "cancelled"])] : []),
    )).orderBy(desc(cases.createdAt)).limit(10);
    return { cases: rows, limitedSample: true, limit: 10, order: "newest created first", checkedAt: new Date().toISOString() };
  }
  if (name === "assigned_invoices") {
    await assertProviderOrganizationCapability(organizationId, "billing");
    const rows = await db.select({
      invoiceNumber: invoices.invoiceNumber, status: invoices.status,
      total: invoices.total, balanceDue: invoices.balanceDue,
    }).from(invoices).where(and(
      eq(invoices.providerOrganizationId, organizationId), isNull(invoices.deletedAt),
      ...(query ? [ilike(invoices.invoiceNumber, literalSearch(query))] : []),
    )).orderBy(desc(invoices.createdAt)).limit(10);
    return { invoices: rows, limitedSample: true, limit: 10, order: "newest created first", checkedAt: new Date().toISOString() };
  }
  throw new HttpError(400, "Unsupported assistant lookup.");
}
