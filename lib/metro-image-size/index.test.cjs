"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const imageSize = require("./index.cjs");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000030000000208060000009d74661a", "hex");

test("reads dimensions from bytes", () => {
  assert.deepEqual(imageSize(png), { width: 3, height: 2, type: "png" });
});

test("preserves Metro's file-path API", () => {
  const file = path.join(os.tmpdir(), `metro-image-size-${process.pid}.png`);
  fs.writeFileSync(file, png);
  try {
    assert.deepEqual(imageSize(file), { width: 3, height: 2, type: "png" });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("rejects unsupported input without scanning indefinitely", () => {
  assert.throws(() => imageSize(Buffer.alloc(1024)), /unsupported file type/);
});