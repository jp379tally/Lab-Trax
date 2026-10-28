import { describe, it, expect } from "vitest";
import {
  arrayBufferToBase64,
  PARSERS_AND_HELPERS_JS,
  buildThumbnailHtml,
  buildViewerHtml,
} from "./index";

// The parsers live inside a JS template string so they can be inlined into the
// viewer/thumbnail HTML docs. Evaluate that string here to get callable
// functions for unit testing. They only rely on globals that exist in Node
// (atob, TextDecoder, DataView, typed arrays); window-touching helpers
// (postMsg/postError) are defined but never invoked by the parser path.
const factory = new Function(
  `${PARSERS_AND_HELPERS_JS}\nreturn { parsePLY: parsePLY, parseScanBuffer: parseScanBuffer, scanFallbackStatus: scanFallbackStatus };`,
);
const { parsePLY, parseScanBuffer, scanFallbackStatus } = factory() as {
  parsePLY: (buf: ArrayBuffer) => {
    vertices: Float32Array;
    normals: Float32Array;
    colors?: Float32Array;
    uvs?: Float32Array;
    colorWarning?: string;
    textureDeclared?: boolean;
    textureFileName?: string;
  } | null;
  parseScanBuffer: (
    buf: ArrayBuffer,
    format: string,
  ) => { vertices: Float32Array; colors?: Float32Array; uvs?: Float32Array } | null;
  scanFallbackStatus: (
    parsed: { textureDeclared?: boolean; textureFileName?: string },
    hasColor: boolean,
    reason: "missing" | "unmapped" | "unreadable" | "none" | null,
  ) => string | null;
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

const ASCII_TEXTURE_PLY = [
  "ply",
  "format ascii 1.0",
  "comment TextureFile dental-texture.jpg",
  "element vertex 3",
  "property float x",
  "property float y",
  "property float z",
  "element face 1",
  "property list uchar int vertex_indices",
  "property list uchar float texcoord",
  "end_header",
  "0 0 0",
  "1 0 0",
  "0 1 0",
  "3 0 1 2 6 0 0 1 0 0 1",
  "",
].join("\n");

const ASCII_TEXTURED_COLOR_PLY = [
  "ply",
  "format ascii 1.0",
  "comment TextureFile synthetic-texture.jpg",
  "element vertex 3",
  "property float x",
  "property float y",
  "property float z",
  "property uchar red",
  "property uchar green",
  "property uchar blue",
  "element face 1",
  "property list uchar int vertex_indices",
  "property list uchar float texcoord",
  "end_header",
  "0 0 0 220 190 170",
  "1 0 0 205 175 155",
  "0 1 0 235 210 190",
  "3 0 1 2 6 0 0 1 0 0 1",
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

function buildSyntheticInterleavedColorPly(): ArrayBuffer {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    "comment synthetic test geometry",
    "element vertex 3",
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "property float nx",
    "property float ny",
    "property float nz",
    "element face 1",
    "property int object",
    "property list uchar int vertex_indices",
    "end_header\n",
  ].join("\n");
  const headerBytes = new TextEncoder().encode(header);
  const vertices: Array<[number, number, number, number, number, number]> = [
    [0, 0, 0, 255, 0, 0],
    [1, 0, 0, 0, 255, 0],
    [0, 1, 0, 0, 0, 255],
  ];
  const body = new ArrayBuffer(3 * 27 + 17);
  const view = new DataView(body);
  let offset = 0;

  for (const [x, y, z, red, green, blue] of vertices) {
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    view.setUint8(offset + 12, red);
    view.setUint8(offset + 13, green);
    view.setUint8(offset + 14, blue);
    view.setFloat32(offset + 15, 0, true);
    view.setFloat32(offset + 19, 0, true);
    view.setFloat32(offset + 23, 1, true);
    offset += 27;
  }

  // The object scalar precedes the face's vertex-index list in this layout.
  view.setInt32(offset, 7, true);
  offset += 4;
  view.setUint8(offset, 3);
  offset += 1;
  for (const index of [0, 1, 2]) {
    view.setInt32(offset, index, true);
    offset += 4;
  }

  const output = new Uint8Array(headerBytes.byteLength + body.byteLength);
  output.set(headerBytes, 0);
  output.set(new Uint8Array(body), headerBytes.byteLength);
  return toArrayBuffer(output);
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

describe("parsePLY texture declaration and fallback status", () => {
  it("retains one safe TextureFile name and usable UV coordinates", () => {
    const parsed = parsePLY(asciiToArrayBuffer(ASCII_TEXTURE_PLY));
    expect(parsed).not.toBeNull();
    expect(parsed!.textureDeclared).toBe(true);
    expect(parsed!.textureFileName).toBe("dental-texture.jpg");
    expect(parsed!.uvs).toBeInstanceOf(Float32Array);
    expect(parsed!.colors).toBeUndefined();
  });

  it("preserves vertex colors alongside a declared texture and UVs", () => {
    const parsed = parsePLY(asciiToArrayBuffer(ASCII_TEXTURED_COLOR_PLY));
    expect(parsed?.textureFileName).toBe("synthetic-texture.jpg");
    expect(parsed?.uvs).toBeInstanceOf(Float32Array);
    const expectedColors = [
      220 / 255, 190 / 255, 170 / 255,
      205 / 255, 175 / 255, 155 / 255,
      235 / 255, 210 / 255, 190 / 255,
    ];
    Array.from(parsed!.colors!).forEach((value, index) => {
      expect(value).toBeCloseTo(expectedColors[index]!, 6);
    });
    expect(
      scanFallbackStatus(parsed!, true, "missing"),
    ).toBe(
      'Declared texture "synthetic-texture.jpg" is unavailable; using vertex colors.',
    );
    const viewer = buildViewerHtml(
      arrayBufferToBase64(asciiToArrayBuffer(ASCII_TEXTURED_COLOR_PLY)),
      "ply",
      { base64: "aGVsbG8=", mimeType: "image/jpeg" },
    );
    expect(viewer).toContain("vertexColors:true");
    expect(viewer).toContain("map:tex");
  });

  it("does not retain unsafe or ambiguous texture declarations", () => {
    const unsafe = ASCII_TEXTURE_PLY.replace(
      "dental-texture.jpg",
      "../private.jpg",
    );
    expect(parsePLY(asciiToArrayBuffer(unsafe))?.textureFileName).toBeUndefined();

    const repeated = ASCII_TEXTURE_PLY.replace(
      "comment TextureFile dental-texture.jpg",
      "comment TextureFile dental-texture.jpg\ncomment TextureFile second.jpg",
    );
    expect(parsePLY(asciiToArrayBuffer(repeated))?.textureFileName).toBeUndefined();
  });

  it("distinguishes an unavailable declared texture from absent mesh colors", () => {
    const coloredViewer = buildViewerHtml("cGx5", "ply");
    const colorlessViewer = buildViewerHtml("cGx5", "ply");
    expect(coloredViewer).toContain("Declared texture");
    expect(colorlessViewer).toContain("No mesh color data; showing neutral mesh.");
    expect(coloredViewer).toContain('id="notice" role="status" aria-live="polite"');
    expect(
      scanFallbackStatus(
        { textureDeclared: true, textureFileName: "dental-texture.jpg" },
        true,
        "missing",
      ),
    ).toBe('Declared texture "dental-texture.jpg" is unavailable; using vertex colors.');
    expect(
      scanFallbackStatus({ textureDeclared: true }, false, "missing"),
    ).toBe(
      "Declared texture is unavailable; using neutral mesh; no mesh color data is present.",
    );
    expect(scanFallbackStatus({}, false, "none")).toBe(
      "No mesh color data; showing neutral mesh.",
    );
    expect(scanFallbackStatus({}, true, "unreadable")).toBe(
      "Texture could not be loaded; using vertex colors.",
    );
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

describe("synthetic interleaved-color PLY layout", () => {
  it("parses vertex colors with no colorWarning via parseScanBuffer", () => {
    const result = parseScanBuffer(buildSyntheticInterleavedColorPly(), "ply") as {
      vertices: Float32Array;
      normals: Float32Array;
      colors?: Float32Array;
      colorWarning?: string;
    } | null;
    expect(result).not.toBeNull();
    expect(result!.colorWarning).toBeUndefined();

    // One synthetic triangle with xyz, interleaved RGB, and vertex normals.
    expect(result!.vertices.length).toBe(9);
    expect(result!.normals.length).toBe(result!.vertices.length);

    expect(result!.colors).toBeInstanceOf(Float32Array);
    expect(result!.colors!.length).toBe(result!.vertices.length);
    expect(Array.from(result!.colors!)).toEqual(EXPECTED_COLORS);
    let min = Infinity;
    let max = -Infinity;
    for (const c of result!.colors!) {
      if (c < min) min = c;
      if (c > max) max = c;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(max - min).toBeGreaterThan(0.1);
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

const ASCII_UV_PLY = [
  "ply",
  "format ascii 1.0",
  "element vertex 4",
  "property float x",
  "property float y",
  "property float z",
  "element face 1",
  "property uchar quality",
  "property list uchar int vertex_indices",
  "property list uchar float texcoord",
  "end_header",
  "0 0 0",
  "1 0 0",
  "1 1 0",
  "0 1 0",
  // A quad deliberately exercises fan triangulation and UV lockstep.
  "7 4 0 1 2 3 8 0 0 1 0 1 1 0 1",
  "",
].join("\n");

function buildBinaryUvPly(): ArrayBuffer {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    "element vertex 4",
    "property float x",
    "property float y",
    "property float z",
    "element face 1",
    "property uchar quality",
    "property list uchar int vertex_indices",
    "property list uchar float texcoord",
    "end_header\n",
  ].join("\n");
  const hb = new TextEncoder().encode(header);
  const body = new ArrayBuffer(4 * 12 + 1 + 1 + 4 * 4 + 1 + 8 * 4);
  const dv = new DataView(body);
  let off = 0;
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    dv.setFloat32(off, x, true); dv.setFloat32(off + 4, y, true);
    dv.setFloat32(off + 8, 0, true); off += 12;
  }
  dv.setUint8(off++, 7);
  dv.setUint8(off++, 4);
  for (const i of [0, 1, 2, 3]) { dv.setInt32(off, i, true); off += 4; }
  dv.setUint8(off++, 8);
  for (const value of [0, 0, 1, 0, 1, 1, 0, 1]) {
    dv.setFloat32(off, value, true); off += 4;
  }
  const out = new Uint8Array(hb.length + body.byteLength);
  out.set(hb); out.set(new Uint8Array(body), hb.length);
  return toArrayBuffer(out);
}

describe("PLY face-corner texture coordinates", () => {
  it("reads declared-order ASCII UVs and triangulates a quad in lockstep", () => {
    const result = parsePLY(asciiToArrayBuffer(ASCII_UV_PLY)) as {
      vertices: Float32Array; uvs?: Float32Array;
    };
    expect(result.vertices.length).toBe(18);
    // Texture V is flipped for three.js: [0,0],[1,0],[1,1] then [0,0],[1,1],[0,1].
    expect(Array.from(result.uvs!)).toEqual([
      0, 1, 1, 1, 1, 0,
      0, 1, 1, 0, 0, 0,
    ]);
  });

  it("reads binary UVs after a scalar and index list in declaration order", () => {
    const result = parsePLY(buildBinaryUvPly()) as { vertices: Float32Array; uvs?: Float32Array };
    expect(result.vertices.length).toBe(18);
    expect(result.uvs).toBeInstanceOf(Float32Array);
    expect(Array.from(result.uvs!)).toEqual([
      0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
    ]);
  });

  it("keeps geometry but omits UVs when a face UV list is malformed", () => {
    const malformed = ASCII_UV_PLY.replace(
      "7 4 0 1 2 3 8 0 0 1 0 1 1 0 1",
      "7 4 0 1 2 3 8 0 0 1 0",
    );
    const result = parsePLY(asciiToArrayBuffer(malformed)) as {
      vertices: Float32Array; uvs?: Float32Array;
    };
    expect(result.vertices.length).toBe(18);
    expect(result.uvs).toBeUndefined();
  });
});

describe("textured viewer HTML safety and material setup", () => {
  it("embeds validated data URI texture setup in both renderers", () => {
    const texture = { base64: "aGVsbG8=", mimeType: "image/png" };
    const viewer = buildViewerHtml("cGx5", "ply", texture);
    const thumb = buildThumbnailHtml("cGx5", "ply", {}, texture);
    for (const html of [viewer, thumb]) {
      expect(html).toContain("TextureLoader");
      expect(html).toContain("data:image/png;base64,aGVsbG8=");
      expect(html).toContain("SRGBColorSpace");
      expect(html).toContain("TEXTURE_URI=\"data:image/png;base64,aGVsbG8=\"");
      expect(html).toContain("AmbientLight(0xffffff,0.8)");
      expect(html).toContain("DirectionalLight(0xffffff,0.15)");
      expect(html).toContain("DirectionalLight(0x88aaff,0.05)");
      expect(html).toContain("shininess:10");
      expect(html).toContain("specular:0x222222");
    }
  });

  it("uses readable, low-glare lights and materials for the neutral formats", () => {
    for (const html of [
      buildViewerHtml("c3Rs", "stl"),
      buildViewerHtml("b2Jq", "obj"),
      buildViewerHtml("cGx5", "ply"),
      buildThumbnailHtml("c3Rs", "stl"),
      buildThumbnailHtml("b2Jq", "obj"),
      buildThumbnailHtml("cGx5", "ply"),
    ]) {
      expect(html).toContain("AmbientLight(0xffffff,0.8)");
      expect(html).toContain("color:0xe2e8f0,specular:0x222222,shininess:15");
    }
  });

  it("rejects arbitrary texture URLs and unsafe MIME types", () => {
    const html = buildViewerHtml("cGx5", "ply", {
      base64: "https://evil.example/texture.png",
      mimeType: "text/html",
    });
    expect(html).toContain("TEXTURE_URI=null");
    expect(html).not.toContain("https://evil.example");
  });
});
