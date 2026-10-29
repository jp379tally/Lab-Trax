import { createHash } from "node:crypto";
import {
  deleteOneDriveBackupFile, downloadFileFromOneDrive, getOneDriveFileByName,
  listOneDriveBackupFiles, uploadBackupToOneDrive,
} from "./onedrive";
import type { DatabaseObjectStore } from "./database-protection";
import { objectVersionSchema } from "./object-version-proof";
import { isDatabaseProtectionObjectName } from "./database-protection-object-name";

// Dedicated source-bound namespace is not visited by legacy archive retention.
// All objects are encrypted; no plaintext database or index is sent to Graph.

// Dedicated source-bound namespace is not visited by legacy archive retention.
// All objects are encrypted; no plaintext database or index is sent to Graph.
export function databaseOneDriveStore(folder: string, signal?: AbortSignal): DatabaseObjectStore {
  const stats={bytesRead:0,bytesWritten:0,recordBodyBytesRead:0};
  let listedIntegrity = new Map<string, { bytes: number; sha1: string | null; sha256: null }>();
  const checkName = (name: string) => {
    if (!isDatabaseProtectionObjectName(name)) {
      throw new Error("Invalid database protection object name.");
    }
  };
  const getIntegrity = async (name: string) => {
    checkName(name);
    signal?.throwIfAborted();
    const cached = listedIntegrity.get(name);
    if (cached) return cached;
    const item = await getOneDriveFileByName(name, folder);
    if (!item) return null;
    // Microsoft Graph explicitly does not support hashes.sha256Hash.
    // SHA-1/QuickXorHash must never be promoted into strong reuse proof.
    const integrity = { bytes: item.size, sha1: item.sha1Hash ?? null, sha256: null };
    listedIntegrity.set(name, integrity);
    return integrity;
  };
  const store: DatabaseObjectStore = {
    readStats:()=>({...stats}),
    async getVersions(names) {
      for(const name of names)checkName(name);
      signal?.throwIfAborted();
      const wanted=new Set(names),versions=new Map<string,import("./object-version-proof").ObjectVersion|null>(names.map(name=>[name,null]));
      // One fresh paginated pass avoids tens of thousands of serial requests
      // for a large unchanged media set. getVersion remains uncached for the
      // before/after checks that establish each new object's initial byte proof.
      const items=await listOneDriveBackupFiles(folder,{databaseProtection:true});
      const seen=new Set<string>();
      for(const item of items){
        if(!wanted.has(item.name))continue;
        if(seen.has(item.name))throw new Error("Duplicate OneDrive protection object identity in metadata pass.");
        seen.add(item.name);
        const parsed=objectVersionSchema.safeParse({provider:"onedrive-content-v1",driveId:item.driveId,
          itemId:item.id,contentTag:item.contentTag,bytes:item.size});
        versions.set(item.name,parsed.success?parsed.data:null);
      }
      return versions;
    },
    async getVersion(name) {
      checkName(name);
      signal?.throwIfAborted();
      // Never use the listing cache: replacement/deletion/recreation must be
      // observable even when it occurs between two reads in the same job.
      const item = await getOneDriveFileByName(name, folder);
      if (!item) return null;
      const parsed = objectVersionSchema.safeParse({
        provider: "onedrive-content-v1", driveId: item.driveId,
        itemId: item.id, contentTag: item.contentTag, bytes: item.size,
      });
      if (item.name !== name || !parsed.success) {
        throw new Error("OneDrive content-version continuity evidence is unavailable or inconsistent.");
      }
      return parsed.data;
    },
    async list() {
      signal?.throwIfAborted();
      const items = await listOneDriveBackupFiles(folder, { databaseProtection: true });
      listedIntegrity = new Map(items.map(item => [item.name, { bytes: item.size, sha1: item.sha1Hash ?? null, sha256: null }]));
      return items.map(item => ({
        name: item.name,
        createdAt: Number.isFinite(Date.parse(item.createdDateTime)) ? item.createdDateTime : null,
      }));
    },
    getIntegrity,
    async get(name) {
      checkName(name);
      signal?.throwIfAborted();
      const item = await getOneDriveFileByName(name, folder);
      if (!item) return null;
      if (item.name !== name || item.size <= 0 || item.size > 8 * 1024 * 1024) {
        throw new Error("OneDrive database object identity or size is invalid.");
      }
      const stream = await downloadFileFromOneDrive(name, item.size, folder, item.id, signal);
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of stream) {
        signal?.throwIfAborted();
        stats.bytesRead+=part.length;
        if(name.startsWith("records-body-"))stats.recordBodyBytesRead+=part.length;
        size += part.length;
        if (size > item.size) throw new Error("OneDrive database object exceeded its recorded size.");
        parts.push(Buffer.from(part));
      }
      if (size !== item.size) throw new Error("OneDrive database object was truncated.");
      return Buffer.concat(parts);
    },
    async put(name, bytes) {
      checkName(name);
      signal?.throwIfAborted();
      const uploaded = await uploadBackupToOneDrive(bytes, name, { folder, signal });
      // Graph may rename on a collision: never count another object's bytes.
      if (uploaded.fileName !== name || uploaded.size !== bytes.length) {
        throw new Error("OneDrive database upload identity or size does not match.");
      }
      stats.bytesWritten+=uploaded.size;
      listedIntegrity.delete(name);
      const received = await store.get(name);
      if (!received || createHash("sha256").update(received).digest("hex") !==
          createHash("sha256").update(bytes).digest("hex")) {
        throw new Error("OneDrive encrypted object SHA-256 byte read-back failed after upload.");
      }
    },
    async delete(name) {
      checkName(name);
      signal?.throwIfAborted();
      const item = await getOneDriveFileByName(name, folder);
      if (!item) return;
      if (item.name !== name || item.size <= 0) {
        throw new Error("OneDrive database deletion identity or size is invalid.");
      }
      signal?.throwIfAborted();
      await deleteOneDriveBackupFile(item.id);
    },
  };
  return store;
}
