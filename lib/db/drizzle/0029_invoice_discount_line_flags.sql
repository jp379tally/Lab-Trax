ALTER TABLE "lab_item_labels"
  ADD COLUMN IF NOT EXISTS "is_discount" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "invoice_line_items"
  ADD COLUMN IF NOT EXISTS "is_discount" boolean NOT NULL DEFAULT false;
