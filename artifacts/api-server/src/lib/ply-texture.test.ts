import { describe, expect, it } from "vitest";
import { declaredPlyTexture, pairPlyTextures } from "./ply-texture";

describe("PLY texture pairing", () => {
  const ply = (name: string) => Buffer.from(
    `ply\nformat ascii 1.0\ncomment TextureFile ${name}\nelement vertex 0\nend_header\n`,
  );
  it("matches an exact same-archive image", () => {
    expect(pairPlyTextures([
      { name: "scan.ply", data: ply("scan.jpg"), mimeType: "application/octet-stream" },
      { name: "scan.jpg", data: Buffer.from([1]), mimeType: "image/jpeg" },
    ]).get("scan.ply")).toBe("scan.jpg");
  });
  it("rejects paths and missing references", () => {
    expect(declaredPlyTexture(ply("../scan.jpg"))).toBeNull();
    expect(declaredPlyTexture(ply(`${"x".repeat(256)}.jpg`))).toBeNull();
    expect(pairPlyTextures([{ name: "scan.ply", data: ply("missing.jpg"), mimeType: "x" }]).size).toBe(0);
  });
  it("does not pair duplicate image or PLY basenames", () => {
    const image = { name: "scan.jpg", data: Buffer.from([1]), mimeType: "image/jpeg" };
    expect(pairPlyTextures([
      { name: "scan.ply", data: ply("scan.jpg"), mimeType: "x" },
      { name: "scan.ply", data: ply("scan.jpg"), mimeType: "x" },
      image,
    ]).size).toBe(0);
    expect(pairPlyTextures([
      { name: "scan.ply", data: ply("scan.jpg"), mimeType: "x" },
      { name: "scan.jpg", data: Buffer.from([1]), mimeType: "image/jpeg" },
      { name: "scan.jpg", data: Buffer.from([2]), mimeType: "image/jpeg" },
    ]).size).toBe(0);
  });
});