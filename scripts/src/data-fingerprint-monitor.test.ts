/**
 * Scheduled between-publish monitoring of the production database identity.
 *
 * These tests drive the monitor the way the runner does — the shared
 * comparison (`resolveDataIdentity`) inside the monitor's read-only session —
 * so they cover both what the job reports and the two promises it makes:
 * it only reads, and it never rewrites the committed fingerprint.
 *
 * Fixtures are built from `FINGERPRINT_COUNTS` rather than listing columns by
 * hand: the probe counts every irreplaceable record set, and that list grows.
 * A test that hardcoded two of them would start failing — or worse, stop
 * covering the new ones — the next time a record set is added.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DATA_FINGERPRINT_RELATIVE_PATH,
  DATA_FINGERPRINT_SQL,
  FINGERPRINT_COUNTS,
  LAB_DATA_FINGERPRINT_SQL,
  RECORD_PRODUCTION_FINGERPRINT_COMMAND,
  type ExpectedDataFingerprints,
  type FingerprintCountField,
  type RecordedDataFingerprint,
  resolveDataIdentity,
} from "./data-fingerprint";
import {
  BEGIN_READ_ONLY_SQL,
  END_READ_ONLY_SQL,
  MONITOR_LABEL,
  UNREADABLE_FACTS_LINE,
  buildMonitorOutcome,
  withReadOnlySession,
} from "./data-fingerprint-monitor";

const PRODUCTION_OLDEST = "2026-01-02T03:04:05.123456Z";
const DEVELOPMENT_OLDEST = "2025-12-31T23:59:59.654321Z";
const CHECKED_AT = "2026-01-06T18:30:00.000Z";
const RECORDED_AT = "2026-01-04T00:00:00.000Z";
const SYNTHETIC_FINGERPRINT_PATH = fileURLToPath(
  new URL("./fixtures/synthetic-database-fingerprint.json", import.meta.url),
);

/** Every record set not named by a test holds this much, recorded and live. */
const BASELINE = 500;

type Counts = Partial<Record<FingerprintCountField, number>>;

const PRODUCTION_COUNTS: Counts = { activeCaseCount: 10, invoiceCount: 11 };
const DEVELOPMENT_COUNTS: Counts = { activeCaseCount: 8, invoiceCount: 9 };

function countOf(field: FingerprintCountField, overrides: Counts): number {
  return overrides[field] ?? BASELINE;
}

/** Counts for every record set the probe compares, named ones overridden. */
function allCounts(overrides: Counts): Record<FingerprintCountField, number> {
  const counts = {} as Record<FingerprintCountField, number>;
  for (const count of FINGERPRINT_COUNTS) {
    counts[count.field] = countOf(count.field, overrides);
  }
  return counts;
}

function recorded(
  counts: Counts,
  oldestCaseCreatedAt: string | null,
  extra: Partial<RecordedDataFingerprint> = {},
): RecordedDataFingerprint {
  return {
    recordedAt: RECORDED_AT,
    ...allCounts(counts),
    oldestCaseCreatedAt,
    ...extra,
  };
}

function expectedFingerprints(
  overrides: Partial<ExpectedDataFingerprints> = {},
): ExpectedDataFingerprints {
  return {
    minimumRetainedFraction: 0.9,
    production: recorded(PRODUCTION_COUNTS, PRODUCTION_OLDEST),
    development: recorded(DEVELOPMENT_COUNTS, DEVELOPMENT_OLDEST),
    ...overrides,
  };
}

/** One row of the probe's single select, as node-postgres returns it. */
function probeRow(
  counts: Counts,
  oldestCaseCreatedAt: string | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const count of FINGERPRINT_COUNTS) {
    row[count.column] = countOf(count.field, counts);
  }
  row.oldest_case_created_at = oldestCaseCreatedAt;
  return row;
}

/** The summary line this record set produces when live matches recorded. */
function unchangedFacts(counts: Counts): string[] {
  return FINGERPRINT_COUNTS.map((count) => {
    const value = countOf(count.field, counts);
    return `${count.label}: ${value} (fingerprint ${value})`;
  });
}

/** Run the monitor's pipeline against a fake production database. */
async function runMonitor(
  result: Record<string, unknown> | Error,
  expected = expectedFingerprints(),
) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql === BEGIN_READ_ONLY_SQL || sql === END_READ_ONLY_SQL) {
        return { rows: [] };
      }
      if (result instanceof Error) throw result;
      // The lab-scoped probe also proves the protected lab exists.
      return {
        rows: [
          sql === LAB_DATA_FINGERPRINT_SQL
            ? { lab_exists: true, ...result }
            : result,
        ],
      };
    },
  };

  const verdict = await withReadOnlySession(client, (query) =>
    resolveDataIdentity({ target: "production", expected, query }),
  );

  return {
    statements,
    outcome: buildMonitorOutcome({
      target: "production",
      observed: verdict.observed,
      expected,
      findings: verdict.findings,
      checkedAt: CHECKED_AT,
    }),
  };
}

function missingTablesError(): Error {
  const error = new Error('relation "cases" does not exist') as Error & {
    code: string;
  };
  error.code = "42P01";
  return error;
}

describe("scheduled production identity monitor", () => {
  it("reports the facts and stays quiet while production still matches", async () => {
    const { outcome } = await runMonitor(
      probeRow(PRODUCTION_COUNTS, PRODUCTION_OLDEST),
    );

    expect(outcome.findings).toEqual([]);
    expect(outcome.shouldAlert).toBe(false);
    expect(outcome.payload).toBeNull();
    expect(outcome.facts).toEqual([
      "scope: entire database",
      ...unchangedFacts(PRODUCTION_COUNTS),
      `oldest case created_at: ${PRODUCTION_OLDEST} (fingerprint ${PRODUCTION_OLDEST})`,
      `matches the development database to the microsecond: no (development fingerprint ${DEVELOPMENT_OLDEST}, recorded ${RECORDED_AT})`,
    ]);
    expect(outcome.logLines.at(-1)).toContain(
      `matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}`,
    );
  });

  it("runs the probe inside a read-only transaction and issues no write", async () => {
    const { statements } = await runMonitor(
      probeRow(PRODUCTION_COUNTS, PRODUCTION_OLDEST),
      expectedFingerprints({
        production: recorded(PRODUCTION_COUNTS, PRODUCTION_OLDEST, {
          labOrganizationId: "00000000-0000-4000-8000-000000000234",
        }),
      }),
    );

    expect(statements.map((s) => s.sql)).toEqual([
      BEGIN_READ_ONLY_SQL,
      LAB_DATA_FINGERPRINT_SQL,
      END_READ_ONLY_SQL,
    ]);
    // The scope query carries the committed protected lab, not a hardcoded one.
    expect(statements[1]?.values).toEqual([
      "00000000-0000-4000-8000-000000000234",
    ]);
    for (const { sql } of statements) {
      expect(sql).not.toMatch(
        /\b(insert|update|delete|alter|drop|create|truncate|grant)\b/i,
      );
    }
  });

  it("closes the transaction even when the probe fails outright", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === BEGIN_READ_ONLY_SQL || sql === END_READ_ONLY_SQL) {
          return { rows: [] };
        }
        throw new Error("connection terminated unexpectedly");
      },
    };

    await expect(
      withReadOnlySession(client, (query) =>
        resolveDataIdentity({
          target: "production",
          expected: expectedFingerprints(),
          query,
        }),
      ),
    ).rejects.toThrow(/connection terminated/);

    expect(statements[0]).toBe(BEGIN_READ_ONLY_SQL);
    expect(statements.at(-1)).toBe(END_READ_ONLY_SQL);
  });

  it("alerts with the reported facts when production stops matching", async () => {
    const { outcome } = await runMonitor(
      probeRow(
        { activeCaseCount: 4, invoiceCount: 0 },
        "2026-01-03T09:00:00.000001Z",
      ),
    );

    expect(outcome.shouldAlert).toBe(true);
    expect(outcome.failures.map((f) => f.code)).toContain("lineage-mismatch");

    const payload = outcome.payload!;
    expect(payload.source).toBe(MONITOR_LABEL);
    expect(payload.target).toBe("production");
    expect(payload.checkedAt).toBe(CHECKED_AT);
    expect(payload.facts).toEqual(outcome.facts);

    // The reported facts travel with the alert, not just the verdict: every
    // record set the probe counts is in the email, not only the failing ones.
    for (const count of FINGERPRINT_COUNTS) {
      expect(payload.facts).toContainEqual(
        expect.stringMatching(new RegExp(`^${count.label}: \\d+ \\(fingerprint \\d+\\)$`)),
      );
    }
    expect(payload.facts).toContainEqual(
      expect.stringMatching(/^active cases: 4 \(fingerprint 10\)$/),
    );
    expect(payload.facts).toContainEqual(
      expect.stringMatching(/^invoices: 0 \(fingerprint 11\)$/),
    );
    expect(payload.facts).toContainEqual(
      expect.stringContaining("oldest case created_at: 2026-01-03T09:00:00.000001Z"),
    );
    expect(payload.facts).toContainEqual(
      expect.stringContaining("matches the development database to the microsecond: no"),
    );

    expect(payload.findings.every((f) => typeof f.message === "string")).toBe(true);
    expect(payload.fingerprintPath).toBe(DATA_FINGERPRINT_RELATIVE_PATH);
    expect(payload.recordCommand).toBe(RECORD_PRODUCTION_FINGERPRINT_COMMAND);
  });

  it("carries the configured protected lab, so only its admins can be told", async () => {
    const PROTECTED_LAB = "00000000-0000-4000-8000-000000000234";
    const scoped = expectedFingerprints({
      production: recorded(PRODUCTION_COUNTS, PRODUCTION_OLDEST, {
        labOrganizationId: PROTECTED_LAB,
      }),
    });

    const { outcome } = await runMonitor(
      probeRow({ activeCaseCount: 4 }, "2026-01-03T09:00:00.000001Z"),
      scoped,
    );

    // The scope comes from the committed file the monitor read, never from
    // the database it is questioning: a rebound database that holds another
    // lab must not be able to redirect this lab's alert to that lab's admins.
    expect(outcome.payload?.protectedLabOrganizationId).toBe(PROTECTED_LAB);
  });

  it("reports no protected lab when the fingerprint is database-wide", async () => {
    const { outcome } = await runMonitor(
      probeRow({ activeCaseCount: 4 }, "2026-01-03T09:00:00.000001Z"),
    );

    expect(outcome.payload?.protectedLabOrganizationId).toBeNull();
  });

  it("alerts when production has become a copy of development", async () => {
    const { outcome } = await runMonitor(
      probeRow(DEVELOPMENT_COUNTS, DEVELOPMENT_OLDEST),
    );

    expect(outcome.failures.map((f) => f.code)).toContain("development-copy");
    expect(outcome.payload?.facts).toContainEqual(
      expect.stringContaining(
        "matches the development database to the microsecond: YES",
      ),
    );
  });

  it("alerts when production cannot be read at all", async () => {
    const { outcome, statements } = await runMonitor(missingTablesError());

    expect(outcome.facts).toEqual([UNREADABLE_FACTS_LINE]);
    expect(outcome.failures.map((f) => f.code)).toEqual(["tables-absent"]);
    expect(outcome.payload?.facts).toEqual([UNREADABLE_FACTS_LINE]);
    expect(statements.at(-1)?.sql).toBe(END_READ_ONLY_SQL);
  });

  it("warns without alerting when only the repository's bookkeeping is behind", async () => {
    const { outcome } = await runMonitor(
      probeRow(PRODUCTION_COUNTS, PRODUCTION_OLDEST),
      expectedFingerprints({ development: null }),
    );

    expect(outcome.findings.map((f) => f.level)).toEqual(["warning"]);
    expect(outcome.shouldAlert).toBe(false);
    expect(outcome.payload).toBeNull();
  });

  it("never rewrites the committed fingerprint, even on a mismatch", async () => {
    const before = readFileSync(SYNTHETIC_FINGERPRINT_PATH, "utf8");

    const emptied: Counts = {};
    for (const count of FINGERPRINT_COUNTS) emptied[count.field] = 0;
    await runMonitor(probeRow(emptied, null));

    expect(readFileSync(SYNTHETIC_FINGERPRINT_PATH, "utf8")).toBe(before);
    // Expected values only ever change through the recorder plus a commit.
    expect(RECORD_PRODUCTION_FINGERPRINT_COMMAND).toContain(
      "record-production-data-fingerprint",
    );
  });

  it("uses the unscoped probe when no protected lab is committed", async () => {
    const { statements } = await runMonitor(
      probeRow(PRODUCTION_COUNTS, PRODUCTION_OLDEST),
    );

    expect(statements[1]?.sql).toBe(DATA_FINGERPRINT_SQL);
  });
});
