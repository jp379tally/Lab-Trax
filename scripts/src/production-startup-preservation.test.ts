import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const TSX = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const FIXTURE = resolve(
  REPO_ROOT,
  "scripts",
  "fixtures",
  "production-startup-maintenance.ts",
);

describe("production startup data preservation", () => {
  it("defers historical writers even when every one-time completion flag is absent", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };

    const result = spawnSync(TSX, [FIXTURE], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      result: { scheduled: string[]; deferred: string[] };
      state: {
        completionFlags: string[];
        vendorId: string | null;
        dueDate: string;
        expectedDeliveryDate: string | null;
        restorationRows: string[];
        invoiceStatus: string;
        invoices: string[];
        mediaFiles: string[];
        mediaReference: string;
      };
    };
    expect(output.result.scheduled).toEqual([]);
    expect(output.result.deferred).toHaveLength(6);
    expect(output.state).toEqual({
      completionFlags: [],
      vendorId: null,
      dueDate: "2026-10-20",
      expectedDeliveryDate: "2026-10-10",
      restorationRows: ["upper", "lower"],
      invoiceStatus: "draft",
      invoices: [],
      mediaFiles: ["case-photo.jpg"],
      mediaReference: "case-photo.jpg",
    });
  }, 40_000);

  it("fails closed when deployment context is missing or ambiguous", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_ENV;
    const result = spawnSync(TSX, [FIXTURE], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      result: { scheduled: string[]; deferred: string[] };
      state: { restorationRows: string[]; expectedDeliveryDate: string | null };
    };
    expect(output.result.scheduled).toEqual([]);
    expect(output.result.deferred).toHaveLength(6);
    expect(output.state.restorationRows).toEqual(["upper", "lower"]);
    expect(output.state.expectedDeliveryDate).toBe("2026-10-10");
  }, 40_000);

  it("only enables those jobs in an explicitly identified development process", () => {
    const result = spawnSync(TSX, [FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "development" },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      result: { scheduled: string[]; deferred: string[] };
      state: {
        vendorId: string | null;
        expectedDeliveryDate: string | null;
        restorationRows: string[];
        invoiceStatus: string;
        invoices: string[];
        mediaFiles: string[];
      };
    };
    expect(output.result.scheduled).toHaveLength(6);
    expect(output.result.deferred).toEqual([]);
    expect(output.state.vendorId).toBe("inferred-vendor");
    expect(output.state.expectedDeliveryDate).toBeNull();
    expect(output.state.restorationRows).toEqual(["upper"]);
    expect(output.state.invoiceStatus).toBe("open");
    expect(output.state.invoices).toEqual(["new-historical-invoice"]);
    expect(output.state.mediaFiles).toEqual([]);
  }, 40_000);

  it("wires the guarded registration into API startup and keeps duplicate consolidation dev-only", () => {
    const index = readFileSync(
      resolve(REPO_ROOT, "artifacts/api-server/src/index.ts"),
      "utf8",
    );
    expect(index).toContain("registerHistoricalStartupJobs([");
    for (const entryPoint of [
      "scheduleVendorLinkBackfillIfNeeded",
      "scheduleLabInboxStorageRepair",
      "scheduleExpectedDeliveryDateBackfillIfNeeded",
      "scheduleRemovableRestorationCollapseBackfillIfNeeded",
      "scheduleRecentCaseInvoiceRepair",
      "migrateDraftInvoicesToOpen",
      "migrateInvoiceIssuedAt",
      "backfillLegacyCaseMedia",
    ]) {
      expect(index).toContain(entryPoint);
    }

    const consolidation = readFileSync(
      resolve(
        REPO_ROOT,
        "artifacts/api-server/src/lib/doctor-account-consolidation.ts",
      ),
      "utf8",
    );
    expect(consolidation).toContain('process.env.NODE_ENV === "development"');

    const demoSeeds = readFileSync(
      resolve(REPO_ROOT, "artifacts/api-server/src/routes/labtrax-routes.ts"),
      "utf8",
    );
    expect(demoSeeds).toContain('process.env.NODE_ENV === "development"');
  });

  it("does not perform stuck-media-run recovery while arming the recurring cleanup timer", () => {
    const caseMedia = readFileSync(
      resolve(REPO_ROOT, "artifacts/api-server/src/lib/case-media.ts"),
      "utf8",
    );
    const scheduler = caseMedia.slice(
      caseMedia.indexOf("export function startDailyOrphanedMediaCleanup"),
    );
    expect(scheduler).not.toContain("recoverStuckCleanupRuns().then");
    expect(scheduler).toContain("setTimeout(tick, initialDelay)");
    expect(scheduler).toContain('runAndPersistCleanup("scheduler"');
  });

  it("keeps accounting constraint installation but removes the startup-wide historical rewrite", () => {
    const constraints = readFileSync(
      resolve(REPO_ROOT, "artifacts/api-server/src/lib/db-constraints.ts"),
      "utf8",
    );
    const setupStart = constraints.indexOf("const SETUP_SQL");
    const setupEnd = constraints.indexOf("/**", setupStart);
    const setupSql = constraints.slice(setupStart, setupEnd);
    expect(setupSql).not.toContain("INVOICE_ACCOUNTING_BASELINE_SQL");
    expect(setupSql).not.toContain("INVOICE_ACCOUNTING_BASELINE_REPAIR_SQL");
    expect(setupSql).toContain("CREATE TRIGGER invoices_record_accounting_event");

    const trigger = setupSql.slice(
      setupSql.indexOf("CREATE OR REPLACE FUNCTION record_invoice_accounting_event"),
    );
    expect(trigger).toContain("NOT EXISTS");
    expect(trigger).toContain("OLD.total");
    expect(constraints).toContain("Historical invoice accounting baseline/reconciliation is deferred");
  });
});
