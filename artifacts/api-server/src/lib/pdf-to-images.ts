import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Convert a PDF (provided as a Buffer) into one JPEG data URL per page using
 * the `pdftoppm` poppler utility. Renders at most the first `maxPages` pages.
 *
 * This is the canonical PDF→image path for AI vision extraction. The Replit AI
 * Integrations proxy does NOT support the OpenAI Files API (`POST /files`), so
 * native PDF understanding via `openai.files.create()` always fails with
 * "Endpoint: 'POST /files' is not supported." Rasterizing to images and using
 * the vision (chat.completions image_url) API is the supported approach.
 *
 * Returns an empty array if the PDF renders no pages. Throws if `pdftoppm`
 * itself fails (e.g. corrupt input) or exceeds `timeoutMs` — callers should
 * catch and fall back.
 */
export async function convertPdfBufferToImageDataUrls(
  buf: Buffer,
  maxPages = 3,
  timeoutMs = 30_000,
): Promise<string[]> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rx-pdf-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outputPrefix = path.join(tmpDir, "page");
  try {
    await writeFile(pdfPath, buf);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pdftoppm", [
        "-jpeg",
        "-r",
        "250",
        "-f",
        "1",
        "-l",
        String(maxPages),
        pdfPath,
        outputPrefix,
      ]);
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        reject(
          new Error(`pdftoppm timed out after ${timeoutMs}ms (possibly corrupt or oversized PDF)`),
        );
      }, timeoutMs);
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString().slice(0, 500);
      });
      proc.on("close", (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exited ${code}: ${stderr}`));
      });
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
    const allFiles = await readdir(tmpDir);
    const jpgFiles = allFiles
      .filter(
        (f) => f.startsWith("page") && (f.endsWith(".jpg") || f.endsWith(".jpeg")),
      )
      .sort();
    const images: string[] = [];
    for (const file of jpgFiles) {
      const data = await readFile(path.join(tmpDir, file));
      images.push(`data:image/jpeg;base64,${data.toString("base64")}`);
    }
    return images;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
