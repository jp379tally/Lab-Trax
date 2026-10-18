import { findMissingPracticeAuthorizationSchemaObjects } from "./practice-authorization-schema-contract";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    if (process.env.API_TEST_REQUIRE_DATABASE === "1") {
      throw new Error(
        "API_TEST_REQUIRE_DATABASE=1 requires DATABASE_URL; refusing to skip the practice-authorization schema check.",
      );
    }
    console.info(
      "practice-authorization-schema-check: skipped because DATABASE_URL is unset (DB-free API tests).",
    );
    return;
  }

  const { pool } = await import("@workspace/db");
  try {
    const missing = await findMissingPracticeAuthorizationSchemaObjects(
      (sql, values) => pool.query(sql, values),
    );

    if (missing.length > 0) {
      console.error(
        `practice-authorization-schema-check: database is missing ${missing.length} required schema object(s):`,
      );
      for (const objectName of missing) {
        console.error(`  - ${objectName}`);
      }
      process.exitCode = 1;
      return;
    }

    console.info(
      "practice-authorization-schema-check: verified supersession column, unique index, and immutability trigger",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "practice-authorization-schema-check: unable to inspect the database",
    error,
  );
  process.exitCode = 1;
});