import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SchemaDiffFinding {
  rule: string;
  detail: string;
}

/**
 * Conservative text screening for a proposed SQL migration. This is not a
 * PostgreSQL parser and cannot certify a platform-managed diff as safe.
 */
export function inspectSchemaDiff(sqlText: string): SchemaDiffFinding[] {
  const sql = sqlText.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const checks: Array<{ rule: string; pattern: RegExp; detail: string }> = [
    {
      rule: "drop-operation",
      pattern: /\bDROP\s+(?:TABLE|SCHEMA|DATABASE|COLUMN|TYPE|INDEX|CONSTRAINT|SEQUENCE|VIEW|TRIGGER|FUNCTION)\b/i,
      detail: "DROP operations need a separately reviewed preservation plan.",
    },
    {
      rule: "truncate",
      pattern: /^\s*TRUNCATE\b/im,
      detail: "TRUNCATE removes existing rows.",
    },
    {
      rule: "data-rewrite",
      pattern: /\b(?:UPDATE\s+\S+\s+SET|DELETE\s+FROM|INSERT\s+INTO|COPY\s+\S+[\s\S]*?\bFROM\s+(?:STDIN|['"]))/i,
      detail: "Data rewrites, deletes, inserts, or COPY imports need a separately reviewed scope.",
    },
    {
      rule: "column-type-change",
      pattern: /\bALTER\s+TABLE\b[^;]*\bALTER(?:\s+COLUMN)?\s+\S+\s+(?:TYPE\b|SET\s+DATA\s+TYPE\b)/im,
      detail: "Column type conversions can be lossy and must be reviewed against the exact existing data.",
    },
    {
      rule: "rename",
      pattern: /\bALTER\s+TABLE\b[^;]*\bRENAME\s+(?:COLUMN|TO)\b/im,
      detail: "Renames can strand data or break production compatibility and require explicit review.",
    },
  ];

  return checks.flatMap(({ rule, pattern, detail }) =>
    pattern.test(sql) ? [{ rule, detail }] : [],
  );
}

function main(): void {
  const diffPath = process.env.PUBLISH_SCHEMA_DIFF_PATH?.trim();
  if (!diffPath) {
    console.warn(
      "[publish-safety] MIGRATION SAFETY UNVERIFIED: this build has no proposed platform migration diff. Replit's managed migration must be reviewed in the Publish interface; this build does not certify promotion as safe.",
    );
    console.warn(
      "[publish-safety] A recent, verified off-site production backup is also required. A successful build or backup-history row is not evidence of either check.",
    );
    return;
  }

  let sqlText: string;
  try {
    sqlText = readFileSync(diffPath, "utf8");
  } catch (error) {
    console.error(
      `[publish-safety] BLOCKED: proposed migration diff is unreadable at ${diffPath}`,
      error,
    );
    process.exitCode = 1;
    return;
  }
  if (!sqlText.trim()) {
    console.error(
      `[publish-safety] BLOCKED: proposed migration diff is empty or unreadable at ${diffPath}`,
    );
    process.exitCode = 1;
    return;
  }

  const findings = inspectSchemaDiff(sqlText);
  if (findings.length > 0) {
    console.error(
      `[publish-safety] BLOCKED: proposed migration diff contains ${findings.length} operation(s) that require rejection or separate review:`,
    );
    for (const finding of findings) {
      console.error(`  - ${finding.rule}: ${finding.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.info(
    "[publish-safety] Static scan found no known destructive SQL patterns. Migration safety is still not certified: compare this exact input to Replit's pending diff, verify the production binding, and verify the recent off-site backup before any promotion.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
