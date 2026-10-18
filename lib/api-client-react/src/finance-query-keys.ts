/**
 * Shared prefixes for finance data.
 *
 * Keep these as prefixes rather than complete keys so every filter, page, and
 * organization-specific query remains invalidatable after a finance mutation.
 */
export const FINANCE_INVOICES_QUERY_KEY = ["invoices"] as const;
export const FINANCE_PAYMENT_HISTORY_QUERY_KEY = ["payment-history"] as const;
export const FINANCE_STATEMENT_SUMMARIES_QUERY_KEY = ["statement-account-summaries"] as const;