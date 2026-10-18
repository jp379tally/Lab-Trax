/**
 * Resolution of the PostgreSQL client programs the backup pipeline shells out
 * to.
 *
 * The published artifact process starts with a minimal PATH that has no Nix
 * toolchain, so a bare spawn("pg_dump") fails there with ENOENT while the dev
 * workspace keeps working. That asymmetry is why the production server took no
 * backups for weeks and the gate still passed. These tests pin the packaged
 * lookup so a regression shows up here rather than in production logs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  _resetPostgresToolCacheForTests,
  findPackagedPostgresTool,
  resolvePostgresTool,
} from "./pg-tools.js";

/** Create <root>/.production-runtime/bin/<tool> executables. */
function stagePackagedTools(root: string, tools: string[]): string {
  const binDir = path.join(root, ".production-runtime", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of tools) {
    const file = path.join(binDir, tool);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return binDir;
}

describe("PostgreSQL client tool resolution", () => {
  let tmpRoot: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-pg-tools-"));
    _resetPostgresToolCacheForTests();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    _resetPostgresToolCacheForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("finds the packaged launcher through the explicit override", () => {
    const binDir = stagePackagedTools(tmpRoot, ["pg_dump", "pg_restore"]);
    vi.stubEnv("LABTRAX_PG_BIN_DIR", binDir);

    expect(findPackagedPostgresTool("pg_dump")).toBe(path.join(binDir, "pg_dump"));
    expect(resolvePostgresTool("pg_restore")).toBe(path.join(binDir, "pg_restore"));
  });

  it("finds the packaged launcher relative to the process working directory", () => {
    // Production runs `.production-runtime/bin/node … .production-api/dist/index.mjs`
    // with cwd at the project root, and the API's own files sit several levels
    // below it — so the lookup has to walk up, not just check cwd.
    const binDir = stagePackagedTools(tmpRoot, ["pg_dump", "pg_restore"]);
    const nested = path.join(tmpRoot, "artifacts", "api-server");
    fs.mkdirSync(nested, { recursive: true });
    vi.stubEnv("LABTRAX_PG_BIN_DIR", "");
    process.chdir(nested);

    expect(findPackagedPostgresTool("pg_dump")).toBe(path.join(binDir, "pg_dump"));
  });

  it("treats the explicit override as authoritative, ignoring a discoverable image", () => {
    // Staged where discovery WOULD find it (cwd ancestor), so this is not a
    // vacuous assertion: without override exclusivity the call below returns
    // this launcher instead of null.
    const discoverable = stagePackagedTools(tmpRoot, ["pg_dump"]);
    const nested = path.join(tmpRoot, "artifacts", "api-server");
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(findPackagedPostgresTool("pg_dump")).toBe(path.join(discoverable, "pg_dump"));

    const empty = path.join(tmpRoot, "elsewhere");
    fs.mkdirSync(empty, { recursive: true });
    vi.stubEnv("LABTRAX_PG_BIN_DIR", empty);
    _resetPostgresToolCacheForTests();

    expect(findPackagedPostgresTool("pg_dump")).toBeNull();
  });

  it("ignores a staged path that is not executable", () => {
    const binDir = path.join(tmpRoot, ".production-runtime", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // A directory, and a non-executable file: neither is a usable launcher, and
    // treating either as one would turn a build mistake into a runtime ENOENT.
    fs.mkdirSync(path.join(binDir, "pg_dump"));
    fs.writeFileSync(path.join(binDir, "pg_restore"), "not executable");
    fs.chmodSync(path.join(binDir, "pg_restore"), 0o644);
    vi.stubEnv("LABTRAX_PG_BIN_DIR", binDir);

    expect(findPackagedPostgresTool("pg_dump")).toBeNull();
    expect(findPackagedPostgresTool("pg_restore")).toBeNull();
  });

  it("falls back to the bare program name for the development workspace", () => {
    const empty = path.join(tmpRoot, "empty");
    fs.mkdirSync(empty, { recursive: true });
    vi.stubEnv("LABTRAX_PG_BIN_DIR", empty);
    process.chdir(empty);

    // No packaged image here, so PATH resolution must still work — the dev
    // workspace has the Nix toolchain and relies on it.
    expect(resolvePostgresTool("pg_dump")).toBe("pg_dump");
  });

  it("memoizes the resolution for the lifetime of the process", () => {
    const binDir = stagePackagedTools(tmpRoot, ["pg_dump"]);
    vi.stubEnv("LABTRAX_PG_BIN_DIR", binDir);
    const first = resolvePostgresTool("pg_dump");

    // Removing the launcher afterwards must not change an already-resolved
    // command: it cannot move under a running process, and re-statting on
    // every spawn would be pure overhead.
    fs.rmSync(path.join(binDir, "pg_dump"));
    expect(resolvePostgresTool("pg_dump")).toBe(first);
  });
});
