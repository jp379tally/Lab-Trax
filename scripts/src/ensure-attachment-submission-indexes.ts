import { pool } from "@workspace/db";
import { installAttachmentSubmissionIndexes } from "./attachment-submission-schema";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await installAttachmentSubmissionIndexes((sql) => client.query(sql));
    await client.query("COMMIT");
    console.log("Attachment submission indexes installed; existing records were not changed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error("Attachment submission indexes could not be installed. Check lock contention, column availability and duplicate submission keys; no records were removed.");
  process.exitCode = 1;
});
