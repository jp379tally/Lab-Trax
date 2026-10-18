import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  classifySchemaProbeFailure,
  type DataFingerprint,
  DATA_FINGERPRINT_SQL,
  FINGERPRINT_COUNTS,
  LAB_DATA_FINGERPRINT_SQL,
  type ExpectedDataFingerprints,
  evaluateDataFingerprint,
  evaluateUnreadableFingerprint,
  loadExpectedDataFingerprints,
  parseDataFingerprintRow,
  parseExpectedDataFingerprints,
  readDataFingerprint,
  resolveDataIdentity,
  summarizeDataFingerprint,
} from "./data-fingerprint";

const PRODUCTION_OLDEST = "2026-01-02T03:04:05.123456Z";
const DEVELOPMENT_OLDEST = "2025-12-31T23:59:59.654321Z";
const RECORD_TIMESTAMP = "2026-01-04T00:00:00.000Z";

/** Synthetic counts used to exercise the fingerprint comparison. */
const PRODUCTION_COUNTS = {
  activeCaseCount: 10,
  invoiceCount: 11,
  userCount: 3,
  organizationCount: 2,
  doctorProfileCount: 4,
  paymentCount: 5,
  caseAttachmentCount: 6,
  auditHistoryCount: 7,
};

const DEVELOPMENT_COUNTS = {
  activeCaseCount: 8,
  invoiceCount: 8,
  userCount: 3,
  organizationCount: 2,
  doctorProfileCount: 4,
  paymentCount: 3,
  caseAttachmentCount: 4,
  auditHistoryCount: 7,
};
const SYNTHETIC_FINGERPRINT_PATH = fileURLToPath(
  new URL("./fixtures/synthetic-database-fingerprint.json", import.meta.url),
);
const loadSyntheticFingerprints = () =>
  loadExpectedDataFingerprints(SYNTHETIC_FINGERPRINT_PATH);

function observedFingerprint(
  overrides: Partial<DataFingerprint> = {},
): DataFingerprint {
  return {
    ...PRODUCTION_COUNTS,
    oldestCaseCreatedAt: PRODUCTION_OLDEST,
    ...overrides,
  };
}

function expectedFingerprints(
  overrides: Partial<ExpectedDataFingerprints> = {},
): ExpectedDataFingerprints {
  return {
    minimumRetainedFraction: 0.9,
    production: {
      recordedAt: RECORD_TIMESTAMP,
      ...PRODUCTION_COUNTS,
      oldestCaseCreatedAt: PRODUCTION_OLDEST,
    },
    development: {
      recordedAt: RECORD_TIMESTAMP,
      ...DEVELOPMENT_COUNTS,
      oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
    },
    ...overrides,
  };
}

function codesFor(
  observed: DataFingerprint,
  expected = expectedFingerprints(),
  target: "production" | "development" = "production",
): Array<{ level: string; code: string }> {
  return evaluateDataFingerprint({ target, observed, expected }).map(
    ({ level, code }) => ({ level, code }),
  );
}

/** A probe row as node-postgres returns it: bigint counts arrive as strings. */
function probeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    oldest_case_created_at: PRODUCTION_OLDEST,
  };
  for (const count of FINGERPRINT_COUNTS) {
    row[count.column] = String(PRODUCTION_COUNTS[count.field]);
  }
  return { ...row, ...overrides };
}

describe("database identity probe", () => {
  it("reads every irreplaceable record set with a single read-only query", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];

    const observed = await readDataFingerprint(async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [probeRow()] };
    });

    expect(calls).toEqual([{ sql: DATA_FINGERPRINT_SQL, values: [] }]);
    expect(DATA_FINGERPRINT_SQL).toMatch(/^select\b/i);
    expect(DATA_FINGERPRINT_SQL).not.toMatch(
      /\b(insert|update|delete|alter|drop|create|truncate|grant)\b/i,
    );
    expect(observed).toEqual(observedFingerprint());
  });

  it("counts the lab's accounts, practices, money and files, not only its cases", () => {
    // The October 2026 swap took these with it. A database that kept its
    // case rows and arrived with the wrong accounts or an emptied media
    // ledger must not pass the gate, so each one is probed.
    expect(FINGERPRINT_COUNTS.map((count) => count.field)).toEqual([
      "activeCaseCount",
      "invoiceCount",
      "userCount",
      "organizationCount",
      "doctorProfileCount",
      "paymentCount",
      "caseAttachmentCount",
      "auditHistoryCount",
    ]);

    for (const count of FINGERPRINT_COUNTS) {
      expect(DATA_FINGERPRINT_SQL).toContain(`) as ${count.column},`);
      expect(LAB_DATA_FINGERPRINT_SQL).toContain(`) as ${count.column},`);
    }
    // Nothing is selected that no comparison rule covers.
    expect(DATA_FINGERPRINT_SQL.match(/ as \w+_count,/g)).toHaveLength(
      FINGERPRINT_COUNTS.length,
    );
  });

  it("keeps microsecond precision instead of rounding to a comparable second", async () => {
    const observed = await readDataFingerprint(async () => ({
      rows: [probeRow({ oldest_case_created_at: PRODUCTION_OLDEST })],
    }));

    expect(observed.oldestCaseCreatedAt).toBe(PRODUCTION_OLDEST);
  });

  it.each(FINGERPRINT_COUNTS.map((count) => count.column))(
    "refuses to turn an unreadable %s into a believable zero",
    (column) => {
      const { [column]: _omitted, ...withoutColumn } = probeRow();
      expect(() => parseDataFingerprintRow(withoutColumn)).toThrow(column);
      expect(() =>
        parseDataFingerprintRow(probeRow({ [column]: null })),
      ).toThrow(column);
    },
  );

  it("rejects a timestamp that lost its microseconds", () => {
    expect(() =>
      parseDataFingerprintRow(
        probeRow({ oldest_case_created_at: "2026-01-02T03:04:05Z" }),
      ),
    ).toThrow(/oldest_case_created_at/);
  });

  it("reads an empty database as zero rows and no oldest case", () => {
    const emptyRow: Record<string, unknown> = {
      oldest_case_created_at: null,
    };
    for (const count of FINGERPRINT_COUNTS) emptyRow[count.column] = "0";

    expect(parseDataFingerprintRow(emptyRow)).toEqual(
      observedFingerprint({
        activeCaseCount: 0,
        invoiceCount: 0,
        userCount: 0,
        organizationCount: 0,
        doctorProfileCount: 0,
        paymentCount: 0,
        caseAttachmentCount: 0,
        auditHistoryCount: 0,
        oldestCaseCreatedAt: null,
      }),
    );
  });

  it("tells an absent table apart from a merely older one", () => {
    expect(
      classifySchemaProbeFailure(Object.assign(new Error("x"), { code: "42P01" })),
    ).toBe("missing-tables");
    expect(
      classifySchemaProbeFailure(Object.assign(new Error("x"), { code: "3F000" })),
    ).toBe("missing-tables");
    expect(
      classifySchemaProbeFailure(Object.assign(new Error("x"), { code: "42703" })),
    ).toBe("missing-columns");
    expect(
      classifySchemaProbeFailure(
        Object.assign(new Error("connection terminated"), { code: "ECONNRESET" }),
      ),
    ).toBeNull();
    expect(classifySchemaProbeFailure(new Error("no code"))).toBeNull();
  });
});

describe("a production database the probe cannot read", () => {
  function unreadableCodes(
    failure: "missing-tables" | "missing-columns",
    expected = expectedFingerprints(),
    target: "production" | "development" = "production",
  ): Array<{ level: string; code: string }> {
    return evaluateUnreadableFingerprint({ target, expected, failure }).map(
      ({ level, code }) => ({ level, code }),
    );
  }

  it("blocks a publish pointed at a database without the lab's tables", () => {
    expect(unreadableCodes("missing-tables")).toEqual([
      { level: "failure", code: "tables-absent" },
    ]);
  });

  it("names the data the recorded fingerprint says should be there", () => {
    const [finding] = evaluateUnreadableFingerprint({
      target: "production",
      expected: expectedFingerprints(),
      failure: "missing-tables",
    });

    for (const count of FINGERPRINT_COUNTS) {
      expect(finding.message).toContain(
        `${PRODUCTION_COUNTS[count.field]} ${count.noun}(s)`,
      );
    }
  });

  it("lets a genuinely new deployment through with a warning", () => {
    expect(
      unreadableCodes("missing-tables", expectedFingerprints({ production: null })),
    ).toEqual([{ level: "warning", code: "tables-absent" }]);
  });

  it("never blocks development, which has no publish to protect", () => {
    expect(
      unreadableCodes("missing-tables", expectedFingerprints(), "development"),
    ).toEqual([{ level: "warning", code: "tables-absent" }]);
  });

  it("warns rather than deadlocking when the tables are merely older than the code", () => {
    // Replit Publish applies the reviewed schema diff after this build stage,
    // so blocking here would block the publish that adds the missing column.
    expect(unreadableCodes("missing-columns")).toEqual([
      { level: "warning", code: "fingerprint-unreadable" },
    ]);
  });

  it("reaches that verdict through the preflight's own probe, not a skip", async () => {
    const missingTable = Object.assign(
      new Error('relation "public.cases" does not exist'),
      { code: "42P01" },
    );

    const verdict = await resolveDataIdentity({
      target: "production",
      expected: expectedFingerprints(),
      query: async () => {
        throw missingTable;
      },
    });

    expect(verdict.observed).toBeNull();
    expect(verdict.findings).toEqual([
      expect.objectContaining({ level: "failure", code: "tables-absent" }),
    ]);
  });

  it("lets the preflight report a connection failure instead of judging it", async () => {
    const connectionLost = Object.assign(new Error("connection terminated"), {
      code: "ECONNRESET",
    });

    await expect(
      resolveDataIdentity({
        target: "production",
        expected: expectedFingerprints(),
        query: async () => {
          throw connectionLost;
        },
      }),
    ).rejects.toBe(connectionLost);
  });

  it("still compares normally when the probe can read the database", async () => {
    const verdict = await resolveDataIdentity({
      target: "production",
      expected: expectedFingerprints(),
      query: async () => ({ rows: [probeRow()] }),
    });

    expect(verdict.observed).toEqual(observedFingerprint());
    expect(verdict.findings).toEqual([]);
  });
});

describe("committed fingerprint file", () => {
  it("ships a production and development baseline that parse", () => {
    const expected = loadSyntheticFingerprints();

    expect(expected.minimumRetainedFraction).toBeGreaterThan(0);
    expect(expected.minimumRetainedFraction).toBeLessThanOrEqual(1);
    expect(expected.production?.oldestCaseCreatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    expect(expected.development?.oldestCaseCreatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
  });

  it("records a non-zero production count for every irreplaceable record set", () => {
    // A recorded zero switches that record set's floor off entirely, so a
    // zero here would quietly leave it unprotected.
    const production = loadSyntheticFingerprints().production;

    for (const count of FINGERPRINT_COUNTS) {
      expect(production?.[count.field]).toBeGreaterThan(0);
    }
  });

  it("never records production and development as the same database", () => {
    const expected = loadSyntheticFingerprints();

    expect(expected.production?.oldestCaseCreatedAt).not.toBe(
      expected.development?.oldestCaseCreatedAt,
    );
  });

  it("protects a synthetic lab explicitly without scoping the development fingerprint", () => {
    const expected = loadSyntheticFingerprints();
    expect(expected.production?.labOrganizationId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(expected.development?.labOrganizationId).toBeUndefined();
  });

  it.each(["", " ", " padded ", null, 123])("rejects invalid committed lab scope %j", (scope) => {
    const expected = expectedFingerprints();
    expect(() => parseExpectedDataFingerprints({
      ...expected,
      production: { ...expected.production, labOrganizationId: scope },
    })).toThrow(/production\.labOrganizationId/);
  });

  it("reports a malformed fingerprint instead of silently ignoring it", () => {
    expect(() =>
      parseExpectedDataFingerprints({
        production: { recordedAt: RECORD_TIMESTAMP, activeCaseCount: 1 },
      }),
    ).toThrow(/production\.invoiceCount/);

    expect(() =>
      parseExpectedDataFingerprints({ minimumRetainedFraction: 1.5 }),
    ).toThrow(/minimumRetainedFraction/);

    expect(() =>
      parseExpectedDataFingerprints({
        development: {
          recordedAt: RECORD_TIMESTAMP,
          ...DEVELOPMENT_COUNTS,
          oldestCaseCreatedAt: "2026-01-02 03:04:05",
        },
      }),
    ).toThrow(/development\.oldestCaseCreatedAt/);
  });

  it.each(FINGERPRINT_COUNTS.map((count) => count.field))(
    "refuses a fingerprint recorded without %s rather than skipping its comparison",
    (field) => {
      const expected = expectedFingerprints();
      const { [field]: _omitted, ...withoutField } = expected.production!;

      expect(() =>
        parseExpectedDataFingerprints({ ...expected, production: withoutField }),
      ).toThrow(`production.${field}`);
    },
  );

  it("treats an absent baseline as unrecorded rather than empty", () => {
    const parsed = parseExpectedDataFingerprints({ production: null });

    expect(parsed.production).toBeNull();
    expect(parsed.development).toBeNull();
    expect(parsed.minimumRetainedFraction).toBe(0.9);
  });
});

describe("production publish preflight", () => {
  it("passes when production still holds its own data", () => {
    expect(
      codesFor(
        observedFingerprint({ activeCaseCount: 1400, invoiceCount: 1500 }),
      ),
    ).toEqual([]);
  });

  it("blocks when production is a copy of development", () => {
    expect(
      codesFor(
        observedFingerprint({
          ...DEVELOPMENT_COUNTS,
          oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
        }),
      ),
    ).toEqual([
      { level: "failure", code: "development-copy" },
      { level: "failure", code: "lineage-mismatch" },
      { level: "failure", code: "active-cases-collapsed" },
      { level: "failure", code: "invoices-collapsed" },
      { level: "failure", code: "payments-collapsed" },
      { level: "failure", code: "case-attachments-collapsed" },
    ]);
  });

  it("blocks a swapped database even when it is bigger than the recorded one", () => {
    const bigger = { ...observedFingerprint(), oldestCaseCreatedAt: "2026-01-02T03:04:05.123457Z" };
    for (const count of FINGERPRINT_COUNTS) bigger[count.field] = 99_999;

    expect(codesFor(bigger)).toEqual([
      { level: "failure", code: "lineage-mismatch" },
    ]);
  });

  it("blocks when production has been emptied of cases entirely", () => {
    const emptied = observedFingerprint({ oldestCaseCreatedAt: null });
    for (const count of FINGERPRINT_COUNTS) emptied[count.field] = 0;

    expect(codesFor(emptied)).toEqual([
      { level: "failure", code: "no-cases" },
      ...FINGERPRINT_COUNTS.map((count) => ({
        level: "failure",
        code: count.code,
      })),
    ]);
  });

  it("blocks when production collapses relative to the recorded counts", () => {
    expect(codesFor(observedFingerprint({ activeCaseCount: 8 }))).toEqual([
      { level: "failure", code: "active-cases-collapsed" },
    ]);
  });

  it.each(
    FINGERPRINT_COUNTS.filter(
      (count) =>
        count.field !== "activeCaseCount" && count.field !== "invoiceCount",
    ),
  )(
    "blocks a database that kept its cases but lost its $label",
    ({ field, code, noun }) => {
      const findings = evaluateDataFingerprint({
        target: "production",
        observed: observedFingerprint({ [field]: 0 }),
        expected: expectedFingerprints(),
      });

      expect(findings.map((finding) => finding.code)).toEqual([code]);
      // The report names which record set collapsed, not just that one did.
      expect(findings[0].message).toContain(`0 ${noun}(s)`);
      expect(findings[0].level).toBe("failure");
    },
  );

  it("allows ordinary churn within the recorded tolerance", () => {
    expect(
      codesFor(
        observedFingerprint({
          activeCaseCount: 1204,
          invoiceCount: 1210,
          userCount: 38,
          organizationCount: 34,
          doctorProfileCount: 26,
          paymentCount: 900,
          caseAttachmentCount: 5000,
          auditHistoryCount: 23500,
        }),
      ),
    ).toEqual([]);
  });

  it("treats emptying a small recorded database as collapse even when the floor rounds to zero", () => {
    const expected = expectedFingerprints({
      production: {
        recordedAt: RECORD_TIMESTAMP,
        activeCaseCount: 3,
        invoiceCount: 3,
        userCount: 3,
        organizationCount: 3,
        doctorProfileCount: 3,
        paymentCount: 3,
        caseAttachmentCount: 3,
        auditHistoryCount: 3,
        oldestCaseCreatedAt: PRODUCTION_OLDEST,
      },
    });
    const emptied = observedFingerprint();
    for (const count of FINGERPRINT_COUNTS) emptied[count.field] = 0;

    expect(codesFor(emptied, expected)).toEqual(
      FINGERPRINT_COUNTS.map((count) => ({
        level: "failure",
        code: count.code,
      })),
    );
  });

  it("warns instead of deadlocking a production database with no recorded baseline", () => {
    const expected = expectedFingerprints({ production: null });
    const empty = observedFingerprint({ oldestCaseCreatedAt: null });
    for (const count of FINGERPRINT_COUNTS) empty[count.field] = 0;

    expect(codesFor(empty, expected)).toEqual([
      { level: "warning", code: "missing-production-fingerprint" },
    ]);
  });

  it("still blocks a development copy when no production baseline is recorded", () => {
    const expected = expectedFingerprints({ production: null });

    expect(
      codesFor(
        observedFingerprint({
          ...DEVELOPMENT_COUNTS,
          oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
        }),
        expected,
      ),
    ).toEqual([
      { level: "failure", code: "development-copy" },
      { level: "warning", code: "missing-production-fingerprint" },
    ]);
  });

  it("warns when it cannot tell whether production is a development copy", () => {
    const expected = expectedFingerprints({ development: null });

    expect(codesFor(observedFingerprint(), expected)).toEqual([
      { level: "warning", code: "missing-development-fingerprint" },
    ]);
  });

  it("reports every counted record set, including the development comparison, before any verdict", () => {
    const lines = summarizeDataFingerprint({
      target: "production",
      observed: observedFingerprint(),
      expected: expectedFingerprints(),
    });

    expect(lines).toEqual([
      "scope: entire database",
      `active cases: ${PRODUCTION_COUNTS.activeCaseCount} (fingerprint ${PRODUCTION_COUNTS.activeCaseCount})`,
      `invoices: ${PRODUCTION_COUNTS.invoiceCount} (fingerprint ${PRODUCTION_COUNTS.invoiceCount})`,
      `users: ${PRODUCTION_COUNTS.userCount} (fingerprint ${PRODUCTION_COUNTS.userCount})`,
      `organizations: ${PRODUCTION_COUNTS.organizationCount} (fingerprint ${PRODUCTION_COUNTS.organizationCount})`,
      `doctor profiles: ${PRODUCTION_COUNTS.doctorProfileCount} (fingerprint ${PRODUCTION_COUNTS.doctorProfileCount})`,
      `payments: ${PRODUCTION_COUNTS.paymentCount} (fingerprint ${PRODUCTION_COUNTS.paymentCount})`,
      `case attachments: ${PRODUCTION_COUNTS.caseAttachmentCount} (fingerprint ${PRODUCTION_COUNTS.caseAttachmentCount})`,
      `audit history rows: ${PRODUCTION_COUNTS.auditHistoryCount} (fingerprint ${PRODUCTION_COUNTS.auditHistoryCount})`,
      `oldest case created_at: ${PRODUCTION_OLDEST} (fingerprint ${PRODUCTION_OLDEST})`,
      `matches the development database to the microsecond: no (development fingerprint ${DEVELOPMENT_OLDEST}, recorded ${RECORD_TIMESTAMP})`,
    ]);
  });

  it("says plainly when production matches development to the microsecond", () => {
    const lines = summarizeDataFingerprint({
      target: "production",
      observed: observedFingerprint({
        ...DEVELOPMENT_COUNTS,
        oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
      }),
      expected: expectedFingerprints(),
    });

    expect(lines.at(-1)).toContain(
      "matches the development database to the microsecond: YES",
    );
  });
});

describe("protected-lab identity in a mixed-lineage database", () => {
  const labId = "00000000-0000-4000-8000-000000000234";
  const expected = expectedFingerprints();
  expected.production = { ...expected.production!, labOrganizationId: labId };

  function row(overrides: Record<string, unknown> = {}) {
    return probeRow({ lab_exists: true, ...overrides });
  }

  it("probes only the committed lab, so older imported test cases cannot poison identity", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const verdict = await resolveDataIdentity({
      target: "production", expected,
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [row()] };
      },
    });
    expect(calls).toEqual([{ sql: LAB_DATA_FINGERPRINT_SQL, values: [labId] }]);
    expect(LAB_DATA_FINGERPRINT_SQL).not.toMatch(/\b(insert|update|delete|alter|drop|truncate)\b/i);
    expect(verdict.findings).toEqual([]);
    expect(summarizeDataFingerprint({
      target: "production", expected, observed: verdict.observed!,
    })[0]).toBe(`scope: protected lab ${labId}`);
  });

  it("scopes every counted record set to the committed lab", () => {
    const countLines = LAB_DATA_FINGERPRINT_SQL.split("\n").filter((line) =>
      / as \w+_count,$/.test(line),
    );

    expect(countLines).toHaveLength(FINGERPRINT_COUNTS.length);
    for (const line of countLines) {
      expect(line).toContain("$1");
    }
    // The database-wide probe takes no scope parameter at all.
    expect(DATA_FINGERPRINT_SQL).not.toContain("$1");
  });

  it("counts the lab's media through canonical and legacy cases alike", () => {
    const attachmentLine = LAB_DATA_FINGERPRINT_SQL.split("\n").find((line) =>
      line.endsWith(" as case_attachment_count,"),
    );

    // Exception-note media is bound to a legacy lab case instead of a
    // canonical one, so counting a single link column would let a whole kind
    // of attachment vanish with the gate still reporting a full ledger.
    expect(attachmentLine).toContain("a.case_id in");
    expect(attachmentLine).toContain("public.cases where lab_organization_id = $1");
    expect(attachmentLine).toContain("a.lab_case_id in");
    expect(attachmentLine).toContain("public.lab_cases where organization_id = $1");
  });

  it("blocks a development copy with no protected lab even if fixture counts are high", async () => {
    await expect(resolveDataIdentity({
      target: "production", expected,
      query: async () => ({ rows: [row({ lab_exists: false })] }),
    })).rejects.toThrow(/protected lab .* is missing/);
  });

  it("blocks an unverifiable lab existence result", async () => {
    await expect(readDataFingerprint(
      async () => ({ rows: [row({ lab_exists: undefined })] }), labId,
    )).rejects.toThrow(/existence could not be verified/);
  });

  it("still blocks missing cases and invoices within the protected lab", async () => {
    const verdict = await resolveDataIdentity({
      target: "production", expected,
      query: async () => ({ rows: [row({
        active_case_count: "0", invoice_count: "0", oldest_case_created_at: null,
      })] }),
    });
    expect(verdict.findings.map(f => f.code)).toEqual([
      "no-cases", "active-cases-collapsed", "invoices-collapsed",
    ]);
    expect(verdict.findings.every(f => f.level === "failure")).toBe(true);
  });

  it("blocks a protected lab that arrived without its users or media ledger", async () => {
    const verdict = await resolveDataIdentity({
      target: "production", expected,
      query: async () => ({ rows: [row({
        user_count: "0", case_attachment_count: "0",
      })] }),
    });
    expect(verdict.findings.map(f => f.code)).toEqual([
      "users-collapsed", "case-attachments-collapsed",
    ]);
    expect(verdict.findings.every(f => f.level === "failure")).toBe(true);
  });

  it("still blocks a changed protected-lab timestamp", async () => {
    const verdict = await resolveDataIdentity({
      target: "production", expected,
      query: async () => ({ rows: [row({
        oldest_case_created_at: "2026-01-02T03:04:05.123457Z",
      })] }),
    });
    expect(verdict.findings.map(f => f.code)).toEqual(["lineage-mismatch"]);
  });

  it("fails closed rather than falling back globally when a scope column is absent", async () => {
    let calls = 0;
    const verdict = await resolveDataIdentity({
      target: "production", expected,
      query: async () => {
        calls++;
        throw Object.assign(new Error("missing scope column"), { code: "42703" });
      },
    });
    expect(calls).toBe(1);
    expect(verdict.findings).toEqual([
      expect.objectContaining({ code: "fingerprint-unreadable", level: "failure" }),
    ]);
  });
});

describe("development fingerprint freshness", () => {
  it("stays quiet while the recorded development lineage is current", () => {
    expect(
      codesFor(
        observedFingerprint({
          ...DEVELOPMENT_COUNTS,
          oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
        }),
        expectedFingerprints(),
        "development",
      ),
    ).toEqual([]);
  });

  it("warns, never blocks, when development has been reseeded", () => {
    expect(
      codesFor(
        observedFingerprint({
          ...DEVELOPMENT_COUNTS,
          oldestCaseCreatedAt: "2026-01-03T09:00:00.000001Z",
        }),
        expectedFingerprints(),
        "development",
      ),
    ).toEqual([{ level: "warning", code: "stale-development-fingerprint" }]);
  });

  it("does not judge development against the production counts", () => {
    expect(
      codesFor(
        observedFingerprint({
          activeCaseCount: 1,
          invoiceCount: 1,
          userCount: 1,
          organizationCount: 1,
          doctorProfileCount: 1,
          paymentCount: 1,
          caseAttachmentCount: 1,
          auditHistoryCount: 1,
          oldestCaseCreatedAt: DEVELOPMENT_OLDEST,
        }),
        expectedFingerprints(),
        "development",
      ),
    ).toEqual([]);
  });
});
