/**
 * Unit tests for the OneDrive (Microsoft Graph) backup destination client.
 *
 * All network access goes through the injectable fetch override
 * (setOneDriveFetchForTests), so these tests never touch the Replit connector
 * proxy or Microsoft Graph.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS,
  DEFAULT_ONEDRIVE_RETENTION_POLICY,
  ONEDRIVE_BACKUP_FOLDER,
  ONEDRIVE_MIN_RETAINED_ARCHIVES,
  ONEDRIVE_NON_PRODUCTION_FOLDER,
  deleteOneDriveBackupFile,
  getOneDriveBackupFolder,
  getOneDriveFileByName,
  downloadFileFromOneDrive,
  oneDriveItemPath,
  oneDriveItemIdFromPath,
  getOneDriveManageUrl,
  getOneDriveStatus,
  isOneDriveConnectorAvailable,
  listOneDriveBackupFiles,
  parseBackupFileName,
  pruneOneDriveBackups,
  selectOneDriveBackupsToPrune,
  setOneDriveFetchForTests,
  uploadBackupFileToOneDrive,
  uploadBackupSourceToOneDrive,
  uploadBackupToOneDrive,
  type OneDriveBackupFile,
  type OneDriveFetch,
} from "./onedrive.js";

type FetchCall = { url: string; init?: Parameters<OneDriveFetch>[1] };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CONNECTOR_URL_PART = "/api/v2/connection?include_secrets=true&connector_names=onedrive";

/** Standard connector response containing a Graph access token. */
function connectorResponse(token = "graph-token-1") {
  return jsonResponse(200, {
    items: [{ settings: { access_token: token } }],
  });
}

describe("onedrive client", () => {
  beforeEach(() => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connectors.test.internal");
    vi.stubEnv("REPL_IDENTITY", "test-identity");
    vi.stubEnv("WEB_REPL_RENEWAL", "");
    vi.stubEnv("REPL_OWNER", "test-owner");
    vi.stubEnv("REPL_SLUG", "test-slug");
    // These tests model the production server, which is the only one allowed
    // to write to the lab's real backup folder. The split is covered on its
    // own below.
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
  });

  afterEach(() => {
    setOneDriveFetchForTests(null);
    vi.unstubAllEnvs();
  });

  describe("backup folder by environment", () => {
    it("writes to the lab's backup folder only from the production server", () => {
      expect(getOneDriveBackupFolder()).toBe(ONEDRIVE_BACKUP_FOLDER);
    });

    it("confines every other environment to a separate subfolder", () => {
      // A workspace archive is built from development data. If it landed in
      // the real folder it would be indistinguishable from the lab's own
      // backups — and development retention would prune the real ones.
      vi.stubEnv("REPLIT_DEPLOYMENT", "");
      expect(getOneDriveBackupFolder()).toBe(ONEDRIVE_NON_PRODUCTION_FOLDER);
      expect(getOneDriveBackupFolder().startsWith(`${ONEDRIVE_BACKUP_FOLDER}/`)).toBe(true);
    });

    it("sends a non-production upload into the subfolder path", async () => {
      vi.stubEnv("REPLIT_DEPLOYMENT", "");
      const calls: FetchCall[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        calls.push({ url, init });
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.test/session" });
        }
        return jsonResponse(201, { id: "f1", name: "backup.zip", size: 11, webUrl: "https://1drv.ms/f1" });
      });

      const result = await uploadBackupToOneDrive(Buffer.from("hello world"), "backup.zip");
      expect(result.folder).toBe(ONEDRIVE_NON_PRODUCTION_FOLDER);
      const sessionCall = calls.find((c) => c.url.includes("/createUploadSession"))!;
      expect(sessionCall.url).toContain("non-production/backup.zip");
    });
  });

  describe("isOneDriveConnectorAvailable", () => {
    it("is true when the connector hostname and identity are present", () => {
      expect(isOneDriveConnectorAvailable()).toBe(true);
    });

    it("is false without the connector hostname", () => {
      vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
      expect(isOneDriveConnectorAvailable()).toBe(false);
    });

    it("is false without any identity token", () => {
      vi.stubEnv("REPL_IDENTITY", "");
      vi.stubEnv("WEB_REPL_RENEWAL", "");
      expect(isOneDriveConnectorAvailable()).toBe(false);
    });
  });

  describe("getOneDriveStatus", () => {
    it("returns connected:false (never throws) when the connector infra is missing", async () => {
      vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
      const status = await getOneDriveStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toMatch(/not available/i);
      expect(status.folder).toBe(ONEDRIVE_BACKUP_FOLDER);
    });

    it("returns connected:false when no OneDrive connection exists", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return jsonResponse(200, { items: [] });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const status = await getOneDriveStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toMatch(/not connected/i);
    });

    it("returns connected:true with the account identity on success", async () => {
      const calls: FetchCall[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        calls.push({ url, init });
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/me?")) {
          expect(init?.headers?.Authorization).toBe("Bearer graph-token-1");
          return jsonResponse(200, {
            displayName: "Backup Owner",
            mail: "owner@example.com",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const status = await getOneDriveStatus();
      expect(status).toEqual({
        connected: true,
        accountName: "Backup Owner",
        accountEmail: "owner@example.com",
        folder: ONEDRIVE_BACKUP_FOLDER,
        error: null,
        manageUrl: "https://replit.com/@test-owner/test-slug",
      });
    });

    it("reports rejected credentials when Graph returns 401", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/me?")) return jsonResponse(401, { error: "bad token" });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const status = await getOneDriveStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toMatch(/HTTP 401/);
      expect(status.error).toMatch(/reconnect/i);
      expect(status.manageUrl).toBe("https://replit.com/@test-owner/test-slug");
    });
  });

  describe("getOneDriveManageUrl", () => {
    it("builds the hosting-workspace URL from the repl identity env", () => {
      expect(getOneDriveManageUrl()).toBe("https://replit.com/@test-owner/test-slug");
    });

    it("URL-encodes the owner and slug", () => {
      vi.stubEnv("REPL_OWNER", "owner with space");
      vi.stubEnv("REPL_SLUG", "slug/兔");
      expect(getOneDriveManageUrl()).toBe(
        `https://replit.com/@${encodeURIComponent("owner with space")}/${encodeURIComponent("slug/兔")}`,
      );
    });

    it("is null when the hosting environment does not expose its identity", () => {
      vi.stubEnv("REPL_OWNER", "");
      expect(getOneDriveManageUrl()).toBe(null);
      vi.stubEnv("REPL_OWNER", "test-owner");
      vi.stubEnv("REPL_SLUG", "");
      expect(getOneDriveManageUrl()).toBe(null);
    });
  });

  describe("uploadBackupToOneDrive", () => {
    function mockCompletion(status: number, item: unknown) {
      const puts = vi.fn();
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.test/session" });
        }
        puts(init);
        return jsonResponse(status, item);
      });
      return puts;
    }

    it.each([200, 201])("returns the exact renamed item identity on final HTTP %s", async status => {
      mockCompletion(status, { id: "new-item", name: "backup.zip 22.enc", size: 3 });
      const result = await uploadBackupToOneDrive(Buffer.from("new"), "backup.zip.enc");
      expect(result).toMatchObject({ itemId: "new-item", fileName: "backup.zip 22.enc", size: 3 });
    });

    it.each([undefined, null, "3", 2, 4, -1, 3.5])("rejects missing or wrong completion size %s", async size => {
      mockCompletion(201, { id: "new-item", name: "backup.zip.enc", size });
      await expect(uploadBackupToOneDrive(Buffer.from("new"), "backup.zip.enc"))
        .rejects.toThrow(/size/);
    });

    it.each([{ size: 3 }, { id: "id", size: 3 }, { name: "backup.zip.enc", size: 3 }, null])(
      "rejects a completion without confirmed identity: %s", async item => {
        mockCompletion(201, item);
        await expect(uploadBackupToOneDrive(Buffer.from("new"), "backup.zip.enc")).rejects.toThrow();
      },
    );

    it("rejects early completion immediately without sending another chunk", async () => {
      const size = 5 * 1024 * 1024 + 1;
      const puts = mockCompletion(201, { id: "id", name: "backup.zip.enc", size });
      await expect(uploadBackupToOneDrive(Buffer.alloc(size), "backup.zip.enc"))
        .rejects.toThrow(/before the final chunk/);
      expect(puts).toHaveBeenCalledTimes(1);
    });

    it("rejects a final 202, even after accepted intermediate chunks", async () => {
      const puts = mockCompletion(202, { nextExpectedRanges: ["0-"] });
      await expect(uploadBackupToOneDrive(Buffer.alloc(5 * 1024 * 1024 + 1), "backup.zip.enc"))
        .rejects.toThrow(/without a completed-item/);
      expect(puts).toHaveBeenCalledTimes(2);
    });

    it("rejects a malformed completion body", async () => {
      mockCompletion(201, null);
      await expect(uploadBackupToOneDrive(Buffer.from("new"), "backup.zip.enc")).rejects.toThrow();
    });

    it("creates an upload session and uploads a small buffer in one chunk", async () => {
      const calls: FetchCall[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        calls.push({ url, init });
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-1" });
        }
        if (url === "https://upload.example.com/session-1") {
          return jsonResponse(201, { id: "f1", name: "backup.zip", size: 11, webUrl: "https://1drv.ms/f1" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await uploadBackupToOneDrive(Buffer.from("hello world"), "backup.zip");
      expect(result).toEqual({
        itemId: "f1",
        fileName: "backup.zip",
        size: 11,
        webUrl: "https://1drv.ms/f1",
        folder: ONEDRIVE_BACKUP_FOLDER,
      });

      const sessionCall = calls.find((c) => c.url.includes("/createUploadSession"))!;
      // Path-encodes the backup folder + file name under the drive root.
      expect(sessionCall.url).toContain("/me/drive/root:/Apps/LabTrax%20Backups/backup.zip:/createUploadSession");
      const sessionBody = JSON.parse(String(sessionCall.init?.body)) as {
        item: Record<string, unknown>;
      };
      expect(sessionBody.item["@microsoft.graph.conflictBehavior"]).toBe("rename");

      const putCalls = calls.filter((c) => c.init?.method === "PUT");
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]!.init?.headers?.["Content-Range"]).toBe("bytes 0-10/11");
    });

    it("retries a transient chunk transport failure on the same upload session and range", async () => {
      const payload = Buffer.from("archive-v1");
      const ranges: string[] = [];
      const bodies: Buffer[] = [];
      let sessionCount = 0;
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          sessionCount += 1;
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-retry" });
        }
        if (url === "https://upload.example.com/session-retry") {
          ranges.push(String(init?.headers?.["Content-Range"]));
          bodies.push(Buffer.from(init?.body as Uint8Array));
          if (ranges.length === 1) throw new TypeError("fetch failed");
          return jsonResponse(201, {
            id: "retry-item",
            name: "retry.zip.enc",
            size: payload.length,
            webUrl: "https://1drv.ms/retry",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await uploadBackupToOneDrive(payload, "retry.zip.enc");

      expect(result.size).toBe(payload.length);
      expect(sessionCount).toBe(1);
      expect(ranges).toEqual([
        `bytes 0-${payload.length - 1}/${payload.length}`,
        `bytes 0-${payload.length - 1}/${payload.length}`,
      ]);
      expect(bodies.every((body) => body.equals(payload))).toBe(true);
    });

    it("stops after the initial attempt and three transient transport retries", async () => {
      let attempts = 0;
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-exhausted" });
        }
        if (url === "https://upload.example.com/session-exhausted") {
          attempts += 1;
          throw new TypeError("fetch failed");
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await expect(uploadBackupToOneDrive(Buffer.from("archive"), "failed.zip.enc"))
        .rejects.toThrow(/after 4 attempts at bytes 0-6 of 7/);
      expect(attempts).toBe(4);
    });

    it("reports the name OneDrive kept, not the name that was requested", async () => {
      // Graph's "rename" conflict behaviour is what produced files called
      // "labtrax-backup-2026-09-18.zip 22.enc" while backup history recorded
      // "labtrax-backup-2026-09-18.zip.enc" — a history row addressing a file
      // that does not exist.
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-r" });
        }
        if (url === "https://upload.example.com/session-r") {
          return jsonResponse(201, {
            id: "01RENAMEDITEM",
            name: "backup.zip 22.enc",
            size: 11,
            webUrl: "https://1drv.ms/f3",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await uploadBackupToOneDrive(Buffer.from("hello world"), "backup.zip.enc");
      expect(result.fileName).toBe("backup.zip 22.enc");
      expect(result.itemId).toBe("01RENAMEDITEM");
    });

    it("splits large buffers into 5 MiB chunks with correct Content-Range headers", async () => {
      const CHUNK = 320 * 1024 * 16; // 5 MiB — must be a multiple of 320 KiB
      const total = CHUNK + 1024; // forces exactly two chunks
      const ranges: string[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-2" });
        }
        if (url === "https://upload.example.com/session-2") {
          ranges.push(String(init?.headers?.["Content-Range"]));
          const isLast = ranges.length === 2;
          // Graph replies 202 for intermediate chunks and 200/201 with the
          // drive item for the final one.
          return isLast
            ? jsonResponse(201, { id: "f2", name: "big-backup.zip", size: total, webUrl: "https://1drv.ms/f2" })
            : jsonResponse(202, {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await uploadBackupToOneDrive(Buffer.alloc(total), "big-backup.zip");
      expect(result.size).toBe(total);
      expect(ranges).toEqual([
        `bytes 0-${CHUNK - 1}/${total}`,
        `bytes ${CHUNK}-${total - 1}/${total}`,
      ]);
    });

    it("uploads bounded asynchronous cloud ranges and reuses the same bytes on retry", async () => {
      const CHUNK = 320 * 1024 * 16;
      const payload = Buffer.alloc(CHUNK + 2048, 71);
      const readChunk = vi.fn(async (offset: number, length: number) => payload.subarray(offset, offset + length));
      const ranges: string[] = [];
      const bodies: Buffer[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) return jsonResponse(200, { uploadUrl: "https://upload.example.com/cloud" });
        if (url === "https://upload.example.com/cloud") {
          ranges.push(String(init?.headers?.["Content-Range"]));
          bodies.push(Buffer.from(init?.body as unknown as Uint8Array));
          if (ranges.length === 1) throw Object.assign(new Error("temporary connection reset"), { code: "ECONNRESET" });
          return ranges.length === 3
            ? jsonResponse(201, { id: "cloud", name: "cloud.zip.enc", size: payload.length })
            : jsonResponse(202, {});
        }
        throw new Error("Unexpected mocked network request");
      });
      const result = await uploadBackupSourceToOneDrive({ size: payload.length, readChunk }, "cloud.zip.enc");
      expect(result.size).toBe(payload.length);
      expect(readChunk.mock.calls).toEqual([[0, CHUNK], [CHUNK, 2048]]);
      expect(ranges[0]).toBe(ranges[1]);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(Buffer.concat(bodies.slice(1))).toEqual(payload);
    });

    it("handles a production-sized logical source without 32-bit byte-count truncation", async () => {
      const size = 33_462_939_621;
      const CHUNK = 320 * 1024 * 16;
      const block = Buffer.alloc(CHUNK, 7);
      let sent = 0;
      let lastRange = "";
      let reads = 0;
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) return jsonResponse(200, { uploadUrl: "https://upload.example.com/large-logical" });
        sent += (init?.body as Uint8Array).length;
        lastRange = init?.headers?.["Content-Range"] ?? "";
        return sent === size
          ? jsonResponse(201, { id: "large", name: "large.zip.enc", size })
          : jsonResponse(202, {});
      });
      const result = await uploadBackupSourceToOneDrive({
        size,
        async readChunk(_offset, length) {
          reads++;
          expect(length).toBeLessThanOrEqual(CHUNK);
          return block.subarray(0, length);
        },
      }, "large.zip.enc");
      expect(sent).toBe(size);
      expect(result.size).toBe(size);
      expect(reads).toBe(Math.ceil(size / CHUNK));
      expect(lastRange).toBe(`bytes ${Math.floor(size / CHUNK) * CHUNK}-${size - 1}/${size}`);
    });

    it("rejects a short async cloud range before transmitting it", async () => {
      const writes = vi.fn();
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) return jsonResponse(200, { uploadUrl: "https://upload.example.com/short" });
        writes();
        throw new Error("A short range must never be sent");
      });
      await expect(uploadBackupSourceToOneDrive({
        size: 100, readChunk: async () => Buffer.alloc(99),
      }, "short.zip.enc")).rejects.toThrow(/incorrect chunk size/);
      expect(writes).not.toHaveBeenCalled();
    });

    it("uploadBackupFileToOneDrive reads a file in chunks and sends the exact bytes", async () => {
      const CHUNK = 320 * 1024 * 16;
      const total = CHUNK + 2048; // forces exactly two chunks
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-upload-"));
      const filePath = path.join(dir, "from-disk.zip");
      const payload = Buffer.alloc(total);
      payload.write("HEAD", 0);
      payload.write("TAIL", total - 4);
      fs.writeFileSync(filePath, payload);

      const ranges: string[] = [];
      const bodies: Buffer[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-file" });
        }
        if (url === "https://upload.example.com/session-file") {
          ranges.push(String(init?.headers?.["Content-Range"]));
          bodies.push(Buffer.from(init?.body as unknown as Uint8Array));
          return ranges.length === 2
            ? jsonResponse(201, { id: "f3", name: "from-disk.zip", size: total, webUrl: "https://1drv.ms/f3" })
            : jsonResponse(202, {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      try {
        const result = await uploadBackupFileToOneDrive(filePath, "from-disk.zip");
        expect(result.size).toBe(total);
        expect(ranges).toEqual([
          `bytes 0-${CHUNK - 1}/${total}`,
          `bytes ${CHUNK}-${total - 1}/${total}`,
        ]);
        // What went over the wire must reassemble into the original file byte
        // for byte — a positioned-read bug would corrupt the backup silently.
        expect(Buffer.concat(bodies).equals(payload)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("interrupts a chunk that is still in flight when the run's deadline aborts", async () => {
      // The between-chunk guard only helps if a chunk ever returns. A wedged
      // transfer sits inside one request for its whole per-request budget, so
      // the run's deadline has to reach the request itself — otherwise a
      // single stuck upload holds the in-flight guard and no later backup
      // runs, which is exactly how the schedule went quiet.
      const CHUNK = 320 * 1024 * 16;
      const total = CHUNK + 2048; // two chunks
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-upload-"));
      const filePath = path.join(dir, "wedged.zip");
      fs.writeFileSync(filePath, Buffer.alloc(total));

      const runDeadline = new AbortController();
      let chunks = 0;
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-wedged" });
        }
        if (url === "https://upload.example.com/session-wedged") {
          chunks += 1;
          if (chunks === 1) return jsonResponse(202, {});
          // This chunk never completes on its own: only an abort reaching the
          // request itself can end it. A request with no signal at all is the
          // regression this guards, so fail fast instead of hanging.
          const chunkSignal = init?.signal;
          if (!chunkSignal) throw new Error("the chunk request carried no abort signal");
          return await new Promise((_resolve, reject) => {
            chunkSignal.addEventListener(
              "abort",
              () => {
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
            // The run's overall deadline fires while this chunk is in flight.
            runDeadline.abort();
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      try {
        await expect(
          uploadBackupFileToOneDrive(filePath, "wedged.zip", { signal: runDeadline.signal }),
        ).rejects.toThrow(/time budget/i);
        // It really did stop inside the second chunk, not before sending it.
        expect(chunks).toBe(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("uploadBackupFileToOneDrive throws rather than sending a short chunk if the file shrinks mid-upload", async () => {
      const CHUNK = 320 * 1024 * 16;
      const total = CHUNK + 2048;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-upload-"));
      const filePath = path.join(dir, "shrinking.zip");
      fs.writeFileSync(filePath, Buffer.alloc(total));

      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-short" });
        }
        if (url === "https://upload.example.com/session-short") {
          // Truncate after the first chunk so the second positioned read comes
          // up short against the Content-Range already computed for it.
          fs.truncateSync(filePath, CHUNK);
          return jsonResponse(202, {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      try {
        await expect(
          uploadBackupFileToOneDrive(filePath, "shrinking.zip"),
        ).rejects.toThrow(/short read/i);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("throws with the Graph status when the upload session cannot be created", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) return jsonResponse(507, { error: "quota" });
        throw new Error(`unexpected fetch: ${url}`);
      });
      await expect(uploadBackupToOneDrive(Buffer.from("x"), "b.zip")).rejects.toThrow(/HTTP 507/);
    });

    it("throws when a chunk upload fails part-way", async () => {
      let attempts = 0;
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/createUploadSession")) {
          return jsonResponse(200, { uploadUrl: "https://upload.example.com/session-3" });
        }
        if (url === "https://upload.example.com/session-3") {
          attempts += 1;
          return jsonResponse(500, { error: "boom" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await expect(uploadBackupToOneDrive(Buffer.from("data"), "b.zip")).rejects.toThrow(
        /chunk upload failed \(HTTP 500\)/,
      );
      expect(attempts).toBe(1);
    });

    it("throws when OneDrive is not connected (no token)", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return jsonResponse(200, { items: [] });
        throw new Error(`unexpected fetch: ${url}`);
      });
      await expect(uploadBackupToOneDrive(Buffer.from("x"), "b.zip")).rejects.toThrow(
        /not connected/i,
      );
    });
  });

  describe("listOneDriveBackupFiles", () => {
    it("returns files from Graph sorted newest-first", async () => {
      const items = [
        { id: "id1", name: "backup-2026-07-12.zip.enc", size: 1024, createdDateTime: "2026-07-12T07:00:00Z", webUrl: "https://1drv.ms/a" },
        { id: "id2", name: "backup-2026-07-11.zip.enc", size: 2048, createdDateTime: "2026-07-11T07:00:00Z", webUrl: "https://1drv.ms/b" },
      ];
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(200, { value: items.map(item => ({ ...item, file: {} })) });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const result = await listOneDriveBackupFiles();
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe("id1");
      expect(result[0]!.name).toBe("backup-2026-07-12.zip.enc");
      expect(result[1]!.id).toBe("id2");
    });

    it("ignores subfolders, so the non-production folder is never listed as an archive", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) {
          return jsonResponse(200, {
            value: [
              { id: "dir", name: "non-production", createdDateTime: "2026-10-06T07:00:00Z", folder: { childCount: 4 } },
              { id: "id1", name: "backup-2026-10-06.zip.enc", file: {}, size: 1024, createdDateTime: "2026-10-06T06:00:00Z" },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const result = await listOneDriveBackupFiles();
      expect(result.map((f) => f.id)).toEqual(["id1"]);
    });

    it("asks Graph for the folder facet so directories can be told apart", async () => {
      let capturedUrl = "";
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) {
          capturedUrl = url;
          return jsonResponse(200, { value: [] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await listOneDriveBackupFiles();
      expect(capturedUrl).toContain("folder");
    });

    it("returns empty array when the backup folder does not exist (404)", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(404, { error: "itemNotFound" });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const result = await listOneDriveBackupFiles();
      expect(result).toEqual([]);
    });

    it("throws when Graph returns an unexpected error", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(500, { error: "serverError" });
        throw new Error(`unexpected fetch: ${url}`);
      });
      await expect(listOneDriveBackupFiles()).rejects.toThrow(/folder list failed.*HTTP 500/i);
    });

    it("passes the Authorization header to Graph", async () => {
      let capturedAuth: string | undefined;
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse("my-token");
        if (url.includes("/children?")) {
          capturedAuth = init?.headers?.Authorization;
          return jsonResponse(200, { value: [] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await listOneDriveBackupFiles();
      expect(capturedAuth).toBe("Bearer my-token");
    });

    it("does not send an $orderby query param (rejected with HTTP 400 on personal OneDrive accounts)", async () => {
      let capturedUrl: string | undefined;
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) {
          capturedUrl = url;
          return jsonResponse(200, { value: [] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await listOneDriveBackupFiles();
      expect(capturedUrl).toBeDefined();
      expect(capturedUrl).not.toContain("$orderby");
    });

    it("sorts results newest-first client-side even when Graph returns them unsorted", async () => {
      const items = [
        { id: "old", name: "backup-old.zip.enc", size: 100, createdDateTime: "2026-06-30T07:00:00Z" },
        { id: "new", name: "backup-new.zip.enc", size: 100, createdDateTime: "2026-07-12T07:00:00Z" },
        { id: "mid", name: "backup-mid.zip.enc", size: 100, createdDateTime: "2026-07-01T07:00:00Z" },
      ];
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(200, { value: items.map(item => ({ ...item, file: {} })) });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const result = await listOneDriveBackupFiles();
      expect(result.map((f) => f.id)).toEqual(["new", "mid", "old"]);
    });
  });

  describe("deleteOneDriveBackupFile", () => {
    it("issues a DELETE request to the Graph items endpoint", async () => {
      const calls: FetchCall[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        calls.push({ url, init });
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/me/drive/items/")) {
          expect(init?.method).toBe("DELETE");
          return jsonResponse(204, null);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await deleteOneDriveBackupFile("item-abc");
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toContain("/me/drive/items/item-abc");
    });

    it("throws when the DELETE returns an error status", async () => {
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/me/drive/items/") && init?.method === "DELETE") {
          return jsonResponse(404, { error: "itemNotFound" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await expect(deleteOneDriveBackupFile("ghost-id")).rejects.toThrow(/delete failed.*HTTP 404/i);
    });
  });

  describe("pruneOneDriveBackups", () => {
    it("caps the folder well above a single day of 15-minute backups", () => {
      // 96 archives a day: a cap of 30 could not hold even one day, which is
      // why the file ceiling is now a storage guard rather than the policy.
      expect(DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS).toBeGreaterThan(96);
    });
  });

  describe("parseBackupFileName", () => {
    it("reads the run time and kind from a timestamped archive name", () => {
      const parsed = parseBackupFileName("labtrax-backup-2026-10-06T154500Z-db-only.zip.enc");
      expect(parsed.isLabTraxBackup).toBe(true);
      expect(parsed.isDatabaseOnly).toBe(true);
      expect(parsed.takenAt?.toISOString()).toBe("2026-10-06T15:45:00.000Z");
    });

    it("treats a timestamped full archive as full", () => {
      const parsed = parseBackupFileName("labtrax-backup-2026-10-06T160000Z-full.zip.enc");
      expect(parsed.isDatabaseOnly).toBe(false);
      expect(parsed.takenAt?.toISOString()).toBe("2026-10-06T16:00:00.000Z");
    });

    it("treats legacy date-only names (and Graph's renamed copies) as full archives", () => {
      // These are the names already sitting in the live folder: Graph's
      // "rename" conflict behaviour appended a counter before the extension.
      const renamed = parseBackupFileName("labtrax-backup-2026-09-18.zip 22.enc");
      expect(renamed.isLabTraxBackup).toBe(true);
      expect(renamed.isDatabaseOnly).toBe(false);
      expect(renamed.takenAt?.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    });

    it("does not claim files that are not LabTrax archives", () => {
      const parsed = parseBackupFileName("holiday-photos.zip");
      expect(parsed.isLabTraxBackup).toBe(false);
      expect(parsed.takenAt).toBeNull();
    });
  });

  describe("pruneOneDriveBackups", () => {
    it("does not delete anything the policy still keeps", async () => {
      const deletedIds: string[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) {
          return jsonResponse(200, {
            value: [
              { id: "a", name: "backup-a.zip.enc", file: {}, size: 100, createdDateTime: "2026-07-12T07:00:00Z" },
              { id: "b", name: "backup-b.zip.enc", file: {}, size: 100, createdDateTime: "2026-07-11T07:00:00Z" },
            ],
          });
        }
        if (url.includes("/me/drive/items/") && init?.method === "DELETE") {
          deletedIds.push(url.split("/items/")[1]!);
          return jsonResponse(204, null);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const pruned = await pruneOneDriveBackups({
        keepAllWithinHours: 0,
        keepHourlyWithinDays: 0,
        keepDailyWithinDays: 3650,
        maxFiles: 5,
        keepNewestCount: 0,
      });
      expect(pruned).toEqual([]);
      expect(deletedIds).toEqual([]);
    });

    it("deletes the archives the policy drops, newest-first order preserved", async () => {
      const deletedIds: string[] = [];
      // One archive a day, two more than the cap. The cap is the floor here,
      // because no smaller one is honoured.
      const items = Array.from({ length: ONEDRIVE_MIN_RETAINED_ARCHIVES + 2 }, (_, i) => ({
        id: `day${i}`,
        name: `backup-day${i}.zip.enc`,
        size: 100,
        createdDateTime: new Date(Date.parse("2026-07-12T07:00:00Z") - i * 86_400_000).toISOString(),
      }));
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(200, { value: items.map(item => ({ ...item, file: {} })) });
        if (url.includes("/me/drive/items/") && init?.method === "DELETE") {
          deletedIds.push(url.split("/items/")[1]!);
          return jsonResponse(204, null);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const pruned = await pruneOneDriveBackups({
        keepAllWithinHours: 0,
        keepHourlyWithinDays: 0,
        keepDailyWithinDays: 3650,
        maxFiles: ONEDRIVE_MIN_RETAINED_ARCHIVES,
        keepNewestCount: 0,
      });
      const oldest = `day${ONEDRIVE_MIN_RETAINED_ARCHIVES + 1}`;
      const secondOldest = `day${ONEDRIVE_MIN_RETAINED_ARCHIVES}`;
      expect(deletedIds).toEqual([secondOldest, oldest]);
      expect(pruned).toEqual([`backup-${secondOldest}.zip.enc`, `backup-${oldest}.zip.enc`]);
    });

    it("never deletes a subfolder or a non-archive file sharing the folder", async () => {
      const deletedIds: string[] = [];
      // 32 archives (two over the floor) plus the non-production subfolder and
      // a stray document. Only archives may ever be selected for deletion.
      const items: Array<Record<string, unknown>> = Array.from(
        { length: ONEDRIVE_MIN_RETAINED_ARCHIVES + 2 },
        (_, i) => ({
          id: `day${i}`,
          name: `backup-day${i}.zip.enc`,
          size: 100,
          createdDateTime: new Date(Date.parse("2026-07-12T07:00:00Z") - i * 86_400_000).toISOString(),
        }),
      );
      items.push({
        id: "non-production-folder",
        name: "non-production",
        createdDateTime: "2020-01-01T00:00:00Z",
        folder: { childCount: 12 },
      });
      items.push({
        id: "readme",
        name: "README-recovery-notes.txt",
        size: 40,
        createdDateTime: "2020-01-01T00:00:00Z",
      });
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(200, { value: items.map(item => ({ ...item, file: {} })) });
        if (url.includes("/me/drive/items/") && init?.method === "DELETE") {
          deletedIds.push(url.split("/items/")[1]!);
          return jsonResponse(204, null);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      await pruneOneDriveBackups({
        keepAllWithinHours: 0,
        keepHourlyWithinDays: 0,
        keepDailyWithinDays: 3650,
        maxFiles: ONEDRIVE_MIN_RETAINED_ARCHIVES,
        keepNewestCount: 0,
      });
      expect(deletedIds).not.toContain("non-production-folder");
      expect(deletedIds).not.toContain("readme");
      // The archives over the cap were still pruned, so the filter did not
      // quietly disable retention.
      expect(deletedIds.length).toBe(2);
    });

    it("returns empty and does not throw when the list call fails", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(503, { error: "serviceUnavailable" });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const pruned = await pruneOneDriveBackups(DEFAULT_ONEDRIVE_RETENTION_POLICY);
      expect(pruned).toEqual([]);
    });

    it("continues pruning other files when one delete fails (non-fatal)", async () => {
      const items = [
        { id: "keep", name: "labtrax-backup-2026-10-06T115500Z-full.zip.enc", size: 100, createdDateTime: "2026-10-06T11:55:00Z" },
        { id: "fail", name: "labtrax-backup-2026-07-01T070000Z-full.zip.enc", size: 100, createdDateTime: "2026-07-01T07:00:00Z" },
        { id: "ok", name: "labtrax-backup-2026-06-30T070000Z-full.zip.enc", size: 100, createdDateTime: "2026-06-30T07:00:00Z" },
      ];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/children?")) return jsonResponse(200, { value: items.map(item => ({ ...item, file: {} })) });
        if (url.includes("/me/drive/items/") && init?.method === "DELETE") {
          const id = url.split("/items/")[1]!;
          if (id === "fail") return jsonResponse(500, { error: "boom" });
          return jsonResponse(204, null);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      // Tier-driven deletion (everything past the daily tier), since the file
      // cap can no longer be set below the retained-archive floor.
      const pruned = await pruneOneDriveBackups({
        keepAllWithinHours: 0,
        keepHourlyWithinDays: 0,
        keepDailyWithinDays: 0,
        maxFiles: DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS,
        keepNewestCount: 0,
      });
      // "fail" errored but "ok" still got deleted
      expect(pruned).toEqual(["labtrax-backup-2026-06-30T070000Z-full.zip.enc"]);
    });
  });

  describe("downloading by recorded item identity", () => {
    it("fetches the item's content endpoint by id, not by name", async () => {
      const urls: string[] = [];
      setOneDriveFetchForTests(async (url) => {
        urls.push(url);
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("/content")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => "",
            arrayBuffer: async () => new TextEncoder().encode("ciphertext").buffer,
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      // The recorded name is deliberately wrong here: a run's history row must
      // resolve through the item id Graph confirmed, never through a name that
      // Graph's rename-on-conflict behaviour may have given to another file.
      const buf = await downloadFileFromOneDrive("not-the-stored-name.zip.enc", undefined, "item-xyz");
      expect(buf.toString("utf8")).toBe("ciphertext");
      expect(urls.some((u) => u.includes("/me/drive/items/item-xyz/content"))).toBe(true);
      expect(urls.some((u) => u.includes("not-the-stored-name"))).toBe(false);
    });
  });

  describe("selectOneDriveBackupsToPrune (time-tiered retention)", () => {
    const NOW = Date.parse("2026-10-06T12:00:00Z");

    function file(id: string, createdDateTime: string): OneDriveBackupFile {
      return {
        id,
        name: `labtrax-backup-${createdDateTime.replace(/[:]/g, "-")}.zip.enc`,
        size: 600_000_000,
        createdDateTime,
        webUrl: null,
      };
    }

    it("keeps every archive inside the recent window", () => {
      const files = [
        file("a", "2026-10-06T11:45:00Z"),
        file("b", "2026-10-06T11:30:00Z"),
        file("c", "2026-10-06T11:15:00Z"),
        file("d", "2026-10-06T11:00:00Z"),
      ];
      const pruned = selectOneDriveBackupsToPrune(files, DEFAULT_ONEDRIVE_RETENTION_POLICY, NOW);
      expect(pruned).toEqual([]);
    });

    it("keeps the full archive as the survivor of an hour or a day, not a database-only one", () => {
      // A database-only archive carries no media. If the newest file in a
      // bucket won on recency alone, thinning would quietly replace that
      // day's restorable copy with one that restores no media at all.
      const named = (id: string, createdDateTime: string, name: string): OneDriveBackupFile => ({
        id, name, size: 600_000_000, createdDateTime, webUrl: null,
      });
      const files = [
        // The newest archive is never pruned whatever its kind, so the pair
        // under test must not be the newest thing in the folder.
        named("newest", "2026-10-06T11:45:00Z", "labtrax-backup-2026-10-06T114500Z-db-only.zip.enc"),
        // Same hour, ~2 days old (hourly tier): db-only is newer, full wins.
        named("h-db", "2026-10-04T09:45:00Z", "labtrax-backup-2026-10-04T094500Z-db-only.zip.enc"),
        named("h-full", "2026-10-04T09:30:00Z", "labtrax-backup-2026-10-04T093000Z-full.zip.enc"),
        // Same day, ~10 days old (daily tier): same rule.
        named("d-db", "2026-09-26T22:00:00Z", "labtrax-backup-2026-09-26T220000Z-db-only.zip.enc"),
        named("d-full", "2026-09-26T21:00:00Z", "labtrax-backup-2026-09-26T210000Z-full.zip.enc"),
      ];
      const pruned = selectOneDriveBackupsToPrune(
        files,
        { ...DEFAULT_ONEDRIVE_RETENTION_POLICY, keepNewestCount: 0 },
        NOW,
      ).map((f) => f.id);
      expect(pruned.sort()).toEqual(["d-db", "h-db"]);
    });

    it("thins older archives to one per hour, then one per day", () => {
      const files = [
        // Inside keepAllWithinHours (12h) — all four survive.
        file("recent-1", "2026-10-06T11:45:00Z"),
        file("recent-2", "2026-10-06T11:30:00Z"),
        // ~2 days old: hourly tier keeps the newest of each hour only.
        file("hourly-keep", "2026-10-04T09:45:00Z"),
        file("hourly-drop-1", "2026-10-04T09:30:00Z"),
        file("hourly-drop-2", "2026-10-04T09:15:00Z"),
        // ~10 days old: daily tier keeps the newest of each day only.
        file("daily-keep", "2026-09-26T22:00:00Z"),
        file("daily-drop", "2026-09-26T04:00:00Z"),
        // Older than keepDailyWithinDays (30d) — dropped.
        file("ancient", "2026-08-01T04:00:00Z"),
      ];
      // Tier behaviour on its own: the protected floor of newest archives is
      // covered separately below, and would otherwise keep this whole fixture.
      const pruned = selectOneDriveBackupsToPrune(
        files,
        { ...DEFAULT_ONEDRIVE_RETENTION_POLICY, keepNewestCount: 2 },
        NOW,
      ).map((f) => f.id);
      expect(pruned.sort()).toEqual(
        ["ancient", "daily-drop", "hourly-drop-1", "hourly-drop-2"].sort(),
      );
    });

    it("keeps multiple days of recovery points at a fifteen-minute cadence", () => {
      // Four days of backups every 15 minutes: a flat 30-file cap would leave
      // barely seven hours of history, which is what made an 18-day-old
      // archive the newest usable copy.
      const files: OneDriveBackupFile[] = [];
      for (let i = 0; i < 4 * 24 * 4; i++) {
        files.push(file(`f${i}`, new Date(NOW - i * 15 * 60_000).toISOString()));
      }
      const pruned = selectOneDriveBackupsToPrune(files, DEFAULT_ONEDRIVE_RETENTION_POLICY, NOW);
      const keptIds = new Set(files.map((f) => f.id));
      for (const p of pruned) keptIds.delete(p.id);
      const kept = files.filter((f) => keptIds.has(f.id));
      const keptDays = new Set(kept.map((f) => f.createdDateTime.slice(0, 10)));
      // Every one of the four days still has a restorable point.
      expect(keptDays.size).toBe(5); // 4 full days + the partial current day
      // And it does so with far fewer files than keeping everything.
      expect(kept.length).toBeLessThan(files.length / 2);
    });

    it("never deletes the newest archive, whatever the policy says", () => {
      const files = [file("only", "2020-01-01T00:00:00Z")];
      const pruned = selectOneDriveBackupsToPrune(
        files,
        {
          keepAllWithinHours: 0,
          keepHourlyWithinDays: 0,
          keepDailyWithinDays: 0,
          maxFiles: 1,
          keepNewestCount: 0,
        },
        NOW,
      );
      expect(pruned).toEqual([]);
    });

    it("never thins below the protected floor of newest archives", () => {
      // The outage left a cluster of hourly archives from a single day as the
      // only recovery points. Daily thinning alone would have deleted all but
      // one of them while the recovery was still in progress.
      const files: OneDriveBackupFile[] = [];
      for (let i = 0; i < 30; i++) {
        files.push(file(`cluster-${i}`, new Date(NOW - (18 * 24 + i) * 3_600_000).toISOString()));
      }
      const pruned = selectOneDriveBackupsToPrune(files, DEFAULT_ONEDRIVE_RETENTION_POLICY, NOW);
      expect(pruned).toEqual([]);

      // A 31st archive, older than the floor *and* past the daily tier, may go.
      files.push(file("beyond-floor", new Date(NOW - 40 * 24 * 3_600_000).toISOString()));
      const prunedWithExtra = selectOneDriveBackupsToPrune(
        files,
        DEFAULT_ONEDRIVE_RETENTION_POLICY,
        NOW,
      );
      expect(prunedWithExtra.map((f) => f.id)).toEqual(["beyond-floor"]);
    });

    it("raises a configured cap below the floor instead of honouring it", () => {
      // Retention settings are editable. A cap of 5 would leave the lab with
      // about an hour of history at a fifteen-minute cadence, so the floor
      // wins and the newest 30 archives survive.
      const files: OneDriveBackupFile[] = [];
      for (let i = 0; i < 40; i++) {
        files.push(file(`f${i}`, new Date(NOW - i * 15 * 60_000).toISOString()));
      }
      const pruned = selectOneDriveBackupsToPrune(
        files,
        { ...DEFAULT_ONEDRIVE_RETENTION_POLICY, maxFiles: 5, keepNewestCount: 1 },
        NOW,
      );
      const prunedIds = new Set(pruned.map((f) => f.id));
      const kept = files.filter((f) => !prunedIds.has(f.id));
      expect(kept.length).toBeGreaterThanOrEqual(ONEDRIVE_MIN_RETAINED_ARCHIVES);
      // The survivors are the newest ones, not an arbitrary subset.
      for (let i = 0; i < ONEDRIVE_MIN_RETAINED_ARCHIVES; i++) {
        expect(prunedIds.has(`f${i}`)).toBe(false);
      }
    });

    it("keeps archives with an unreadable creation time instead of deleting them", () => {
      const files = [
        file("newest", "2026-10-06T11:45:00Z"),
        { ...file("broken", "2026-10-06T11:00:00Z"), createdDateTime: "not-a-date" },
      ];
      const pruned = selectOneDriveBackupsToPrune(files, DEFAULT_ONEDRIVE_RETENTION_POLICY, NOW);
      expect(pruned).toEqual([]);
    });
  });

  describe("listOneDriveBackupFiles paging", () => {
    it("follows @odata.nextLink so retention sees the whole folder", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("page2")) {
          return jsonResponse(200, {
            value: [
              { id: "p2", name: "b2.zip.enc", file: {}, size: 2, createdDateTime: "2026-10-05T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/children?")) {
          return jsonResponse(200, {
            value: [
              { id: "p1", name: "b1.zip.enc", file: {}, size: 1, createdDateTime: "2026-10-06T00:00:00Z" },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?page2",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const files = await listOneDriveBackupFiles();
      expect(files.map((f) => f.id)).toEqual(["p1", "p2"]);
    });

    it.each([
      "https://attacker.test/v1.0/me/drive/children",
      "http://graph.microsoft.com/v1.0/me/drive/children",
      "https://graph.microsoft.com@attacker.test/v1.0/me/drive/children",
      "https://user:pass@graph.microsoft.com/v1.0/me/drive/children",
      "https://graph.microsoft.com/v1.0/users/other/drive/children",
      "",
      42,
    ])("does not send credentials to an unsafe pagination link %s", async next => {
      const calls: string[] = [];
      setOneDriveFetchForTests(async url => {
        calls.push(url);
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        return jsonResponse(200, { value: [], "@odata.nextLink": next });
      });
      await expect(listOneDriveBackupFiles()).rejects.toThrow();
      expect(calls).toHaveLength(2);
    });

    it("rejects pagination loops", async () => {
      let page = "";
      setOneDriveFetchForTests(async url => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        page = url;
        return jsonResponse(200, { value: [], "@odata.nextLink": page });
      });
      await expect(listOneDriveBackupFiles()).rejects.toThrow(/repeated/);
    });

    it.each([404, 500, 401])("does not prune from a partial listing when page two returns %s", async status => {
      const deletes: string[] = [];
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (init?.method === "DELETE") deletes.push(url);
        if (url.includes("page2")) return jsonResponse(status, {});
        return jsonResponse(200, {
          value: [{ id: "old", name: "old.zip.enc", file: {}, createdDateTime: "2000-01-01T00:00:00Z" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?page2",
        });
      });
      await expect(listOneDriveBackupFiles()).rejects.toThrow(/folder list failed/);
      expect(await pruneOneDriveBackups(DEFAULT_ONEDRIVE_RETENTION_POLICY)).toEqual([]);
      expect(deletes).toEqual([]);
    });

    it("lists only local archive files, including legacy collision names, across three pages", async () => {
      const item = (id: string, name: string) => ({ id, name, file: {}, size: 100 });
      setOneDriveFetchForTests(async url => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        if (url.includes("page3")) return jsonResponse(200, { value: [item("third", "backup.zip (2).enc")] });
        if (url.includes("page2")) return jsonResponse(200, {
          value: [item("second", "backup.zip 22.enc"), { ...item("remote", "remote.zip.enc"), remoteItem: {} }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?page3",
        });
        return jsonResponse(200, {
          value: [
            item("first", "backup.zip.enc"),
            item("notes", "notes.txt"),
            { id: "folder", name: "folder.zip.enc", folder: {} },
            { id: "unknown", name: "unknown.zip.enc" },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?page2",
        });
      });
      expect((await listOneDriveBackupFiles()).map(file => file.id)).toEqual(["first", "second", "third"]);
    });

    it("rejects malformed pages instead of treating them as complete empty folders", async () => {
      setOneDriveFetchForTests(async url =>
        url.includes(CONNECTOR_URL_PART) ? connectorResponse() : jsonResponse(200, {}));
      await expect(listOneDriveBackupFiles()).rejects.toThrow(/malformed page/);
    });
  });

  describe("stable history item references", () => {
    it("round-trips opaque IDs and leaves legacy history name-based", () => {
      expect(oneDriveItemIdFromPath(oneDriveItemPath("item/with!opaque?chars"))).toBe("item/with!opaque?chars");
      expect(oneDriveItemIdFromPath("https://1drv.ms/legacy")).toBeUndefined();
      expect(oneDriveItemIdFromPath(null)).toBeUndefined();
      expect(() => oneDriveItemIdFromPath("OneDrive:item:")).toThrow();
    });

    it("looks up and downloads by ID rather than the original collided name", async () => {
      setOneDriveFetchForTests(async url => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        expect(url).toContain("/me/drive/items/new-item");
        expect(url).not.toContain("/root:");
        if (url.endsWith("/content")) return {
          ...jsonResponse(200, {}), arrayBuffer: async () => Uint8Array.from(Buffer.from("new")).buffer,
        };
        return jsonResponse(200, { id: "new-item", name: "backup.zip 22.enc", size: 3 });
      });
      expect((await getOneDriveFileByName("backup.zip.enc", undefined, "new-item"))?.id).toBe("new-item");
      expect(await downloadFileFromOneDrive("backup.zip.enc", undefined, "new-item")).toEqual(Buffer.from("new"));
    });
  });

  describe("getOneDriveFileByName (upload read-back)", () => {
    it("returns the stored size so an upload can be verified", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        return jsonResponse(200, {
          id: "item-1",
          name: "labtrax-backup.zip.enc",
          size: 1234,
          createdDateTime: "2026-10-06T12:00:00Z",
          webUrl: "https://onedrive/x",
        });
      });
      const found = await getOneDriveFileByName("labtrax-backup.zip.enc");
      expect(found?.size).toBe(1234);
    });

    it("returns null when the file is not in the backup folder", async () => {
      setOneDriveFetchForTests(async (url) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        return jsonResponse(404, { error: { code: "itemNotFound" } });
      });
      expect(await getOneDriveFileByName("missing.zip.enc")).toBeNull();
    });
  });

  describe("request deadlines", () => {
    it("attaches an abort signal to every Graph request", async () => {
      let sawSignal = false;
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        sawSignal = Boolean(init?.signal);
        return jsonResponse(200, { value: [] });
      });
      await listOneDriveBackupFiles();
      expect(sawSignal).toBe(true);
    });

    it("reports a hung request as a timeout instead of hanging forever", async () => {
      setOneDriveFetchForTests(async (url, init) => {
        if (url.includes(CONNECTOR_URL_PART)) return connectorResponse();
        // Stand in for a connection that is accepted and never answered: the
        // deadline fires and aborts it.
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      vi.useFakeTimers();
      try {
        const pending = listOneDriveBackupFiles();
        const assertion = expect(pending).rejects.toThrow(/timed out after \d+s/);
        await vi.advanceTimersByTimeAsync(61_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
