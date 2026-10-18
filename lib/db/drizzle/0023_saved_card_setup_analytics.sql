CREATE TABLE IF NOT EXISTS "saved_card_setup_analytics" (
  "outcome" text PRIMARY KEY NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "saved_card_setup_analytics_outcome_check"
    CHECK ("outcome" IN ('started', 'succeeded', 'expired'))
);