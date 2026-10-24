import { parse } from "yaml";
import { readUpdateManifest } from "./desktop-installer-storage";
import { HttpError } from "./http";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** The updater feed is authoritative when an installable release exists. */
export async function getPublishedDesktopVersion(
  readFallback: () => Promise<string>,
): Promise<string> {
  let manifest: Buffer | null;
  try {
    manifest = await readUpdateManifest();
  } catch {
    throw new HttpError(503, "Desktop update information is temporarily unavailable.");
  }
  // Portable-only installations may not have an updater feed yet.
  if (manifest === null) return readFallback();
  try {
    if (manifest.length > MAX_MANIFEST_BYTES) throw new Error("Manifest too large");
    const parsed: unknown = parse(manifest.toString("utf8"), { maxAliasCount: 0 });
    const version = parsed && typeof parsed === "object" && "version" in parsed
      ? (parsed as { version: unknown }).version
      : null;
    if (typeof version !== "string" || !VERSION.test(version)) {
      throw new Error("Invalid manifest version");
    }
    return version;
  } catch {
    // Never hide a broken feed behind an unrelated DB or environment version.
    throw new HttpError(503, "Desktop update information is temporarily unavailable.");
  }
}
