import { pool } from "@workspace/db";
import { installBackupDownloadSchema } from "./backup-download-schema";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await installBackupDownloadSchema((sql) => client.query(sql));
    await client.query("COMMIT");
    console.log("Declared backup-download metadata installed; no history rows were changed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error("Backup-download schema installation failed. Check schema ownership, locks and duplicate keys; no history was removed.");
  process.exitCode = 1;
});
