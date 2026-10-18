import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePdfConverter, resolvePdfInfo } from "./pdf-runtime";

import { MAX_RX_PDF_PAGES, MAX_RX_RENDERED_BYTES, PdfConversionError } from "./prescription-limits";
export { MAX_RX_PDF_PAGES, MAX_RX_RENDERED_BYTES, PdfConversionError } from "./prescription-limits";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Convert a PDF (provided as a Buffer) into one JPEG data URL per page using
 * the `pdftoppm` poppler utility. maxPages is an acceptance limit (at most ten);
 * oversized documents are rejected, never silently truncated.
 *
 * This is the canonical PDF→image path for AI vision extraction. The Replit AI
 * Integrations proxy does NOT support the OpenAI Files API (`POST /files`), so
 * native PDF understanding via `openai.files.create()` always fails with
 * "Endpoint: 'POST /files' is not supported." Rasterizing to images and using
 * the vision (chat.completions image_url) API is the supported approach.
 *
 * Throws a safe, classified error if the converter is unavailable, the PDF
 * renders no pages/is unreadable, or conversion exceeds `timeoutMs`. Callers
 * must not treat failed conversion as successfully inferred work.
 */
export async function convertPdfBufferToImageDataUrls(
  buf: Buffer,
  maxPages = MAX_RX_PDF_PAGES,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!buf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new PdfConversionError("unreadable");
  if (buf.length > 9 * 1024 * 1024) throw new PdfConversionError("oversized");
  const deadline = Date.now() + timeoutMs;
  const pageLimit = Math.min(MAX_RX_PDF_PAGES, maxPages);
  if (!Number.isInteger(pageLimit) || pageLimit < 1) throw new PdfConversionError("oversized");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rx-pdf-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outputPrefix = path.join(tmpDir, "page");
  try {
    await writeFile(pdfPath, buf);
    // Preflight before rendering. Metadata output is bounded and never logged.
    const info = await runPdfProcess(resolvePdfInfo(), [pdfPath], deadline, signal, true);
    const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new PdfConversionError("unreadable");
    if (pages > pageLimit) throw new PdfConversionError("oversized");
    const images: string[] = [];
    let bytes = 0;
    // At most one page's pixel/output buffer exists on disk at a time. Each
    // subprocess shares the same deadline and is killed on cancellation.
    for (let page = 1; page <= pages; page++) {
      await runPdfProcess(resolvePdfConverter(), [
        "-jpeg", "-r", "250", "-scale-to", "3000",
        "-f", String(page), "-l", String(page), pdfPath, outputPrefix,
      ], deadline, signal);
      const files = (await readdir(tmpDir)).filter((f) => /^page.*\.jpe?g$/.test(f));
      if (files.length !== 1) throw new PdfConversionError("unreadable");
      const file = path.join(tmpDir, files[0]!);
      const size = (await stat(file)).size;
      bytes += size;
      if (size > MAX_PAGE_BYTES || bytes > MAX_RX_RENDERED_BYTES) throw new PdfConversionError("oversized");
      const data = await readFile(file);
      images.push(`data:image/jpeg;base64,${data.toString("base64")}`);
      await rm(file);
    }
    return images;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runPdfProcess(tool: string, args: string[], deadline: number, signal?: AbortSignal, capture = false): Promise<string> {
  if (signal?.aborted) return Promise.reject(new PdfConversionError("cancelled"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new PdfConversionError("timeout"));
  return new Promise((resolve, reject) => {
    // Poppler may decode a large embedded image before writing the bounded
    // output. Constrain that child independently of the Node process, and
    // fail explicitly if the runtime cannot apply the limits.
    const proc = spawn("/bin/sh", [
      "-c", 'set -e; ulimit -v 262144; ulimit -f 16384; ulimit -t 30; exec "$@"',
      "rx-pdf", tool, ...args,
    ], { stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    let failure: PdfConversionError | undefined;
    let output = "";
    const stop = (reason: "timeout" | "cancelled" | "oversized") => {
      failure ??= new PdfConversionError(reason);
      proc.kill("SIGKILL");
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), remaining);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    proc.stderr?.resume();
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 64 * 1024) stop("oversized");
      else output += chunk.toString("utf8");
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      failure ??= new PdfConversionError(err.code === "ENOENT" || err.code === "EACCES" ? "unavailable" : "unreadable");
    });
    // Wait for close after SIGKILL before deleting the temporary directory.
    proc.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new PdfConversionError(code === 126 || code === 127 ? "unavailable" : "unreadable"));
      else resolve(output);
    });
  });
}
