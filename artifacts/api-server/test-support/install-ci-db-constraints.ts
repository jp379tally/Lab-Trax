import { pool } from "@workspace/db";
import { ensureDbConstraints } from "../src/lib/db-constraints.js";

try {
  await ensureDbConstraints();
} finally {
  await pool.end();
}
