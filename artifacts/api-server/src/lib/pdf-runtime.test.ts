import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePdfConverter, resolvePdfInfo } from "./pdf-runtime";

describe("packaged PDF converter resolution", () => {
  const root = `/tmp/pdf-runtime-${crypto.randomUUID()}`;
  const bin = path.join(root, ".production-runtime/bin/pdftoppm");
  beforeAll(async () => {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(path.join(path.dirname(bin), "pdfinfo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  it("prefers the retained converter over PATH from the project root", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(resolvePdfConverter()).toBe(bin);
      expect(resolvePdfInfo()).toBe(path.join(path.dirname(bin), "pdfinfo"));
    } finally { cwd.mockRestore(); }
  });
  it("finds the retained converter from an artifact working directory", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "artifacts/api-server"));
    try { expect(resolvePdfConverter()).toBe(bin); } finally { cwd.mockRestore(); }
  });
});
