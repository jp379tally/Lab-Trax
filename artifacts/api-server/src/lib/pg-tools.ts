import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/**
 * PostgreSQL client programs the backup/restore pipeline shells out to.
 *
 * Published artifact processes start with a minimal PATH that does not contain
 * the Nix toolchain, so a bare `spawn("pg_dump")` fails with ENOENT on the
 * production VM even though it resolves fine in the dev workspace. The image
 * build packages both programs (with their ELF loader and shared libraries)
 * under `.production-runtime/bin`; this module finds that packaged copy first
 * and only falls back to PATH for the development workspace.
 */
export type PostgresClientTool = "pg_dump" | "pg_restore";

/** Project-relative directory the production image writes its launchers to. */
const PACKAGED_BIN_RELATIVE = path.join(".production-runtime", "bin");

/** How far up from a starting directory to look for the packaged runtime. */
const MAX_PARENT_LOOKUPS = 6;

const resolvedCache = new Map<PostgresClientTool, string>();

function moduleDirectory(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function ancestorDirectories(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  for (let i = 0; i <= MAX_PARENT_LOOKUPS; i += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories that may hold the packaged client tools, most specific first.
 *
 * LABTRAX_PG_BIN_DIR names one directory explicitly and is authoritative: when
 * it is set, no discovery is attempted. Searching on past it would make the
 * variable advisory rather than an override, and an operator who points it at
 * the wrong directory would get a silently different binary instead of the
 * PATH fallback and the log line that say so.
 */
function candidateBinDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.LABTRAX_PG_BIN_DIR?.trim();
  if (override) return [path.resolve(override)];

  const roots = [process.cwd(), moduleDirectory()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const root of roots) {
    for (const dir of ancestorDirectories(root)) {
      dirs.push(path.join(dir, PACKAGED_BIN_RELATIVE));
    }
  }
  return dirs;
}

/**
 * Absolute path to a packaged client tool, or null when this process is not
 * running against a prepared production image.
 */
export function findPackagedPostgresTool(tool: PostgresClientTool): string | null {
  const seen = new Set<string>();
  for (const dir of candidateBinDirs()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, tool);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The command to spawn for a PostgreSQL client tool.
 *
 * Returns the packaged launcher when one exists, otherwise the bare program
 * name so the development workspace keeps resolving it from PATH. The result
 * is cached because it cannot change inside one process lifetime.
 */
export function resolvePostgresTool(tool: PostgresClientTool): string {
  const cached = resolvedCache.get(tool);
  if (cached) return cached;

  const packaged = findPackagedPostgresTool(tool);
  const resolved = packaged ?? tool;
  resolvedCache.set(tool, resolved);
  logger.info(
    { tool, resolved, packaged: packaged !== null },
    packaged !== null
      ? "[backup] Using packaged PostgreSQL client tool"
      : "[backup] No packaged PostgreSQL client tool found; falling back to PATH",
  );
  return resolved;
}

/** Test-only: drop the memoized resolutions so a new layout can be observed. */
export function _resetPostgresToolCacheForTests(): void {
  resolvedCache.clear();
}
