#!/usr/bin/env tsx
/**
 * One-shot maintenance command for Task #4373 — consolidate the duplicate
 * provider accounts that already exist.
 *
 * Practices accumulated several provider *user accounts* for the same person
  * (four "Synthetic Provider Alpha", two "Synthetic Provider Beta" in one practice alone).
 * This walks every lab, clusters provider accounts inside one lab + practice
 * with the shared doctor-similarity matcher, and consolidates each unambiguous
 * cluster onto the account holding the oldest account number. Clusters whose
 * identity signals conflict (two different emails or phones) are reported and
 * left alone — they surface in the duplicate-suspects panel for an admin.
 *
 * Usage (dry run is the default — nothing is written):
 *
 *   pnpm --filter @workspace/scripts run consolidate-duplicate-doctor-accounts
 *   pnpm --filter @workspace/scripts run consolidate-duplicate-doctor-accounts -- --apply
 *   pnpm --filter @workspace/scripts run consolidate-duplicate-doctor-accounts -- --lab=<labId> --apply
 *
 * Re-running after an --apply is a no-op: the retired accounts are
 * soft-deleted and detection only ever loads live accounts.
 */
import path from "node:path";

// Loaded at runtime (like the other maintenance entry points) so this stays a
// thin launcher: the API implementation owns detection, locking, the
// transaction, and the audit/undo record.
const workspaceRoot = process.cwd().endsWith(`${path.sep}scripts`)
  ? path.resolve(process.cwd(), "..")
  : process.cwd();
const { sweepDuplicateProviderAccounts } = await import(
  path.resolve(
    workspaceRoot,
    "artifacts/api-server/src/lib/doctor-account-consolidation.ts"
  )
);

function parseArgs(argv: string[]): { apply: boolean; labIds: string[] } {
  const labIds: string[] = [];
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--lab=")) {
      const v = arg.slice("--lab=".length).trim();
      if (v) labIds.push(v);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Consolidate duplicate provider accounts.",
          "",
          "  --apply        actually write (default is a dry-run preview)",
          "  --lab=<id>     restrict to one lab (repeatable)",
        ].join("\n")
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { apply, labIds };
}

async function main() {
  const { apply, labIds } = parseArgs(process.argv.slice(2));
  const dryRun = !apply;

  console.log(
    dryRun
      ? "[consolidate-doctor-accounts] DRY RUN — no changes will be written. Re-run with --apply to commit."
      : "[consolidate-doctor-accounts] APPLYING changes."
  );
  if (labIds.length > 0) {
    console.log(`[consolidate-doctor-accounts] Labs: ${labIds.join(", ")}`);
  }

  const report = await sweepDuplicateProviderAccounts({
    labIds: labIds.length > 0 ? labIds : undefined,
    dryRun,
    actorUserId: null,
    trigger: dryRun ? "maintenance-script (dry run)" : "maintenance-script",
  });

  console.log("");
  console.log(
    `Labs scanned: ${report.labsScanned}   Clusters found: ${report.clustersFound}`
  );
  console.log("");

  for (const c of report.clusters) {
    const names = Array.from(new Set(c.doctorNames)).join(" / ");
    const marker =
      c.outcome === "skipped-conflicting"
        ? "SKIP"
        : c.outcome === "would-consolidate"
          ? "WOULD"
          : "DONE";
    console.log(
      `[${marker}] ${names} — lab ${c.labOrganizationId}, practice ${
        c.providerOrganizationId ?? "(unassigned)"
      }`
    );
    console.log(
      `        accounts: ${c.accountNumbers.join(", ")}  (score ${c.topScore.toFixed(2)})`
    );
    if (c.outcome === "skipped-conflicting") {
      console.log(`        reason: ${c.conflictReason}`);
    } else {
      console.log(
        `        survivor: ${c.survivorAccountNumber ?? "(no number)"} (${c.survivorUserId})`
      );
      console.log(
        `        retiring: ${c.retiredUserIds.length} account(s)${
          c.outcome === "consolidated"
            ? `, ${c.referencesMoved} reference(s) moved, audit ${c.auditLogId}`
            : ""
        }`
      );
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(
    `${dryRun ? "Would consolidate" : "Consolidated"}: ${report.clustersConsolidated} cluster(s), ` +
      `${report.accountsRetired} account(s) retired`
  );
  console.log(
    `Left for an admin (conflicting identity signals): ${report.clustersSkippedConflicting} cluster(s)`
  );
  if (dryRun && report.clustersConsolidated > 0) {
    console.log("");
    console.log("Re-run with --apply to commit these changes.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[consolidate-doctor-accounts] FAILED:", err);
    process.exit(1);
  });
