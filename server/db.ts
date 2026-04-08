import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";
import * as chatSchema from "../shared/models/chat";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

let connectionString = process.env.DATABASE_URL;
if (!connectionString.includes("sslmode=")) {
  const separator = connectionString.includes("?") ? "&" : "?";
  connectionString += `${separator}sslmode=verify-full`;
}

const pool = new pg.Pool({ connectionString });
export const db = drizzle(pool, { schema: { ...schema, ...chatSchema } });
