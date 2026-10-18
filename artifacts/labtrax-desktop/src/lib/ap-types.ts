/**
 * Shared shapes for the Accounts Payable screens.
 *
 * Every response shape here comes from the shared API spec via
 * `@workspace/api-client-react`, so a server-side change to an
 * accounts-payable endpoint fails the desktop build instead of breaking these
 * screens at runtime. Only the local aliases the screens read by live here.
 */

import type {
  TransactionCategory,
  Vendor,
  VendorBill,
  VendorBillDetail,
  VendorBillLine,
  VendorPayment,
} from "@workspace/api-client-react";

export {
  AgingBucketKey,
  BillStatus,
  BillStatusFilter,
} from "@workspace/api-client-react";

export type {
  AgingBucketLabel,
  AgingBuckets,
  AgingLimitation,
  ApAgingBillDetail,
  ApAgingReport,
  ApAgingRow,
  ArAgingInvoiceDetail,
  ArAgingReport,
  ArAgingRow,
  BillAllocation,
  BillEvent,
  BillLineInput,
  PayBillsVendor,
  VendorApSummary,
  VendorCredit,
} from "@workspace/api-client-react";

export type Bill = VendorBill;
export type BillDetail = VendorBillDetail;
export type BillLine = VendorBillLine;

/** A posted payment to a vendor. The money figure is `totalAmount`. */
export type VendorPaymentRecord = VendorPayment;

/** Payees usable on a bill, and the categories a bill line can be coded to. */
export type VendorLite = Vendor;
export type CategoryLite = TransactionCategory;
