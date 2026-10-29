import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fullSourceRevision,
  hashInstaller,
  parsePreparedDesktopReleaseIdentity,
  prepareDesktopReleaseIdentity,
  readIdentityJson,
  verifyDesktopRecoveryRelease,
} from "../lib/desktop-recovery-release";

const roots: string[] = [];
const revision = "a".repeat(40);
const cliPath = resolve(import.meta.dirname, "../desktop-recovery-release.ts");

async function fixture(fileName = "LabTrax-Setup.exe") {
  const root = await mkdtemp(join(tmpdir(), "desktop-release-files-"));
  roots.push(root);
  const installerPath = join(root, fileName);
  // Synthetic bytes are deliberate: these tests verify the recorded signature
  // status, not an OS certificate. The build wrapper runs the real verifier.
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 7);
  await writeFile(installerPath, bytes);
  const { sidecarPath: releaseIdentityPath, identity } = await prepareDesktopReleaseIdentity(installerPath, {
    version: "1.2.3", sourceRevision: revision, signatureVerification: "verified-installer",
  });
  const apiBuildIdentityPath = join(root, "build-identity.json");
  await writeFile(apiBuildIdentityPath, JSON.stringify({ sourceRevision: revision }));
  return { root, bytes, installerPath, releaseIdentityPath, apiBuildIdentityPath, identity };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("prepared Desktop release identity", () => {
  it.each(["LabTrax-Setup.exe", "LabTrax.dmg"])("binds %s to its exact bytes and API source revision", async fileName => {
    const f = await fixture(fileName);
    const before = await readdir(f.root);
    const sidecarBefore = await readFile(f.releaseIdentityPath);
    const result = await verifyDesktopRecoveryRelease(f);
    expect(result).toMatchObject({
      status: "local-release-files-verified",
      sourceRevision: revision,
      signatureVerification: "verified-installer",
      artifact: {
        fileName,
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    });
    expect(result.limitations).toContain("This read-only check does not prove deployment, upload, or complete production archive integrity.");
    expect(await readdir(f.root)).toEqual(before);
    expect(await readFile(f.releaseIdentityPath)).toEqual(sidecarBefore);
    expect((await readFile(f.installerPath)).equals(f.bytes)).toBe(true);
    expect(sidecarBefore.toString()).toBe(JSON.stringify(f.identity));
  });

  it("rejects same-size corruption as well as truncated installer bytes", async () => {
    const f = await fixture();
    const corrupt = Buffer.from(f.bytes);
    corrupt[corrupt.length - 1] = 8;
    await writeFile(f.installerPath, corrupt);
    await expect(verifyDesktopRecoveryRelease(f)).rejects.toThrow("exact byte size and SHA-256");
    await writeFile(f.installerPath, f.bytes.subarray(0, -1));
    await expect(verifyDesktopRecoveryRelease(f)).rejects.toThrow("exact byte size and SHA-256");
  });

  it("rejects a different API revision and never guesses from the workspace", async () => {
    const f = await fixture();
    await writeFile(f.apiBuildIdentityPath, JSON.stringify({ sourceRevision: "b".repeat(40) }));
    await expect(verifyDesktopRecoveryRelease(f)).rejects.toThrow("does not match the supplied API build identity");
    await writeFile(f.apiBuildIdentityPath, "{}");
    await expect(verifyDesktopRecoveryRelease(f)).rejects.toThrow("full 40-character");
  });

  it("rejects an unexpected installer filename even when the bytes match", async () => {
    const f = await fixture();
    const installerPath = join(f.root, "renamed.exe");
    await writeFile(installerPath, f.bytes);
    await expect(verifyDesktopRecoveryRelease({ ...f, installerPath })).rejects.toThrow("filename");
  });

  it.each(["unverified", "verified-contained-executable", undefined])("refuses %s without overwriting a sidecar", async signatureVerification => {
    const f = await fixture();
    const before = await readFile(f.releaseIdentityPath);
    await expect(prepareDesktopReleaseIdentity(f.installerPath, {
      version: "1.2.3", sourceRevision: revision, signatureVerification,
    })).rejects.toThrow("verified signed installer");
    expect(await readFile(f.releaseIdentityPath)).toEqual(before);
  });

  it("never accepts portable ZIP evidence as a signed recovery installer", async () => {
    const f = await fixture();
    expect(() => parsePreparedDesktopReleaseIdentity({
      ...f.identity,
      signatureVerification: "verified-contained-executable",
      artifact: { ...f.identity.artifact, fileName: "LabTrax-Windows-Portable.zip" },
    })).toThrow("portable ZIPs are not accepted");
  });

  it.each(["main", "a".repeat(7), "", undefined, null])("rejects an incomplete or absent source revision (%s)", value => {
    expect(() => fullSourceRevision(value)).toThrow("full 40-character");
  });

  it("normalizes a full source revision when writing but requires canonical sidecar data", async () => {
    const f = await fixture();
    const result = await prepareDesktopReleaseIdentity(f.installerPath, {
      version: "1.2.3", sourceRevision: revision.toUpperCase(), signatureVerification: "verified-installer",
    });
    expect(result.identity.sourceRevision).toBe(revision);
    expect(() => parsePreparedDesktopReleaseIdentity({
      ...result.identity, sourceRevision: revision.toUpperCase(),
    })).toThrow("must be lowercase");
  });

  it("bounds JSON input and rejects malformed, missing, or empty files", async () => {
    const f = await fixture();
    await writeFile(f.apiBuildIdentityPath, "not-json");
    await expect(readIdentityJson(f.apiBuildIdentityPath)).rejects.toThrow("not valid JSON");
    await writeFile(f.apiBuildIdentityPath, " ".repeat(64 * 1024 + 1));
    await expect(readIdentityJson(f.apiBuildIdentityPath)).rejects.toThrow("64 KiB");
    await expect(readIdentityJson(join(f.root, "absent.json"))).rejects.toThrow();
    await writeFile(f.installerPath, "");
    await expect(hashInstaller(f.installerPath)).rejects.toThrow("non-empty regular file");
  });
});

describe("read-only verification command", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cliPath, "verify", ...args], {
      encoding: "utf8",
      timeout: 20_000,
      // No database, signing, storage or platform-admin credentials.
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
  }

  it("exits successfully for matching files and nonzero for mismatched evidence", async () => {
    const f = await fixture();
    const args = [
      "--api-build-identity", f.apiBuildIdentityPath,
      "--release-identity", f.releaseIdentityPath,
      "--installer", f.installerPath,
    ];
    const passed = run(args);
    expect(passed.status, passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout).status).toBe("local-release-files-verified");
    await writeFile(f.apiBuildIdentityPath, JSON.stringify({ sourceRevision: "b".repeat(40) }));
    const failed = run(args);
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain("does not match the supplied API build identity");
    expect(failed.stdout).toBe("");
  });

  it("fails closed on missing, repeated, or unknown options", async () => {
    const f = await fixture();
    const args = ["--api-build-identity", f.apiBuildIdentityPath];
    expect(run(args).status).toBe(1);
    expect(run([...args, ...args]).stderr).toContain("duplicated");
    expect(run(["--ignore-signature", "yes"]).status).toBe(1);
  });

  it("keeps the package commands attached to the tested entry point", async () => {
    const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"));
    expect(pkg.scripts["verify-desktop-recovery-release"]).toBe("tsx ./src/desktop-recovery-release.ts verify");
    expect(pkg.scripts["prepare-desktop-release-identity"]).toBe("tsx ./src/desktop-recovery-release.ts prepare");
  });
});
