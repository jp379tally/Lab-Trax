import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MAX_IDENTITY_BYTES = 64 * 1024;

export interface PreparedDesktopReleaseIdentity {
  schemaVersion: 1;
  version: string;
  sourceRevision: string;
  signatureVerification: "verified-installer";
  artifact: {
    fileName: "LabTrax-Setup.exe" | "LabTrax.dmg";
    size: number;
    sha256: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release identity must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function fullSourceRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("A full 40-character source revision is required; branches and short hashes are not accepted.");
  }
  return value.toLowerCase();
}

export function parsePreparedDesktopReleaseIdentity(value: unknown): PreparedDesktopReleaseIdentity {
  const identity = record(value);
  const artifact = record(identity.artifact);
  if (identity.schemaVersion !== 1 ||
      typeof identity.version !== "string" || !identity.version.trim() || identity.version.length > 64 ||
      identity.signatureVerification !== "verified-installer" ||
      typeof artifact.fileName !== "string" || !["LabTrax-Setup.exe", "LabTrax.dmg"].includes(artifact.fileName) ||
      typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error("A verified signed installer identity with an exact filename, byte size and SHA-256 is required; portable ZIPs are not accepted.");
  }
  const sourceRevision = fullSourceRevision(identity.sourceRevision);
  if (identity.sourceRevision !== sourceRevision) {
    throw new Error("The release sidecar source revision must be lowercase, as required by recovery capture.");
  }
  return {
    schemaVersion: 1,
    version: identity.version,
    sourceRevision,
    signatureVerification: "verified-installer",
    artifact: {
      fileName: artifact.fileName as PreparedDesktopReleaseIdentity["artifact"]["fileName"],
      size: artifact.size,
      sha256: artifact.sha256,
    },
  };
}

/** Read only bounded metadata, never a whole installer or recovery archive. */
export async function readIdentityJson(filePath: string): Promise<unknown> {
  const file = await open(filePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_IDENTITY_BYTES) {
      throw new Error(`${basename(filePath)} must be a non-empty JSON file no larger than 64 KiB.`);
    }
    const bytes = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_IDENTITY_BYTES) throw new Error("Identity metadata grew beyond the 64 KiB limit.");
    try {
      return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } catch {
      throw new Error(`${basename(filePath)} is not valid JSON.`);
    }
  } finally {
    await file.close();
  }
}

/** Hash the exact bytes with bounded memory and refuse changes during inspection. */
export async function hashInstaller(filePath: string): Promise<{ size: number; sha256: string }> {
  const file = await open(filePath, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) {
      throw new Error("The installer must be a non-empty regular file with an exact byte size.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (!Number.isSafeInteger(size) || size > before.size) {
        throw new Error("The installer changed during inspection.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    const current = await stat(filePath);
    if (size !== before.size || [after, current].some(value =>
      value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size ||
      value.mtimeMs !== before.mtimeMs || value.ctimeMs !== before.ctimeMs)) {
      throw new Error("The installer changed during inspection.");
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

/**
 * The build wrapper must first verify the OS signature and the packaged build
 * stamp. This records that result; it does not itself verify a code signature.
 */
export async function prepareDesktopReleaseIdentity(
  installerPath: string,
  input: { version: unknown; sourceRevision: unknown; signatureVerification: unknown },
): Promise<{ sidecarPath: string; identity: PreparedDesktopReleaseIdentity }> {
  // Reject an unsupported file or unsigned attestation before hashing any bytes.
  const metadata = parsePreparedDesktopReleaseIdentity({
    schemaVersion: 1,
    ...input,
    sourceRevision: fullSourceRevision(input.sourceRevision),
    artifact: { fileName: basename(installerPath), size: 1, sha256: "0".repeat(64) },
  });
  const artifactBytes = await hashInstaller(installerPath);
  const identity = { ...metadata, artifact: { ...metadata.artifact, ...artifactBytes } };
  const sidecarPath = join(dirname(installerPath), "release-identity.json");
  // Match the uploader's schema, property order and exact JSON serialization.
  await writeFile(sidecarPath, JSON.stringify(identity), { mode: 0o600 });
  return { sidecarPath, identity };
}

export async function verifyDesktopRecoveryRelease(input: {
  apiBuildIdentityPath: string;
  releaseIdentityPath: string;
  installerPath: string;
}) {
  const [apiValue, releaseValue] = await Promise.all([
    readIdentityJson(input.apiBuildIdentityPath),
    readIdentityJson(input.releaseIdentityPath),
  ]);
  const sourceRevision = fullSourceRevision(record(apiValue).sourceRevision);
  const identity = parsePreparedDesktopReleaseIdentity(releaseValue);
  if (identity.sourceRevision !== sourceRevision) {
    throw new Error("The Desktop release source revision does not match the supplied API build identity.");
  }
  if (basename(input.installerPath) !== identity.artifact.fileName) {
    throw new Error("The installer filename does not match the release identity.");
  }
  const actual = await hashInstaller(input.installerPath);
  if (actual.size !== identity.artifact.size || actual.sha256 !== identity.artifact.sha256) {
    throw new Error("The installer does not match the sidecar's exact byte size and SHA-256.");
  }
  return {
    status: "local-release-files-verified" as const,
    sourceRevision,
    version: identity.version,
    signatureVerification: identity.signatureVerification,
    artifact: identity.artifact,
    limitations: [
      "Signature status is the build pipeline's attestation, not a new OS-signature verification.",
      "This read-only check does not prove deployment, upload, or complete production archive integrity.",
    ],
  };
}
