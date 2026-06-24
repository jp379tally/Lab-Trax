/**
 * Pure validation and generation helpers for the electron-updater auto-update
 * manifest (latest.yml).
 *
 * CRITICAL INVARIANT
 * ─────────────────
 * latest.yml MUST reference LabTrax-Setup.exe (the NSIS installer), NEVER
 * LabTrax-Windows-Portable.zip. If latest.yml points at the portable ZIP,
 * NSIS-installed users whose auto-updater fetches the manifest will have the
 * ZIP extracted to a temp directory while the original install path goes stale,
 * breaking every pinned taskbar and Start Menu shortcut with:
 *   "The item 'LabTrax.exe' has been changed or moved."
 *
 * These helpers are extracted from upload-desktop-installer.ts so they can be
 * unit-tested independently of any I/O or process.exit() calls.
 */

import { writeFile, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";

export type InstallerKind = "exe" | "zip" | "dmg";

/**
 * Returns true only for installer kinds whose auto-update manifest (latest.yml)
 * must be uploaded to App Storage.
 *
 * - exe (NSIS installer) → true  — primary Windows update path
 * - dmg (macOS)          → true  — macOS update path
 * - zip (portable)       → false — portable ZIP must NEVER update latest.yml;
 *                                   it is not an installable package and has no
 *                                   stable install-path for the updater to patch
 */
export function shouldUploadLatestYml(kind: InstallerKind): boolean {
  return kind === "exe" || kind === "dmg";
}

export interface ValidateResult {
  ok: boolean;
  error: string | null;
}

/**
 * Validates the content of an existing latest.yml file before it is uploaded
 * to the auto-update feed.
 *
 * Rejects any content that references LabTrax-Windows-Portable.zip — this
 * catches the scenario where a stale manifest from a previous portable-ZIP
 * build is present in electron-dist when an EXE publish runs.
 */
export function validateLatestYmlContent(content: string): ValidateResult {
  if (content.includes("LabTrax-Windows-Portable.zip")) {
    return {
      ok: false,
      error:
        "latest.yml references LabTrax-Windows-Portable.zip — this must never " +
        "be uploaded as the auto-update feed for NSIS-installed users. Delete " +
        "electron-dist/latest.yml and re-run the build to regenerate it from " +
        "the NSIS installer (LabTrax-Setup.exe).",
    };
  }
  return { ok: true, error: null };
}

export interface BuildLatestYmlOpts {
  version: string;
  filename: string;
  sha512: string;
  size: number;
  releaseDate: string;
}

/**
 * Generates the YAML content for the electron-updater auto-update manifest.
 *
 * The caller is responsible for ensuring `filename` is the NSIS installer
 * (LabTrax-Setup.exe) and never the portable ZIP.
 */
export function buildLatestYmlContent(opts: BuildLatestYmlOpts): string {
  const { version, filename, sha512, size, releaseDate } = opts;
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

// ── Filesystem-level gate ────────────────────────────────────────────────────

export interface GateResult {
  /** true if latest.yml was written or was already valid (exe/dmg path only) */
  latestYmlWritten: boolean;
  /** true if latest-portable.yml was written (zip path only) */
  portableYmlWritten: boolean;
  /** true if a stale latest.yml was removed during a zip build run */
  staleLatestYmlRemoved: boolean;
  /** non-null when the existing latest.yml referenced the portable ZIP */
  error: string | null;
}

const INSTALLER_FILENAME: Record<InstallerKind, string> = {
  exe: "LabTrax-Setup.exe",
  zip: "LabTrax-Windows-Portable.zip",
  dmg: "LabTrax.dmg",
};

/**
 * Applies the auto-update manifest file-system decisions for a given installer
 * kind, without any GCS upload.  This is the testable, I/O-only layer that
 * mirrors the manifest-related logic in desktop-build-publish.sh and
 * upload-desktop-installer.ts.
 *
 * Portable-ZIP path (kind="zip"):
 *   - Writes latest-portable.yml  (informational record of this build)
 *   - Removes any stale latest.yml to prevent the uploader from accidentally
 *     finding and uploading it
 *   - NEVER writes latest.yml
 *
 * EXE/DMG path (kind="exe"|"dmg"):
 *   - If latest.yml is absent: generates it from the given opts and writes it
 *   - If latest.yml is present: validates its content; returns error when it
 *     references LabTrax-Windows-Portable.zip (caller should exit non-zero)
 *   - NEVER writes latest-portable.yml
 *
 * @param electronDistDir  Path to the electron-dist output directory
 * @param kind             Installer kind ("exe", "zip", or "dmg")
 * @param opts             Version/hash/size metadata used when generating yml
 */
export async function applyLatestYmlGate(
  electronDistDir: string,
  kind: InstallerKind,
  opts: Omit<BuildLatestYmlOpts, "filename" | "releaseDate"> & {
    releaseDate?: string;
  },
): Promise<GateResult> {
  const latestYmlPath = join(electronDistDir, "latest.yml");
  const portableYmlPath = join(electronDistDir, "latest-portable.yml");
  const releaseDate = opts.releaseDate ?? new Date().toISOString();

  const result: GateResult = {
    latestYmlWritten: false,
    portableYmlWritten: false,
    staleLatestYmlRemoved: false,
    error: null,
  };

  if (kind === "zip") {
    // Portable-ZIP path: write latest-portable.yml; do NOT write latest.yml.
    const content = buildLatestYmlContent({
      ...opts,
      filename: INSTALLER_FILENAME.zip,
      releaseDate,
    });
    await writeFile(portableYmlPath, content, "utf8");
    result.portableYmlWritten = true;

    // Remove any stale latest.yml so the uploader cannot accidentally find it.
    try {
      await access(latestYmlPath);
      await rm(latestYmlPath);
      result.staleLatestYmlRemoved = true;
    } catch {
      // Not present — nothing to remove.
    }
  } else {
    // EXE or DMG path: validate or generate latest.yml.
    const filename = INSTALLER_FILENAME[kind];

    let existingContent: string | null = null;
    try {
      await access(latestYmlPath);
      existingContent = await readFile(latestYmlPath, "utf8");
    } catch {
      // Not present — generate from opts.
    }

    if (existingContent !== null) {
      const validation = validateLatestYmlContent(existingContent);
      if (!validation.ok) {
        result.error = validation.error;
        return result;
      }
      // Existing content is valid — no need to re-write.
      result.latestYmlWritten = false;
    } else {
      const content = buildLatestYmlContent({ ...opts, filename, releaseDate });
      await writeFile(latestYmlPath, content, "utf8");
      result.latestYmlWritten = true;
    }
  }

  return result;
}
