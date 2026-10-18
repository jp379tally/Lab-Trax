import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Extracts the text below the H2 release heading for one version.
 * A block ends at the next version heading or at end-of-file.
 */
export function extractVersionBlock(raw, version) {
  const normalizedVersion = version.startsWith("v") ? version : `v${version}`;
  const lines = raw.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const line of lines) {
    if (/^## v/.test(line)) {
      if (inBlock) break;
      if (line.replace(/^##\s+/, "").trim() === normalizedVersion) {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) blockLines.push(line);
  }

  if (!inBlock) return null;
  return blockLines.join("\n").trim() || null;
}

export async function parseReleaseNotes(filePath, version) {
  try {
    return extractVersionBlock(await readFile(filePath, "utf8"), version);
  } catch {
    return null;
  }
}

async function main() {
  const [, , filePath, version] = process.argv;
  if (!filePath || !version) {
    console.error("Usage: node parse-release-notes.mjs <file> <version>");
    process.exitCode = 2;
    return;
  }

  const notes = await parseReleaseNotes(filePath, version);
  if (notes) process.stdout.write(notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
