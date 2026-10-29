import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  shouldUploadLatestYml,
  validateLatestYmlContent,
  buildLatestYmlContent,
  applyLatestYmlGate,
  type InstallerKind,
} from "../lib/latest-yml-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_SRC = resolve(__dirname, "..");
const UPLOAD_INSTALLER_SCRIPT = resolve(SCRIPTS_SRC, "upload-desktop-installer.ts");
const TSX_LOADER = import.meta.resolve("tsx");
const STORAGE_MOCK_PRELOAD = pathToFileURL(
  resolve(__dirname, "fixtures", "register-stub-storage.mjs"),
).href;
const REPO_ROOT = resolve(SCRIPTS_SRC, "../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh isolated temp directory per test. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "labtrax-latest-yml-test-"));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function withTempDir(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

function runUploaderWithMockStorage(
  installerPath: string,
  storageRoot: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (revision.status !== 0) {
    throw new Error(`Unable to resolve checked-out source revision: ${revision.stderr}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRIVATE_OBJECT_DIR: "test-bucket/test-dir",
    GIT_COMMIT_SHA: revision.stdout.trim(),
    LABTRAX_DESKTOP_SIGNATURE_VERIFICATION: "verified-installer",
    LABTRAX_LATEST_YML_PATH: join(storageRoot, "missing-latest.yml"),
    DESKTOP_INSTALLER_VERSION: "9.8.7-test",
    PUBLISH_API_BASE_URL: "",
    PLATFORM_ADMIN_SECRET: "",
    MOCK_STORAGE_ROOT: storageRoot,
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      "--import",
      STORAGE_MOCK_PRELOAD,
      UPLOAD_INSTALLER_SCRIPT,
      installerPath,
    ],
    {
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  return result;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function expectNoReleaseObjects(storageRoot: string): Promise<void> {
  const objectRoot = join(storageRoot, "test-bucket", "test-dir", "desktop-installer");
  for (const objectName of [
    "LabTrax-Setup.exe",
    "LabTrax-Windows-Portable.zip",
    "LabTrax.dmg",
    "latest.yml",
    "release-identity.json",
  ]) {
    expect(await fileExists(join(objectRoot, objectName))).toBe(false);
  }
}

const FAKE_SHA512 = "AAABBBCCC==";
const FAKE_OPTS = { version: "1.2.3", sha512: FAKE_SHA512, size: 87654321 };

// ---------------------------------------------------------------------------
// shouldUploadLatestYml — pure unit tests
// ---------------------------------------------------------------------------

describe("shouldUploadLatestYml", () => {
  it("returns false for kind=zip (portable ZIP must never update latest.yml)", () => {
    expect(shouldUploadLatestYml("zip")).toBe(false);
  });

  it("returns true for kind=exe (NSIS installer must update latest.yml)", () => {
    expect(shouldUploadLatestYml("exe")).toBe(true);
  });

  it("returns true for kind=dmg (macOS installer must update latest.yml)", () => {
    expect(shouldUploadLatestYml("dmg")).toBe(true);
  });

  it("covers all InstallerKind values: only zip is excluded", () => {
    const kinds: InstallerKind[] = ["exe", "zip", "dmg"];
    const uploaders = kinds.filter((k) => shouldUploadLatestYml(k));
    const skippers = kinds.filter((k) => !shouldUploadLatestYml(k));
    expect(uploaders).toEqual(["exe", "dmg"]);
    expect(skippers).toEqual(["zip"]);
  });
});

// ---------------------------------------------------------------------------
// validateLatestYmlContent — pure unit tests
// ---------------------------------------------------------------------------

describe("validateLatestYmlContent", () => {
  it("accepts a well-formed EXE manifest", () => {
    const content = buildLatestYmlContent({
      version: "1.2.3",
      filename: "LabTrax-Setup.exe",
      sha512: FAKE_SHA512,
      size: 87654321,
      releaseDate: "2026-06-24T12:00:00.000Z",
    });
    expect(validateLatestYmlContent(content).ok).toBe(true);
  });

  it("rejects content referencing LabTrax-Windows-Portable.zip", () => {
    const stale = "path: LabTrax-Windows-Portable.zip\nsha512: x\n";
    expect(validateLatestYmlContent(stale).ok).toBe(false);
  });

  it("error message references the ZIP and the correct remedy", () => {
    const stale = "path: LabTrax-Windows-Portable.zip\n";
    const { error } = validateLatestYmlContent(stale);
    expect(error).not.toBeNull();
    expect(error).toContain("LabTrax-Windows-Portable.zip");
    expect(error).toContain("LabTrax-Setup.exe");
  });

  it("accepts an empty string", () => {
    expect(validateLatestYmlContent("").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildLatestYmlContent — pure unit tests
// ---------------------------------------------------------------------------

describe("buildLatestYmlContent", () => {
  const opts = {
    version: "1.2.3",
    filename: "LabTrax-Setup.exe",
    sha512: FAKE_SHA512,
    size: 87654321,
    releaseDate: "2026-06-24T12:00:00.000Z",
  };

  it("references LabTrax-Setup.exe on the url line", () => {
    expect(buildLatestYmlContent(opts)).toContain("url: LabTrax-Setup.exe");
  });

  it("references LabTrax-Setup.exe on the path line", () => {
    expect(buildLatestYmlContent(opts)).toContain("path: LabTrax-Setup.exe");
  });

  it("does NOT reference LabTrax-Windows-Portable.zip", () => {
    expect(buildLatestYmlContent(opts)).not.toContain(
      "LabTrax-Windows-Portable.zip",
    );
  });

  it("generated EXE manifest passes validateLatestYmlContent", () => {
    expect(validateLatestYmlContent(buildLatestYmlContent(opts)).ok).toBe(true);
  });

  it("a manifest built with the ZIP filename fails validation", () => {
    const zipManifest = buildLatestYmlContent({
      ...opts,
      filename: "LabTrax-Windows-Portable.zip",
    });
    expect(validateLatestYmlContent(zipManifest).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyLatestYmlGate — filesystem integration tests
// ---------------------------------------------------------------------------

describe("applyLatestYmlGate — portable-ZIP build simulation", () => {
  it("writes latest-portable.yml and does NOT write latest.yml (clean dir)", async () => {
    const dir = await withTempDir();

    const result = await applyLatestYmlGate(dir, "zip", FAKE_OPTS);

    expect(result.portableYmlWritten).toBe(true);
    expect(await fileExists(join(dir, "latest-portable.yml"))).toBe(true);
    expect(await fileExists(join(dir, "latest.yml"))).toBe(false);
    expect(result.latestYmlWritten).toBe(false);
    expect(result.staleLatestYmlRemoved).toBe(false);
    expect(result.error).toBeNull();
  });

  it("removes a stale latest.yml present from a prior run, and still does not re-create it", async () => {
    const dir = await withTempDir();
    // Simulate a stale latest.yml left by a previous EXE build
    await writeFile(
      join(dir, "latest.yml"),
      "version: 0.9.0\npath: LabTrax-Setup.exe\n",
      "utf8",
    );

    const result = await applyLatestYmlGate(dir, "zip", FAKE_OPTS);

    expect(result.staleLatestYmlRemoved).toBe(true);
    expect(await fileExists(join(dir, "latest.yml"))).toBe(false);
    expect(await fileExists(join(dir, "latest-portable.yml"))).toBe(true);
    expect(result.portableYmlWritten).toBe(true);
  });

  it("portable.yml content references LabTrax-Windows-Portable.zip, NOT LabTrax-Setup.exe", async () => {
    const dir = await withTempDir();
    await applyLatestYmlGate(dir, "zip", FAKE_OPTS);
    const content = await readFile(join(dir, "latest-portable.yml"), "utf8");
    expect(content).toContain("LabTrax-Windows-Portable.zip");
    expect(content).not.toContain("LabTrax-Setup.exe");
  });

  it("portable.yml content would fail validateLatestYmlContent (proving isolation)", async () => {
    const dir = await withTempDir();
    await applyLatestYmlGate(dir, "zip", FAKE_OPTS);
    const content = await readFile(join(dir, "latest-portable.yml"), "utf8");
    // The portable.yml references the ZIP — validating it as a latest.yml upload
    // must fail, proving it can never be mistaken for the auto-update feed.
    expect(validateLatestYmlContent(content).ok).toBe(false);
  });
});

describe("applyLatestYmlGate — EXE build simulation", () => {
  it("generates latest.yml referencing LabTrax-Setup.exe when none exists", async () => {
    const dir = await withTempDir();

    const result = await applyLatestYmlGate(dir, "exe", FAKE_OPTS);

    expect(result.latestYmlWritten).toBe(true);
    expect(await fileExists(join(dir, "latest.yml"))).toBe(true);
    expect(result.portableYmlWritten).toBe(false);
    expect(result.error).toBeNull();
  });

  it("generated latest.yml references LabTrax-Setup.exe, not the portable ZIP", async () => {
    const dir = await withTempDir();
    await applyLatestYmlGate(dir, "exe", FAKE_OPTS);
    const content = await readFile(join(dir, "latest.yml"), "utf8");
    expect(content).toContain("LabTrax-Setup.exe");
    expect(content).not.toContain("LabTrax-Windows-Portable.zip");
  });

  it("generated latest.yml passes validateLatestYmlContent", async () => {
    const dir = await withTempDir();
    await applyLatestYmlGate(dir, "exe", FAKE_OPTS);
    const content = await readFile(join(dir, "latest.yml"), "utf8");
    expect(validateLatestYmlContent(content).ok).toBe(true);
  });

  it("accepts an existing valid latest.yml from electron-builder (does not overwrite)", async () => {
    const dir = await withTempDir();
    const existingContent = buildLatestYmlContent({
      version: "1.2.3",
      filename: "LabTrax-Setup.exe",
      sha512: "electron-builder-hash==",
      size: 99999999,
      releaseDate: "2026-06-24T00:00:00.000Z",
    });
    await writeFile(join(dir, "latest.yml"), existingContent, "utf8");

    const result = await applyLatestYmlGate(dir, "exe", FAKE_OPTS);

    // latestYmlWritten is false because we reused the existing file
    expect(result.latestYmlWritten).toBe(false);
    expect(result.error).toBeNull();
    // File content is unchanged
    const afterContent = await readFile(join(dir, "latest.yml"), "utf8");
    expect(afterContent).toBe(existingContent);
  });

  it("does NOT create latest-portable.yml on the EXE path", async () => {
    const dir = await withTempDir();
    await applyLatestYmlGate(dir, "exe", FAKE_OPTS);
    expect(await fileExists(join(dir, "latest-portable.yml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyLatestYmlGate — safety-check: stale ZIP latest.yml on EXE build run
// ---------------------------------------------------------------------------

describe("applyLatestYmlGate — safety-check: stale ZIP latest.yml during EXE publish", () => {
  const staleZipContent = [
    "version: 0.9.9",
    "files:",
    "  - url: LabTrax-Windows-Portable.zip",
    "    sha512: stale==",
    "    size: 45000000",
    "path: LabTrax-Windows-Portable.zip",
    "sha512: stale==",
    "releaseDate: '2026-06-01T00:00:00.000Z'",
    "",
  ].join("\n");

  it("returns error (does not throw) when latest.yml references the ZIP", async () => {
    const dir = await withTempDir();
    await writeFile(join(dir, "latest.yml"), staleZipContent, "utf8");

    const result = await applyLatestYmlGate(dir, "exe", FAKE_OPTS);

    expect(result.error).not.toBeNull();
    expect(result.error).toContain("LabTrax-Windows-Portable.zip");
  });

  it("sets latestYmlWritten:false when error is detected (no new file written)", async () => {
    const dir = await withTempDir();
    await writeFile(join(dir, "latest.yml"), staleZipContent, "utf8");
    const result = await applyLatestYmlGate(dir, "exe", FAKE_OPTS);
    expect(result.latestYmlWritten).toBe(false);
  });

  it("leaves the stale file untouched (caller must act on the error)", async () => {
    const dir = await withTempDir();
    await writeFile(join(dir, "latest.yml"), staleZipContent, "utf8");
    await applyLatestYmlGate(dir, "exe", FAKE_OPTS);
    // Stale file still present — gate returned an error, not silently deleted it
    const afterContent = await readFile(join(dir, "latest.yml"), "utf8");
    expect(afterContent).toBe(staleZipContent);
  });
});

// ---------------------------------------------------------------------------
// Spawn integration: upload-desktop-installer exits non-zero when latest.yml
// references the portable ZIP (process-level safety-check test)
// ---------------------------------------------------------------------------

describe("spawn: upload-desktop-installer exits 1 on stale ZIP latest.yml", () => {
  // The child loads tsx and compiles the script from scratch — usually a few
  // seconds, but when the Run-button aggregate fires every rel-* workflow at
  // once, CPU contention can push it well past the 5 s default test timeout
  // (a false positive: the test passes cleanly when run alone). Give both the
  // spawned process and the test itself generous headroom.
  it("exits with code 1 and logs the ZIP filename when stale latest.yml is detected", async () => {
    const dir = await withTempDir();

    // Create a stale latest.yml that references the portable ZIP
    const staleLatestYml = join(dir, "latest.yml");
    await writeFile(
      staleLatestYml,
      [
        "version: 0.9.9",
        "files:",
        "  - url: LabTrax-Windows-Portable.zip",
        "    sha512: stale==",
        "    size: 45000000",
        "path: LabTrax-Windows-Portable.zip",
        "sha512: stale==",
        "releaseDate: '2026-06-01T00:00:00.000Z'",
        "",
      ].join("\n"),
      "utf8",
    );

    // Create a minimal fake EXE so stat() and readFile() pass
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, "MZ fake exe", "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, UPLOAD_INSTALLER_SCRIPT, fakeExe],
      {
        env: {
          ...process.env,
          // Must be set to pass the first guard in main()
          PRIVATE_OBJECT_DIR: "test-bucket/test-dir",
          GIT_COMMIT_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: resolve(SCRIPTS_SRC, "../.."),
            encoding: "utf8",
          }).stdout.trim(),
          LABTRAX_DESKTOP_SIGNATURE_VERIFICATION: "verified-installer",
          // Point latest.yml at the stale fixture — validation runs before GCS
          LABTRAX_LATEST_YML_PATH: staleLatestYml,
          // Suppress sidecar / GCS noise (validation fires before any upload)
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    // stderr must mention the ZIP so operators know what went wrong
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("LabTrax-Windows-Portable.zip");
  }, 150_000);

  it("uses GIT_COMMIT_SHA when it matches checkout, even if GITHUB_SHA differs", async () => {
    const dir = await withTempDir();
    const storageRoot = join(dir, "mock-storage");
    const readbackLog = join(dir, "storage-readbacks.jsonl");
    const installerBytes = Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0x10, 0x20]);
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, installerBytes);

    const checkedOutRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(checkedOutRevision.status).toBe(0);
    const expectedRevision = checkedOutRevision.stdout.trim().toLowerCase();
    const differentGithubSha =
      `${expectedRevision[0] === "0" ? "1" : "0"}${expectedRevision.slice(1)}`;
    expect(differentGithubSha).not.toBe(expectedRevision);

    const result = runUploaderWithMockStorage(fakeExe, storageRoot, {
      GIT_COMMIT_SHA: expectedRevision,
      GITHUB_SHA: differentGithubSha,
      MOCK_STORAGE_READBACK_LOG: readbackLog,
    });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(0);

    const uploadedInstallerPath = join(
      storageRoot,
      "test-bucket",
      "test-dir",
      "desktop-installer",
      "LabTrax-Setup.exe",
    );
    const sidecarPath = join(
      storageRoot,
      "test-bucket",
      "test-dir",
      "desktop-installer",
      "release-identity.json",
    );
    expect(await readFile(uploadedInstallerPath)).toEqual(installerBytes);

    const sidecarBytes = await readFile(sidecarPath);
    const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
    expect(sidecar).toEqual({
      schemaVersion: 1,
      version: "9.8.7-test",
      sourceRevision: expectedRevision,
      signatureVerification: "verified-installer",
      artifact: {
        fileName: "LabTrax-Setup.exe",
        size: installerBytes.length,
        sha256: createHash("sha256").update(installerBytes).digest("hex"),
      },
    });
    expect(sidecar.sourceRevision).toHaveLength(40);
    expect(sidecar.artifact.size).toBe(installerBytes.length);
    expect(sidecar.artifact.sha256).toBe(
      createHash("sha256").update(installerBytes).digest("hex"),
    );
    const readbackRecords = (await readFile(readbackLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(readbackRecords).toHaveLength(1);
    expect(readbackRecords[0].key).toBe(
      "test-dir/desktop-installer/release-identity.json",
    );
    expect(Buffer.from(readbackRecords[0].bytesBase64, "base64")).toEqual(sidecarBytes);
  }, 150_000);

  it("uses GITHUB_SHA when GIT_COMMIT_SHA is unset", async () => {
    const dir = await withTempDir();
    const storageRoot = join(dir, "mock-storage");
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, Buffer.from([0x4d, 0x5a, 0x01]));

    const checkedOutRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(checkedOutRevision.status).toBe(0);
    const revision = checkedOutRevision.stdout.trim().toLowerCase();
    expect(revision).toMatch(/^[a-f0-9]{40}$/);

    const result = runUploaderWithMockStorage(fakeExe, storageRoot, {
      GIT_COMMIT_SHA: undefined,
      GITHUB_SHA: revision,
    });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(0);

    const uploadedInstallerPath = join(
      storageRoot,
      "test-bucket",
      "test-dir",
      "desktop-installer",
      "LabTrax-Setup.exe",
    );
    const sidecarPath = join(
      storageRoot,
      "test-bucket",
      "test-dir",
      "desktop-installer",
      "release-identity.json",
    );
    expect(await readFile(uploadedInstallerPath)).toEqual(
      Buffer.from([0x4d, 0x5a, 0x01]),
    );
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(sidecar.sourceRevision).toBe(revision);
  }, 150_000);

  it("rejects a valid but stale source revision before writing any storage objects", async () => {
    const dir = await withTempDir();
    const storageRoot = join(dir, "mock-storage");
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    const latestYml = join(dir, "latest.yml");
    await writeFile(fakeExe, "MZ fake exe", "utf8");
    await writeFile(
      latestYml,
      buildLatestYmlContent({
        version: "9.8.7-test",
        filename: "LabTrax-Setup.exe",
        sha512: FAKE_SHA512,
        size: 11,
        releaseDate: "2026-06-24T12:00:00.000Z",
      }),
      "utf8",
    );

    const checkedOutRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(checkedOutRevision.status).toBe(0);
    const currentSha = checkedOutRevision.stdout.trim();
    const staleSha = `${currentSha[0] === "0" ? "1" : "0"}${currentSha.slice(1)}`;
    expect(staleSha).toMatch(/^[a-f0-9]{40}$/i);
    expect(staleSha.toLowerCase()).not.toBe(currentSha.toLowerCase());

    const result = runUploaderWithMockStorage(fakeExe, storageRoot, {
      GIT_COMMIT_SHA: staleSha,
      GITHUB_SHA: currentSha,
      LABTRAX_LATEST_YML_PATH: latestYml,
    });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(2);
    expect(combined).toContain(
      "Unable to verify that installer source revision matches the checked-out source.",
    );

    const objectRoot = join(storageRoot, "test-bucket", "test-dir", "desktop-installer");
    for (const objectName of [
      "LabTrax-Setup.exe",
      "latest.yml",
      "release-identity.json",
    ]) {
      expect(await fileExists(join(objectRoot, objectName))).toBe(false);
    }
  }, 150_000);

  it.each([
    {
      label: "missing",
      revisionEnv: {
        GIT_COMMIT_SHA: undefined,
        GITHUB_SHA: undefined,
      },
    },
    {
      label: "short",
      revisionEnv: {
        GIT_COMMIT_SHA: undefined,
        GITHUB_SHA: "a".repeat(39),
      },
    },
    {
      label: "overlong",
      revisionEnv: {
        GIT_COMMIT_SHA: undefined,
        GITHUB_SHA: "a".repeat(41),
      },
    },
    {
      label: "malformed primary",
      revisionEnv: {
        GIT_COMMIT_SHA: "not-a-full-source-revision",
        GITHUB_SHA: undefined,
      },
    },
    {
      label: "malformed fallback",
      revisionEnv: {
        GIT_COMMIT_SHA: undefined,
        GITHUB_SHA: "not-a-full-source-revision",
      },
    },
  ])(
    "rejects a $label source revision before writing any storage objects",
    async ({ revisionEnv }) => {
      const dir = await withTempDir();
      const storageRoot = join(dir, "mock-storage");
      const fakeExe = join(dir, "LabTrax-Setup.exe");
      const latestYml = join(dir, "latest.yml");
      await writeFile(fakeExe, "MZ fake exe", "utf8");
      await writeFile(
        latestYml,
        buildLatestYmlContent({
          version: "9.8.7-test",
          filename: "LabTrax-Setup.exe",
          sha512: FAKE_SHA512,
          size: 11,
          releaseDate: "2026-06-24T12:00:00.000Z",
        }),
        "utf8",
      );

      const result = runUploaderWithMockStorage(fakeExe, storageRoot, {
        ...revisionEnv,
        LABTRAX_LATEST_YML_PATH: latestYml,
      });
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, combined).toBe(2);
      expect(combined).toContain(
        "A full 40-character source revision is required for installer identity.",
      );

      await expectNoReleaseObjects(storageRoot);
    },
    150_000,
  );

  it("fails when the stored release identity sidecar reports the wrong size", async () => {
    const dir = await withTempDir();
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, "MZ fake exe", "utf8");

    const result = runUploaderWithMockStorage(fakeExe, join(dir, "mock-storage"), {
      MOCK_STORAGE_METADATA_SIZE_MISMATCH_FOR:
        "test-dir/desktop-installer/release-identity.json",
    });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(2);
    expect(combined).toContain(
      "Uploaded Desktop release identity sidecar has an unexpected size.",
    );
  }, 150_000);

  it("fails when the release identity sidecar read-back bytes differ", async () => {
    const dir = await withTempDir();
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, "MZ fake exe", "utf8");

    const result = runUploaderWithMockStorage(fakeExe, join(dir, "mock-storage"), {
      MOCK_STORAGE_READBACK_MISMATCH_FOR:
        "test-dir/desktop-installer/release-identity.json",
    });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(2);
    expect(combined).toContain(
      "Uploaded Desktop release identity sidecar failed its exact-byte read-back check.",
    );
  }, 150_000);

  it("refuses unsigned installer uploads before contacting App Storage", async () => {
    const dir = await withTempDir();
    const fakeExe = join(dir, "LabTrax-Setup.exe");
    await writeFile(fakeExe, "MZ fake exe", "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, UPLOAD_INSTALLER_SCRIPT, fakeExe],
      {
        env: {
          ...process.env,
          PRIVATE_OBJECT_DIR: "test-bucket/test-dir",
          LABTRAX_DESKTOP_SIGNATURE_VERIFICATION: "unverified",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect((result.stdout ?? "") + (result.stderr ?? "")).toContain(
      "without successful code-signature verification",
    );
  }, 150_000);
});
