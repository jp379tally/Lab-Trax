import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("@replit/connectors-sdk", () => ({ ReplitConnectors: class {} }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./backup-phase", () => ({ setBackupLiveProgress: vi.fn() }));
import { databaseGoogleDriveStore, setGoogleDriveFetchForTests } from "./google-drive";
import { sameObjectVersion } from "./object-version-proof";

const folder = "synthetic-recovery", folderId = "synthetic-folder";
const name = `records-body-${"a".repeat(64)}.enc`;
type Item = { id: string; name: string; body: Buffer; version: string; revision: string };
let items: Item[], corrupt: boolean, truncate: boolean, duplicates: boolean, missingVersion: boolean;
let pending: { id: string; name: string; parents: string[] } | undefined;
let calls: string[], writes: number, pageSize: number;
const json = (body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
const metadata = (item: Item) => ({ id: item.id, name: item.name, size: String(item.body.length), parents: [folderId],
  mimeType: "application/octet-stream", createdTime: "2026-10-27T12:00:00.000Z",
  headRevisionId: missingVersion ? undefined : item.revision, version: item.version,
  sha256Checksum: createHash("sha256").update(item.body).digest("hex") });
const proxy = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input); calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname === "/upload/drive/v3/files") {
    pending = { ...JSON.parse(String(init?.body)), id: `synthetic-upload-${writes}` };
    return new Response(null, { headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic" } });
  }
  if (url.pathname === "/drive/v3/files") {
    const q = url.searchParams.get("q") ?? "";
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
      return json({ files: [{ id: folderId, name: folder, mimeType: "application/vnd.google-apps.folder" }] });
    }
    let matches = items;
    const requestedName = q.match(/name = '([^']+)'/);
    if (requestedName) matches = matches.filter(item => item.name === requestedName[1]);
    if (duplicates && matches.length) matches = [...matches, { ...matches[0]!, id: "synthetic-duplicate" }];
    const offset = Number(url.searchParams.get("pageToken") ?? "0");
    const page = matches.slice(offset, offset + pageSize).map(metadata);
    return json({ files: page, ...(offset + pageSize < matches.length ? { nextPageToken: String(offset + pageSize) } : {}) });
  }
  const item = items.find(value => url.pathname === `/drive/v3/files/${value.id}`);
  if (item && url.searchParams.get("alt") === "media") {
    let bytes = Buffer.from(item.body);
    if (corrupt) bytes[0] = bytes[0]! ^ 1;
    if (truncate) bytes = bytes.subarray(1);
    return new Response(bytes);
  }
  throw new Error("Unexpected synthetic Drive request");
});
const upload = vi.fn(async (_input: string, init?: RequestInit) => {
  writes++;
  const p = pending!;
  const body = Buffer.from(init?.body as Uint8Array);
  const item: Item = { id: p.id, name: p.name, body, version: "1", revision: "synthetic-revision-1" };
  items.push(item);
  return json(metadata(item));
});
beforeEach(() => {
  items = []; corrupt = truncate = duplicates = missingVersion = false; pending = undefined;
  calls = []; writes = 0; pageSize = 100;
  proxy.mockClear(); upload.mockClear(); setGoogleDriveFetchForTests(proxy, upload);
});
afterEach(() => setGoogleDriveFetchForTests(null));
describe("Google Drive immutable production protection objects (fake provider only)", () => {
  it("stores exact encrypted bytes and authenticates read-back before returning", async () => {
    const store = databaseGoogleDriveStore(folder);
    const bytes = Buffer.from("synthetic authenticated ciphertext");
    await store.put(name, bytes);
    expect(await store.get(name)).toEqual(bytes);
    expect(await store.getVersion!(name)).toMatchObject({ provider: "google-drive-content-v1", driveId: folderId, contentTag: "synthetic-revision-1:1" });
    expect(await store.getIntegrity!(name)).toMatchObject({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(store.readStats!().bytesWritten).toBe(bytes.length);
  });
  it("never overwrites existing ciphertext when content differs", async () => {
    const store = databaseGoogleDriveStore(folder);
    await store.put(name, Buffer.from("prior ciphertext"));
    await expect(store.put(name, Buffer.from("different ciphertext"))).rejects.toThrow(/SHA-256/);
    expect(writes).toBe(1);
    expect(items[0]!.body.toString()).toBe("prior ciphertext");
  });
  it("rejects corrupt and truncated read-back without deleting any object", async () => {
    corrupt = true;
    await expect(databaseGoogleDriveStore(folder).put(name, Buffer.from("synthetic ciphertext"))).rejects.toThrow(/SHA-256/);
    expect(items).toHaveLength(1);
    corrupt = false; truncate = true;
    await expect(databaseGoogleDriveStore(folder).get(name)).rejects.toThrow(/truncated|bytes|stream/i);
    expect(items).toHaveLength(1);
  });
  it("reads every metadata page and notices changed or missing version evidence", async () => {
    const store = databaseGoogleDriveStore(folder);
    await store.put(name, Buffer.from("synthetic ciphertext"));
    const other = `chunk-${"b".repeat(64)}.enc`;
    await store.put(other, Buffer.from("synthetic second ciphertext"));
    pageSize = 1;
    const first = (await store.getVersions!([name, other, `chunk-${"c".repeat(64)}.enc`])).get(name)!;
    expect(first).not.toBeNull();
    expect((await store.list()).map(item => item.name)).toEqual([name, other]);
    items[0]!.version = "2";
    expect(sameObjectVersion(first, (await store.getVersions!([name])).get(name)!)).toBe(false);
    items[0]!.id = "synthetic-recreated-id";
    expect(sameObjectVersion(first, await store.getVersion!(name))).toBe(false);
    missingVersion = true;
    await expect(store.getVersions!([name])).rejects.toThrow(/continuity/);
  });
  it("fails closed on duplicate object identities", async () => {
    const store = databaseGoogleDriveStore(folder);
    await store.put(name, Buffer.from("synthetic ciphertext")); duplicates = true;
    await expect(store.getVersion!(name)).rejects.toThrow(/ambiguous/);
    await expect(store.list()).rejects.toThrow(/ambiguous/);
  });
  it("does no provider work after cancellation and never permits pruning", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(databaseGoogleDriveStore(folder, controller.signal).list()).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(databaseGoogleDriveStore(folder).delete(name)).rejects.toThrow(/deletion is disabled/);
    expect(calls).toHaveLength(0);
  });
});
