import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { sendBackupOverSftp } from "./backup";

function mockSsh2(remoteSizeOffset = 0) {
  const files = new Map<string, Buffer>();
  const sftp = {
    createWriteStream: vi.fn((remotePath: string) => {
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(remotePath, Buffer.concat(chunks));
          callback();
        },
      });
    }),
    stat: vi.fn((remotePath: string, callback: (error?: Error, stats?: { size: number }) => void) => {
      const stored = files.get(remotePath);
      if (!stored) return callback(new Error("No such file"));
      callback(undefined, { size: stored.length + remoteSizeOffset });
    }),
    rename: vi.fn((source: string, destination: string, callback: (error?: Error | null) => void) => {
      const stored = files.get(source);
      if (!stored) return callback(new Error("No such file"));
      files.delete(source);
      files.set(destination, stored);
      callback(null);
    }),
    unlink: vi.fn((remotePath: string, callback: (error?: Error | null) => void) => {
      files.delete(remotePath);
      callback(null);
    }),
  };
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  class Client {
    on(event: string, callback: (...args: unknown[]) => void) {
      listeners[event] = callback;
      return this;
    }
    connect(options: { host: string; port: number; username: string }) {
      expect(options).toMatchObject({ host: "backup.example.test", port: 2222, username: "lab-admin" });
      queueMicrotask(() => listeners.ready?.());
    }
    sftp(callback: (error: Error | undefined, client: typeof sftp) => void) {
      callback(undefined, sftp);
    }
    end() {}
  }
  return {
    module: { Client } as unknown as NonNullable<Parameters<typeof sendBackupOverSftp>[1]>,
    sftp,
    files,
  };
}

const archiveBytes = Buffer.concat([
  Buffer.from("LTR2 encrypted complete database-and-files archive "),
  Buffer.alloc(64 * 1024, 0x5a),
]);

/** Writes the archive in several chunks, as the encrypted archive stream does. */
async function writeArchive(destination: Writable, failAfterFirstChunk = false): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    destination.once("error", reject);
    destination.once("finish", resolve);
    destination.write(archiveBytes.subarray(0, 1024));
    if (failAfterFirstChunk) {
      destination.destroy();
      reject(new Error("Recovery file changed or was truncated during capture; no complete archive was kept."));
      return;
    }
    destination.write(archiveBytes.subarray(1024, 40_000));
    destination.end(archiveBytes.subarray(40_000));
  });
  return archiveBytes.length;
}

const target = new URL("sftp://lab-admin@backup.example.test:2222/archives");

describe("complete SFTP backup transfer", () => {
  it("streams every byte to a partial file and names it only after remote size verification", async () => {
    const ssh2 = mockSsh2();
    const result = await sendBackupOverSftp({
      fileName: "complete-backup.zip.enc",
      archiveKind: "complete-production",
      mediaFileCount: 14,
      attachmentRowCount: 18,
      parsed: target,
      write: (destination) => writeArchive(destination),
    }, ssh2.module);

    expect(ssh2.sftp.createWriteStream).toHaveBeenCalledWith("/archives/.complete-backup.zip.enc.partial");
    expect(ssh2.sftp.stat).toHaveBeenCalledWith("/archives/.complete-backup.zip.enc.partial", expect.any(Function));
    expect(ssh2.sftp.rename).toHaveBeenCalledWith(
      "/archives/.complete-backup.zip.enc.partial", "/archives/complete-backup.zip.enc", expect.any(Function),
    );
    expect([...ssh2.files.keys()]).toEqual(["/archives/complete-backup.zip.enc"]);
    expect(ssh2.files.get("/archives/complete-backup.zip.enc")).toEqual(archiveBytes);
    expect(result).toMatchObject({
      destination: "network",
      path: "/archives/complete-backup.zip.enc",
      archiveKind: "complete-production",
      mediaFileCount: 14,
      attachmentRowCount: 18,
      size: archiveBytes.length,
      partialFailure: false,
    });
  });

  it("rejects and removes a remote archive whose stored size differs from the bytes produced", async () => {
    const ssh2 = mockSsh2(-1);
    await expect(sendBackupOverSftp({
      fileName: "complete-backup.zip.enc",
      archiveKind: "complete-non-production",
      mediaFileCount: 1,
      attachmentRowCount: 2,
      parsed: target,
      write: (destination) => writeArchive(destination),
    }, ssh2.module)).rejects.toThrow(/SFTP destination verification failed/i);
    expect(ssh2.sftp.rename).not.toHaveBeenCalled();
    expect(ssh2.sftp.unlink).toHaveBeenCalledWith("/archives/.complete-backup.zip.enc.partial", expect.any(Function));
    expect(ssh2.files.size).toBe(0);
  });

  it("never names a partial archive when capture fails mid-transfer", async () => {
    const ssh2 = mockSsh2();
    await expect(sendBackupOverSftp({
      fileName: "complete-backup.zip.enc",
      archiveKind: "complete-production",
      mediaFileCount: 1,
      attachmentRowCount: 2,
      parsed: target,
      write: (destination) => writeArchive(destination, true),
    }, ssh2.module)).rejects.toThrow(/no complete archive was kept/i);
    expect(ssh2.sftp.stat).not.toHaveBeenCalled();
    expect(ssh2.sftp.rename).not.toHaveBeenCalled();
    expect(ssh2.sftp.unlink).toHaveBeenCalledWith("/archives/.complete-backup.zip.enc.partial", expect.any(Function));
    expect(ssh2.files.has("/archives/complete-backup.zip.enc")).toBe(false);
  });
});
