#!/usr/bin/env tsx
/**
 * Record a database identity fingerprint into the repository.
 *
 * The publish preflight (`check-schema-columns`, run against production by
 * `check-production-schema-columns`) refuses to build when production stops
 * matching the committed fingerprint. That refusal is only safe if there is a
 * deliberate, auditable way to say "this change is real" — which is this
 * script plus a commit of `scripts/database-fingerprint.json`.
 *
 * Usage:
 *   # development (DATABASE_URL already points at development)
 *   pnpm --filter @workspace/scripts run record-data-fingerprint
 *
 *   # production (requires PROD_DATABASE_URL)
 *   pnpm --filter @workspace/scripts run record-production-data-fingerprint
 *
 * The probe is read-only. Nothing here writes to any database.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  DATA_FINGERPRINT_PATH,
  DATA_FINGERPRINT_RELATIVE_PATH,
  FINGERPRINT_COUNTS,
  type FingerprintTarget,
  parseExpectedDataFingerprints,
  readDataFingerprint,
} from "./data-fingerprint";

function resolveTarget(): FingerprintTarget {
  const raw = process.env.DATA_FINGERPRINT_TARGET?.trim() || "development";
  if (raw !== "production" && raw !== "development") {
    throw new Error(
      `DATA_FINGERPRINT_TARGET must be "production" or "development", received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const target = resolveTarget();

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      target === "production"
        ? "DATABASE_URL is empty. Recording the production fingerprint needs PROD_DATABASE_URL to be set so DATABASE_URL can be pointed at production."
        : "DATABASE_URL is empty. Point it at the development database before recording its fingerprint.",
    );
  }

  // Imported lazily so the missing-connection-string message above wins over
  // the generic one the db package throws while loading.
  const { pool } = await import("@workspace/db");

  try {
    // Re-parse before writing: a malformed file must be reported, not
    // silently replaced with a half-correct one.
    const existingRaw = JSON.parse(
      readFileSync(DATA_FINGERPRINT_PATH, "utf8"),
    ) as Record<string, unknown>;
    const expected = parseExpectedDataFingerprints(existingRaw);
    const labOrganizationId = expected[target]?.labOrganizationId;
    const observed = await readDataFingerprint(
      (sql, values) => pool.query(sql, values),
      labOrganizationId,
    );

    const recordedAt = new Date().toISOString();
    // Driven by the same registry the probe and the comparison use, so a
    // newly counted record set is recorded without a second edit here.
    const counts = Object.fromEntries(
      FINGERPRINT_COUNTS.map((count) => [count.field, observed[count.field]]),
    );
    const updated = {
      ...existingRaw,
      [target]: {
        recordedAt,
        ...(labOrganizationId ? { labOrganizationId } : {}),
        ...counts,
        oldestCaseCreatedAt: observed.oldestCaseCreatedAt,
      },
    };

    writeFileSync(
      DATA_FINGERPRINT_PATH,
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8",
    );

    console.info(
      `record-data-fingerprint (${target}): ${FINGERPRINT_COUNTS.map(
        (count) => `${count.label} ${observed[count.field]}`,
      ).join(", ")}, oldest case created_at ${observed.oldestCaseCreatedAt ?? "none"}`,
    );
    console.info(
      `record-data-fingerprint (${target}): wrote ${DATA_FINGERPRINT_RELATIVE_PATH} at ${recordedAt}. Review the diff and commit it with the change that made it true.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("record-data-fingerprint: failed", error);
  process.exitCode = 1;
});
