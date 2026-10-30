import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { Archiver } from "archiver";
import type { CompleteBackupCaptured } from "./complete-backup";
import type { ProductionCapture } from "./production-content-protection";
import type { ProductionFile } from "./production-content-protection";
import { recordInventoryHash } from "./postgres-record-delta";
import { DatabaseProtectionError } from "./database-protection";
import { backupErrorMessage } from "./backup-error-copy";

/** Reuse snapshot/reference/generation checks without rebuilding a ZIP. */
export async function captureProductionMedia(
  captured: Pick<CompleteBackupCaptured, "append" | "manifest" | "productionMediaSources" | "recordCapture">,
  write: Parameters<ProductionCapture["captureMedia"]>[0],
  selectPaths: Parameters<ProductionCapture["captureMedia"]>[1],
  mirror?: Archiver,
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
  sink.pointer = () => mirror?.pointer() ?? bytes;
  sink.destroy = error => { if (error) sink.emit("error", error); else sink.emit("close"); };
  sink.append = (data, { name }) => {
    if (typeof data === "string" || Buffer.isBuffer(data)) {
      mirror?.append(data, { name });
      return sink;
    }
    const destination = name.startsWith("media/") ? 'case-media/' + name.slice('media/'.length) : name;
    const source = sourceByPath.get(destination);
    if (!source || (!mirror && !selectedNames.has(destination))) {
      sink.emit("error", new DatabaseProtectionError("Production media producer emitted an unselected source."));
      return sink;
    }
    const selected = selectedNames.has(destination);
    const archiveDone = mirror ? new Promise<void>((resolve, reject) => {
      const cleanup = () => { mirror.off("entry", entry); mirror.off("error", error); mirror.off("close", close); };
      const entry = (value: { name: string }) => { if (value.name === name) { cleanup(); resolve(); } };
      const error = (error: Error) => { cleanup(); data.destroy(error); reject(error); };
      const close = () => { cleanup(); data.destroy(); reject(new Error("Archive closed before media finished.")); };
      mirror.on("entry", entry); mirror.once("error", error); mirror.once("close", close);
    }) : Promise.resolve();
    let content: Readable = data;
    if (mirror && selected) {
      const archiveStream = new PassThrough({ highWaterMark: 64 * 1024 });
      const contentStream = new PassThrough({ highWaterMark: 64 * 1024 });
      data.once("error", error => { archiveStream.destroy(error); contentStream.destroy(error); });
      // Both consumers apply backpressure to the one pinned source stream.
      data.pipe(archiveStream); data.pipe(contentStream);
      mirror.append(archiveStream, { name });
      content = contentStream;
    } else if (mirror) {
      mirror.append(data, { name });
    }
    const stored = selected ? write(destination, content, source.sourceVersion).then(entry => {
      written.set(name, entry); bytes += entry.bytes;
    }) : Promise.resolve();
    void Promise.all([stored, archiveDone]).then(() => sink.emit("entry", { name })).catch(error => {
      data.destroy(); content.destroy(); mirror?.destroy();
      sink.emit("error", new DatabaseProtectionError(
        'Production media capture/upload failed: ' + backupErrorMessage(error) + ' No recovery point committed.'));
    });
    return sink;
  };
  try {
    await captured.append(sink as unknown as Archiver, undefined, mirror ? undefined : included);
  } catch (error) {
    // The producer may reject with a secondary abort after the sink has
    // already recorded the safe provider/source failure that caused it.
    throw failure ?? error;
  }
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
    sourceVersions, missingReferences: captured.manifest.missingReferences ?? [],
    // The standalone ZIP binds its full pg_dump. The incremental point binds
    // the record inventory from the SAME snapshot, not the full-dump digest.
    evidence: captured.recordCapture ? { ...evidence,
      databaseSha256: recordInventoryHash(captured.recordCapture.inventory),
      databaseCapture: "postgresql-record-state-v1",
    } : evidence,
    coverageLimitations: [
      ...(captured.manifest.productionMediaWriterCoverage?.protocol !== 1
        ? ["Media writer journal coverage is not complete; a full source-version metadata reconciliation remains required."] : []),
      ...(captured.manifest.productionMediaWriterCoverage?.unresolvedWrites
        ? ["Interrupted or failed durable media writes remain unresolved; coverage is partial."] : []),
    ],
  };
}
