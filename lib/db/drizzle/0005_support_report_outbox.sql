CREATE TABLE "support_reports" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "reporter_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "idempotency_key" varchar(128),
 "portal" text NOT NULL, "description" text NOT NULL, "reporter_email" text,
 "owner_email" text, "owner_status" text DEFAULT 'pending' NOT NULL,
 "copy_status" text DEFAULT 'not_applicable' NOT NULL, "owner_attempts" integer DEFAULT 0 NOT NULL,
 "copy_attempts" integer DEFAULT 0 NOT NULL, "owner_next_attempt_at" timestamptz DEFAULT now() NOT NULL,
 "copy_next_attempt_at" timestamptz, "owner_claimed_at" timestamptz, "copy_claimed_at" timestamptz,
 "owner_failure_reason" text, "copy_failure_reason" text, "created_at" timestamptz DEFAULT now() NOT NULL,
 "expires_at" timestamptz NOT NULL, "deleted_at" timestamptz,
 CONSTRAINT "support_reports_portal_check" CHECK ("portal" IN ('lab', 'provider')),
 CONSTRAINT "support_reports_owner_status_check" CHECK ("owner_status" IN ('persisting', 'pending', 'in_flight', 'send_failed', 'sent', 'permanent_failed', 'not_applicable')),
 CONSTRAINT "support_reports_copy_status_check" CHECK ("copy_status" IN ('persisting', 'pending', 'in_flight', 'send_failed', 'sent', 'permanent_failed', 'not_applicable'))
);
CREATE INDEX "support_reports_due_idx" ON "support_reports" ("owner_status","owner_next_attempt_at");
CREATE INDEX "support_reports_retention_idx" ON "support_reports" ("expires_at");
CREATE UNIQUE INDEX "support_reports_reporter_idempotency_unique" ON "support_reports" ("reporter_user_id","idempotency_key");
CREATE INDEX "support_reports_copy_due_idx" ON "support_reports" ("copy_status","copy_next_attempt_at");
CREATE TABLE "support_report_attachments" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "report_id" varchar NOT NULL REFERENCES "support_reports"("id") ON DELETE cascade,
 "filename" text NOT NULL, "content_type" text NOT NULL, "size" integer NOT NULL,
 "storage_key" text NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "deleted_at" timestamptz
);
CREATE INDEX "support_report_attachments_report_idx" ON "support_report_attachments" ("report_id");
CREATE UNIQUE INDEX "support_report_attachments_storage_key_unique" ON "support_report_attachments" ("storage_key");