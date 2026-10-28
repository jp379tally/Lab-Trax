import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export type DesktopUpdatePlatform = "windows" | "mac";

export interface DesktopUpdateArtifact {
  fileName: string;
  buffer: Buffer;
}

interface ManifestFile {
  fileName: string;
  sha512: string;
  size: number;
}

export interface DesktopUpdateFeedValidation {
  ok: boolean;
  error?: string;
  fileNames?: string[];
}

const VERSION_LINE = /^version:\s*["']?([^\s"']+)["']?\s*$/m;
const FILE_URL_LINE = /^\s*-\s+url:\s*["']?([^"'\s]+)["']?\s*$/gm;

function parseManifestFiles(content: string): ManifestFile[] | null {
  const starts = [...content.matchAll(FILE_URL_LINE)];
  if (!starts.length) return null;

  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = starts[index + 1]?.index ?? content.length;
    const block = content.slice(start, nextStart);
    const fileName = match[1];
    const sha512 = block.match(/^\s+sha512:\s*["']?([A-Za-z0-9+/=]+)["']?\s*$/m)?.[1];
    const sizeRaw = block.match(/^\s+size:\s*(\d+)\s*$/m)?.[1];
    const size = sizeRaw === undefined ? Number.NaN : Number(sizeRaw);
    if (
      !fileName ||
      !sha512 ||
      Buffer.from(sha512, "base64").length !== 64 ||
      !Number.isSafeInteger(size) ||
      size <= 0
    ) {
      return { fileName: "", sha512: "", size: Number.NaN };
    }
    return { fileName, sha512, size };
  });
}

/**
 * Validate an electron-builder update manifest against the exact release
 * artifacts that will be published to the generic update feed. The manifest
 * is deliberately checked before any object is replaced, so a bad release
 * cannot advertise a missing or mismatched update package.
 */
export function validateDesktopUpdateFeed(
  content: string,
  platform: DesktopUpdatePlatform,
  version: string,
  artifacts?: DesktopUpdateArtifact[],
): DesktopUpdateFeedValidation {
  const manifestVersion = content.match(VERSION_LINE)?.[1];
  if (manifestVersion !== version) {
    return { ok: false, error: `Manifest version must match release version ${version}.` };
  }

  const files = parseManifestFiles(content);
  if (!files || files.some((file) => !file.fileName)) {
    return { ok: false, error: "Manifest must list update files with URL, SHA-512, and size." };
  }

  const artifactByName = artifacts
    ? new Map(artifacts.map((artifact) => [artifact.fileName, artifact.buffer]))
    : null;
  const allowedName = platform === "windows"
    ? (name: string) => name === "LabTrax-Setup.exe"
    : (name: string) => /^LabTrax-\d+\.\d+\.\d+-(?:arm64|x64|universal)-mac\.zip$/.test(name);
  const manifestNames = new Set<string>();

  for (const entry of files) {
    let fileName = entry.fileName;
    if (platform === "mac") {
      if (entry.fileName.includes("/") || entry.fileName.includes("\\")) {
        return { ok: false, error: "macOS update URLs must use a versioned ZIP filename." };
      }
    } else if (entry.fileName.includes("/") || entry.fileName.includes("\\")) {
      return { ok: false, error: "Windows update URLs must use the API-served installer filename." };
    }

    if (
      !allowedName(fileName) ||
      manifestNames.has(fileName)
    ) {
      return { ok: false, error: `Manifest contains an unsupported or duplicate update file: ${fileName}.` };
    }
    if (platform === "mac" && !fileName.startsWith(`LabTrax-${version}-`)) {
      return { ok: false, error: "macOS update ZIP version does not match the manifest." };
    }
    manifestNames.add(fileName);

    if (artifactByName) {
      const bytes = artifactByName.get(fileName);
      if (!bytes) {
        return { ok: false, error: `Update package ${fileName} is missing from the publish request.` };
      }
      const actualSha512 = createHash("sha512").update(bytes).digest("base64");
      if (entry.sha512 !== actualSha512 || entry.size !== bytes.length) {
        return { ok: false, error: `Update package ${fileName} does not match its manifest checksum or size.` };
      }
    }
  }

  if (platform === "windows" && files.length !== 1) {
    return { ok: false, error: "Windows update manifest must reference exactly one NSIS installer." };
  }
  if (platform === "mac" && files.length < 1) {
    return { ok: false, error: "macOS update manifest must reference at least one signed update ZIP." };
  }

  const manifestPathValue = content.match(/^path:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  const manifestPath = manifestPathValue
    ? decodeURIComponent(manifestPathValue.split("/").at(-1) ?? "")
    : "";
  if (!manifestPath || !manifestNames.has(manifestPath)) {
    return { ok: false, error: "Manifest path must reference one of its listed update files." };
  }

  return { ok: true, fileNames: [...manifestNames] };
}

export function validateDesktopUpdatePayload(
  buffer: Buffer,
  fileName: string,
  version: string,
  expectedSha512: string,
  expectedSize: number,
): DesktopUpdateFeedValidation {
  if (!/^LabTrax-\d+\.\d+\.\d+-(?:arm64|x64|universal)-mac\.zip$/.test(fileName)) {
    return { ok: false, error: "Unsupported macOS update ZIP filename." };
  }
  if (!fileName.startsWith(`LabTrax-${version}-`)) {
    return { ok: false, error: "Update ZIP version does not match the release." };
  }
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2]);
  if (!isZip) {
    return { ok: false, error: "Update file is not a valid ZIP archive." };
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize !== buffer.length) {
    return { ok: false, error: "Update ZIP size does not match latest-mac.yml." };
  }
  const actualSha512 = createHash("sha512").update(buffer).digest("base64");
  if (!expectedSha512 || actualSha512 !== expectedSha512) {
    return { ok: false, error: "Update ZIP checksum does not match latest-mac.yml." };
  }
  return { ok: true, fileNames: [fileName] };
}

export async function validateDesktopUpdatePayloadFile(
  filePath: string,
  fileName: string,
  version: string,
  expectedSha512: string,
  expectedSize: number,
): Promise<DesktopUpdateFeedValidation> {
  if (!/^LabTrax-\d+\.\d+\.\d+-(?:arm64|x64|universal)-mac\.zip$/.test(fileName)) {
    return { ok: false, error: "Unsupported macOS update ZIP filename." };
  }
  if (!fileName.startsWith(`LabTrax-${version}-`)) {
    return { ok: false, error: "Update ZIP version does not match the release." };
  }

  const fileStat = await stat(filePath);
  if (!Number.isSafeInteger(expectedSize) || expectedSize !== fileStat.size) {
    return { ok: false, error: "Update ZIP size does not match latest-mac.yml." };
  }

  const handle = await open(filePath, "r");
  const prefix = Buffer.alloc(4);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(prefix, 0, prefix.length, 0));
  } finally {
    await handle.close();
  }
  if (
    bytesRead < 4 ||
    prefix[0] !== 0x50 ||
    prefix[1] !== 0x4b ||
    ![0x03, 0x05, 0x07].includes(prefix[2])
  ) {
    return { ok: false, error: "Update file is not a valid ZIP archive." };
  }

  const digest = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  if (!expectedSha512 || digest.digest("base64") !== expectedSha512) {
    return { ok: false, error: "Update ZIP checksum does not match latest-mac.yml." };
  }
  return { ok: true, fileNames: [fileName] };
}
