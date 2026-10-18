-- Case receipt is a business calendar day, not an instant.
-- Historical writers deliberately stored reviewed days at UTC noon, so taking
-- the UTC date preserves the day users saw before this migration regardless of
-- the database session timezone.
ALTER TABLE "cases"
  ALTER COLUMN "received_at" DROP DEFAULT,
  ALTER COLUMN "received_at" TYPE date
    USING (("received_at" AT TIME ZONE 'UTC')::date),
  ALTER COLUMN "received_at" SET DEFAULT
    make_date(
      extract(year from timezone('UTC', CURRENT_TIMESTAMP))::integer,
      extract(month from timezone('UTC', CURRENT_TIMESTAMP))::integer,
      extract(day from timezone('UTC', CURRENT_TIMESTAMP))::integer
    );