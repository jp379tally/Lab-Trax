CREATE TABLE "customer_credit_applications" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_credit_id" varchar NOT NULL REFERENCES "customer_credits"("id") ON DELETE restrict,
  "payment_session_id" varchar NOT NULL REFERENCES "statement_payment_sessions"("id") ON DELETE cascade,
  "invoice_id" varchar NOT NULL REFERENCES "invoices"("id") ON DELETE restrict,
  "amount" numeric(12, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "customer_credit_applications_credit_idx" ON "customer_credit_applications" USING btree ("customer_credit_id");
--> statement-breakpoint
CREATE INDEX "customer_credit_applications_session_idx" ON "customer_credit_applications" USING btree ("payment_session_id");
--> statement-breakpoint
CREATE INDEX "customer_credit_applications_invoice_idx" ON "customer_credit_applications" USING btree ("invoice_id");
--> statement-breakpoint
ALTER TABLE "statement_payment_sessions" ADD COLUMN "provider_payment_checkout_id" varchar REFERENCES "provider_payment_checkouts"("id") ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX "statement_payment_sessions_provider_checkout_unique" ON "statement_payment_sessions" USING btree ("provider_payment_checkout_id") WHERE "provider_payment_checkout_id" IS NOT NULL;