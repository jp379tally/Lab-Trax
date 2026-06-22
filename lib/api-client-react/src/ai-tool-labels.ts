const TOOL_LABELS: Record<string, string> = {
  lookup_case: "Looking up cases…",
  get_case_history: "Reading case history…",
  get_cases_due_soon: "Checking cases due soon…",
  count_cases_by_status: "Counting cases by status…",
  create_case: "Creating a case…",
  update_case: "Updating the case…",
  update_case_status: "Updating case status…",
  lookup_invoice: "Checking invoices…",
  mark_invoice_paid: "Marking the invoice paid…",
  void_invoice: "Voiding the invoice…",
  reset_invoice_layout: "Resetting the invoice layout…",
  send_statements: "Sending statements…",
  financial_summary: "Crunching financials…",
  monthly_sales_snapshot: "Reviewing monthly sales…",
  set_practice_pricing_tier: "Updating pricing tier…",
  create_pricing_override: "Creating a pricing override…",
  remake_rate: "Checking remake rates…",
  merge_doctors: "Merging doctors…",
  draft_message: "Drafting a message…",
};

const FALLBACK_LABEL = "Looking up…";

export function getToolCallLabel(toolName: string | null | undefined): string {
  if (!toolName) return FALLBACK_LABEL;
  return TOOL_LABELS[toolName] ?? FALLBACK_LABEL;
}
