import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Dedicated config for the backup/restore integrity gate (rel-backup-restore).
//
// These suites perform DB-WIDE destructive pg_restore runs, so they are
// excluded from the default full-suite config (vitest.config.ts) — running
// them alongside sibling DB-integration files corrupts both directions
// (restore truncates tables under siblings; sibling writes skew the restore's
// post-restore count validation). Run ONLY through
// scripts/run-isolated-backup-restore.sh (schema-only disposable DB/uploads).
// See REGRESSION_GUARDRAILS.md → "DB Serialization Rule (with-db-lock)".
// Run order, not just file membership.
//
// Vitest's default sequencer orders files by size (or by cached duration), so
// the order shifts whenever a file is edited. These suites share one database
// and several of them record successful OneDrive runs, while the schedule and
// alarm assertions read "the newest off-site success" from that same history.
// Whoever runs first therefore decides whether the later file sees a clean
// slate — a real failure one week and a pass the next. Pin it: history-reading
// suites first, history-writing suites after them.
const GATE_RUN_ORDER = [
  "src/lib/pg-tools.test.ts",
  "src/routes/backup-destinations.test.ts",
  "src/routes/restore-session.test.ts",
  "src/routes/backup-restore.test.ts",
  "src/routes/onedrive-restore-integrity.test.ts",
  "src/routes/onedrive-offsite-restore.test.ts",
  "src/routes/google-drive-offsite-restore.test.ts",
  "src/routes/offsite-job.test.ts",
];

class GateOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (spec: TestSpecification): number => {
      const i = GATE_RUN_ORDER.findIndex((p) => spec.moduleId.endsWith(p));
      return i === -1 ? GATE_RUN_ORDER.length : i;
    };
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    sequence: { sequencer: GateOrderSequencer },
    include: [
      "src/routes/backup-restore.test.ts",
      "src/routes/restore-session.test.ts",
      "src/routes/onedrive-restore-integrity.test.ts",
      "src/routes/case-organization-repair.test.ts",
      "src/routes/organization-audit-recovery-rehearsal.test.ts",
      // Real OneDrive round trip: upload → Graph read-back → download →
      // restore. Belongs here because the restore is DB-wide and destructive.
      "src/routes/onedrive-offsite-restore.test.ts",
      // Real Google Drive round trip: upload → exact-ID download → byte
      // comparison → restore. Like OneDrive, it is destructive and isolated.
      "src/routes/google-drive-offsite-restore.test.ts",
      // The published server resolves pg_dump/pg_restore from the packaged
      // production image, not from PATH. The gate stages that layout (see
      // scripts/run-isolated-backup-restore.sh), so the resolution itself is
      // checked here rather than only in the dev-workspace test run.
      "src/lib/pg-tools.test.ts",
      // Schedule persistence, run deadlines, archive kind and naming: the
      // four defects that let scheduled backups stop silently.
      "src/routes/backup-destinations.test.ts",
      // The off-site job itself (real dump, mocked OneDrive): the timer that
      // actually produces production's archives, rather than the helpers it
      // calls. Gate-only — it skips without the disposable database.
      "src/routes/offsite-job.test.ts",
    ],
    env: {
      // Same hermeticity/pool settings as the main config (vitest.config.ts).
      LABTRAX_ENABLE_DEMO_SEEDS: "false",
      LOG_LEVEL: "silent",
      DB_POOL_MAX: "5",
      DB_CONNECT_TIMEOUT_MS: "60000",
    },
    pool: "forks",
    // Restore suites perform DB-wide restore operations. They must not overlap
    // even inside the disposable database.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // The gate copies the package into a temp tree, so Vite transforms the
    // whole route graph from cold on every run. Importing the Express app
    // alone costs ~90 s there, which is the hook budget by itself.
    hookTimeout: 300000,
    testTimeout: 300000,
  },
});
