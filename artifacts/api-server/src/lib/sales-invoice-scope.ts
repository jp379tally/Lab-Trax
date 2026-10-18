import { and, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";
import { invoices } from "@workspace/db";
import { finalizedInvoiceSql } from "./recovery-billing-hold";

export const salesIssuedDate = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;

/** The same persisted sales population for dashboard, series, and detail. */
export function salesInvoiceScope(organizationId: string, from?: Date, to?: Date) {
  return and(
    eq(invoices.labOrganizationId, organizationId),
    isNull(invoices.deletedAt),
    ne(invoices.status, "void"),
    finalizedInvoiceSql(),
    from ? gte(salesIssuedDate, from) : undefined,
    to ? lte(salesIssuedDate, to) : undefined,
  );
}
