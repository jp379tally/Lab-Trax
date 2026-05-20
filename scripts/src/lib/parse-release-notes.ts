import { readFile } from "node:fs/promises";

/**
 * Reads RELEASE_NOTES.md and extracts the notes block for a given version.
 *
 * The file is expected to have H2 headings in the form "## vX.Y.Z". Each
 * version block spans from its heading down to (but not including) the next
 * "## v" heading, or the end of the file.
 *
 * Returns the trimmed text of the matching block, or null if the version is
 * not found or the file cannot be read.
 */
export async function parseReleaseNotes(
  filePath: string,
  version: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  return extractVersionBlock(raw, version);
}

/**
 * Pure (synchronous) parser — useful for testing and for callers that have
 * already loaded the file contents.
 */
export function extractVersionBlock(raw: string, version: string): string | null {
  const normalizedVersion = version.startsWith("v") ? version : `v${version}`;
  const lines = raw.split(/\r?\n/);

  let inBlock = false;
  const blockLines: string[] = [];

  for (const line of lines) {
    if (/^## v/.test(line)) {
      if (inBlock) {
        break;
      }
      const heading = line.replace(/^##\s+/, "").trim();
      if (heading === normalizedVersion) {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) {
      blockLines.push(line);
    }
  }

  if (!inBlock) {
    return null;
  }

  const trimmed = blockLines
    .join("\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");

  return trimmed || null;
}
