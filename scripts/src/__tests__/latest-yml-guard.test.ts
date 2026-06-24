import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const TSX = resolve(__dirname, "../../../node_modules/.bin/tsx");

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

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
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
      TSX,
      [UPLOAD_INSTALLER_SCRIPT, fakeExe],
      {
        env: {
          ...process.env,
          // Must be set to pass the first guard in main()
          PRIVATE_OBJECT_DIR: "test-bucket/test-dir",
          // Point latest.yml at the stale fixture — validation runs before GCS
          LABTRAX_LATEST_YML_PATH: staleLatestYml,
          // Suppress sidecar / GCS noise (validation fires before any upload)
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(1);
    // stderr must mention the ZIP so operators know what went wrong
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("LabTrax-Windows-Portable.zip");
  });
});
