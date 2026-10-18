import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, rm } from "node:fs/promises";
import PDFDocument from "pdfkit";

const fixture = vi.hoisted(() => ({
  dir: `/tmp/pdf-converter-${crypto.randomUUID()}`,
  converter: vi.fn(() => "pdftoppm"),
}));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), tmpdir: () => fixture.dir }));
vi.mock("./pdf-runtime", () => ({ resolvePdfConverter: fixture.converter, resolvePdfInfo: () => "pdfinfo" }));
import { convertPdfBufferToImageDataUrls, PdfConversionError } from "./pdf-to-images";

describe("bounded PDF conversion and temporary cleanup", () => {
  let pdf: Buffer;
  beforeAll(async () => {
    await mkdir(fixture.dir);
    pdf = await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.text("ISOLATED FIXTURE ONLY");
      for (let i = 0; i < 3; i++) { doc.addPage(); doc.text("ISOLATED FIXTURE PAGE"); }
      doc.end();
    });
  });
  beforeEach(() => fixture.converter.mockReturnValue("pdftoppm"));
  afterAll(async () => { await rm(fixture.dir, { recursive: true, force: true }); });
  it("retains all four accepted pages and removes temporary inputs and outputs", async () => {
    expect(await convertPdfBufferToImageDataUrls(pdf)).toHaveLength(4);
    expect(await readdir(fixture.dir)).toEqual([]);
  });
  it("rejects a document beyond an explicit smaller limit instead of silently truncating", async () => {
    await expect(convertPdfBufferToImageDataUrls(pdf, 3)).rejects.toMatchObject({ reason: "oversized" });
    expect(await readdir(fixture.dir)).toEqual([]);
  });
  it("removes temporary files when the deployed converter is unavailable", async () => {
    fixture.converter.mockReturnValue("/missing-test-only/pdftoppm");
    await expect(convertPdfBufferToImageDataUrls(pdf)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await readdir(fixture.dir)).toEqual([]);
  });
  it("removes temporary files when the PDF is corrupt", async () => {
    await expect(convertPdfBufferToImageDataUrls(Buffer.from("%PDF-1.4\nbroken")))
      .rejects.toBeInstanceOf(PdfConversionError);
    expect(await readdir(fixture.dir)).toEqual([]);
  });
  it("kills a timed-out conversion and removes temporary files", async () => {
    await expect(convertPdfBufferToImageDataUrls(pdf, 3, 1)).rejects.toMatchObject({ reason: "timeout" });
    expect(await readdir(fixture.dir)).toEqual([]);
  });
});
