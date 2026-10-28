import { lstat, readdir, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { resolve, dirname, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { restoreDatabasePointIsolated } from "./database-protection-restore";
import { verifyProductionPoint, readProductionFile, type ProductionOptions } from "./production-content-protection";

/** Only a newly allocated empty local rehearsal tree; never writes source storage. */
export async function restoreProductionPointIsolated(options: ProductionOptions & {
  marker: string; targetUrl: string; mediaRoot: string; isolationAcknowledged: boolean;
}) {
  const root = resolve(options.mediaRoot);
  const info = await lstat(root);
  if (!options.isolationAcknowledged || info.isSymbolicLink() || !info.isDirectory() ||
      dirname(root) !== resolve(tmpdir()) || !/^labtrax-content-rehearsal-[a-zA-Z0-9]+$/.test(basename(root)) ||
      await realpath(root) !== root || (await readdir(root)).length) {
    throw new Error("Production media restore requires a new empty disposable rehearsal directory.");
  }
  const verified = await verifyProductionPoint(options, options.marker);
  // Original helper enforces loopback, empty target and disposable DB name.
  await restoreDatabasePointIsolated({ ...options, store: options.databaseStore,
    marker: verified.root.databaseMarker });
  for (const file of verified.inventory.files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(root + sep)) throw new Error("Invalid isolated recovery path.");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await readProductionFile(options, file, async bytes => {
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset)).bytesWritten;
      });
      await handle.sync();
    } finally { await handle.close(); }
  }
  await writeFile(resolve(root, "recovery-report.json"), JSON.stringify({
    point: verified.root.point, coverage: verified.root.coverage,
    restoredFiles: verified.inventory.files.length, missingReferences: verified.inventory.missingReferences,
    coverageLimitations: verified.inventory.coverageLimitations,
    limitation: verified.root.coverage === "partial"
      ? "This point has incomplete protection; consult the preserved missing-reference and coverage reports. No files were fabricated."
      : null,
  }), { mode: 0o600, flag: "wx" });
  return { point: verified.root.point, coverage: verified.root.coverage,
    restoredFiles: verified.inventory.files.length, missingFiles: verified.inventory.missingReferences.length };
}
