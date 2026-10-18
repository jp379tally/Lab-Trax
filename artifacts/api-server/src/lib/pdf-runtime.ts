import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Published artifacts do not inherit the workspace's Nix PATH. */
function resolvePdfTool(tool: "pdftoppm" | "pdfinfo"): string {
  for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    let dir = path.resolve(start);
    for (let i = 0; i <= 6; i++) {
      const candidate = path.join(dir, ".production-runtime", "bin", tool);
      // If present but broken, fail explicitly rather than masking a bad image.
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return tool;
}
export const resolvePdfConverter = () => resolvePdfTool("pdftoppm");
export const resolvePdfInfo = () => resolvePdfTool("pdfinfo");
