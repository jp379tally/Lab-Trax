"use strict";

const fs = require("node:fs");

const types = Object.freeze([
  "bmp",
  "gif",
  "jpg",
  "ktx",
  "png",
  "psd",
  "svg",
  "tiff",
  "webp",
]);
let disabledTypes = new Set();

function ensureAvailable(buffer, offset, length) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new TypeError("invalid or truncated image");
  }
}

function result(type, width, height) {
  if (disabledTypes.has(type)) {
    throw new TypeError(`disabled file type: ${type}`);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`invalid ${type} dimensions`);
  }
  return { width, height, type };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    ensureAvailable(buffer, offset, 2);
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) throw new TypeError("invalid JPEG segment");
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      ensureAvailable(buffer, offset, 7);
      return result("jpg", buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }
    ensureAvailable(buffer, offset, segmentLength);
    offset += segmentLength;
  }
  throw new TypeError("invalid JPEG image");
}

function parseWebp(buffer) {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X") {
    ensureAvailable(buffer, 24, 6);
    return result("webp", 1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
  }
  if (format === "VP8L") {
    ensureAvailable(buffer, 21, 4);
    const bits = buffer.readUInt32LE(21);
    return result("webp", 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  if (format === "VP8 ") {
    ensureAvailable(buffer, 26, 4);
    return result("webp", buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  throw new TypeError("unsupported WebP image");
}

function parseTiff(buffer) {
  if (buffer.length < 8) return null;
  const signature = buffer.toString("ascii", 0, 2);
  if (signature !== "II" && signature !== "MM") return null;
  const littleEndian = signature === "II";
  const readUInt16 = (offset) => {
    ensureAvailable(buffer, offset, 2);
    return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  };
  const readUInt32 = (offset) => {
    ensureAvailable(buffer, offset, 4);
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  };
  if (readUInt16(2) !== 42) return null;
  const directory = readUInt32(4);
  const count = readUInt16(directory);
  let width;
  let height;
  for (let index = 0; index < count && index < 4096; index += 1) {
    const entry = directory + 2 + index * 12;
    ensureAvailable(buffer, entry, 12);
    const tag = readUInt16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const fieldType = readUInt16(entry + 2);
    const value = fieldType === 3 ? readUInt16(entry + 8) : readUInt32(entry + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
    if (width && height) return result("tiff", width, height);
  }
  throw new TypeError("invalid TIFF image");
}

function parseSvg(buffer) {
  const sample = buffer.toString("utf8", 0, Math.min(buffer.length, 64 * 1024));
  if (!/<svg(?:\s|>)/i.test(sample)) return null;
  const widthMatch = sample.match(/\bwidth=["']\s*([0-9.]+)/i);
  const heightMatch = sample.match(/\bheight=["']\s*([0-9.]+)/i);
  if (widthMatch && heightMatch) {
    return result("svg", Math.round(Number(widthMatch[1])), Math.round(Number(heightMatch[1])));
  }
  const viewBox = sample.match(/\bviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)/i);
  if (viewBox) return result("svg", Math.round(Number(viewBox[1])), Math.round(Number(viewBox[2])));
  throw new TypeError("SVG image has no dimensions");
}

function imageSize(input) {
  const buffer = typeof input === "string" ? fs.readFileSync(input) : Buffer.from(input);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return result("png", buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
    return result("gif", buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
    return result("bmp", buffer.readUInt32LE(18), Math.abs(buffer.readInt32LE(22)));
  }
  if (buffer.length >= 26 && buffer.toString("ascii", 0, 4) === "8BPS") {
    return result("psd", buffer.readUInt32BE(18), buffer.readUInt32BE(14));
  }
  if (buffer.length >= 44 && buffer.subarray(0, 12).equals(Buffer.from("ab4b5458203131bb0d0a1a0a", "hex"))) {
    return result("ktx", buffer.readUInt32LE(36), buffer.readUInt32LE(40));
  }
  const parsed = parseJpeg(buffer) || parseWebp(buffer) || parseTiff(buffer) || parseSvg(buffer);
  if (parsed) return parsed;
  throw new TypeError("unsupported file type");
}

function disableTypes(nextDisabledTypes) {
  disabledTypes = new Set(nextDisabledTypes);
}

module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
module.exports.disableTypes = disableTypes;
module.exports.types = types;