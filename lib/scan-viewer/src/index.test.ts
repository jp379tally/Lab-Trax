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
    colorWarning?: string;
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

describe("parsePLY additional color layouts", () => {
  it("reads ambient_* channel aliases", () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property uchar ambient_red",
      "property uchar ambient_green",
      "property uchar ambient_blue",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header",
      "0 0 0 255 0 0",
      "1 0 0 0 255 0",
      "0 1 0 0 0 255",
      "3 0 1 2",
      "",
    ].join("\n");
    const result = parsePLY(asciiToArrayBuffer(ply));
    expect(result).not.toBeNull();
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
    expect(result!.colorWarning).toBeUndefined();
  });

  it("reads RGBA layout (alpha present, no warning)", () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "property uchar alpha",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header",
      "0 0 0 255 0 0 128",
      "1 0 0 0 255 0 128",
      "0 1 0 0 0 255 128",
      "3 0 1 2",
      "",
    ].join("\n");
    const result = parsePLY(asciiToArrayBuffer(ply));
    expect(result).not.toBeNull();
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
    expect(result!.colorWarning).toBeUndefined();
  });

  it("reads packed rgb (0xRRGGBB) from ASCII", () => {
    const packed = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property uint rgb",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header",
      `0 0 0 ${packed(255, 0, 0)}`,
      `1 0 0 ${packed(0, 255, 0)}`,
      `0 1 0 ${packed(0, 0, 255)}`,
      "3 0 1 2",
      "",
    ].join("\n");
    const result = parsePLY(asciiToArrayBuffer(ply));
    expect(result).not.toBeNull();
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
  });

  it("reads packed rgb from binary even when declared as float", () => {
    const header = [
      "ply",
      "format binary_little_endian 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property float rgb",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header\n",
    ].join("\n");
    const headerBytes = new TextEncoder().encode(header);
    const packedVals = [0xff0000, 0x00ff00, 0x0000ff];
    const verts: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const body = new ArrayBuffer(3 * 16 + 13);
    const dv = new DataView(body);
    let off = 0;
    for (let i = 0; i < 3; i++) {
      const [x, y, z] = verts[i]!;
      dv.setFloat32(off, x, true);
      dv.setFloat32(off + 4, y, true);
      dv.setFloat32(off + 8, z, true);
      dv.setUint32(off + 12, packedVals[i]!, true);
      off += 16;
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
    const result = parsePLY(toArrayBuffer(out));
    expect(result).not.toBeNull();
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
  });

  it("reads per-face colors from ASCII when no vertex color exists", () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 4",
      "property float x",
      "property float y",
      "property float z",
      "element face 2",
      "property list uchar int vertex_indices",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header",
      "0 0 0",
      "1 0 0",
      "0 1 0",
      "1 1 0",
      "3 0 1 2 255 0 0",
      "3 1 3 2 0 0 255",
      "",
    ].join("\n");
    const result = parsePLY(asciiToArrayBuffer(ply));
    expect(result).not.toBeNull();
    expect(result!.vertices.length).toBe(18);
    expect(result!.colors!.length).toBe(18);
    // First triangle red, second blue.
    expect(Array.from(result!.colors!.slice(0, 9))).toEqual([
      1, 0, 0, 1, 0, 0, 1, 0, 0,
    ]);
    expect(Array.from(result!.colors!.slice(9))).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
    expect(result!.colorWarning).toBeUndefined();
  });

  it("reads per-face colors from binary when no vertex color exists", () => {
    const header = [
      "ply",
      "format binary_little_endian 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "element face 1",
      "property list uchar int vertex_indices",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header\n",
    ].join("\n");
    const headerBytes = new TextEncoder().encode(header);
    const body = new ArrayBuffer(3 * 12 + 13 + 3);
    const dv = new DataView(body);
    let off = 0;
    for (const [x, y, z] of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ] as Array<[number, number, number]>) {
      dv.setFloat32(off, x, true);
      dv.setFloat32(off + 4, y, true);
      dv.setFloat32(off + 8, z, true);
      off += 12;
    }
    dv.setUint8(off, 3);
    off += 1;
    for (const idx of [0, 1, 2]) {
      dv.setInt32(off, idx, true);
      off += 4;
    }
    dv.setUint8(off, 0);
    dv.setUint8(off + 1, 255);
    dv.setUint8(off + 2, 0);
    const out = new Uint8Array(headerBytes.byteLength + body.byteLength);
    out.set(headerBytes, 0);
    out.set(new Uint8Array(body), headerBytes.byteLength);
    const result = parsePLY(toArrayBuffer(out));
    expect(result).not.toBeNull();
    expect(Array.from(result!.colors!)).toEqual([
      0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
  });
});

describe("parsePLY color warning", () => {
  it("warns when color-like properties exist but cannot be used", () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header",
      "0 0 0 255 0",
      "1 0 0 0 255",
      "0 1 0 0 0",
      "3 0 1 2",
      "",
    ].join("\n");
    const result = parsePLY(asciiToArrayBuffer(ply));
    expect(result).not.toBeNull();
    expect(result!.colors).toBeUndefined();
    expect(result!.colorWarning).toContain("vertex red");
    expect(result!.colorWarning).toContain("vertex green");
  });

  it("does not warn for a PLY with no color-like properties", () => {
    const result = parsePLY(asciiToArrayBuffer(ASCII_NO_COLOR_PLY));
    expect(result).not.toBeNull();
    expect(result!.colorWarning).toBeUndefined();
  });
});
