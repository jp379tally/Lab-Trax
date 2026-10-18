/**
 * Small, deliberately conservative PLY texture linker.  A PLY comment is
 * metadata, not a URL: only a plain filename can be used and it must match
 * exactly one image in the same archive.
 */
export type TextureEntry = { name: string; data: Buffer; mimeType: string };

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"]);

export function declaredPlyTexture(ply: Buffer): string | null {
  // Header is bounded so a hostile binary payload cannot make us scan it all.
  const header = ply.subarray(0, Math.min(ply.length, 1024 * 1024)).toString("latin1");
  const end = header.indexOf("end_header");
  if (end < 0) return null;
  const text = header.slice(0, end);
  const declarations = [...text.matchAll(/(?:^|\r?\n)\s*comment\s+TextureFile\s+([^\s\r\n]+)/gi)];
  if (declarations.length !== 1) return null;
  const value = declarations[0]![1]!;
  // Reject path traversal, absolute paths, URLs, and separators. Pairing is
  // intentionally basename-only and case-sensitive (provider exports rely on
  // exact references).
  if (!value || value.includes("/") || value.includes("\\") || value.includes(":") ||
      value === "." || value === ".." || value.includes("..")) return null;
  return value;
}

export function pairPlyTextures(entries: TextureEntry[]): Map<string, string> {
  const images = new Map<string, TextureEntry>();
  const ambiguousImages = new Set<string>();
  const ambiguousPlys = new Set<string>();
  const seenPlys = new Set<string>();
  for (const entry of entries) {
    const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (images.has(entry.name)) {
        images.delete(entry.name);
        ambiguousImages.add(entry.name);
      }
      else images.set(entry.name, entry);
    }
  }
  const result = new Map<string, string>();
  for (const ply of entries) {
    if (!ply.name.toLowerCase().endsWith(".ply")) continue;
    if (seenPlys.has(ply.name)) {
      ambiguousPlys.add(ply.name);
      result.delete(ply.name);
      continue;
    }
    seenPlys.add(ply.name);
    const declared = declaredPlyTexture(ply.data);
    if (!declared) continue;
    const image = ambiguousImages.has(declared) ? undefined : images.get(declared);
    if (image && !ambiguousPlys.has(ply.name)) result.set(ply.name, image.name);
  }
  return result;
}