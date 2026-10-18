import { describe, expect, it } from "vitest";
import { matchPendingPlyTexture, plyDeclaredTextureFilename } from "../ScanThumbnail";

function plyHeader(comment: string): ArrayBuffer {
  return new TextEncoder()
    .encode(`ply\nformat ascii 1.0\ncomment TextureFile ${comment}\nelement vertex 0\nend_header\n`)
    .buffer as ArrayBuffer;
}

describe("pending PLY texture matching", () => {
  it("matches a unique JPEG by the exact declared filename, not the mesh basename", () => {
    const header = plyHeader("surface-atlas.jpg");
    const result = matchPendingPlyTexture(header, [
      {
        fileName: "different-mesh-name.ply",
        fileUrl: "/pending/mesh",
        mimeType: "model/ply",
      },
      {
        fileName: "surface-atlas.jpg",
        fileUrl: "/authenticated/texture",
        mimeType: "image/jpeg",
      },
    ]);
    expect(result?.fileUrl).toBe("/authenticated/texture");
  });

  it("returns no match for missing or ambiguous exact candidates", () => {
    const header = plyHeader("atlas.jpg");
    const candidate = {
      fileName: "atlas.jpg",
      fileUrl: "/authorized/file",
      mimeType: "image/jpeg",
    };
    expect(matchPendingPlyTexture(header, [])).toBeNull();
    expect(matchPendingPlyTexture(header, [candidate, { ...candidate }])).toBeNull();
    expect(
      matchPendingPlyTexture(header, [{ ...candidate, fileName: "prefix-atlas.jpg" }]),
    ).toBeNull();
  });

  it("ignores declarations outside a complete bounded header", () => {
    expect(plyDeclaredTextureFilename(plyHeader("atlas.jpg"))).toBe("atlas.jpg");
    expect(
      plyDeclaredTextureFilename(
        new TextEncoder().encode("comment TextureFile atlas.jpg").buffer as ArrayBuffer,
      ),
    )
      .toBeNull();
    const oversized = new Uint8Array(64 * 1024 + 64);
    oversized.fill(32);
    oversized.set(new TextEncoder().encode("comment TextureFile atlas.jpg"));
    expect(plyDeclaredTextureFilename(oversized.buffer)).toBeNull();
  });
});