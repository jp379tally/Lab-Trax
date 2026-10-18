/**
 * Deliberately reviewed coverage, not an automatically generated allowlist.
 * Adding a schema table or media-shaped column requires a backup decision.
 * Exclusions apply to rows, not to the schema-only recovery dump.
 */
export type TableRule = { include: boolean; reason: string };
const include = (reason: string): TableRule => ({ include: true, reason });
const exclude = (reason: string): TableRule => ({ include: false, reason });
const tenant = include("Lab/practice-owned records selected by their organization columns.");
const dependent = include("Dependent records selected through a scoped parent, never through a user alone.");
const personal = exclude("Account-wide personal data cannot be isolated to one lab.");
const platform = exclude("Platform-wide configuration or operational state, not lab recovery data.");

export const LAB_BACKUP_TABLE_RULES: Record<string, TableRule> = {
  users: include("Only identities referenced by scoped records; credentials are redacted."),
  organizations: include("The selected lab and its child practices only."),
  lab_cases: tenant,
  lab_case_projection_installation: platform,
  legacy_case_media: tenant,
  lab_pending_files: tenant,
  lab_pending_file_note_edits: dependent,
  platform_account_sequences: platform,
  verification_codes: exclude("Authentication codes must never be exported."),
  doctor_account_links: personal,
  account_link_invites: personal,
  lab_memberships: tenant,
  lab_unassigned_doctors: tenant,
  join_requests: tenant,
  lab_invites: tenant,
  organization_connections: tenant,
  provider_account_change_requests: tenant,
  cases: tenant,
  itero_imported_orders: tenant,
  itero_import_sessions: tenant,
  case_restorations: dependent,
  case_events: dependent,
  case_notes: dependent,
  case_saved_views: include("Lab-shared Cases view definitions selected by their owning lab."),
  case_rx_note_entries: dependent,
  case_attachments: dependent,
  case_locations: dependent,
  case_exceptions: tenant,
  case_exception_notes: dependent,
  case_submission_queue: dependent,
  invoices: tenant,
  invoice_attachments: dependent,
  invoice_credits: tenant,
  practice_statements: tenant,
  practice_statement_sends: dependent,
  invoice_line_items: dependent,
  payments: dependent,
  statement_payment_sessions: include("Lab-owned accounting receipts, not authentication sessions; required by payment and credit ledgers."),
  statement_payment_reversals: include("Receipt reversal evidence selected through the lab-owned receipt parent."),
  provider_payment_customers: tenant,
  provider_payment_checkouts: tenant,
  provider_payment_allocations: dependent,
  pricing_tiers: tenant,
  pricing_overrides: tenant,
  audit_logs: tenant,
  user_sessions: exclude("Authentication sessions must never be exported."),
  notifications: personal,
  bank_accounts: tenant,
  transaction_categories: tenant,
  recurring_transactions: tenant,
  reconciliations: tenant,
  bank_import_batches: tenant,
  bank_transactions: tenant,
  bank_deposit_batch_members: dependent,
  bank_transaction_invoices: dependent,
  reconciliation_items: dependent,
  statement_schedules: tenant,
  statement_send_runs: tenant,
  statement_link_tokens: exclude("Bearer links must never be exported."),
  media_cleanup_runs: platform,
  system_settings: platform,
  installer_changelog: platform,
  installer_uploads: platform,
  lab_item_labels: tenant,
  subscriptions: exclude("Platform subscription billing, not lab clinical/accounting data."),
  subscription_events: exclude("Platform subscription processor events."),
  provider_auto_pay_attempts: exclude("Subscription/invoice retry workflow state can reference excluded platform subscriptions; persisted receipts and checkout evidence are included separately."),
  vendors: tenant,
  vendor_bills: tenant,
  vendor_bill_lines: dependent,
  vendor_credits: tenant,
  vendor_payments: tenant,
  vendor_payment_allocations: dependent,
  vendor_bill_events: tenant,
  reversed_invoice_settlements: tenant,
  invoice_accounting_events: tenant,
  vendor_types: tenant,
  backup_runs: platform,
  backup_live_status: platform,
  rx_practice_name_aliases: tenant,
  rx_doctor_practice_memory: tenant,
  ai_chat_history: personal,
  lab_locations: tenant,
  lab_vocabulary: tenant,
  lab_catalog_entries: tenant,
  ai_memory: tenant,
  lab_inbox_files: tenant,
  doctor_dup_dismissals: tenant,
  ai_memory_candidates: tenant,
  lab_closed_days: tenant,
  employee_vacation_balances: tenant,
  vacation_requests: tenant,
  vacation_request_days: dependent,
  employee_schedules: tenant,
  lab_permission_definitions: tenant,
  lab_member_permissions: dependent,
  quick_reference_notes: tenant,
  organization_additional_emails: tenant,
  doctor_profiles: tenant,
  doctor_phone_entries: dependent,
  doctor_email_entries: dependent,
  provider_messenger_threads: tenant,
  provider_messenger_messages: dependent,
  provider_messenger_read_watermarks: dependent,
  statement_payment_applications: dependent,
  customer_credits: tenant,
  customer_credit_applications: dependent,
  provider_autopay_authorizations: tenant,
  provider_autopay_authorization_requests: tenant,
  provider_autopay_authorization_labs: tenant,
  support_reports: tenant,
  lab_authorization_templates: tenant,
  support_report_attachments: dependent,
  subscription_receipts: exclude("Platform subscription payment evidence."),
  practice_authorization_documents: tenant,
  scan_jobs: tenant,
  scan_inputs: dependent,
  scan_input_chunks: dependent,
  scan_output_garbage: exclude("Cleanup queue for superseded blobs, not live attachments."),
  lab_documents: tenant,
  scan_outputs: dependent,
  saved_card_setup_analytics: platform,
};

export type MediaRule = {
  kind:
    | "case-media" | "invoice-media" | "filename" | "embedded" | "metadata" | "unsupported"
    // Private-media readers: each binds its key to the owning row's identity.
    | "authorization" | "legacy-evidence" | "autopay-signature" | "autopay-document"
    | "statement-pdf" | "statement-bundle" | "profile-photo" | "logo" | "support"
    | "scan-input" | "scan-chunk" | "scan-output" | "scan-document";
  reason: string;
};
const metadata: MediaRule = { kind: "metadata", reason: "Descriptive/structured values, not a blob locator." };
const embedded: MediaRule = { kind: "embedded", reason: "Extract embedded case-media references from the serialized value." };
const caseMedia: MediaRule = { kind: "case-media", reason: "Case-media locator; stage the referenced bytes." };
const filename: MediaRule = { kind: "filename", reason: "Authoritative case-media ledger filename." };

const privateMedia = (kind: MediaRule["kind"]): MediaRule => ({
  kind, reason: "Stage this scoped reference in its original storage namespace; reject missing, unsafe, foreign or ambiguous objects.",
});

const unattributedScanUpload: MediaRule = {
  kind: "unsupported",
  reason: "No LabTrax release has written scan_inputs.upload_path. A populated value is a server-local path that cannot be attributed to this lab's stored files, so the export stops instead of guessing.",
};
/** Every URL/path/blob locator and JSON column is reviewed, including metadata. */
export const LAB_BACKUP_MEDIA_RULES: Record<string, Record<string, MediaRule>> = {
  case_restorations: { assignment_provenance: metadata },
  case_saved_views: { filters: metadata },
  users: { email_preferences: metadata, sms_preferences: metadata, in_app_preferences: metadata, doctor_preferences: metadata, profile_photo_url: privateMedia("profile-photo") },
  lab_cases: { case_data: embedded, projected_summary: metadata },
  legacy_case_media: { file_name: filename },
  lab_pending_files: { file_url: caseMedia, file_name: metadata },
  organizations: { logo_url: privateMedia("logo"), invoice_template: embedded, invoice_template_presets: embedded, statement_template: embedded, case_print_template: embedded, correspondence_template: embedded },
  provider_account_change_requests: { changes_json: embedded, baseline_json: embedded },
  case_events: { metadata_json: embedded },
  case_attachments: { file_name: metadata, storage_key: caseMedia },
  case_submission_queue: { payload_json: embedded },
  invoices: { display_metadata_json: embedded },
  invoice_attachments: { file_name: metadata, storage_key: { kind: "invoice-media", reason: "Invoice-attachment locator; stage from uploads/invoice-attachments." } },
  practice_statements: { invoice_ids_json: metadata, invoice_amounts_json: metadata, invoice_details_json: embedded, pdf_storage_key: privateMedia("statement-pdf"), pdf_file_name: metadata, bundle_manifest_json: privateMedia("statement-bundle") },
  invoice_line_items: { source_restoration_ids_json: metadata },
  statement_payment_sessions: { customer_address_json: metadata },
  provider_payment_customers: { card_billing_address_json: metadata },
  provider_payment_checkouts: { checkout_url: metadata, inline_draft_json: embedded },
  pricing_tiers: { prices_json: metadata },
  pricing_overrides: { prices_json: metadata, discount_percents_json: metadata },
  audit_logs: { before_json: embedded, after_json: embedded, metadata_json: embedded },
  notifications: { data_json: embedded },
  bank_import_batches: { source_filename: metadata },
  bank_deposit_batch_members: { snapshot: metadata },
  statement_send_runs: { bundle_context_json: embedded, retry_scope_json: metadata },
  installer_changelog: { download_url: metadata },
  subscriptions: { provider_onboarding_json: metadata },
  subscription_events: { raw_payload_json: metadata },
  vendor_bill_events: { metadata_json: embedded, effective_lines_json: metadata },
  backup_runs: { path: metadata, file_name: metadata },
  backup_live_status: { metrics: metadata, archive_evidence: metadata },
  lab_inbox_files: { original_filename: metadata, storage_path: caseMedia, object_storage_key: caseMedia },
  doctor_dup_dismissals: { doctors_json: metadata },
  provider_messenger_messages: { formatting_json: metadata },
  provider_autopay_authorizations: { signature_object_key: privateMedia("autopay-signature"), document_object_key: privateMedia("autopay-document"), card_billing_address_json: metadata },
  provider_autopay_authorization_requests: { lab_organization_ids: metadata, card_billing_address_json: metadata },
  support_report_attachments: { filename: metadata, storage_key: privateMedia("support") },
  practice_authorization_documents: { original_filename: metadata, object_key: privateMedia("authorization"), legacy_evidence: privateMedia("legacy-evidence") },
  scan_jobs: { manifest_json: embedded, quality_json: metadata },
  scan_inputs: { file_name: metadata, storage_key: privateMedia("scan-input"), upload_path: unattributedScanUpload },
  scan_input_chunks: { storage_key: privateMedia("scan-chunk") },
  scan_output_garbage: { storage_key: metadata },
  lab_documents: { storage_key: privateMedia("scan-document") },
  scan_outputs: { storage_key: privateMedia("scan-output"), metadata_json: metadata },
};

export function isBackupMediaColumn(name: string, dataType?: string): boolean {
  return dataType === "json" ||
    /(?:url|path|storage.*key|object.*key|file_?name|filename|photo|image|logo|_json|case_data)$/i.test(name);
}

export function assertLabBackupCoverage(
  tables: Iterable<{ name: string; columns: Iterable<{ name: string; dataType?: string }> }>,
): void {
  const errors: string[] = [];
  for (const table of tables) {
    const rule = LAB_BACKUP_TABLE_RULES[table.name];
    if (!rule?.reason) errors.push(`Unclassified table: ${table.name}`);
    for (const column of table.columns) {
      if (isBackupMediaColumn(column.name, column.dataType) &&
          !LAB_BACKUP_MEDIA_RULES[table.name]?.[column.name]?.reason) {
        errors.push(`Unclassified media/JSON column: ${table.name}.${column.name}`);
      }
    }
  }
  if (errors.length) throw new Error(`Lab backup coverage contract failed:\n${errors.join("\n")}`);
}
