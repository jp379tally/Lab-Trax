import { beforeEach, describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
const fake = vi.hoisted(() => ({
  bytes: new Map<string, Buffer>(), wrongName: false, truncate: false, noHash: false,
  contentTag: "synthetic-version-1", itemId: "synthetic-id",
  list: vi.fn(async () => [] as Array<{ name: string; createdDateTime?: string; id?:string;driveId?:string;contentTag?:string; size?: number; sha1Hash?: string | null }>),
  deleted: vi.fn(async () => { fake.bytes.delete(name); }),
}));
vi.mock("./onedrive", () => ({
  listOneDriveBackupFiles: fake.list,
  deleteOneDriveBackupFile: fake.deleted,
  getOneDriveFileByName: async (name: string) => fake.bytes.has(name)
    ? {
      id: fake.itemId, name, size: fake.bytes.get(name)!.length,
      driveId: "synthetic-drive", contentTag: fake.contentTag,
      sha1Hash: fake.noHash ? null : createHash("sha1").update(fake.bytes.get(name)!).digest("hex"),
    } : null,
  downloadFileFromOneDrive: async (name: string) => Readable.from([
    fake.truncate ? fake.bytes.get(name)!.subarray(1) : fake.bytes.get(name)!,
  ]),
  uploadBackupToOneDrive: async (bytes: Buffer, name: string) => {
    fake.bytes.set(name, Buffer.from(bytes));
    return { fileName: fake.wrongName ? "renamed" : name, size: bytes.length };
  },
}));
import { databaseOneDriveStore } from "./database-protection-onedrive";
const name = `chunk-${"a".repeat(64)}.enc`;
describe("OneDrive database object adapter (no cloud calls)", () => {
  beforeEach(() => {
    fake.bytes.clear(); fake.wrongName = false; fake.truncate = false; fake.noHash = false;
    fake.contentTag = "synthetic-version-1"; fake.itemId = "synthetic-id";
    fake.list.mockReset().mockResolvedValue([]);
    fake.deleted.mockClear();
  });
  it.each([
    `records-body-${"b".repeat(64)}.enc`, `records-schema-${"c".repeat(64)}.enc`,
    `records-inventory-${"d".repeat(64)}.enc`,
    "records-point-1793052000000-12345678-1234-4234-8234-123456789abc.enc",
    "records-verified-1793052000000-12345678-1234-4234-8234-123456789abc.enc",
  ])("preserves exact encrypted record object identity for %s",async recordName=>{
    const store=databaseOneDriveStore("synthetic-private-folder");
    const bytes=Buffer.from("synthetic encrypted record object");await store.put(recordName,bytes);
    expect(await store.get(recordName)).toEqual(bytes);expect((await store.getVersion!(recordName))?.contentTag).toBe("synthetic-version-1");
  });
  it("stores and reads the exact encrypted bytes", async () => {
    const store = databaseOneDriveStore("synthetic-private-folder");
    await store.put(name, Buffer.from("synthetic ciphertext"));
    expect((await store.get(name))?.toString()).toBe("synthetic ciphertext");
    expect(await store.getIntegrity!(name)).toEqual({
      bytes: Buffer.byteLength("synthetic ciphertext"),
      sha1: createHash("sha1").update("synthetic ciphertext").digest("hex"),
      sha256: null,
    });
  });
  it("lists the dedicated database namespace rather than legacy archive retention", async () => {
    fake.list.mockResolvedValue([{ name, createdDateTime: "2026-10-25T00:00:00.000Z" }]);
    const store = databaseOneDriveStore("synthetic-private-folder");
    expect(await store.list()).toEqual([{ name, createdAt: "2026-10-25T00:00:00.000Z" }]);
    expect(fake.list).toHaveBeenCalledWith("synthetic-private-folder", { databaseProtection: true });
  });
  it("performs a fresh complete version pass and reports absent/unknown evidence explicitly",async()=>{
    const store=databaseOneDriveStore("synthetic-private-folder"),missing=`chunk-${"f".repeat(64)}.enc`;
    fake.list.mockResolvedValue([{name,id:"synthetic-item",driveId:"synthetic-drive",contentTag:"one",size:12}]);
    const first=await store.getVersions!([name,missing]);expect(first.get(name)?.contentTag).toBe("one");expect(first.get(missing)).toBeNull();
    fake.list.mockResolvedValue([{name,id:"synthetic-item",driveId:"synthetic-drive",contentTag:"two",size:12}]);
    expect((await store.getVersions!([name])).get(name)?.contentTag).toBe("two");expect(fake.list).toHaveBeenCalledTimes(2);
    fake.list.mockResolvedValue([{name,id:"synthetic-item",driveId:"synthetic-drive",size:12}]);
    expect((await store.getVersions!([name])).get(name)).toBeNull();
  });
  it("uses the provider-calculated SHA-1 from the current object listing", async () => {
    const bytes = Buffer.from("synthetic existing ciphertext");
    fake.list.mockResolvedValue([{
      name, size: bytes.length, sha1Hash: createHash("sha1").update(bytes).digest("hex"),
    }]);
    const store = databaseOneDriveStore("synthetic-private-folder");
    expect(await store.list()).toContainEqual({ name, createdAt: null });
    expect(await store.getIntegrity!(name)).toEqual({
      bytes: bytes.length, sha1: createHash("sha1").update(bytes).digest("hex"), sha256: null,
    });
  });
  it("returns absent objects explicitly", async () => {
    expect(await databaseOneDriveStore("synthetic-private-folder").get(name)).toBe(null);
  });
  it("reads fresh object identity and content tags instead of a listing cache", async () => {
    fake.bytes.set(name, Buffer.from("cipher"));
    const store = databaseOneDriveStore("synthetic-private-folder");
    const first = await store.getVersion!(name);
    expect(first?.provider).toBe("onedrive-content-v1");
    fake.contentTag = "synthetic-version-2";
    expect((await store.getVersion!(name))?.contentTag).not.toBe(first?.contentTag);
    fake.itemId = "synthetic-recreated-id";
    expect((await store.getVersion!(name))?.itemId).not.toBe(first?.itemId);
  });
  it("refuses missing content tokens and explicitly reports deleted objects", async () => {
    fake.bytes.set(name, Buffer.from("cipher"));
    fake.contentTag = "";
    const store = databaseOneDriveStore("synthetic-private-folder");
    await expect(store.getVersion!(name)).rejects.toThrow(/continuity/);
    fake.bytes.delete(name);
    expect(await store.getVersion!(name)).toBeNull();
  });
  it("rejects renamed upload results", async () => {
    fake.wrongName = true;
    await expect(databaseOneDriveStore("synthetic-private-folder").put(name, Buffer.from("cipher"))).rejects.toThrow(/identity/);
  });
  it("rejects truncated read-back", async () => {
    fake.bytes.set(name, Buffer.from("cipher"));
    fake.truncate = true;
    await expect(databaseOneDriveStore("synthetic-private-folder").get(name)).rejects.toThrow(/truncated/);
  });
  it("verifies actual uploaded bytes with SHA-256 even when Graph omits SHA-1", async () => {
    fake.noHash = true;
    const store = databaseOneDriveStore("synthetic-private-folder");
    await store.put(name, Buffer.from("cipher"));
    expect((await store.getIntegrity!(name))?.sha256).toBeNull();
  });
  it("rejects upload read-back corruption even when metadata claims the right size", async () => {
    fake.truncate = true;
    await expect(databaseOneDriveStore("synthetic-private-folder").put(name, Buffer.from("cipher")))
      .rejects.toThrow(/truncated/);
  });
  it("honors cancellation and refuses paths outside the object namespace", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(databaseOneDriveStore("synthetic-private-folder", controller.signal).list()).rejects.toThrow();
    await expect(databaseOneDriveStore("synthetic-private-folder").get("../other")).rejects.toThrow(/Invalid/);
  });
  it("deletes only the exact synthetic object identity and treats an absent name as complete", async () => {
    fake.bytes.set(name, Buffer.from("cipher"));
    const store = databaseOneDriveStore("synthetic-private-folder");
    await store.delete(name);
    expect(fake.deleted).toHaveBeenCalledWith("synthetic-id");
    await store.delete(name);
    expect(fake.deleted).toHaveBeenCalledTimes(1);
    await expect(store.delete("../other")).rejects.toThrow(/Invalid/);
  });
});
