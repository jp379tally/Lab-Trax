/**
 * Regression tests for repeated lab-logo upload → replace → serve.
 *
 * The lab logo "worked once, then never again" in production. Part of the fix
 * is guaranteeing the storage round-trip is correct on *every* upload, not just
 * the first:
 *   - replacing the logo with the same format overwrites the stored bytes
 *   - replacing with a different format deletes the old extension so exactly
 *     one logo object remains (otherwise openLabLogoStream — which probes png
 *     first — would keep serving the stale image forever)
 *   - the served bytes + content type always match the most recent upload
 *
 * The @google-cloud/storage client is mocked with a deterministic in-memory
 * object store, so the test needs no provisioned bucket and runs everywhere.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

// In-memory object store shared by the mock. Keyed by "<bucket>/<object>".
const store = new Map<
  string,
  { buf: Buffer; contentType: string; updated: string; generation: string; md5Hash: string; crc32c: string }
>();
let generation = 0;
let streamFailure = false;

vi.mock("@google-cloud/storage", () => {
  class CRC32C {
    private value = 0xffffffff;
    update(bytes: Buffer) {
      for (const byte of bytes) {
        this.value ^= byte;
        for (let index = 0; index < 8; index++) {
          this.value = (this.value >>> 1) ^ (this.value & 1 ? 0x82f63b78 : 0);
        }
      }
    }
    toString() {
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE((~this.value) >>> 0);
      return checksum.toString("base64");
    }
  }
  class FakeFile {
    constructor(
      private bucketName: string,
      private objectName: string,
      private pinnedGeneration?: string,
    ) {}
    get name() { return this.objectName; }
    get bucket(): FakeBucket { return new FakeBucket(this.bucketName); }
    private key() {
      return `${this.bucketName}/${this.objectName}`;
    }
    async save(buffer: Buffer, opts?: {
      contentType?: string;
      metadata?: { contentType?: string };
      validation?: string;
      preconditionOpts?: { ifGenerationMatch?: string | number };
    }) {
      const previous = store.get(this.key());
      if (opts?.preconditionOpts?.ifGenerationMatch !== undefined &&
          String(opts.preconditionOpts.ifGenerationMatch) !== String(previous?.generation ?? 0)) {
        throw Object.assign(new Error("Precondition failed"), { code: 412 });
      }
      if (opts?.validation !== "crc32c") throw new Error("Synthetic upload must validate its CRC32C.");
      const crc = new CRC32C();
      crc.update(buffer);
      store.set(this.key(), {
        buf: Buffer.from(buffer),
        contentType: opts?.metadata?.contentType ?? opts?.contentType ?? "application/octet-stream",
        updated: new Date().toISOString(),
        generation: String(++generation),
        md5Hash: createHash("md5").update(buffer).digest("base64"),
        crc32c: crc.toString(),
      });
    }
    async exists() {
      const e = store.get(this.key());
      return [!!e && (!this.pinnedGeneration || e.generation === this.pinnedGeneration)] as [boolean];
    }
    async getMetadata() {
      const e = store.get(this.key());
      if (!e || (this.pinnedGeneration && e.generation !== this.pinnedGeneration)) {
        throw Object.assign(new Error("Not found"), { code: 404 });
      }
      return [
        {
          size: e.buf.length,
          contentType: e.contentType,
          updated: e.updated,
          timeCreated: e.updated,
          generation: e.generation,
          md5Hash: e.md5Hash,
          crc32c: e.crc32c,
        },
      ];
    }
    async copy(target: FakeFile, opts?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
      const original = store.get(this.key());
      if (!original || (this.pinnedGeneration && original.generation !== this.pinnedGeneration)) {
        throw Object.assign(new Error("Not found"), { code: 404 });
      }
      if (opts?.preconditionOpts?.ifGenerationMatch === 0 && store.has(target.key())) {
        throw Object.assign(new Error("Precondition failed"), { code: 412 });
      }
      store.set(target.key(), {
        ...original,
        buf: Buffer.from(original.buf),
        generation: String(++generation),
      });
      return [target];
    }
    async delete(opts?: { ifGenerationMatch?: string | number }) {
      const previous = store.get(this.key());
      if (opts?.ifGenerationMatch !== undefined &&
          String(opts.ifGenerationMatch) !== String(previous?.generation)) {
        throw Object.assign(new Error("Precondition failed"), { code: 412 });
      }
      store.delete(this.key());
    }
    createReadStream() {
      if (streamFailure) {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => stream.destroy(new Error("storage read failed")));
        return stream;
      }
      const e = store.get(this.key());
      return Readable.from(e ? [e.buf] : []);
    }
  }
  class FakeBucket {
    constructor(private name: string) {}
    file(objectName: string, options?: { generation?: string }) {
      return new FakeFile(this.name, objectName, options?.generation);
    }
  }
  class Storage {
    bucket(name: string) {
      return new FakeBucket(name);
    }
  }
  return { Storage, CRC32C };
});

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("lab-logo-storage upload/replace/serve round-trip", () => {
  let mod: typeof import("./lab-logo-storage.js");
  const orgId = "org-logo-test";

  beforeAll(async () => {
    process.env["PRIVATE_OBJECT_DIR"] = "test-bucket/private";
    mod = await import("./lab-logo-storage.js");
  });

  afterEach(() => {
    store.clear();
    streamFailure = false;
  });

  it("serves the bytes of the first upload", async () => {
    const png = Buffer.from("first-png-bytes");
    const crc = new (await import("@google-cloud/storage")).CRC32C();
    crc.update(Buffer.from("123456789"));
    expect(crc.toString()).toBe("4waSgw==");
    await mod.uploadLabLogo(orgId, png, "image/png");

    const stream = await mod.openLabLogoStream(orgId);
    expect(stream).not.toBeNull();
    expect(stream!.contentType).toBe("image/png");
    expect((await drain(stream!.stream)).equals(png)).toBe(true);
  });

  it("overwrites the stored bytes when replacing with the same format", async () => {
    await mod.uploadLabLogo(orgId, Buffer.from("old-png"), "image/png");
    const next = Buffer.from("new-png-replacement");
    await mod.uploadLabLogo(orgId, next, "image/png");

    const stream = await mod.openLabLogoStream(orgId);
    expect(stream!.contentType).toBe("image/png");
    // Served bytes match the *latest* upload, never the stale one.
    expect((await drain(stream!.stream)).equals(next)).toBe(true);
  });

  it("deletes the old extension when the format changes (no stale logo)", async () => {
    // openLabLogoStream probes png before jpg, so if the png were NOT deleted
    // on a format change it would keep serving the stale png forever. Asserting
    // we get the jpeg bytes back proves the old png object was removed.
    await mod.uploadLabLogo(orgId, Buffer.from("stale-png"), "image/png");
    const jpg = Buffer.from("fresh-jpeg-bytes");
    await mod.uploadLabLogo(orgId, jpg, "image/jpeg");

    const stream = await mod.openLabLogoStream(orgId);
    expect(stream!.contentType).toBe("image/jpeg");
    expect((await drain(stream!.stream)).equals(jpg)).toBe(true);
    // Exactly one logo object remains for this org.
    const remaining = [...store.keys()].filter((k) =>
      k.includes(`/lab-logos/${orgId}.`),
    );
    expect(remaining).toHaveLength(1);
  });

  it("survives many sequential replacements (works every time, not once)", async () => {
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.from(`logo-revision-${i}`);
      const mime = i % 2 === 0 ? "image/png" : "image/webp";
      const meta = await mod.uploadLabLogo(orgId, bytes, mime);
      expect(meta.size).toBe(bytes.length);

      const stream = await mod.openLabLogoStream(orgId);
      expect(stream!.contentType).toBe(mime);
      expect((await drain(stream!.stream)).equals(bytes)).toBe(true);

      const remaining = [...store.keys()].filter((k) =>
        k.includes(`/lab-logos/${orgId}.`),
      );
      expect(remaining).toHaveLength(1);
    }
  });

  it("returns null when no logo has been uploaded", async () => {
    expect(await mod.openLabLogoStream("org-with-no-logo")).toBeNull();
  });

  it("reads logo bytes and MIME type for self-contained email attachments", async () => {
    const png = Buffer.from("email-logo-bytes");
    await mod.uploadLabLogo(orgId, png, "image/png");

    const asset = await mod.readLabLogoAsset(orgId);
    expect(asset?.contentType).toBe("image/png");
    expect(asset?.content.equals(png)).toBe(true);
  });

  it("returns null when the stored logo cannot be read", async () => {
    await mod.uploadLabLogo(orgId, Buffer.from("unreadable"), "image/png");
    streamFailure = true;

    await expect(mod.readLabLogoAsset(orgId)).resolves.toBeNull();
  });
});
