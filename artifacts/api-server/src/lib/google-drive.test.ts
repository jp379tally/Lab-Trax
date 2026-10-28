import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadGoogleDriveBackupFile,
  getGoogleDriveBackupFolder,
  getGoogleDriveStatus,
  setGoogleDriveFetchForTests,
  uploadGoogleDriveBackupFile,
  uploadGoogleDriveBackupSource,
  verifyGoogleDriveBackup,
} from "./google-drive";

const ORIGINAL_ENV = {
  hostname: process.env.REPLIT_CONNECTORS_HOSTNAME,
  identity: process.env.REPL_IDENTITY,
  deployment: process.env.REPLIT_DEPLOYMENT,
};

afterEach(() => {
  setGoogleDriveFetchForTests(null);
  for (const [key, value] of [
    ["REPLIT_CONNECTORS_HOSTNAME", ORIGINAL_ENV.hostname],
    ["REPL_IDENTITY", ORIGINAL_ENV.identity],
    ["REPLIT_DEPLOYMENT", ORIGINAL_ENV.deployment],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function enableConnector(): void {
  process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.test";
  process.env.REPL_IDENTITY = "unit-test-identity-not-a-credential";
  process.env.REPLIT_DEPLOYMENT = "1";
}

async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
  }
  return Buffer.concat(chunks, size);
}

function responseJson(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeUploadMocks(
  finalStatus = 201,
  writeLocalFile = true,
): {
  proxy: ReturnType<typeof vi.fn>;
  direct: ReturnType<typeof vi.fn>;
  filePath: string;
} {
  const filePath = path.join(
    os.tmpdir(),
    `google-drive-backup-${process.pid}-${Date.now()}.zip.enc`,
  );
  if (writeLocalFile) fs.writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a));
  const proxy = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/drive/v3/files" && !url.searchParams.get("uploadType")) {
      if (url.searchParams.has("q")) return responseJson({ files: [] });
      return responseJson({
        id: "drive-backup-1",
        name: "LabTrax Backups",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      });
    }
    if (url.pathname === "/upload/drive/v3/files") {
      return new Response(null, {
        status: 200,
        headers: {
          Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque-test-id",
        },
      });
    }
    if (url.pathname === "/drive/v3/files/drive-file-1") {
      return responseJson({
        id: "drive-file-1",
        name: "backup.zip.enc",
        size: String(5 * 1024 * 1024 + 17),
        parents: ["drive-backup-1"],
        createdTime: "2026-01-02T03:04:05.000Z",
      });
    }
    throw new Error(`Unexpected mocked API request: ${url.pathname}`);
  });
  const direct = vi.fn(async (_input: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Content-Range");
    if (range?.startsWith("bytes 0-")) {
      return new Response(null, {
        status: 308,
        headers: { Range: `bytes=0-${5 * 1024 * 1024 - 1}` },
      });
    }
    if (finalStatus !== 201) return responseJson({ error: "not returned to caller" }, finalStatus);
    return responseJson({
      id: "drive-file-1",
      name: "backup.zip.enc",
      size: String(5 * 1024 * 1024 + 17),
      parents: ["drive-backup-1"],
      createdTime: "2026-01-02T03:04:05.000Z",
      webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
    }, 201);
  });
  setGoogleDriveFetchForTests(proxy, direct);
  return { proxy, direct, filePath };
}

describe("Google Drive backup connector", () => {
  it("downloads the requested archive ID and rejects truncated or oversized content", async () => {
    const expected = Buffer.from("synthetic encrypted archive bytes");
    const proxy = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/drive/v3/files/exact-item-id");
      expect(url.searchParams.get("alt")).toBe("media");
      return new Response(expected, {
        status: 200,
        headers: { "Content-Length": String(expected.length) },
      });
    });
    setGoogleDriveFetchForTests(proxy);
    const downloaded = await downloadGoogleDriveBackupFile("exact-item-id", expected.length);
    await expect(collectStream(downloaded)).resolves.toEqual(expected);
    expect(proxy).toHaveBeenCalledTimes(1);
    proxy.mockResolvedValueOnce(new Response(Buffer.from("truncated")));
    const truncated = await downloadGoogleDriveBackupFile("exact-item-id", expected.length);
    await expect(collectStream(truncated)).rejects.toThrow(/returned .* expected/);
    await expect(downloadGoogleDriveBackupFile("exact-item-id", expected.length + 1))
      .rejects.toThrow(/reported .* expected/);
  });

  it("streams a production-sized archive through bounded chunks without accumulating it", async () => {
    const expectedSize = 36_543_801_982;
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    let remaining = expectedSize;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const length = Math.min(chunk.length, remaining);
        controller.enqueue(chunk.subarray(0, length));
        remaining -= length;
      },
    }, { highWaterMark: 0 });
    setGoogleDriveFetchForTests(async () => new Response(body, {
      status: 200,
      headers: { "Content-Length": String(expectedSize) },
    }));

    const stream = await downloadGoogleDriveBackupFile("large-item-id", expectedSize);
    let total = 0;
    for await (const bytes of stream) total += bytes.byteLength;
    expect(total).toBe(expectedSize);
  });

  it("keeps non-production archives in a separate subfolder", () => {
    const previous = process.env.REPLIT_DEPLOYMENT;
    try {
      process.env.REPLIT_DEPLOYMENT = "1";
      expect(getGoogleDriveBackupFolder()).toBe("LabTrax Backups");
      delete process.env.REPLIT_DEPLOYMENT;
      expect(getGoogleDriveBackupFolder()).toBe("LabTrax Backups/non-production");
    } finally {
      if (previous === undefined) delete process.env.REPLIT_DEPLOYMENT;
      else process.env.REPLIT_DEPLOYMENT = previous;
    }
  });

  it("reports unavailable connection state without exposing connector credentials", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "";
    process.env.REPL_IDENTITY = "unit-test-identity-not-a-credential";
    const status = await getGoogleDriveStatus();
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/not available/i);
    expect(JSON.stringify(status)).not.toContain("unit-test-identity-not-a-credential");
  });

  it("returns account information from the managed connector and actionable access errors", async () => {
    enableConnector();
    const proxy = vi.fn(async () => responseJson({
      user: { displayName: "Backup Account", emailAddress: "backup@example.test" },
    }));
    setGoogleDriveFetchForTests(proxy);
    const connected = await getGoogleDriveStatus();
    expect(connected).toMatchObject({
      connected: true,
      accountName: "Backup Account",
      accountEmail: "backup@example.test",
      folder: "LabTrax Backups",
      error: null,
    });

    setGoogleDriveFetchForTests(vi.fn(async () => new Response(null, { status: 403 })));
    const denied = await getGoogleDriveStatus();
    expect(denied.connected).toBe(false);
    expect(denied.error).toMatch(/Reconnect Google Drive/i);
  });

  it("creates the dedicated folder, uploads in resumable chunks and verifies exact destination metadata", async () => {
    enableConnector();
    const { proxy, direct, filePath } = makeUploadMocks();
    try {
      const uploaded = await uploadGoogleDriveBackupFile(filePath, "backup.zip.enc");
      expect(uploaded).toMatchObject({
        id: "drive-file-1",
        name: "backup.zip.enc",
        size: 5 * 1024 * 1024 + 17,
        folderId: "drive-backup-1",
      });
      expect(direct).toHaveBeenCalledTimes(2);
      expect(new Headers(direct.mock.calls[0]?.[1]?.headers).get("Content-Range"))
        .toBe(`bytes 0-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024 + 17}`);
      expect(new Headers(direct.mock.calls[1]?.[1]?.headers).get("Content-Range"))
        .toBe(`bytes ${5 * 1024 * 1024}-${5 * 1024 * 1024 + 16}/${5 * 1024 * 1024 + 17}`);
      await verifyGoogleDriveBackup(uploaded, uploaded.size);
      expect(proxy.mock.calls.some(([url]) =>
        new URL(url).pathname === "/drive/v3/files/drive-file-1",
      )).toBe(true);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("stops after bounded retries when Drive refuses an upload chunk", async () => {
    enableConnector();
    const { direct, filePath } = makeUploadMocks(503);
    try {
      await expect(uploadGoogleDriveBackupFile(filePath, "backup.zip.enc"))
        .rejects.toThrow(/HTTP 503/);
      // One successful first chunk plus four bounded attempts for the second.
      expect(direct).toHaveBeenCalledTimes(5);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

describe("Google Drive sealed-source uploads", () => {
  const chunkSize = 5 * 1024 * 1024;
  const totalSize = chunkSize + 17;
  const source = () => ({
    size: totalSize,
    readChunk: vi.fn(async (_offset: number, length: number) => Buffer.alloc(length, 0x5a)),
  });

  it("reads only bounded ranges and declares the sealed size without opening a local archive", async () => {
    enableConnector();
    const { proxy, direct } = makeUploadMocks(201, false);
    const staged = source();
    const uploaded = await uploadGoogleDriveBackupSource(staged, "backup.zip.enc");
    expect(staged.readChunk.mock.calls).toEqual([[0, chunkSize], [chunkSize, 17]]);
    expect(uploaded.size).toBe(totalSize);
    expect(direct).toHaveBeenCalledTimes(2);
    const setup = proxy.mock.calls.find(([url]) => new URL(url).pathname === "/upload/drive/v3/files");
    expect(setup).toBeDefined();
    await verifyGoogleDriveBackup(uploaded, totalSize);
  });

  it("resumes from the acknowledged offset after a partially accepted range", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    const accepted = 2 * 1024 * 1024;
    direct.mockImplementationOnce(async () => new Response(null, {
      status: 308, headers: { Range: `bytes=0-${accepted - 1}` },
    }));
    const staged = source();
    await uploadGoogleDriveBackupSource(staged, "backup.zip.enc");
    expect(staged.readChunk.mock.calls).toEqual([[0, chunkSize], [accepted, totalSize - accepted]]);
    expect(new Headers(direct.mock.calls[1]?.[1]?.headers).get("Content-Range"))
      .toBe(`bytes ${accepted}-${totalSize - 1}/${totalSize}`);
  });

  it.each([{ delta: -1 }, { delta: 1 }])("rejects a range of the wrong length ($delta)", async ({ delta }) => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    await expect(uploadGoogleDriveBackupSource({
      size: totalSize,
      readChunk: async (_offset, length) => Buffer.alloc(length + delta),
    }, "backup.zip.enc")).rejects.toThrow(/archive changed while reading bytes/);
    expect(direct).not.toHaveBeenCalled();
  });

  it.each([{ size: 0 }, { size: -1 }, { size: NaN }, { size: Number.MAX_SAFE_INTEGER + 1 }])(
    "rejects an invalid sealed size before creating a remote upload ($size)", async ({ size }) => {
      enableConnector();
      const { proxy, direct } = makeUploadMocks(201, false);
      const readChunk = vi.fn();
      await expect(uploadGoogleDriveBackupSource({ size, readChunk }, "backup.zip.enc"))
        .rejects.toThrow(/empty or invalid/);
      expect(proxy).not.toHaveBeenCalled();
      expect(direct).not.toHaveBeenCalled();
      expect(readChunk).not.toHaveBeenCalled();
    },
  );

  it("does not open a remote upload for an already aborted backup", async () => {
    enableConnector();
    const { proxy, direct } = makeUploadMocks(201, false);
    const controller = new AbortController();
    controller.abort();
    const staged = source();
    await expect(uploadGoogleDriveBackupSource(staged, "backup.zip.enc", { signal: controller.signal }))
      .rejects.toThrow(/aborted/);
    expect(proxy).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(staged.readChunk).not.toHaveBeenCalled();
  });

  it("does not send a range if cancellation happens during the source read", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    const controller = new AbortController();
    await expect(uploadGoogleDriveBackupSource({
      size: totalSize,
      async readChunk(_offset, length) {
        controller.abort();
        return Buffer.alloc(length);
      },
    }, "backup.zip.enc", { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("retries the same range without rereading or advancing the sealed source", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    direct.mockRejectedValueOnce(new TypeError("fetch failed"));
    const staged = source();
    await uploadGoogleDriveBackupSource(staged, "backup.zip.enc");
    expect(staged.readChunk.mock.calls).toEqual([[0, chunkSize], [chunkSize, 17]]);
    expect(direct).toHaveBeenCalledTimes(3);
    expect(direct.mock.calls[0]?.[1]?.body).toBe(direct.mock.calls[1]?.[1]?.body);
  });

  it("rejects an acknowledgement beyond the range actually sent", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    direct.mockImplementationOnce(async () => new Response(null, {
      status: 308, headers: { Range: `bytes=0-${totalSize - 1}` },
    }));
    const staged = source();
    await expect(uploadGoogleDriveBackupSource(staged, "backup.zip.enc"))
      .rejects.toThrow(/invalid resumable-upload byte range/);
    expect(staged.readChunk).toHaveBeenCalledTimes(1);
  });

  it("never treats early completion as a complete archive", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    direct.mockImplementationOnce(async () => new Response("{}", { status: 201 }));
    await expect(uploadGoogleDriveBackupSource(source(), "backup.zip.enc"))
      .rejects.toThrow(/before the final archive chunk/);
  });

  it("preserves source-generation errors instead of uploading replacement or empty bytes", async () => {
    enableConnector();
    const { direct } = makeUploadMocks(201, false);
    await expect(uploadGoogleDriveBackupSource({
      size: totalSize,
      async readChunk() { throw new Error("Pinned generation no longer exists"); },
    }, "backup.zip.enc")).rejects.toThrow(/Pinned generation/);
    expect(direct).not.toHaveBeenCalled();
  });
});

