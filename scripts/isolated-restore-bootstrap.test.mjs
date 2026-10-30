import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const harness = fileURLToPath(new URL("./run-isolated-backup-restore.sh", import.meta.url));

test("restore bootstrap reaches its schema boundary from a deep workspace using authenticated TLS", () => {
  const root = mkdtempSync(join(tmpdir(), "restore-bootstrap-regression-"));
  try {
    const scratch = join(root, "deep-workspace-segment".repeat(6));
    const bin = join(root, "bin");
    const log = join(root, "bootstrap.jsonl");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(scratch, ".labtrax-test-scratch-owner"), "labtrax-workspace-test-scratch-v1");
    assert.ok(Buffer.byteLength(join(scratch, "labtrax-restore-gate.12345678", "socket", ".s.PGSQL.54321")) > 107);
    const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const record = data => fs.appendFileSync(process.env.BOOTSTRAP_LOG, JSON.stringify({ name, ...data }) + "\\n");
if (name === "initdb") {
  fs.mkdirSync(value("-D"), { recursive: true });
  record({ scram: args.includes("--auth-host=scram-sha-256") });
} else if (name === "pg_ctl" && args.includes("start")) {
  const config = fs.readFileSync(path.join(value("-D"), "postgresql.conf"), "utf8");
  const options = value("-o") || "";
  const explicit = options.match(/(?:^|\\s)-k\\s+([^ ]+)/)?.[1];
  const disabled = /^unix_socket_directories\\s*=\\s*''\\s*$/m.test(config);
  if (explicit && Buffer.byteLength(path.join(explicit, ".s.PGSQL.54321")) > 107) {
    fs.writeFileSync(value("-l"), "Unix-domain socket path is too long (maximum 107 bytes).\\n");
    process.stderr.write("Unix-domain socket path is too long (maximum 107 bytes).\\n");
    process.exit(1);
  }
  record({ unixSocketsDisabled: disabled, loopback: /-h 127\\.0\\.0\\.1(?:\\s|$)/.test(options) });
} else if (name === "createdb") {
  const authenticated = /^[a-f0-9]{64}$/.test(process.env.PGPASSWORD || "");
  const verifiedTls = process.env.PGSSLMODE === "verify-full" && fs.existsSync(process.env.PGSSLROOTCERT || "");
  const loopback = value("-h") === "127.0.0.1";
  record({ authenticated, verifiedTls, loopback });
  if (!authenticated || !verifiedTls || !loopback) process.exit(1);
} else if (name === "psql") {
  record({ verifiedTls: args[0]?.includes("sslmode=verify-full") });
  process.stdout.write("t\\n");
} else if (name === "pnpm") {
  process.stderr.write("SYNTHETIC_SCHEMA_BOUNDARY_REACHED\\n");
  process.exit(23);
}
`;
    for (const tool of ["initdb", "pg_ctl", "pg_dump", "createdb", "psql", "pnpm"]) {
      writeFileSync(join(bin, tool), stub, { mode: 0o755 });
    }
    const result = spawnSync("bash", [harness], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: [bin, dirname(process.execPath), process.env.PATH].join(":"),
        LABTRAX_TEST_SCRATCH_ROOT: scratch, TMPDIR: scratch, BOOTSTRAP_LOG: log,
        LABTRAX_BACKUP_ARCHIVE_PATH: "" },
    });
    assert.equal(result.error, undefined);
    // The fake package runner deliberately stops before schema creation.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SYNTHETIC_SCHEMA_BOUNDARY_REACHED/);
    const events = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.find(e => e.name === "initdb")?.scram, true);
    assert.deepEqual(events.find(e => e.name === "pg_ctl"), { name: "pg_ctl", unixSocketsDisabled: true, loopback: true });
    assert.deepEqual(events.find(e => e.name === "createdb"), { name: "createdb", authenticated: true, verifiedTls: true, loopback: true });
    assert.equal(events.find(e => e.name === "psql")?.verifiedTls, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
