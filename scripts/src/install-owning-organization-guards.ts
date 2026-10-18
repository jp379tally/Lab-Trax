import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOwningOrganizationGuardSql } from "@workspace/db/schema";

interface GuardClient {
  query(sql: string): Promise<unknown>;
}

/** Install the exact boot-time guards without running API jobs or data backfills. */
export async function installOwningOrganizationGuards(client: GuardClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(buildOwningOrganizationGuardSql());
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function assertDevelopmentGuardTarget(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (env.NODE_ENV === "production" ||
      (env.PROD_DATABASE_URL && env.DATABASE_URL === env.PROD_DATABASE_URL)) {
    throw new Error("Post-merge guard installation is development-only; production installs guards at API startup");
  }
}

async function main(): Promise<void> {
  assertDevelopmentGuardTarget(process.env);
  const { pool } = await import("@workspace/db");
  try {
    const client = await pool.connect();
    try {
      await installOwningOrganizationGuards(client);
      console.log("post-merge: installed owning-organization guards using shared API boot definitions");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("post-merge: owning-organization guard installation failed", error);
    process.exitCode = 1;
  });
}
