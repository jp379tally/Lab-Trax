import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const MISSING_DATABASE_URL_MESSAGE =
  "DATABASE_URL must be set. Did you forget to provision a database?";
const SHOULD_DEFER_MISSING_DATABASE_URL =
  process.env.NODE_ENV === "test" && !process.env.DATABASE_URL;

if (!process.env.DATABASE_URL && !SHOULD_DEFER_MISSING_DATABASE_URL) {
  throw new Error(MISSING_DATABASE_URL_MESSAGE);
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

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }
  return databaseUrl;
}

function createPool() {
  const nextPool = new Pool({
    connectionString: normalizeDbUrl(requireDatabaseUrl()),
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
    // Optionally cap the pool size via env var.  Production leaves this unset
    // (defaults to pg's built-in limit of 10).  The test vitest configs set
    // DB_POOL_MAX=5 so that two concurrent test workflows stay within the DB's
    // max_connections: 2 workflows × 2 workers × 5 connections = 20 total.
    ...(process.env.DB_POOL_MAX
      ? { max: parseInt(process.env.DB_POOL_MAX, 10) }
      : {}),
  });

  // Without this handler, any error on an idle client (e.g. the database
  // briefly terminating a connection with "terminating connection due to
  // administrator command") would emit an unhandled 'error' event and crash
  // the Node.js process.  pg removes the bad client from the pool
  // automatically; logging here is sufficient — the next query will simply
  // acquire a fresh connection.
  nextPool.on("error", (err) => {
    console.error("[db] idle client error — connection will be recycled:", err.message);
  });

  return nextPool;
}

function createDb(nextPool: pg.Pool) {
  return drizzle(nextPool, { schema });
}

type Database = ReturnType<typeof createDb>;

let poolInstance: pg.Pool | null = null;
let dbInstance: Database | null = null;

function getPoolInstance(): pg.Pool {
  if (!poolInstance) {
    poolInstance = createPool();
  }
  return poolInstance;
}

function getDbInstance(): Database {
  if (!dbInstance) {
    dbInstance = createDb(getPoolInstance());
  }
  return dbInstance;
}

function bindIfFunction<T extends object>(target: T, prop: PropertyKey) {
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
}

const lazyPoolTarget = {
  query: (...args: Parameters<pg.Pool["query"]>) => getPoolInstance().query(...args),
  connect: (...args: Parameters<pg.Pool["connect"]>) => getPoolInstance().connect(...args),
  end: (...args: Parameters<pg.Pool["end"]>) => getPoolInstance().end(...args),
  on: (...args: Parameters<pg.Pool["on"]>) => getPoolInstance().on(...args),
};

export const pool = new Proxy(lazyPoolTarget as pg.Pool, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return bindIfFunction(getPoolInstance(), prop);
  },
  set(_target, prop, value) {
    Reflect.set(getPoolInstance(), prop, value);
    return true;
  },
}) as pg.Pool;

const lazyDbTarget = {
  select: (...args: Parameters<Database["select"]>) => getDbInstance().select(...args),
  insert: (...args: Parameters<Database["insert"]>) => getDbInstance().insert(...args),
  update: (...args: Parameters<Database["update"]>) => getDbInstance().update(...args),
  delete: (...args: Parameters<Database["delete"]>) => getDbInstance().delete(...args),
  execute: (...args: Parameters<Database["execute"]>) => getDbInstance().execute(...args),
  transaction: (...args: Parameters<Database["transaction"]>) =>
    getDbInstance().transaction(...args),
  get query() {
    return getDbInstance().query;
  },
};

export const db = new Proxy(lazyDbTarget as Database, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return bindIfFunction(getDbInstance(), prop);
  },
  set(_target, prop, value) {
    Reflect.set(getDbInstance(), prop, value);
    return true;
  },
}) as Database;

export * from "./schema";
