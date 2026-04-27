import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const zipPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!zipPath) {
  console.error("usage: node scripts/apply-hotfix.mjs <zip> [--dry-run]");
  process.exit(1);
}

const zip = new AdmZip(zipPath);
const entries = zip.getEntries();
console.log(`Entries: ${entries.length}`);
for (const e of entries) {
  if (e.isDirectory) continue;
  const normalized = e.entryName.replace(/\\/g, "/");
  const target = resolve(process.cwd(), normalized);
  const size = e.header.size;
  console.log(`${dryRun ? "[dry] " : ""}${normalized}  (${size} bytes)`);
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.getData());
  }
}
