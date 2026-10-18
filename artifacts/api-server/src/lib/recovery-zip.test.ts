import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { createCipheriv, createHash } from "node:crypto";
import { prepareRecoveryZipFile, writeRecoveryEntry } from "./recovery-zip";
let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
async function prepare(magic: string, corrupt = false, completionFooter = false) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-zip-unit-"));
  const zipPath = path.join(root, "source.zip");
  const output = createWriteStream(zipPath);
  const zip = archiver("zip", { forceZip64: true });
  zip.pipe(output);
  const finished = new Promise<void>((resolve, reject) => {
    output.on("close", resolve); output.on("error", reject); zip.on("error", reject);
  });
  zip.append(Buffer.alloc(66 * 1024 * 1024, 0x5a), { name: "media/representative-video.mp4" });
  zip.append(Buffer.from("{}"), { name: "manifest.json" });
  await zip.finalize();
  await finished;
  const key = createHash("sha256").update("synthetic-test-key").digest();
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(await fs.readFile(zipPath)), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (corrupt) tag[0] ^= 1;
  let bytes = magic === "LTR2" ? Buffer.concat([Buffer.from(magic), iv, encrypted, tag]) :
    Buffer.concat([Buffer.from(magic), iv, tag, encrypted]);
  if (magic === "LTR2" && completionFooter) {
    const footer = Buffer.alloc(12);
    footer.write("LTF1", 0, "ascii");
    footer.writeBigUInt64BE(BigInt(bytes.length), 4);
    bytes = Buffer.concat([bytes, footer]);
  }
  const source = path.join(root, "archive.enc");
  await fs.writeFile(source, bytes);
  return { source, key };
}
describe("bounded disk-backed ZIP64 recovery", () => {
  it.each([
    { magic: "LTRX", completionFooter: false },
    { magic: "LTR2", completionFooter: false },
    { magic: "LTR2", completionFooter: true },
  ])("authenticates $magic (completion footer: $completionFooter) and streams files above the metadata memory bound", async ({ magic, completionFooter }) => {
    const { source, key } = await prepare(magic, false, completionFooter);
    const zip = await prepareRecoveryZipFile(source, key, root);
    const entry = zip.getEntry("media/representative-video.mp4")!;
    expect(entry.header.size).toBe(66 * 1024 * 1024);
    expect(() => entry.getData()).toThrow(/bounded memory/);
    expect(entry.sha256).toBe(createHash("sha256").update(Buffer.alloc(66 * 1024 * 1024, 0x5a)).digest("hex"));
    await writeRecoveryEntry(entry, path.join(root, "restored.mp4"));
    expect((await fs.stat(path.join(root, "restored.mp4"))).size).toBe(entry.header.size);
  });
  it("rejects a corrupted authentication tag before interpreting ZIP entries", async () => {
    const { source, key } = await prepare("LTR2", true);
    await expect(prepareRecoveryZipFile(source, key, root)).rejects.toThrow(/decryption failed/);
    expect((await fs.readdir(root)).filter(name => /^\d+$/.test(name))).toHaveLength(0);
  });
  it("rejects a streamed completion footer whose recorded archive length is wrong", async () => {
    const { source, key } = await prepare("LTR2", false, true);
    const archive = await fs.readFile(source);
    archive.writeBigUInt64BE(BigInt(archive.length - 1), archive.length - 8);
    await fs.writeFile(source, archive);
    await expect(prepareRecoveryZipFile(source, key, root)).rejects.toThrow(/completion footer is invalid or incomplete/);
    expect((await fs.readdir(root)).filter(name => /^\d+$/.test(name))).toHaveLength(0);
  });
});
