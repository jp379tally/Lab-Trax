import { pool } from "@workspace/db";
import { ensureDbConstraints } from "../src/lib/db-constraints.js";

import { ensureProductionMediaJournalSchema } from "../src/lib/production-media-journal.js";

try {
  await ensureDbConstraints();
  // Mirror startup before exercising any journaled media writer.
  await ensureProductionMediaJournalSchema();
} finally {
  await pool.end();
}
