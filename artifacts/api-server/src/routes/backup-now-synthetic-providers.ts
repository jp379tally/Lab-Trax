import { vi } from "vitest";

/** No provider credentials, network writes, or real storage in these rehearsals. */
const syntheticProviders = vi.hoisted(() => ({
  archives: new Map<string, { bytes: Buffer; destination: string; name: string }>(),
  failUpload: false,
  failReadBack: false,
  failDump: false,
  failEncryption: false,
}));
export { syntheticProviders };

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (syntheticProviders.failDump) throw new Error("Synthetic database export failure");
    return actual.spawn(...args);
  } };
});
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createCipheriv: (...args: Parameters<typeof actual.createCipheriv>) => {
    if (syntheticProviders.failEncryption) throw new Error("Synthetic encryption failure");
    return actual.createCipheriv(...args);
  } };
});
vi.mock("../lib/backup-production-source", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/backup-production-source")>(),
  verifyProductionBackupSource: async () => "1".repeat(64),
}));
vi.mock("../lib/case-media-object-storage", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/case-media-object-storage")>(),
  listPrivateBackupObjects: async () => [],
  openPrivateBackupObject: async () => null,
}));
vi.mock("../lib/backup-cloud-staging", () => ({
  createBackupCloudStage: async () => {
    const { Writable } = await import("node:stream");
    const chunks: Buffer[] = [];
    let bytes: Buffer | undefined;
    return {
      open: () => new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
      seal: async (size: number) => {
        bytes = Buffer.concat(chunks);
        if (bytes.length !== size || size > 32 * 1024 * 1024) throw Error("Synthetic staging bound/size failed");
      },
      readChunk: async (offset: number, length: number) => {
        if (!bytes) throw Error("Synthetic stage not sealed");
        return bytes.subarray(offset, offset + length);
      },
      cleanup: async () => { chunks.length = 0; bytes = undefined; },
    };
  },
}));

async function receive(source: { size: number; readChunk(offset: number, length: number): Promise<Buffer> }, name: string, destination: string) {
  if (syntheticProviders.failUpload) throw Error("Synthetic destination upload failure");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
    chunks.push(await source.readChunk(offset, Math.min(1024 * 1024, source.size - offset)));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== source.size) throw Error("Synthetic destination received truncated data");
  const id = `${destination}-${syntheticProviders.archives.size}`;
  syntheticProviders.archives.set(id, { bytes, name, destination });
  return { id, name, size: bytes.length };
}
vi.mock("../lib/onedrive", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/onedrive")>(),
  getOneDriveBackupFolder: () => "/synthetic-private",
  isOneDriveConnectorAvailable: () => true,
  pruneOneDriveBackups: vi.fn(async () => []),
  listOneDriveBackupFiles: async () => [],
  uploadBackupSourceToOneDrive: async (source: Parameters<typeof receive>[0], name: string) => {
    const received = await receive(source, name, "onedrive");
    return { ...received, itemId: received.id, fileName: name, folder: "/synthetic-private", webUrl: "https://example.invalid/synthetic" };
  },
  getOneDriveFileByName: async (_name: string, _folder: string, id: string) => {
    if (syntheticProviders.failReadBack) throw Error("Synthetic destination read-back failure");
    const item = syntheticProviders.archives.get(id);
    return item ? { id, name: item.name, size: item.bytes.length } : null;
  },
}));
vi.mock("../lib/google-drive", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/google-drive")>(),
  getGoogleDriveStatus: async () => ({ connected: true }),
  getGoogleDriveBackupFolderId: async () => "synthetic-private",
  listGoogleDriveBackupFiles: async () => [],
  uploadGoogleDriveBackupSource: (source: Parameters<typeof receive>[0], name: string) => receive(source, name, "google-drive"),
  verifyGoogleDriveBackup: async (uploaded: { id: string }, size: number) => {
    if (syntheticProviders.failReadBack || syntheticProviders.archives.get(uploaded.id)?.bytes.length !== size) {
      throw Error("Synthetic destination read-back failure");
    }
  },
}));
