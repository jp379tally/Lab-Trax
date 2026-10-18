CREATE TABLE "account_link_invites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"new_user_id" varchar NOT NULL,
	"existing_user_id" varchar NOT NULL,
	"matched_on" text NOT NULL,
	"sent_to_phone" text,
	"sent_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"provider_message_id" text,
	"provider_error_code" text,
	"provider_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_chat_history" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"knowledge_section_ids" text[],
	"retention_disclaimer" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_memory" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "ai_memory_candidates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_user_id" varchar,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"organization_id" varchar,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"ip_address" text,
	"user_agent" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"triggered_by" text NOT NULL,
	"destination" text NOT NULL,
	"path" text,
	"file_name" text,
	"size_bytes" integer,
	"status" text DEFAULT 'success' NOT NULL,
	"error" text,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_file_count" integer,
	"attachment_row_count" integer
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"institution" text,
	"last4" text,
	"opening_balance" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"opening_date" timestamp with time zone DEFAULT now() NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"account_type" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"bank_account_id" varchar NOT NULL,
	"source_filename" text NOT NULL,
	"imported_by_user_id" varchar NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_invoices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_transaction_id" varchar NOT NULL,
	"invoice_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"bank_account_id" varchar NOT NULL,
	"txn_date" timestamp with time zone NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"check_number" text,
	"payee" text,
	"memo" text,
	"category_id" varchar,
	"debit_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"credit_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"net_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"cleared" boolean DEFAULT false NOT NULL,
	"cleared_at" timestamp with time zone,
	"reconciled" boolean DEFAULT false NOT NULL,
	"reconciliation_id" varchar,
	"status" text DEFAULT 'posted' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"recurring_rule_id" varchar,
	"vendor_id" varchar,
	"import_batch_id" text,
	"ai_import_source" text,
	"transfer_group_id" varchar,
	"created_by_user_id" varchar,
	"deposited_by_user_id" varchar,
	"deposited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "case_attachments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar,
	"lab_case_id" varchar,
	"uploaded_by_user_id" varchar NOT NULL,
	"uploaded_by_organization_id" varchar NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_type" text NOT NULL,
	"visibility" text DEFAULT 'internal_lab_only' NOT NULL,
	"note" text,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" varchar,
	"actor_organization_id" varchar,
	"actor_initials" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar NOT NULL,
	"location_code" text NOT NULL,
	"location_name" text NOT NULL,
	"moved_by_user_id" varchar NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar NOT NULL,
	"author_user_id" varchar NOT NULL,
	"author_organization_id" varchar NOT NULL,
	"note_text" text NOT NULL,
	"visibility" text DEFAULT 'internal_lab_only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_restorations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar NOT NULL,
	"tooth_number" text NOT NULL,
	"restoration_type" text NOT NULL,
	"restoration_subtype" text,
	"material" text,
	"shade" text,
	"notes" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"price_source" text,
	"price_source_id" varchar,
	"price_source_name" text,
	"price_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_submission_queue" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar NOT NULL,
	"submitted_by_user_id" varchar NOT NULL,
	"submitted_by_organization_id" varchar NOT NULL,
	"submission_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" text NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"provider_organization_id" varchar NOT NULL,
	"patient_first_name" text NOT NULL,
	"patient_last_name" text NOT NULL,
	"external_patient_id" text,
	"doctor_name" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" timestamp with time zone,
	"due_time" text,
	"expected_delivery_date" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar,
	"needs_ai_review" boolean DEFAULT false NOT NULL,
	"ai_import_source" text,
	"remake_of_case_id" varchar,
	"remake_reason" text,
	"remake_charged" boolean,
	"remake_reason_key" varchar,
	"remake_shade_lightness" varchar,
	"remake_shade_prescribed" varchar,
	"remake_shade_provided" varchar,
	"remake_material_prescribed" varchar,
	"remake_material_provided" varchar,
	"remake_returned_to_lab" boolean,
	"remake_category" varchar,
	"remake_notes" text,
	"suggested_doctor_name" text,
	"suggested_provider_org_id" varchar,
	"case_pan_barcode" text,
	"bridge_connectors" text,
	"delivery_date_proposal_date" timestamp with time zone,
	"delivery_date_proposal_note" text,
	"rx_notes" text,
	"shade" text,
	"step" text,
	"step_shade" text,
	"gingivial_shade" text,
	"is_custom_shade" boolean DEFAULT false,
	"custom_shade_technician" varchar,
	"custom_shade_pictures_available" boolean DEFAULT false,
	"custom_shade_video_available" boolean DEFAULT false,
	"lab_location_id" varchar
);
--> statement-breakpoint
CREATE TABLE "doctor_account_links" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id_low" varchar NOT NULL,
	"user_id_high" varchar NOT NULL,
	"linked_via" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_dup_dismissals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"cluster_key" text NOT NULL,
	"doctors_json" jsonb NOT NULL,
	"dismissed_by_user_id" varchar NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_email_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_profile_id" varchar NOT NULL,
	"email" text NOT NULL,
	"label" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_phone_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_profile_id" varchar NOT NULL,
	"phone_number" text NOT NULL,
	"label" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"doctor_name" text NOT NULL,
	"provider_organization_id" varchar,
	"display_name" text,
	"preferences" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_schedules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"schedule_type" text DEFAULT 'recurring' NOT NULL,
	"day_of_week" integer,
	"date" text,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_vacation_balances" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"year" integer NOT NULL,
	"annual_vacation_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"used_vacation_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"pending_vacation_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installer_changelog" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"download_url" text NOT NULL,
	"version" text,
	"release_notes" text,
	"saved_by_user_id" varchar,
	"saved_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installer_uploads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"size_bytes" integer NOT NULL,
	"version" text,
	"checksum_sha256" text,
	"uploaded_by_user_id" varchar,
	"uploaded_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_attachments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" varchar NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"include_in_pdf" boolean DEFAULT false NOT NULL,
	"uploaded_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "invoice_credits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" varchar NOT NULL,
	"provider_organization_id" varchar,
	"lab_organization_id" varchar NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" varchar,
	"note" text,
	"applied_by_user_id" varchar NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" varchar NOT NULL,
	"case_restoration_id" varchar,
	"parent_line_item_id" varchar,
	"tooth_number" integer,
	"tooth_label" varchar,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"line_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"case_id" varchar,
	"lab_organization_id" varchar NOT NULL,
	"provider_organization_id" varchar,
	"status" text DEFAULT 'open' NOT NULL,
	"subtotal" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"tax" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"discount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"balance_due" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"notes" text,
	"display_metadata_json" jsonb,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"ai_pricing_warning" text,
	"ai_reviewed_at" timestamp with time zone,
	"ai_reviewed_by_user_id" varchar,
	"layout_preset_id" varchar,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" varchar,
	"void_reason" text,
	"void_kind" text,
	"source_invoice_id" varchar,
	"frozen" boolean DEFAULT false NOT NULL,
	"case_deleted_at" timestamp with time zone,
	"case_deleted_by_user_id" varchar,
	"case_deleted_note" text,
	"created_by_user_id" varchar NOT NULL,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "itero_import_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"imported_by_user_id" varchar,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"deduped_count" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"case_ids" text[],
	"batch_id" text
);
--> statement-breakpoint
CREATE TABLE "itero_imported_orders" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"itero_order_id" text NOT NULL,
	"created_case_id" varchar,
	"imported_by_user_id" varchar,
	"batch_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_cases" (
	"id" varchar PRIMARY KEY NOT NULL,
	"owner_id" varchar NOT NULL,
	"organization_id" varchar,
	"case_data" text NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"deleted_at" timestamp,
	"deleted_by" varchar
);
--> statement-breakpoint
CREATE TABLE "lab_catalog_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"entry_type" text NOT NULL,
	"case_type" text NOT NULL,
	"parent_key" text DEFAULT '' NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"is_custom" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"price_key_override" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_closed_days" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"date" text NOT NULL,
	"note" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_inbox_files" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"uploaded_by_user_id" varchar NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"storage_path" text,
	"object_storage_key" text,
	"note" text,
	"linked_case_ids" text,
	"assigned_at" timestamp with time zone,
	"assigned_to_case_id" varchar,
	"assigned_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_item_labels" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"price_key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_member_permissions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" varchar NOT NULL,
	"permission_definition_id" varchar NOT NULL,
	"granted_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_pending_file_note_edits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pending_file_id" varchar NOT NULL,
	"editor_user_id" varchar NOT NULL,
	"editor_name" text,
	"old_notes" text,
	"new_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_pending_files" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"uploader_user_id" varchar NOT NULL,
	"uploader_name" text,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"notes" text,
	"notes_updated_at" timestamp with time zone,
	"notes_edited_by_user_id" varchar,
	"notes_edited_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_permission_definitions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"capability_key" text NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_unassigned_doctors" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"removed_from_organization_id" varchar NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lab_vocabulary" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_case_media" (
	"file_name" varchar PRIMARY KEY NOT NULL,
	"lab_case_id" varchar NOT NULL,
	"organization_id" varchar,
	"owner_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_cleanup_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error_message" text,
	"scanned_files" integer DEFAULT 0 NOT NULL,
	"referenced_files" integer DEFAULT 0 NOT NULL,
	"orphan_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"freed_bytes" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data_json" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_additional_emails" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"email" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_connections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"provider_organization_id" varchar NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tier_name" text,
	"requested_by_org_id" varchar NOT NULL,
	"requested_by_user_id" varchar NOT NULL,
	"approved_by_user_id" varchar,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_invites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"email" text,
	"phone" text,
	"role_to_assign" text,
	"token" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" varchar,
	"expires_at" timestamp with time zone,
	"accepted_by_user_id" varchar,
	"accepted_at" timestamp with time zone,
	"last_email_attempt_at" timestamp with time zone,
	"last_email_status" text,
	"last_email_error" text,
	"email_retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "join_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"requested_role" text NOT NULL,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_memberships" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by_user_id" varchar,
	"approved_by_user_id" varchar,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"billing_email" text,
	"phone" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"state" text,
	"zip" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"default_bank_account_id" varchar,
	"logo_url" text,
	"logo_placements" text[],
	"logo_pdf_size" text,
	"invoice_template" jsonb,
	"invoice_template_presets" jsonb,
	"statement_template" jsonb,
	"case_print_template" jsonb,
	"correspondence_template" jsonb,
	"parent_lab_organization_id" varchar,
	"account_number" text,
	"platform_account_number" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_email_opt_out" boolean DEFAULT false NOT NULL,
	"duplicate_suggestion_threshold" numeric(4, 3),
	"default_case_due_days" integer,
	"cap_case_due_to_default" boolean,
	"invoice_due_day_of_month" integer,
	"auto_add_alloy_on_pfm" boolean DEFAULT false NOT NULL,
	"license_number" text,
	"default_doctor_tier_name" text,
	"revenue_target_low" integer,
	"revenue_target_high" integer,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" varchar NOT NULL,
	"bank_transaction_id" varchar,
	"amount" numeric(10, 2) NOT NULL,
	"payment_method" text NOT NULL,
	"reference_number" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_account_sequences" (
	"year" integer NOT NULL,
	"entity_type" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_statement_sends" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" varchar NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"error_message" text,
	"sent_by_user_id" varchar DEFAULT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_statements" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"provider_organization_id" varchar NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"total_billed" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_paid" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"balance_due" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"invoice_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pdf_storage_key" text,
	"pdf_file_name" text,
	"pdf_file_size" integer,
	"created_by_user_id" varchar DEFAULT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"doctor_name" text NOT NULL,
	"practice_name" text,
	"provider_organization_id" varchar,
	"tier_name" text,
	"prices_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discount_percent" numeric(5, 2),
	"discount_percents_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "pricing_tiers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"prices_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "provider_messenger_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"sender_user_id" varchar NOT NULL,
	"body" text NOT NULL,
	"formatting_json" jsonb,
	"media_key" text,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_messenger_read_watermarks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"last_read_message_id" varchar,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_messenger_threads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_organization_id" varchar NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_reference_notes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"body" text NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" varchar NOT NULL,
	"transaction_id" varchar NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"bank_account_id" varchar NOT NULL,
	"statement_date" timestamp with time zone NOT NULL,
	"starting_balance" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"ending_balance" numeric(14, 2) NOT NULL,
	"cleared_total" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"difference" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"bank_account_id" varchar NOT NULL,
	"name" text NOT NULL,
	"payee" text,
	"vendor_id" varchar,
	"memo" text,
	"category_id" varchar,
	"direction" text NOT NULL,
	"amount" numeric(14, 2),
	"estimate_method" text DEFAULT 'fixed' NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"start_date" timestamp with time zone DEFAULT now() NOT NULL,
	"end_date" timestamp with time zone,
	"auto_create" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_generated_for" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rx_practice_name_aliases" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"rx_name" text NOT NULL,
	"provider_organization_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "statement_link_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" varchar NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_key" text NOT NULL,
	"practice_organization_id" varchar,
	"practice_name" text NOT NULL,
	"invoice_scope" text NOT NULL,
	"custom_from" timestamp with time zone,
	"custom_to" timestamp with time zone,
	"period_label" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_link_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "statement_schedules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"email_subject" text,
	"email_body" text,
	"email_reply_to" text,
	"included_org_ids" text[],
	"last_sent_for_month" text,
	"last_run_at" timestamp with time zone,
	"in_progress_for_month" text,
	"in_progress_leased_at" timestamp with time zone,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_send_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"practice_organization_id" varchar,
	"practice_name" text NOT NULL,
	"practice_email" text,
	"period_month" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"total_billed" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"open_balance" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"triggered_by" text NOT NULL,
	"triggered_by_user_id" varchar,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" varchar,
	"subject_type" text,
	"subject_id" varchar,
	"event_type" text NOT NULL,
	"provider" text,
	"external_event_id" text,
	"status_before" text,
	"status_after" text,
	"raw_payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" varchar NOT NULL,
	"provider" text DEFAULT 'none' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"revenue_cat_app_user_id" text,
	"status" text DEFAULT 'trialing' NOT NULL,
	"trial_start_at" timestamp with time zone,
	"trial_end_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"payment_method_on_file" boolean DEFAULT false NOT NULL,
	"last_reminder_sent_at" timestamp with time zone,
	"last_reminder_kind" text,
	"grace_period_start_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"stripe_price_id" text,
	"plan_type" text,
	"billing_interval" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_categories" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'expense' NOT NULL,
	"color" text,
	"description" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"category_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text,
	"device_name" text,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"email" text,
	"phone" text,
	"first_name" text,
	"last_name" text,
	"initials" text,
	"user_type" text DEFAULT 'lab',
	"role" text DEFAULT 'user',
	"is_active" boolean DEFAULT true NOT NULL,
	"license_number" text,
	"practice_name" text,
	"doctor_name" text,
	"practice_address" text,
	"practice_phone" text,
	"phone_contact_name" text,
	"account_number" text,
	"platform_account_number" text,
	"wants_updates" boolean DEFAULT false,
	"last_login_at" timestamp with time zone,
	"work_status" text DEFAULT 'available',
	"email_preferences" jsonb,
	"sms_preferences" jsonb,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"profile_photo_url" text,
	"created_at" timestamp DEFAULT now(),
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "vacation_request_days" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar NOT NULL,
	"date" text NOT NULL,
	"is_all_day" boolean DEFAULT true NOT NULL,
	"start_time" text,
	"end_time" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacation_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"total_requested_hours" numeric(8, 2) NOT NULL,
	"reason" text,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_decision_note" text,
	"approved_by_user_id" varchar,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_types" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"builtin_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"zip" text,
	"phone" text,
	"email" text,
	"website" text,
	"notes" text,
	"unit_price" numeric(10, 2),
	"item_category" text,
	"vendor_type" text DEFAULT 'vendor' NOT NULL,
	"vendor_type_id" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_link_invites" ADD CONSTRAINT "account_link_invites_new_user_id_users_id_fk" FOREIGN KEY ("new_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link_invites" ADD CONSTRAINT "account_link_invites_existing_user_id_users_id_fk" FOREIGN KEY ("existing_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_history" ADD CONSTRAINT "ai_chat_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_candidates" ADD CONSTRAINT "ai_memory_candidates_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_candidates" ADD CONSTRAINT "ai_memory_candidates_source_user_id_users_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_candidates" ADD CONSTRAINT "ai_memory_candidates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_invoices" ADD CONSTRAINT "bank_transaction_invoices_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_invoices" ADD CONSTRAINT "bank_transaction_invoices_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_category_id_transaction_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."transaction_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_recurring_rule_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_rule_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_batch_id_bank_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."bank_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_deposited_by_user_id_users_id_fk" FOREIGN KEY ("deposited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_lab_case_id_lab_cases_id_fk" FOREIGN KEY ("lab_case_id") REFERENCES "public"."lab_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_uploaded_by_organization_id_organizations_id_fk" FOREIGN KEY ("uploaded_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_organization_id_organizations_id_fk" FOREIGN KEY ("actor_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_locations" ADD CONSTRAINT "case_locations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_locations" ADD CONSTRAINT "case_locations_moved_by_user_id_users_id_fk" FOREIGN KEY ("moved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_author_organization_id_organizations_id_fk" FOREIGN KEY ("author_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_restorations" ADD CONSTRAINT "case_restorations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_submission_queue" ADD CONSTRAINT "case_submission_queue_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_submission_queue" ADD CONSTRAINT "case_submission_queue_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_submission_queue" ADD CONSTRAINT "case_submission_queue_submitted_by_organization_id_organizations_id_fk" FOREIGN KEY ("submitted_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_submission_queue" ADD CONSTRAINT "case_submission_queue_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_suggested_provider_org_id_organizations_id_fk" FOREIGN KEY ("suggested_provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_lab_location_id_lab_locations_id_fk" FOREIGN KEY ("lab_location_id") REFERENCES "public"."lab_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_account_links" ADD CONSTRAINT "doctor_account_links_user_id_low_users_id_fk" FOREIGN KEY ("user_id_low") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_account_links" ADD CONSTRAINT "doctor_account_links_user_id_high_users_id_fk" FOREIGN KEY ("user_id_high") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_dup_dismissals" ADD CONSTRAINT "doctor_dup_dismissals_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_dup_dismissals" ADD CONSTRAINT "doctor_dup_dismissals_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_email_entries" ADD CONSTRAINT "doctor_email_entries_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_phone_entries" ADD CONSTRAINT "doctor_phone_entries_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacation_balances" ADD CONSTRAINT "employee_vacation_balances_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacation_balances" ADD CONSTRAINT "employee_vacation_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installer_changelog" ADD CONSTRAINT "installer_changelog_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installer_uploads" ADD CONSTRAINT "installer_uploads_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_case_restoration_id_case_restorations_id_fk" FOREIGN KEY ("case_restoration_id") REFERENCES "public"."case_restorations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_parent_line_item_id_invoice_line_items_id_fk" FOREIGN KEY ("parent_line_item_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ai_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("ai_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_case_deleted_by_user_id_users_id_fk" FOREIGN KEY ("case_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itero_import_sessions" ADD CONSTRAINT "itero_import_sessions_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itero_import_sessions" ADD CONSTRAINT "itero_import_sessions_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itero_imported_orders" ADD CONSTRAINT "itero_imported_orders_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itero_imported_orders" ADD CONSTRAINT "itero_imported_orders_created_case_id_cases_id_fk" FOREIGN KEY ("created_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itero_imported_orders" ADD CONSTRAINT "itero_imported_orders_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_catalog_entries" ADD CONSTRAINT "lab_catalog_entries_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_catalog_entries" ADD CONSTRAINT "lab_catalog_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_closed_days" ADD CONSTRAINT "lab_closed_days_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_closed_days" ADD CONSTRAINT "lab_closed_days_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_inbox_files" ADD CONSTRAINT "lab_inbox_files_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_inbox_files" ADD CONSTRAINT "lab_inbox_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_inbox_files" ADD CONSTRAINT "lab_inbox_files_assigned_to_case_id_cases_id_fk" FOREIGN KEY ("assigned_to_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_inbox_files" ADD CONSTRAINT "lab_inbox_files_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_item_labels" ADD CONSTRAINT "lab_item_labels_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_locations" ADD CONSTRAINT "lab_locations_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_member_permissions" ADD CONSTRAINT "lab_member_permissions_membership_id_lab_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."lab_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_member_permissions" ADD CONSTRAINT "lab_member_permissions_permission_definition_id_lab_permission_definitions_id_fk" FOREIGN KEY ("permission_definition_id") REFERENCES "public"."lab_permission_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_member_permissions" ADD CONSTRAINT "lab_member_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_permission_definitions" ADD CONSTRAINT "lab_permission_definitions_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_permission_definitions" ADD CONSTRAINT "lab_permission_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_unassigned_doctors" ADD CONSTRAINT "lab_unassigned_doctors_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_unassigned_doctors" ADD CONSTRAINT "lab_unassigned_doctors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_unassigned_doctors" ADD CONSTRAINT "lab_unassigned_doctors_removed_from_organization_id_organizations_id_fk" FOREIGN KEY ("removed_from_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_unassigned_doctors" ADD CONSTRAINT "lab_unassigned_doctors_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_vocabulary" ADD CONSTRAINT "lab_vocabulary_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_vocabulary" ADD CONSTRAINT "lab_vocabulary_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_additional_emails" ADD CONSTRAINT "organization_additional_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_connections" ADD CONSTRAINT "organization_connections_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_connections" ADD CONSTRAINT "organization_connections_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_connections" ADD CONSTRAINT "organization_connections_requested_by_org_id_organizations_id_fk" FOREIGN KEY ("requested_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_connections" ADD CONSTRAINT "organization_connections_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_connections" ADD CONSTRAINT "organization_connections_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_invites" ADD CONSTRAINT "lab_invites_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_invites" ADD CONSTRAINT "lab_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_invites" ADD CONSTRAINT "lab_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_memberships" ADD CONSTRAINT "lab_memberships_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_memberships" ADD CONSTRAINT "lab_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_memberships" ADD CONSTRAINT "lab_memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_memberships" ADD CONSTRAINT "lab_memberships_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_memberships" ADD CONSTRAINT "lab_memberships_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_statement_sends" ADD CONSTRAINT "practice_statement_sends_statement_id_practice_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."practice_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_statement_sends" ADD CONSTRAINT "practice_statement_sends_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_statements" ADD CONSTRAINT "practice_statements_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_statements" ADD CONSTRAINT "practice_statements_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_statements" ADD CONSTRAINT "practice_statements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_overrides" ADD CONSTRAINT "pricing_overrides_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_overrides" ADD CONSTRAINT "pricing_overrides_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_overrides" ADD CONSTRAINT "pricing_overrides_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_overrides" ADD CONSTRAINT "pricing_overrides_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_tiers" ADD CONSTRAINT "pricing_tiers_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_tiers" ADD CONSTRAINT "pricing_tiers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_tiers" ADD CONSTRAINT "pricing_tiers_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_messages" ADD CONSTRAINT "provider_messenger_messages_thread_id_provider_messenger_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."provider_messenger_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_messages" ADD CONSTRAINT "provider_messenger_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_read_watermarks" ADD CONSTRAINT "provider_messenger_read_watermarks_thread_id_provider_messenger_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."provider_messenger_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_read_watermarks" ADD CONSTRAINT "provider_messenger_read_watermarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_read_watermarks" ADD CONSTRAINT "provider_messenger_read_watermarks_last_read_message_id_provider_messenger_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."provider_messenger_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_threads" ADD CONSTRAINT "provider_messenger_threads_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_messenger_threads" ADD CONSTRAINT "provider_messenger_threads_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_reference_notes" ADD CONSTRAINT "quick_reference_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_category_id_transaction_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."transaction_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_practice_name_aliases" ADD CONSTRAINT "rx_practice_name_aliases_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_practice_name_aliases" ADD CONSTRAINT "rx_practice_name_aliases_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_practice_name_aliases" ADD CONSTRAINT "rx_practice_name_aliases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_link_tokens" ADD CONSTRAINT "statement_link_tokens_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_link_tokens" ADD CONSTRAINT "statement_link_tokens_practice_organization_id_organizations_id_fk" FOREIGN KEY ("practice_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_schedules" ADD CONSTRAINT "statement_schedules_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_schedules" ADD CONSTRAINT "statement_schedules_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_send_runs" ADD CONSTRAINT "statement_send_runs_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_send_runs" ADD CONSTRAINT "statement_send_runs_practice_organization_id_organizations_id_fk" FOREIGN KEY ("practice_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_send_runs" ADD CONSTRAINT "statement_send_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categories" ADD CONSTRAINT "transaction_categories_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_request_days" ADD CONSTRAINT "vacation_request_days_request_id_vacation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."vacation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_lab_id_organizations_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_types" ADD CONSTRAINT "vendor_types_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_lab_organization_id_organizations_id_fk" FOREIGN KEY ("lab_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_vendor_type_id_vendor_types_id_fk" FOREIGN KEY ("vendor_type_id") REFERENCES "public"."vendor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_link_invites_pair_unique" ON "account_link_invites" USING btree ("new_user_id","existing_user_id");--> statement-breakpoint
CREATE INDEX "account_link_invites_pending_phone_idx" ON "account_link_invites" USING btree ("sent_to_phone","status");--> statement-breakpoint
CREATE INDEX "ai_chat_history_user_idx" ON "ai_chat_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_chat_history_user_created_idx" ON "ai_chat_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_memory_org_kind_idx" ON "ai_memory" USING btree ("lab_organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memory_org_kind_key_uniq" ON "ai_memory" USING btree ("lab_organization_id","kind","key");--> statement-breakpoint
CREATE INDEX "ai_memory_candidates_org_status_idx" ON "ai_memory_candidates" USING btree ("lab_organization_id","status");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backup_runs_completed_at_idx" ON "backup_runs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "bank_accounts_lab_idx" ON "bank_accounts" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "bank_import_batches_org_idx" ON "bank_import_batches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_import_batches_account_idx" ON "bank_import_batches" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transaction_invoices_unique" ON "bank_transaction_invoices" USING btree ("bank_transaction_id","invoice_id");--> statement-breakpoint
CREATE INDEX "bank_transaction_invoices_invoice_idx" ON "bank_transaction_invoices" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_lab_idx" ON "bank_transactions" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_account_idx" ON "bank_transactions" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_date_idx" ON "bank_transactions" USING btree ("txn_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_transfer_idx" ON "bank_transactions" USING btree ("transfer_group_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_deleted_at_idx" ON "bank_transactions" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "case_events_case_idx" ON "case_events" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_case_number_unique" ON "cases" USING btree ("case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_barcode_unique_per_lab" ON "cases" USING btree ("lab_organization_id","case_pan_barcode") WHERE deleted_at IS NULL AND case_pan_barcode IS NOT NULL AND status <> 'complete';--> statement-breakpoint
CREATE INDEX "cases_deleted_at_idx" ON "cases" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "cases_lab_idx" ON "cases" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "cases_provider_idx" ON "cases" USING btree ("provider_organization_id");--> statement-breakpoint
CREATE INDEX "cases_remake_of_idx" ON "cases" USING btree ("remake_of_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_account_links_pair_unique" ON "doctor_account_links" USING btree ("user_id_low","user_id_high");--> statement-breakpoint
CREATE INDEX "doctor_account_links_low_idx" ON "doctor_account_links" USING btree ("user_id_low");--> statement-breakpoint
CREATE INDEX "doctor_account_links_high_idx" ON "doctor_account_links" USING btree ("user_id_high");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_dup_dismissals_lab_cluster_unique" ON "doctor_dup_dismissals" USING btree ("lab_organization_id","cluster_key");--> statement-breakpoint
CREATE INDEX "doctor_dup_dismissals_lab_idx" ON "doctor_dup_dismissals" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "doctor_email_entries_profile_idx" ON "doctor_email_entries" USING btree ("doctor_profile_id");--> statement-breakpoint
CREATE INDEX "doctor_phone_entries_profile_idx" ON "doctor_phone_entries" USING btree ("doctor_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profiles_lab_doctor_provider_unique" ON "doctor_profiles" USING btree ("lab_organization_id","doctor_name","provider_organization_id") WHERE provider_organization_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profiles_lab_doctor_null_provider_unique" ON "doctor_profiles" USING btree ("lab_organization_id","doctor_name") WHERE provider_organization_id IS NULL;--> statement-breakpoint
CREATE INDEX "doctor_profiles_lab_idx" ON "doctor_profiles" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "employee_schedules_lab_user_idx" ON "employee_schedules" USING btree ("lab_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_vacation_balances_lab_user_year" ON "employee_vacation_balances" USING btree ("lab_id","user_id","year");--> statement-breakpoint
CREATE INDEX "employee_vacation_balances_lab_user_idx" ON "employee_vacation_balances" USING btree ("lab_id","user_id");--> statement-breakpoint
CREATE INDEX "installer_changelog_created_at_idx" ON "installer_changelog" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "installer_uploads_created_at_idx" ON "installer_uploads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoice_attachments_invoice_idx" ON "invoice_attachments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_credits_invoice_idx" ON "invoice_credits" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_credits_provider_idx" ON "invoice_credits" USING btree ("provider_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_invoice_number_unique" ON "invoices" USING btree ("lab_organization_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_deleted_at_idx" ON "invoices" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "invoices_provider_org_idx" ON "invoices" USING btree ("provider_organization_id");--> statement-breakpoint
CREATE INDEX "invoices_lab_org_idx" ON "invoices" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "invoices_ai_generated_idx" ON "invoices" USING btree ("ai_generated");--> statement-breakpoint
CREATE UNIQUE INDEX "itero_imported_orders_unique" ON "itero_imported_orders" USING btree ("lab_organization_id","itero_order_id");--> statement-breakpoint
CREATE INDEX "lab_catalog_entries_lab_type_idx" ON "lab_catalog_entries" USING btree ("lab_organization_id","entry_type");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_catalog_entries_natural_key_uniq" ON "lab_catalog_entries" USING btree ("lab_organization_id","entry_type","case_type","parent_key","key");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_closed_days_lab_date_uniq" ON "lab_closed_days" USING btree ("lab_organization_id","date");--> statement-breakpoint
CREATE INDEX "lab_closed_days_lab_idx" ON "lab_closed_days" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "lab_inbox_files_lab_idx" ON "lab_inbox_files" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "lab_inbox_files_unassigned_idx" ON "lab_inbox_files" USING btree ("lab_organization_id","assigned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_item_labels_lab_price_key_unique" ON "lab_item_labels" USING btree ("lab_organization_id","price_key");--> statement-breakpoint
CREATE INDEX "lab_item_labels_lab_idx" ON "lab_item_labels" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "lab_locations_org_idx" ON "lab_locations" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_locations_org_code_uniq" ON "lab_locations" USING btree ("lab_organization_id","code");--> statement-breakpoint
CREATE INDEX "lab_member_permissions_membership_idx" ON "lab_member_permissions" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "lab_member_permissions_perm_def_idx" ON "lab_member_permissions" USING btree ("permission_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_member_permissions_unique_assignment" ON "lab_member_permissions" USING btree ("membership_id","permission_definition_id");--> statement-breakpoint
CREATE INDEX "lab_pending_file_note_edits_file_idx" ON "lab_pending_file_note_edits" USING btree ("pending_file_id");--> statement-breakpoint
CREATE INDEX "lab_pending_files_org_idx" ON "lab_pending_files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lab_permission_definitions_lab_idx" ON "lab_permission_definitions" USING btree ("lab_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_unassigned_doctors_unique" ON "lab_unassigned_doctors" USING btree ("lab_organization_id","user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "lab_unassigned_doctors_lab_idx" ON "lab_unassigned_doctors" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "lab_unassigned_doctors_user_idx" ON "lab_unassigned_doctors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "lab_vocabulary_org_kind_idx" ON "lab_vocabulary" USING btree ("lab_organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_vocabulary_org_kind_value_uniq" ON "lab_vocabulary" USING btree ("lab_organization_id","kind","value");--> statement-breakpoint
CREATE INDEX "legacy_case_media_lab_case_idx" ON "legacy_case_media" USING btree ("lab_case_id");--> statement-breakpoint
CREATE INDEX "legacy_case_media_org_idx" ON "legacy_case_media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "media_cleanup_runs_started_at_idx" ON "media_cleanup_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_cleanup_runs_one_running_idx" ON "media_cleanup_runs" USING btree ("status") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "organization_additional_emails_org_idx" ON "organization_additional_emails" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_connections_unique" ON "organization_connections" USING btree ("lab_organization_id","provider_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_invites_token_unique" ON "lab_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_unique" ON "join_requests" USING btree ("lab_id","user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_unique" ON "lab_memberships" USING btree ("lab_id","user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "lab_memberships" USING btree ("lab_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "lab_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_platform_account_number_unique" ON "organizations" USING btree ("platform_account_number") WHERE platform_account_number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_account_sequences_pk" ON "platform_account_sequences" USING btree ("year","entity_type");--> statement-breakpoint
CREATE INDEX "practice_statement_sends_statement_idx" ON "practice_statement_sends" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "practice_statements_provider_idx" ON "practice_statements" USING btree ("provider_organization_id");--> statement-breakpoint
CREATE INDEX "practice_statements_lab_idx" ON "practice_statements" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "pricing_overrides_lab_idx" ON "pricing_overrides" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_overrides_lab_doctor_unique" ON "pricing_overrides" USING btree ("lab_organization_id","doctor_name","provider_organization_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "pricing_overrides_deleted_at_idx" ON "pricing_overrides" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "pricing_tiers_lab_idx" ON "pricing_tiers" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_tiers_lab_name_unique" ON "pricing_tiers" USING btree ("lab_organization_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "pricing_tiers_deleted_at_idx" ON "pricing_tiers" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "provider_messenger_messages_thread_idx" ON "provider_messenger_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "provider_messenger_messages_thread_created_idx" ON "provider_messenger_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_messenger_read_watermarks_thread_user_unique" ON "provider_messenger_read_watermarks" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX "provider_messenger_read_watermarks_user_idx" ON "provider_messenger_read_watermarks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_messenger_threads_pair_unique" ON "provider_messenger_threads" USING btree ("provider_organization_id","lab_organization_id");--> statement-breakpoint
CREATE INDEX "provider_messenger_threads_lab_idx" ON "provider_messenger_threads" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "provider_messenger_threads_provider_idx" ON "provider_messenger_threads" USING btree ("provider_organization_id");--> statement-breakpoint
CREATE INDEX "quick_reference_notes_org_idx" ON "quick_reference_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_items_unique" ON "reconciliation_items" USING btree ("reconciliation_id","transaction_id");--> statement-breakpoint
CREATE INDEX "reconciliations_lab_idx" ON "reconciliations" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "reconciliations_account_idx" ON "reconciliations" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "recurring_transactions_lab_idx" ON "recurring_transactions" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rx_practice_name_aliases_lab_rx_name_unique" ON "rx_practice_name_aliases" USING btree ("lab_organization_id","rx_name");--> statement-breakpoint
CREATE INDEX "rx_practice_name_aliases_lab_idx" ON "rx_practice_name_aliases" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_link_tokens_token_idx" ON "statement_link_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "statement_link_tokens_expires_idx" ON "statement_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_schedules_org_unique" ON "statement_schedules" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "statement_send_runs_lab_idx" ON "statement_send_runs" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "statement_send_runs_lab_period_idx" ON "statement_send_runs" USING btree ("lab_organization_id","period_month");--> statement-breakpoint
CREATE INDEX "statement_send_runs_next_attempt_idx" ON "statement_send_runs" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "subscription_events_sub_idx" ON "subscription_events" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_events_subject_idx" ON "subscription_events" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subscription_events_event_type_idx" ON "subscription_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "subscription_events_created_at_idx" ON "subscription_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_events_external_event_unique" ON "subscription_events" USING btree ("provider","external_event_id") WHERE external_event_id IS NOT NULL AND provider IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_subject_unique" ON "subscriptions" USING btree ("subject_type","subject_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_stripe_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_stripe_sub_idx" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_rc_user_idx" ON "subscriptions" USING btree ("revenue_cat_app_user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscriptions_trial_end_idx" ON "subscriptions" USING btree ("trial_end_at");--> statement-breakpoint
CREATE INDEX "transaction_categories_lab_idx" ON "transaction_categories" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_categories_unique" ON "transaction_categories" USING btree ("lab_organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_platform_account_number_unique" ON "users" USING btree ("platform_account_number") WHERE platform_account_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vacation_request_days_request_idx" ON "vacation_request_days" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "vacation_requests_lab_status_idx" ON "vacation_requests" USING btree ("lab_id","status");--> statement-breakpoint
CREATE INDEX "vacation_requests_lab_user_idx" ON "vacation_requests" USING btree ("lab_id","user_id");--> statement-breakpoint
CREATE INDEX "vendor_types_lab_idx" ON "vendor_types" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_types_lab_name_unique" ON "vendor_types" USING btree ("lab_organization_id",lower("name")) WHERE "vendor_types"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_types_lab_builtin_kind_unique" ON "vendor_types" USING btree ("lab_organization_id","builtin_kind") WHERE "vendor_types"."builtin_kind" IS NOT NULL AND "vendor_types"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "vendors_lab_idx" ON "vendors" USING btree ("lab_organization_id");--> statement-breakpoint
CREATE INDEX "vendors_vendor_type_idx" ON "vendors" USING btree ("vendor_type_id");--> statement-breakpoint
CREATE INDEX "verification_codes_target_channel_idx" ON "verification_codes" USING btree ("target","channel");--> statement-breakpoint
CREATE INDEX "verification_codes_user_idx" ON "verification_codes" USING btree ("user_id");