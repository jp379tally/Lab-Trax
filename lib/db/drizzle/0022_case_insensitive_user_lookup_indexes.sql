CREATE INDEX IF NOT EXISTS "users_username_lower_idx"
  ON "users" (lower("username"));

CREATE INDEX IF NOT EXISTS "users_email_lower_trim_idx"
  ON "users" (lower(trim("email")));