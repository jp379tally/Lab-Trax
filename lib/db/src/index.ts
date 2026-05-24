import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// pg-connection-string fires a security warning when it parses a connection
// string whose sslmode is 'prefer', 'require', or 'verify-ca', because those
// modes are treated as aliases for 'verify-full' in newer pg versions.
// Rewriting the URL to use 'verify-full' explicitly suppresses the noise
// without changing the actual TLS behaviour.
function normalizeDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const mode = u.searchParams.get("sslmode");
    if (mode === "prefer" || mode === "require" || mode === "verify-ca") {
      u.searchParams.set("sslmode", "verify-full");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export const pool = new Pool({
  connectionString: normalizeDbUrl(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: true },
  // Fail fast when the pool is saturated rather than queuing requests
  // indefinitely. 10 s is generous enough for normal operations (typical
  // acquire time is <50 ms) while still surfacing pool exhaustion quickly
  // so callers can return a 503 and free the HTTP connection.
  connectionTimeoutMillis: 10_000,
  // Bound individual statement execution so a slow query releases its
  // connection before it cascades into pool starvation.  30 s is well
  // above p99 for any intentional query in this codebase.
  statement_timeout: 30_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
