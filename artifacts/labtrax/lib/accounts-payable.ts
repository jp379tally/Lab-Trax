/**
 * Accounts Payable helpers for the mobile screens.
 *
 * The response shapes come from the shared API spec via
 * `@workspace/api-client-react`, so a server-side change to an
 * accounts-payable endpoint fails the mobile build instead of breaking these
 * screens at runtime. Only the money/date helpers below are local.
 */

import type {
  VendorBill,
  VendorBillDetail,
  VendorBillLine,
  TransactionCategory,
} from "@workspace/api-client-react";

export {
  AgingBucketKey,
  BillStatus,
} from "@workspace/api-client-react";

export type {
  AgingBuckets,
  ApAgingReport,
  ApAgingRow,
  ArAgingReport,
  ArAgingRow,
  PayBillsVendor,
  Vendor,
  VendorApSummary,
  VendorCredit,
  VendorPayment,
} from "@workspace/api-client-react";

export type Bill = VendorBill;
export type BillDetail = VendorBillDetail;
export type BillLine = VendorBillLine;
export type Category = TransactionCategory;

export type Money = string | number | null | undefined;

/**
 * Bank accounts come from the cash-side `/finance/accounts` endpoint, which
 * is not part of the accounts-payable surface in the spec yet.
 */
export interface Account {
  id: string;
  name: string;
  accountType?: string | null;
  isArchived?: boolean | null;
}

export interface AvailableCredit { id: string; remainingAmount: Money }

/** Allocate cents across credits in the supplied (oldest-first) order. */
export function spreadCreditApplications(
  credits: AvailableCredit[],
  requestedCents: number,
): Array<{ vendorCreditId: string; amount: number }> {
  const applications: Array<{ vendorCreditId: string; amount: number }> = [];
  let remaining = Math.max(0, Math.trunc(requestedCents));
  for (const credit of credits) {
    if (remaining <= 0) break;
    const available = cents(credit.remainingAmount) ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    applications.push({ vendorCreditId: credit.id, amount: dollars(take) });
    remaining -= take;
  }
  return applications;
}

export function cents(value: Money): number | null {
  if (value == null || value === "") return 0;
  const normalized = String(value).trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace("-", "").split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return negative ? -result : result;
}

export function dollars(value: number): number {
  return value / 100;
}

/** Today as YYYY-MM-DD on the device, not in UTC. */
export function today(): string {
  return localIsoDate(new Date());
}

export function plusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function localIsoDate(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * The device's IANA zone, sent with dated reports so the server resolves a
 * bare date to the end of that day where the user is, not in UTC.
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function dueDateFromTerms(billDate: string, termsDays: number): string | null {
  if (!validDate(billDate) || !Number.isInteger(termsDays) || termsDays < 0) return null;
  const date = new Date(`${billDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}

export function agingBucket(dueDate: string, asOf: string): "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus" | null {
  if (!validDate(dueDate) || !validDate(asOf)) return null;
  const days = Math.floor((Date.parse(`${asOf}T12:00:00.000Z`) - Date.parse(`${dueDate}T12:00:00.000Z`)) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
}

export function newKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}