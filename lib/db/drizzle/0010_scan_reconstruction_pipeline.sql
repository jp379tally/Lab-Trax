CREATE TABLE "scan_jobs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "created_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "idempotency_key" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "capture_method" text DEFAULT 'camera' NOT NULL,
  "device" text,
  "manifest_json" jsonb,
  "quality_json" jsonb,
  "error_code" text,
  "error_message" text,
  "guidance" text,
  "case_id" varchar,
  "legacy_case_id" varchar,
  "retention_until" timestamptz,
  "lease_until" timestamptz,
  "lease_token" text,
  "retry_at" timestamptz,
  "attempts" integer DEFAULT 0 NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "scan_jobs_status_check" CHECK ("status" IN ('draft','queued','processing','retry','completed','failed')),
  CONSTRAINT "scan_jobs_destination_xor" CHECK (NOT ("case_id" IS NOT NULL AND "legacy_case_id" IS NOT NULL))
);
CREATE INDEX "scan_jobs_lab_status_idx" ON "scan_jobs" ("lab_organization_id","status");
CREATE INDEX "scan_jobs_lease_idx" ON "scan_jobs" ("status","lease_until");
CREATE UNIQUE INDEX "scan_jobs_lab_idempotency_unique" ON "scan_jobs" ("lab_organization_id","idempotency_key");

CREATE TABLE "scan_inputs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" varchar NOT NULL REFERENCES "scan_jobs"("id") ON DELETE cascade,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "expected_bytes" integer NOT NULL,
  "received_bytes" integer DEFAULT 0 NOT NULL,
  "storage_key" text,
  "upload_path" text,
  "sha256" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "scan_inputs_size_check" CHECK ("expected_bytes" > 0 AND "received_bytes" >= 0 AND "received_bytes" <= "expected_bytes")
);
CREATE INDEX "scan_inputs_job_idx" ON "scan_inputs" ("job_id");

CREATE TABLE "scan_input_chunks" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "input_id" varchar NOT NULL REFERENCES "scan_inputs"("id") ON DELETE cascade,
  "offset" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "storage_key" text NOT NULL,
  "checksum" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "scan_input_chunks_input_offset_unique" ON "scan_input_chunks" ("input_id","offset");

CREATE TABLE "scan_outputs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" varchar NOT NULL REFERENCES "scan_jobs"("id") ON DELETE cascade,
  "format" text NOT NULL,
  "mime_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "byte_size" integer NOT NULL,
  "metadata_json" jsonb NOT NULL,
  "ready_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "scan_outputs_format_check" CHECK ("format" IN ('ply','stl'))
);
CREATE UNIQUE INDEX "scan_outputs_job_format_unique" ON "scan_outputs" ("job_id","format");

CREATE TABLE "scan_output_garbage" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" varchar NOT NULL REFERENCES "scan_jobs"("id") ON DELETE cascade,
  "storage_key" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "scan_output_garbage_storage_key_unique" ON "scan_output_garbage" ("storage_key");

CREATE TABLE "lab_documents" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "scan_job_id" varchar NOT NULL REFERENCES "scan_jobs"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "mime_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "created_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "lab_documents_scan_unique" ON "lab_documents" ("scan_job_id","mime_type");