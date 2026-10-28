import { verifyCompleteBackupDownload, verifyCompleteBackupEnvelope, verifyCompleteBackupMetadata } from "./backup-download-integrity";
import { fetch as expoFetch } from "expo/fetch";

export interface BackupFileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface BackupFileHandle {
  name: string;
  createWritable(): Promise<BackupFileSink>;
}

/** Call inside the user's click, before awaiting authentication or a long capture. */
export async function chooseBackupSaveFile(): Promise<BackupFileHandle | null> {
  const browser = globalThis as typeof globalThis & {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<BackupFileHandle>;
  };
  if (!browser.showSaveFilePicker) return null;
  try {
    return await browser.showSaveFilePicker({ suggestedName: "labtrax-complete-backup.zip.enc" });
  } catch (error) {
    // Cross-origin preview frames can expose the method but prohibit using it.
    if (error instanceof Error && error.name === "SecurityError") return null;
    throw error; // In particular, cancellation must not start a backup.
  }
}

type BackupRequestOptions = Parameters<typeof expoFetch>[1];
interface BackupDownload {
  size: number;
  headers: Headers;
  buffer?: ArrayBuffer;
}

/** Both web and native streaming responses must originate from expo/fetch. */
async function downloadCompleteBackup(
  url: string, options: BackupRequestOptions, sink: BackupFileSink | undefined, limit: number,
): Promise<BackupDownload> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let prefix = new Uint8Array(0);
  let footer = new Uint8Array(0);
  let size = 0;
  const chunks: Uint8Array[] = [];
  const tooLarge = () => new Error("This backup exceeds this browser's safe download limit. Use OneDrive, Google Drive, or installed Desktop to save it to USB; no complete local backup was saved.");
  try {
    const response = await expoFetch(url, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string; diagnostic?: string };
      const error = new Error(body?.error || body?.message || `Backup download failed (${response.status}).`);
      Object.assign(error, { diagnostic: body?.diagnostic });
      throw error;
    }
    verifyCompleteBackupMetadata(response.headers);
    const length = response.headers.get("content-length");
    if (!sink && length && /^\d+$/.test(length) && BigInt(length) > BigInt(limit)) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (!response.body) {
      if (sink) throw new Error("The browser could not stream this backup. Use a cloud destination or installed Desktop.");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > limit) throw tooLarge();
      verifyCompleteBackupDownload(buffer, response.headers);
      return { buffer, size: buffer.byteLength, headers: response.headers };
    }
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (!sink && size > limit) throw tooLarge();
      if (prefix.byteLength < 4) {
        const first = new Uint8Array(prefix.byteLength + Math.min(4 - prefix.byteLength, value.byteLength));
        first.set(prefix);
        first.set(value.subarray(0, first.byteLength - prefix.byteLength), prefix.byteLength);
        prefix = first;
      }
      if (value.byteLength >= 12) footer = value.slice(-12);
      else {
        const tail = new Uint8Array(footer.byteLength + value.byteLength);
        tail.set(footer);
        tail.set(value, footer.byteLength);
        footer = tail.slice(-12);
      }
      if (sink) await sink.write(value);
      else chunks.push(value);
    }
    verifyCompleteBackupEnvelope(prefix, footer, size, response.headers);
    if (sink) {
      await sink.close();
      return { size, headers: response.headers };
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { buffer: bytes.buffer, size, headers: response.headers };
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await sink?.abort().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

/** Writes are backpressured; the chosen file commits only after validation. */
export async function streamCompleteBackupToFile(url: string, options: BackupRequestOptions, sink: BackupFileSink): Promise<number> {
  return (await downloadCompleteBackup(url, options, sink, 0)).size;
}

/** Unsupported browsers fail visibly instead of exhausting memory on multi-GB archives. */
export async function readBoundedBrowserBackup(
  url: string, options: BackupRequestOptions, limit = 128 * 1024 * 1024,
): Promise<{ buffer: ArrayBuffer; headers: Headers }> {
  const result = await downloadCompleteBackup(url, options, undefined, limit);
  if (!result.buffer) throw new Error("The browser did not receive a backup file.");
  return { buffer: result.buffer, headers: result.headers };
}
