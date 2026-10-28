import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildBackupSmokeHelper } from "../../scripts/lib/backup-smoke-helper.mjs";

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("loads the actual bundled backup execution helper without a Vite runtime", async () => {
  root = await mkdtemp(path.join(tmpdir(), "backup-helper-test-"));
  const outfile = path.join(root, "helper.cjs");
  await buildBackupSmokeHelper({
    desktopRoot: fileURLToPath(new URL("../..", import.meta.url)),
    apiOrigin: "http://127.0.0.1:54329",
    outfile,
  });
  const helper = createRequire(import.meta.url)(outfile);
  expect(helper.executeLocalBackup).toBeTypeOf("function");
});

it("refuses to build backup verification against a production endpoint", async () => {
  await expect(buildBackupSmokeHelper({ apiOrigin: "https://example.com" })).rejects.toThrow(/local synthetic API/);
});
