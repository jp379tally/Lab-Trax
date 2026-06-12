import { describe, it, expect } from "vitest";
import { PARSERS_AND_HELPERS_JS } from "./index";

// The parsers live inside a JS template string so they can be inlined into the
// viewer/thumbnail HTML docs. Evaluate that string here to get callable
// functions for unit testing. They only rely on globals that exist in Node
// (atob, TextDecoder, DataView, typed arrays); window-touching helpers
// (postMsg/postError) are defined but never invoked by the parser path.
const factory = new Function(
  `${PARSERS_AND_HELPERS_JS}\nreturn { parsePLY: parsePLY, parseScanBuffer: parseScanBuffer };`,
);
const { parsePLY, parseScanBuffer } = factory() as {
  parsePLY: (buf: ArrayBuffer) => {
    vertices: Float32Array;
    normals: Float32Array;
    colors?: Float32Array;
  } | null;
  parseScanBuffer: (
    buf: ArrayBuffer,
    format: string,
  ) => { vertices: Float32Array; colors?: Float32Array } | null;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function asciiToArrayBuffer(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

// One triangle (vertices 0,1,2) with pure red / green / blue corners.
const ASCII_COLOR_PLY = [
  "ply",
  "format ascii 1.0",
  "element vertex 3",
  "property float x",
  "property float y",
  "property float z",
  "property uchar red",
  "property uchar green",
  "property uchar blue",
  "element face 1",
  "property list uchar int vertex_indices",
  "end_header",
  "0 0 0 255 0 0",
  "1 0 0 0 255 0",
  "0 1 0 0 0 255",
  "3 0 1 2",
  "",
].join("\n");

const ASCII_NO_COLOR_PLY = [
  "ply",
  "format ascii 1.0",
  "element vertex 3",
  "property float x",
  "property float y",
  "property float z",
  "element face 1",
  "property list uchar int vertex_indices",
  "end_header",
  "0 0 0",
  "1 0 0",
  "0 1 0",
  "3 0 1 2",
  "",
].join("\n");

function buildBinaryColorPly(): ArrayBuffer {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    "element vertex 3",
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "element face 1",
    "property list uchar int vertex_indices",
    "end_header\n",
  ].join("\n");
  const headerBytes = new TextEncoder().encode(header);

  const verts: Array<[number, number, number, number, number, number]> = [
    [0, 0, 0, 255, 0, 0],
    [1, 0, 0, 0, 255, 0],
    [0, 1, 0, 0, 0, 255],
  ];
  // 3 vertices * (12 bytes xyz + 3 bytes rgb) + 1 face (1 + 3*4 bytes)
  const body = new ArrayBuffer(3 * 15 + 13);
  const dv = new DataView(body);
  let off = 0;
  for (const [x, y, z, r, g, b] of verts) {
    dv.setFloat32(off, x, true);
    dv.setFloat32(off + 4, y, true);
    dv.setFloat32(off + 8, z, true);
    dv.setUint8(off + 12, r);
    dv.setUint8(off + 13, g);
    dv.setUint8(off + 14, b);
    off += 15;
  }
  dv.setUint8(off, 3);
  off += 1;
  for (const idx of [0, 1, 2]) {
    dv.setInt32(off, idx, true);
    off += 4;
  }

  const out = new Uint8Array(headerBytes.byteLength + body.byteLength);
  out.set(headerBytes, 0);
  out.set(new Uint8Array(body), headerBytes.byteLength);
  return toArrayBuffer(out);
}

const EXPECTED_COLORS = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("parsePLY vertex colors", () => {
  it("reads per-vertex color from an ASCII color PLY", () => {
    const result = parsePLY(asciiToArrayBuffer(ASCII_COLOR_PLY));
    expect(result).not.toBeNull();
    expect(result!.vertices.length).toBe(9);
    expect(result!.colors).toBeInstanceOf(Float32Array);
    expect(result!.colors!.length).toBe(9);
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
  });

  it("reads per-vertex color from a binary little-endian color PLY", () => {
    const result = parsePLY(buildBinaryColorPly());
    expect(result).not.toBeNull();
    expect(result!.vertices.length).toBe(9);
    expect(result!.colors).toBeInstanceOf(Float32Array);
    expect(result!.colors!.length).toBe(9);
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
  });

  it("normalizes 0–255 channels to 0–1", () => {
    const result = parsePLY(buildBinaryColorPly());
    for (const c of result!.colors!) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("returns no color array for a color-less PLY", () => {
    const result = parsePLY(asciiToArrayBuffer(ASCII_NO_COLOR_PLY));
    expect(result).not.toBeNull();
    expect(result!.vertices.length).toBe(9);
    expect(result!.colors).toBeUndefined();
  });

  it("exposes colors through parseScanBuffer for ply format", () => {
    const result = parseScanBuffer(
      asciiToArrayBuffer(ASCII_COLOR_PLY),
      "ply",
    );
    expect(result!.colors).toBeInstanceOf(Float32Array);
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
  });
});
