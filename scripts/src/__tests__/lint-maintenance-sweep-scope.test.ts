import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanTestContent,
  checkRegistry,
  findScopeOption,
  describeReach,
  GUARDED_SWEEPS,
  SCAN_ROOTS,
  ALLOW_MARKER,
  type GuardedSweep,
} from "../lint-maintenance-sweep-scope.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TEST_FILE = "artifacts/api-server/src/routes/some-sweep.test.ts";

/** The first guarded sweep reached as a plain function call. */
const CALL_SWEEP = GUARDED_SWEEPS.find((sweep) => sweep.reach.kind === "call")!;
/** The first guarded sweep reached over HTTP. */
const ENDPOINT_SWEEP = GUARDED_SWEEPS.find((sweep) => sweep.reach.kind === "endpoint")!;

function callName(sweep: GuardedSweep): string {
  if (sweep.reach.kind !== "call") throw new Error("not a call sweep");
  return sweep.reach.call;
}

function endpointPath(sweep: GuardedSweep): string {
  if (sweep.reach.kind !== "endpoint") throw new Error("not an endpoint sweep");
  return sweep.reach.path;
}

/** A throwaway file tree for the registry-rot cases. */
function withTempRepo(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sweep-scope-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("lint-maintenance-sweep-scope — an unscoped sweep in a test fails", () => {
  it("flags a guarded call with no scope option", () => {
    const content = `it("migrates", async () => {
  const report = await ${callName(CALL_SWEEP)}({ dryRun: false, limit: 5 });
  expect(report.migratedCases).toBe(1);
});
`;
    const violations = scanTestContent(content, TEST_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].sweepId).toBe(CALL_SWEEP.id);
    expect(violations[0].line).toBe(2);
    expect(violations[0].file).toBe(TEST_FILE);
    expect(violations[0].reason).toContain(CALL_SWEEP.scopeOption);
    expect(violations[0].reason).toContain(CALL_SWEEP.sweeps);
  });

  it("flags the call under a module alias", () => {
    const content = `const report = await lib.${callName(CALL_SWEEP)}({ dryRun: true });\n`;
    expect(scanTestContent(content, TEST_FILE)).toHaveLength(1);
  });

  it("accepts a call that passes the scope", () => {
    const content = `const report = await ${callName(CALL_SWEEP)}({
  dryRun: false,
  ${CALL_SWEEP.scopeOption}: [id],
});
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("accepts the shorthand a runScoped helper uses", () => {
    const content = `async function runScoped(ids, options = {}) {
  return ${callName(CALL_SWEEP)}({ limit: 200, ...options, ${CALL_SWEEP.scopeOption} });
}
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("does not accept a scope that scopes nothing", () => {
    const content = `await ${callName(CALL_SWEEP)}({ ${CALL_SWEEP.scopeOption}: undefined });\n`;
    const violations = scanTestContent(content, TEST_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("scopes nothing");
  });

  it("ignores the name in a comment", () => {
    const content = `// ${callName(CALL_SWEEP)}({ dryRun: false }) would sweep the whole table.
 * ${callName(CALL_SWEEP)}({ limit: 5 }) is what production does.
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("reports each unscoped call site, not just the first", () => {
    const content = `await ${callName(CALL_SWEEP)}({ dryRun: true });
await ${callName(CALL_SWEEP)}({ ${CALL_SWEEP.scopeOption}: [id] });
await ${callName(CALL_SWEEP)}({ dryRun: false });
`;
    expect(scanTestContent(content, TEST_FILE).map((v) => v.line)).toEqual([1, 3]);
  });
});

describe("lint-maintenance-sweep-scope — an admin route is a sweep too", () => {
  it("flags a request that sends no scope", () => {
    const content = `const res = await request(app)
  .post("${endpointPath(ENDPOINT_SWEEP)}")
  .set("X-Platform-Admin-Secret", secret)
  .send({ dryRun: false, confirm: CONFIRM });
`;
    const violations = scanTestContent(content, TEST_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].sweepId).toBe(ENDPOINT_SWEEP.id);
    expect(violations[0].reason).toContain(describeReach(ENDPOINT_SWEEP));
  });

  it("accepts a request whose body carries the scope, however far down the chain", () => {
    const content = `const res = await request(app)
  .post("${endpointPath(ENDPOINT_SWEEP)}")
  .set("X-Platform-Admin-Secret", secret)
  .send({
    ${ENDPOINT_SWEEP.scopeOption}: ownId,
    dryRun: false,
  });
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("sees the scope in a non-supertest client too", () => {
    const content = `await fetch("${endpointPath(ENDPOINT_SWEEP)}", {
  method: "POST",
  body: JSON.stringify({ ${ENDPOINT_SWEEP.scopeOption}: ownId }),
});
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("sees the URL built from a base-url template", () => {
    const unscoped = "await fetch(`${base}" + endpointPath(ENDPOINT_SWEEP) + "`, { method: \"POST\" });\n";
    expect(scanTestContent(unscoped, TEST_FILE)).toHaveLength(1);
    const scoped =
      "await fetch(`${base}" +
      endpointPath(ENDPOINT_SWEEP) +
      `?dryRun=false\`, { body: JSON.stringify({ ${ENDPOINT_SWEEP.scopeOption}: ownId }) });\n`;
    expect(scanTestContent(scoped, TEST_FILE)).toEqual([]);
  });

  it("does not let a later statement's scope cover an unscoped request", () => {
    const content = `await request(app).post("${endpointPath(ENDPOINT_SWEEP)}").send({});
const other = { ${ENDPOINT_SWEEP.scopeOption}: ownId };
`;
    expect(scanTestContent(content, TEST_FILE)).toHaveLength(1);
  });
});

describe("lint-maintenance-sweep-scope — the escape hatch has to say why", () => {
  it("allows a deliberately unscoped call that carries a reason", () => {
    const content = `const res = await request(app)
  .post("${endpointPath(ENDPOINT_SWEEP)}")
  // ${ALLOW_MARKER} the missing scope IS the assertion — the route answers 400
  // before it reads a row.
  .send({});
`;
    expect(scanTestContent(content, TEST_FILE)).toEqual([]);
  });

  it("rejects a bare marker with no reason", () => {
    const content = `await ${callName(CALL_SWEEP)}({ dryRun: false }); // ${ALLOW_MARKER}\n`;
    const violations = scanTestContent(content, TEST_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("no reason");
  });

  it("does not let a marker elsewhere in the file cover a later call", () => {
    const content = `await ${callName(CALL_SWEEP)}({ ${CALL_SWEEP.scopeOption}: [id] }); // ${ALLOW_MARKER} documented
await ${callName(CALL_SWEEP)}({ dryRun: false });
`;
    const violations = scanTestContent(content, TEST_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });
});

describe("findScopeOption", () => {
  it("does not match a key that merely ends with the option name", () => {
    expect(findScopeOption("{ excludedCaseIds: [id] }", "caseIds").present).toBe(false);
    expect(findScopeOption("{ report.caseIds }", "caseIds").present).toBe(false);
  });

  it("matches an empty array — scoping to nothing is still a scope", () => {
    expect(findScopeOption("{ caseIds: [] }", "caseIds").present).toBe(true);
  });
});

describe("lint-maintenance-sweep-scope — the registry cannot rot", () => {
  it("every guarded entry matches the sweep it names today", () => {
    expect(checkRegistry()).toEqual([]);
  });

  it("names a scope option, a source, and what an unscoped run reaches", () => {
    expect(GUARDED_SWEEPS.length).toBeGreaterThan(0);
    for (const sweep of GUARDED_SWEEPS) {
      expect(sweep.scopeOption).not.toBe("");
      expect(sweep.sweeps).not.toBe("");
      expect(sweep.source).toMatch(/\.ts$/);
    }
  });

  it("fails when the sweep's file has moved away", () => {
    const entry: GuardedSweep = {
      id: "gone",
      reach: { kind: "call", call: "runSomeSweep" },
      scopeOption: "caseIds",
      source: "artifacts/api-server/src/lib/not-here.ts",
      sweeps: "every row",
    };
    withTempRepo({}, (root) => {
      expect(checkRegistry([entry], root).join(" ")).toContain("is gone");
    });
  });

  it("fails when the sweep has been renamed", () => {
    const entry: GuardedSweep = {
      id: "renamed",
      reach: { kind: "call", call: "runSomeSweep" },
      scopeOption: "caseIds",
      source: "lib/sweep.ts",
      sweeps: "every row",
    };
    withTempRepo(
      { "lib/sweep.ts": "export async function runSomeSweepV2(o: { caseIds?: string[] }) {}\n" },
      (root) => {
        expect(checkRegistry([entry], root).join(" ")).toContain("no longer exports");
      },
    );
  });

  it("fails when the option that scopes the sweep is gone", () => {
    const entry: GuardedSweep = {
      id: "unscopable",
      reach: { kind: "call", call: "runSomeSweep" },
      scopeOption: "caseIds",
      source: "lib/sweep.ts",
      sweeps: "every row",
    };
    withTempRepo(
      { "lib/sweep.ts": "export async function runSomeSweep(o: { limit?: number }) {}\n" },
      (root) => {
        expect(checkRegistry([entry], root).join(" ")).toContain("takes no `caseIds` option");
      },
    );
  });

  it("fails when the guarded route has moved or stopped reading its scope", () => {
    const moved: GuardedSweep = {
      id: "moved-route",
      reach: { kind: "endpoint", method: "post", path: "/api/admin/sweep" },
      scopeOption: "organizationId",
      source: "routes.ts",
      sweeps: "every row",
    };
    withTempRepo(
      { "routes.ts": 'router.post("/admin/other", h);\nconst id = body.organizationId;\n' },
      (root) => {
        expect(checkRegistry([moved], root).join(" ")).toContain("registers no POST");
      },
    );
    withTempRepo(
      { "routes.ts": 'router.post("/admin/sweep", h);\nconst id = body.labId;\n' },
      (root) => {
        expect(checkRegistry([moved], root).join(" ")).toContain("no longer reads");
      },
    );
  });

  it("catches a duplicated entry id", () => {
    const entry = GUARDED_SWEEPS[0];
    expect(checkRegistry([entry, entry]).join(" ")).toContain("duplicate entry id");
  });
});

describe("lint-maintenance-sweep-scope — the suites that call these sweeps today", () => {
  it.each(
    // The real callers, read from disk: the guard has to stay green on them,
    // and a future loosening of one of these files fails here as well as in CI.
    [
      "artifacts/api-server/src/routes/legacy-case-media-externalize.test.ts",
      "artifacts/api-server/src/routes/sdr1-legacy-cleanup.test.ts",
    ],
  )("%s scopes every sweep it runs", (rel) => {
    const content = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    expect(scanTestContent(content, rel)).toEqual([]);
  });

  it("scans the packages whose tests can reach a database", () => {
    expect(SCAN_ROOTS).toContain("artifacts/api-server/src");
  });
});
