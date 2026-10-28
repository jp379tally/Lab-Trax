import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { Archiver } from "archiver";
import type { CompleteBackupCaptured } from "./complete-backup";
import type { ProductionCapture } from "./production-content-protection";
import type { ProductionFile } from "./production-content-protection";
import { DatabaseProtectionError } from "./database-protection";
import { backupErrorMessage } from "./backup-error-copy";

/** Reuse snapshot/reference/generation checks without rebuilding a ZIP. */
export async function captureProductionMedia(
  captured: Pick<CompleteBackupCaptured, "append" | "manifest" | "productionMediaSources">,
  write: Parameters<ProductionCapture["captureMedia"]>[0],
  selectPaths: Parameters<ProductionCapture["captureMedia"]>[1],
) {
  const sink = new EventEmitter() as EventEmitter & {
    append: (data: Readable | string | Buffer, options: { name: string }) => unknown;
    pointer: () => number; destroy: (error?: Error) => void;
  };
  let bytes = 0; let failure: Error | undefined;
  const written = new Map<string, ProductionFile>();
  const sourceVersions = captured.productionMediaSources.map(source => ({
    archivePath: source.archivePath,
    size: source.size,
    sourceVersion: source.sourceVersion,
  }));
  const included = selectPaths(sourceVersions, captured.manifest.productionMediaJournal);
  const selectedSources = sourceVersions.filter(source => included.has(source.archivePath));
  const selectedNames = new Set(selectedSources.map(source => source.archivePath));
  const sourceByPath = new Map(sourceVersions.map(source => [source.archivePath, source]));
  sink.on("error", (error: Error) => { failure ??= error; });
  sink.pointer = () => bytes;
  sink.destroy = error => { if (error) sink.emit("error", error); else sink.emit("close"); };
  sink.append = (data, { name }) => {
    // These are represented in the authenticated recovery inventory instead.
    if (typeof data === "string" || Buffer.isBuffer(data)) return sink;
    const destination = name.startsWith("media/") ? `case-media/${name.slice("media/".length)}` : name;
    const source = sourceByPath.get(destination);
    if (!source || !selectedNames.has(destination)) {
      sink.emit("error", new DatabaseProtectionError("Production media producer emitted an unselected source."));
      return sink;
    }
    void write(destination, data, source.sourceVersion).then(entry => {
      written.set(name, entry);
      bytes += entry.bytes;
      sink.emit("entry", { name });
    }).catch(error => sink.emit("error", new DatabaseProtectionError(
      `Production media capture/upload failed: ${backupErrorMessage(error)} No recovery point committed.`)));
    return sink;
  };
  await captured.append(sink as unknown as Archiver, undefined, included);
  if (failure) throw failure;
  const { files, ...evidence } = captured.manifest;
  // The producer independently hashes pinned bytes. Never accept an entry from
  // an unvalidated/truncated stream or silently drop a required source.
  const expectedFiles = files.filter(f => selectedNames.has(
    f.archivePath.startsWith("media/") ? `case-media/${f.archivePath.slice("media/".length)}` : f.archivePath,
  ));
  if (expectedFiles.length !== written.size || expectedFiles.some(f => {
    const stored = written.get(f.archivePath);
    return !stored || stored.bytes !== f.size || stored.hash !== f.sha256;
  }) || written.size !== selectedNames.size) {
    throw new Error("Production media evidence is incomplete or differs from pinned source bytes.");
  }
  return {
    sourceVersions, missingReferences: captured.manifest.missingReferences ?? [], evidence,
    coverageLimitations: [
      ...(captured.manifest.productionMediaWriterCoverage?.protocol !== 1
        ? ["Media writer journal coverage is not complete; a full source-version metadata reconciliation remains required."] : []),
      ...(captured.manifest.productionMediaWriterCoverage?.unresolvedWrites
        ? ["Interrupted or failed durable media writes remain unresolved; coverage is partial."] : []),
    ],
  };
}
