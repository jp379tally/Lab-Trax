import { Readable } from "node:stream";

export type BackupDownloadSource =
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

function asAsyncIterable(source: BackupDownloadSource): AsyncIterable<Uint8Array> {
  if (typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    return source as AsyncIterable<Uint8Array>;
  }

  const webStream = source as ReadableStream<Uint8Array>;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = webStream.getReader();
      let ended = false;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            ended = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!ended) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}

/**
 * Passes archive chunks through with fixed stream buffering and verifies the
 * byte count at both ends. Never accumulates the archive in memory.
 */
export function createVerifiedBackupDownloadStream(
  source: BackupDownloadSource,
  expectedSize: number,
  provider: "Google Drive" | "OneDrive",
  onFinished: () => void = () => undefined,
): Readable {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(`${provider} archive download requires a valid expected size.`);
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    onFinished();
  };

  async function* verifiedChunks(): AsyncGenerator<Buffer> {
    let total = 0;
    try {
      for await (const chunk of asAsyncIterable(source)) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        total += bytes.byteLength;
        if (total > expectedSize) {
          throw new Error(`${provider} archive download exceeded its verified size.`);
        }
        yield bytes;
      }
      if (total !== expectedSize) {
        throw new Error(
          `${provider} archive download returned ${total} bytes; expected ${expectedSize}.`,
        );
      }
    } finally {
      dispose();
    }
  }

  const stream = Readable.from(verifiedChunks(), {
    objectMode: false,
    highWaterMark: 64 * 1024,
  });
  stream.once("close", dispose);
  return stream;
}
