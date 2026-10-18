import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to prepare the disposable API test database.");
}

const pool = new pg.Pool({ connectionString });
try {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  console.log("Enabled pg_trgm in the disposable API test database.");
} finally {
  await pool.end();
}
