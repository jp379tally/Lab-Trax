import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  invoices,
  notifications,
  organizationMemberships,
  organizations,
  providerPaymentAllocations,
  providerPaymentCheckouts,
} from "@workspace/db";
import { BILLING_ROLES } from "./rbac";

type PaymentOrigin = "provider" | "lab";

export interface PaymentNotificationInput {
  origin: PaymentOrigin;
  event?: "payment" | "reversal";
  sourceType: "provider_checkout" | "statement_payment_session" | "invoice_payment" | "receive_payment";
  sourceId: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  amount: string | number;
  invoiceIds?: readonly string[];
  paymentMethod?: string | null;
  customerCreditAmount?: string | number | null;
}

function money(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
}

/**
 * Sends one reciprocal in-app payment alert per eligible recipient.
 * The payment operation has already committed when this runs; every lookup and
 * insert is therefore best-effort and cannot change settlement success.
 */
export async function deliverPaymentNotifications(
  input: PaymentNotificationInput,
): Promise<void> {
  try {
    const invoiceIds = [...new Set((input.invoiceIds ?? []).filter(Boolean))];
    const [labRows, providerRows, invoiceRows] = await Promise.all([
      db
        .select({ name: organizations.name, displayName: organizations.displayName })
        .from(organizations)
        .where(eq(organizations.id, input.labOrganizationId))
        .limit(1),
      db
        .select({ name: organizations.name, displayName: organizations.displayName })
        .from(organizations)
        .where(eq(organizations.id, input.providerOrganizationId))
        .limit(1),
      invoiceIds.length
        ? db
            .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
            .from(invoices)
            .where(
              and(
                inArray(invoices.id, invoiceIds),
                eq(invoices.labOrganizationId, input.labOrganizationId),
                eq(invoices.providerOrganizationId, input.providerOrganizationId),
              ),
            )
        : Promise.resolve([]),
    ]);
    const labName = labRows[0]?.displayName || labRows[0]?.name || "The lab";
    const providerName =
      providerRows[0]?.displayName || providerRows[0]?.name || "The provider";
    const invoiceNumbers = invoiceRows.map((invoice) => invoice.invoiceNumber);

    const recipients =
      input.origin === "provider"
        ? await db
            .select({ userId: organizationMemberships.userId })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.labId, input.labOrganizationId),
                eq(organizationMemberships.status, "active"),
                isNull(organizationMemberships.deletedAt),
                inArray(organizationMemberships.role, BILLING_ROLES),
              ),
            )
        : await db
            .select({ userId: organizationMemberships.userId })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.labId, input.providerOrganizationId),
                eq(organizationMemberships.status, "active"),
                isNull(organizationMemberships.deletedAt),
              ),
            );
    if (recipients.length === 0) return;

    const invoiceContext =
      invoiceNumbers.length === 1
        ? `invoice ${invoiceNumbers[0]}`
        : invoiceNumbers.length > 1
          ? `${invoiceNumbers.length} invoices`
          : "the customer account";
    const credit = Number(input.customerCreditAmount ?? 0);
    const creditContext =
      Number.isFinite(credit) && credit > 0.005
        ? `, including $${credit.toFixed(2)} in account credit`
        : "";
    const reversed = input.event === "reversal";
    const type = reversed
      ? "payment_reversed"
      : input.origin === "provider"
        ? "provider_payment_received"
        : "lab_payment_recorded";
    const title = reversed
      ? "Payment reversed"
      : input.origin === "provider"
        ? "Provider payment received"
        : "Payment recorded by lab";
    const body = reversed
      ? `${labName} reversed a $${money(input.amount)} payment from ${providerName} for ${invoiceContext}. The account balance has been updated.`
      : input.origin === "provider"
        ? `${providerName} paid $${money(input.amount)} to ${labName} for ${invoiceContext}.`
        : `${labName} recorded a $${money(input.amount)} payment from ${providerName} for ${invoiceContext}${creditContext}.`;

    await db
      .insert(notifications)
      .values(
        recipients.map(({ userId }) => ({
          userId,
          type,
          title,
          body,
          dedupeKey: `${input.sourceType}:${input.sourceId}:${userId}`,
          dataJson: {
            paymentOrigin: input.origin,
            paymentEvent: input.event ?? "payment",
            checkoutId:
              input.sourceType === "provider_checkout"
                ? input.sourceId.split(":")[0]
                : undefined,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            labOrganizationId: input.labOrganizationId,
            providerOrganizationId: input.providerOrganizationId,
            amount: money(input.amount),
            customerCreditAmount: money(input.customerCreditAmount),
            paymentMethod: input.paymentMethod ?? null,
            invoiceIds,
            invoiceNumbers,
            billingDestination:
              input.origin === "provider" ? "lab_accounts" : "provider_billing",
          },
        })),
      )
      .onConflictDoNothing({ target: notifications.dedupeKey });
  } catch {
    // Reciprocal alerts are best-effort and never change payment success.
  }
}

export async function deliverProviderCheckoutPaymentNotifications(
  checkoutId: string,
): Promise<void> {
  try {
    const [checkout] = await db
      .select()
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, checkoutId))
      .limit(1);
    if (!checkout || checkout.status !== "succeeded") return;
    const allocations = await db
      .select({
        invoiceId: providerPaymentAllocations.invoiceId,
        amount: providerPaymentAllocations.amount,
      })
      .from(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, checkoutId));
    const invoiceRows = allocations.length
      ? await db
          .select({
            id: invoices.id,
            labOrganizationId: invoices.labOrganizationId,
          })
          .from(invoices)
          .where(
            and(
              inArray(
                invoices.id,
                allocations.map((allocation) => allocation.invoiceId),
              ),
              eq(invoices.providerOrganizationId, checkout.providerOrganizationId),
            ),
          )
      : [];
    const byLab = new Map<string, string[]>();
    for (const invoice of invoiceRows) {
      const ids = byLab.get(invoice.labOrganizationId) ?? [];
      ids.push(invoice.id);
      byLab.set(invoice.labOrganizationId, ids);
    }
    for (const [labOrganizationId, labInvoiceIds] of byLab) {
      const labInvoiceSet = new Set(labInvoiceIds);
      const amount = allocations
        .filter((allocation) => labInvoiceSet.has(allocation.invoiceId))
        .reduce((sum, allocation) => sum + Number(allocation.amount), 0);
      await deliverPaymentNotifications({
        origin: "provider",
        sourceType: "provider_checkout",
        sourceId: `${checkoutId}:${labOrganizationId}`,
        labOrganizationId,
        providerOrganizationId: checkout.providerOrganizationId,
        amount,
        invoiceIds: labInvoiceIds,
        paymentMethod: "card",
      });
    }
  } catch {
    // Best-effort wrapper; checkout settlement remains authoritative.
  }
}