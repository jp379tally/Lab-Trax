import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import { chooseBackupSaveFile, readBoundedBrowserBackup as boundedRequest, streamCompleteBackupToFile as streamRequest, type BackupFileSink } from "../backup-browser-download";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("expo/fetch", () => ({ fetch: network.fetch }));
async function streamCompleteBackupToFile(response: Response, target: BackupFileSink) {
  network.fetch.mockResolvedValueOnce(response);
  return streamRequest("https://backup.example.test/api/admin/backup/generate", {}, target);
}
async function readBoundedBrowserBackup(response: Response, limit?: number) {
  network.fetch.mockResolvedValueOnce(response);
  return (await boundedRequest("https://backup.example.test/api/admin/backup/generate", {}, limit)).buffer;
}

it("aborts the selected file on an authentication refusal without retrying capture", async () => {
  network.fetch.mockClear();
  network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Synthetic session expired." }), { status: 401 }));
  const target = { write: vi.fn(), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
  await expect(streamRequest("https://backup.example.test/api/admin/backup/generate", {
    method: "POST", credentials: "include", headers: { "X-LabTrax-Backup-Source": "production" },
  }, target)).rejects.toThrow("Synthetic session expired.");
  expect(network.fetch).toHaveBeenCalledTimes(1);
  expect(target.write).not.toHaveBeenCalled();
  expect(target.close).not.toHaveBeenCalled();
  expect(target.abort).toHaveBeenCalledOnce();
});

function fixture(truncated = false, chunkSize = 3) {
  const bytes = new Uint8Array(truncated ? 43 : 44);
  bytes.set([76, 84, 82, 50]);
  if (!truncated) {
    bytes.set([76, 84, 70, 49], 32);
    new DataView(bytes.buffer).setBigUint64(36, 32n, false);
  }
  const cancel = vi.fn();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.length);
    },
    cancel,
  });
  const headers = new Headers({
    "x-backup-archive-kind": "complete-non-production",
    "x-backup-coverage-version": "1",
    "x-backup-media-file-count": "0",
    "x-backup-attachment-row-count": "0",
  });
  return { bytes, cancel, response: new Response(body as unknown as BodyInit, { headers }) };
}
function sink() {
  return { write: vi.fn(async (_chunk: Uint8Array) => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
}

afterEach(() => vi.unstubAllGlobals());
describe("bounded browser backup saving", () => {
  it.each([1, 3, 44])("validates split header/footer with %s-byte chunks before committing", async (chunkSize) => {
    const { bytes, response } = fixture(false, chunkSize);
    const target = sink();
    expect(await streamCompleteBackupToFile(response, target)).toBe(44);
    expect(new Uint8Array(target.write.mock.calls.flatMap(([chunk]) => [...chunk]))).toEqual(bytes);
    expect(target.close).toHaveBeenCalledOnce();
    expect(target.abort).not.toHaveBeenCalled();
  });
  it("aborts a truncated file without committing it", async () => {
    const target = sink();
    await expect(streamCompleteBackupToFile(fixture(true).response, target)).rejects.toThrow(/incomplete|truncated/);
    expect(target.close).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
  });
  it("does not write a database-only archive and aborts the uncommitted file", async () => {
    const { response } = fixture();
    response.headers.set("x-backup-archive-kind", "database-only");
    const target = sink();
    await expect(streamCompleteBackupToFile(response, target)).rejects.toThrow("did not confirm");
    expect(target.write).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
  });
  it("cancels reading on a destination write failure and never reports success", async () => {
    const { response, cancel } = fixture();
    const target = sink();
    target.write.mockRejectedValueOnce(new Error("Synthetic destination is full"));
    await expect(streamCompleteBackupToFile(response, target)).rejects.toThrow("destination is full");
    expect(cancel).toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalled();
  });
  it("backpressures writes instead of accumulating the archive", async () => {
    let outstanding = 0;
    let maximum = 0;
    const target = sink();
    target.write.mockImplementation(async () => {
      maximum = Math.max(maximum, ++outstanding);
      await new Promise(resolve => setTimeout(resolve, 0));
      outstanding--;
    });
    await streamCompleteBackupToFile(fixture(false, 1).response, target);
    expect(maximum).toBe(1);
  });
  it("bounds legacy-browser buffering when Content-Length is absent", async () => {
    const { response, cancel } = fixture();
    await expect(readBoundedBrowserBackup(response, 20)).rejects.toThrow("safe download limit");
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects an advertised oversized archive before reading it", async () => {
    const { response, cancel } = fixture();
    response.headers.set("content-length", "100000000000");
    await expect(readBoundedBrowserBackup(response)).rejects.toThrow("safe download limit");
    expect(cancel).toHaveBeenCalled();
  });
  it("supports a verified small download in browsers without a file picker", async () => {
    const { response, bytes } = fixture();
    expect(new Uint8Array(await readBoundedBrowserBackup(response))).toEqual(bytes);
  });
  it("chooses a file only through the browser's explicit user picker", async () => {
    const handle = { name: "synthetic.zip.enc", createWritable: vi.fn() };
    const picker = vi.fn(async () => handle);
    vi.stubGlobal("showSaveFilePicker", picker);
    expect(await chooseBackupSaveFile()).toBe(handle);
    expect(picker).toHaveBeenCalledWith({ suggestedName: "labtrax-complete-backup.zip.enc" });
  });
  it("uses the bounded fallback when an embedded preview prohibits the picker", async () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => {
      throw Object.assign(new Error("Synthetic preview-frame restriction"), { name: "SecurityError" });
    }));
    expect(await chooseBackupSaveFile()).toBeNull();
  });
  it("preserves cancellation instead of silently starting a fallback backup", async () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => {
      throw Object.assign(new Error("Synthetic user cancellation"), { name: "AbortError" });
    }));
    await expect(chooseBackupSaveFile()).rejects.toMatchObject({ name: "AbortError" });
  });
});
