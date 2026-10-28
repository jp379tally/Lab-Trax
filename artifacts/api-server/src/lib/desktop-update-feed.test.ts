import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateDesktopUpdateFeed,
  validateDesktopUpdatePayload,
  validateDesktopUpdatePayloadFile,
} from "./desktop-update-feed";

function entry(buffer: Buffer) {
  return {
    sha512: createHash("sha512").update(buffer).digest("base64"),
    size: buffer.length,
  };
}

describe("validateDesktopUpdateFeed", () => {
  it("accepts a Windows manifest only when its EXE matches the signed metadata", () => {
    const buffer = Buffer.from("windows installer bytes");
    const metadata = entry(buffer);
    const manifest = [
      "version: 1.2.3",
      "files:",
      "  - url: LabTrax-Setup.exe",
      `    sha512: ${metadata.sha512}`,
      `    size: ${metadata.size}`,
      "path: LabTrax-Setup.exe",
      "sha512: ignored-top-level-hash",
      "",
    ].join("\n");

    expect(
      validateDesktopUpdateFeed(manifest, "windows", "1.2.3", [
        { fileName: "LabTrax-Setup.exe", buffer },
      ]),
    ).toEqual({ ok: true, fileNames: ["LabTrax-Setup.exe"] });
  });

  it("accepts multiple macOS architecture ZIPs and rejects a missing payload", () => {
    const arm = Buffer.from("arm update");
    const intel = Buffer.from("intel update");
    const armMeta = entry(arm);
    const intelMeta = entry(intel);
    const manifest = [
      "version: 1.2.3",
      "files:",
      "  - url: LabTrax-1.2.3-arm64-mac.zip",
      `    sha512: ${armMeta.sha512}`,
      `    size: ${armMeta.size}`,
      "  - url: LabTrax-1.2.3-x64-mac.zip",
      `    sha512: ${intelMeta.sha512}`,
      `    size: ${intelMeta.size}`,
      "path: LabTrax-1.2.3-arm64-mac.zip",
      "",
    ].join("\n");

    expect(
      validateDesktopUpdateFeed(manifest, "mac", "1.2.3", [
        { fileName: "LabTrax-1.2.3-arm64-mac.zip", buffer: arm },
        { fileName: "LabTrax-1.2.3-x64-mac.zip", buffer: intel },
      ]).ok,
    ).toBe(true);
    expect(
      validateDesktopUpdateFeed(manifest, "mac", "1.2.3", [
        { fileName: "LabTrax-1.2.3-arm64-mac.zip", buffer: arm },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringContaining("missing") });
    expect(
      validateDesktopUpdateFeed(
        manifest.replace("LabTrax-1.2.3-arm64-mac.zip", "LabTrax-1.2.4-arm64-mac.zip"),
        "mac",
        "1.2.3",
      ).ok,
    ).toBe(false);
  });

  it("rejects version drift, path traversal, and checksum mismatches", () => {
    const buffer = Buffer.from("installer bytes");
    const metadata = entry(buffer);
    const valid = [
      "version: 1.2.3",
      "files:",
      "  - url: LabTrax-Setup.exe",
      `    sha512: ${metadata.sha512}`,
      `    size: ${metadata.size}`,
      "path: LabTrax-Setup.exe",
    ].join("\n");
    const artifact = [{ fileName: "LabTrax-Setup.exe", buffer }];

    expect(validateDesktopUpdateFeed(valid, "windows", "1.2.4", artifact).ok).toBe(false);
    expect(validateDesktopUpdateFeed(valid.replace("LabTrax-Setup.exe", "../LabTrax-Setup.exe"), "windows", "1.2.3", artifact).ok).toBe(false);
    expect(validateDesktopUpdateFeed(valid.replace(metadata.sha512, "wrong"), "windows", "1.2.3", artifact).ok).toBe(false);
  });

  it("validates the macOS ZIP bytes, release version, size, and SHA-512", () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const metadata = entry(buffer);
    const fileName = "LabTrax-1.2.3-arm64-mac.zip";
    expect(
      validateDesktopUpdatePayload(buffer, fileName, "1.2.3", metadata.sha512, metadata.size).ok,
    ).toBe(true);
    expect(
      validateDesktopUpdatePayload(buffer, fileName, "1.2.4", metadata.sha512, metadata.size).ok,
    ).toBe(false);
    expect(
      validateDesktopUpdatePayload(buffer, fileName, "1.2.3", "wrong", metadata.size).ok,
    ).toBe(false);
  });

  it("validates a streamed macOS ZIP from disk without loading it into memory", async () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const metadata = entry(buffer);
    const fileName = "LabTrax-1.2.3-arm64-mac.zip";
    const directory = await mkdtemp(join(tmpdir(), "labtrax-update-test-"));
    const filePath = join(directory, fileName);
    try {
      await writeFile(filePath, buffer);
      expect(
        await validateDesktopUpdatePayloadFile(
          filePath,
          fileName,
          "1.2.3",
          metadata.sha512,
          metadata.size,
        ),
      ).toEqual({ ok: true, fileNames: [fileName] });
      expect(
        await validateDesktopUpdatePayloadFile(
          filePath,
          fileName,
          "1.2.3",
          metadata.sha512,
          metadata.size + 1,
        ),
      ).toMatchObject({ ok: false, error: expect.stringContaining("size") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
