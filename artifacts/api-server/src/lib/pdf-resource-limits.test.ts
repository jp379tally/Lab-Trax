import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
const fake = vi.hoisted(() => ({ spawn: vi.fn(), pages: 4, bytes: 1000, hang: false }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("./pdf-runtime", () => ({ resolvePdfInfo: () => "pdfinfo", resolvePdfConverter: () => "pdftoppm" }));
import { convertPdfBufferToImageDataUrls } from "./pdf-to-images";
const PDF = Buffer.from("%PDF-1.4 synthetic nonclinical fixture");

describe("resource-bounded prescription PDF conversion", () => {
  beforeEach(() => {
    fake.pages = 4; fake.bytes = 1000; fake.hang = false;
    fake.spawn.mockReset();
    fake.spawn.mockImplementation((tool: string, args: string[]) => {
      if (tool === "/bin/sh") { tool = args[3]!; args = args.slice(4); }
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }),
      });
      if (!fake.hang) queueMicrotask(() => {
        if (tool === "pdfinfo") child.stdout.write(`Pages: ${fake.pages}\n`);
        else {
          const page = args[args.indexOf("-f") + 1];
          writeFileSync(`${args.at(-1)}-${page}.jpg`, Buffer.alloc(fake.bytes, Number(page)));
        }
        child.emit("close", 0);
      });
      return child;
    });
  });
  it("preflights page count then renders every accepted page, one at a time in order", async () => {
    const images = await convertPdfBufferToImageDataUrls(PDF);
    expect(images).toHaveLength(4);
    expect(fake.spawn.mock.calls[0][1][3]).toBe("pdfinfo");
    expect(fake.spawn.mock.calls[0][1][1]).toContain("ulimit -v 262144");
    expect(fake.spawn).toHaveBeenCalledTimes(5);
    expect(images.map((image) => Buffer.from(image.split(",")[1]!, "base64")[0])).toEqual([1, 2, 3, 4]);
    for (const [, args] of fake.spawn.mock.calls.slice(1)) {
      expect(args[args.indexOf("-f") + 1]).toBe(args[args.indexOf("-l") + 1]);
    }
  });
  it("rejects over-limit page counts before any rendering", async () => {
    fake.pages = 11;
    await expect(convertPdfBufferToImageDataUrls(PDF)).rejects.toThrow(/maximum 10 pages/);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
  it("rejects large inputs before allocating a converter", async () => {
    const large = Buffer.alloc(10 * 1024 * 1024);
    PDF.copy(large);
    await expect(convertPdfBufferToImageDataUrls(large)).rejects.toThrow(/too large/);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
  it("rejects an oversized rendered page before loading it into JS", async () => {
    fake.bytes = 3 * 1024 * 1024;
    await expect(convertPdfBufferToImageDataUrls(PDF)).rejects.toThrow(/too large/);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });
  it("bounds aggregate rendered bytes, not only per-page size", async () => {
    fake.pages = 6; fake.bytes = 2 * 1024 * 1024;
    await expect(convertPdfBufferToImageDataUrls(PDF)).rejects.toThrow(/too large/);
    expect(fake.spawn).toHaveBeenCalledTimes(6);
  });
  it("kills preflight on cancellation and waits for child close", async () => {
    fake.hang = true;
    const controller = new AbortController();
    const conversion = convertPdfBufferToImageDataUrls(PDF, 10, 30_000, controller.signal);
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(conversion).rejects.toThrow(/cancelled/);
    expect(fake.spawn.mock.results[0].value.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("uses one overall deadline, including metadata lookup", async () => {
    fake.hang = true;
    await expect(convertPdfBufferToImageDataUrls(PDF, 10, 10)).rejects.toThrow(/timeout/);
    expect(fake.spawn.mock.results[0].value.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
