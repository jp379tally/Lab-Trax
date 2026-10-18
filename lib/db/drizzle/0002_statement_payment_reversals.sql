CREATE TABLE "statement_payment_reversals" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_session_id" varchar NOT NULL REFERENCES "statement_payment_sessions"("id") ON DELETE restrict,
  "processor_idempotency_key" text NOT NULL,
  "stripe_payment_intent_id" text,
  "stripe_charge_id" text,
  "stripe_refund_id" text,
  "amount" numeric(12, 2) NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "status" text DEFAULT 'pending_processor' NOT NULL,
  "failure_reason" text,
  "processor_lease_token" text,
  "processing_started_at" timestamp with time zone,
  "initiated_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "statement_payment_reversals_session_unique" ON "statement_payment_reversals" USING btree ("payment_session_id");
--> statement-breakpoint
CREATE INDEX "statement_payment_reversals_status_idx" ON "statement_payment_reversals" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "statement_payment_reversals_refund_unique" ON "statement_payment_reversals" USING btree ("stripe_refund_id") WHERE "stripe_refund_id" IS NOT NULL;