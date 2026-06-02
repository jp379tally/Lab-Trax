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
import { Readable } from "node:stream";

// In-memory object store shared by the mock. Keyed by "<bucket>/<object>".
const store = new Map<
  string,
  { buf: Buffer; contentType: string; updated: string }
>();

vi.mock("@google-cloud/storage", () => {
  class FakeFile {
    constructor(
      private bucketName: string,
      private objectName: string,
    ) {}
    private key() {
      return `${this.bucketName}/${this.objectName}`;
    }
    async save(buffer: Buffer, opts?: { contentType?: string }) {
      store.set(this.key(), {
        buf: Buffer.from(buffer),
        contentType: opts?.contentType ?? "application/octet-stream",
        updated: new Date().toISOString(),
      });
    }
    async exists() {
      return [store.has(this.key())] as [boolean];
    }
    async getMetadata() {
      const e = store.get(this.key());
      return [
        {
          size: e ? e.buf.length : 0,
          contentType: e?.contentType,
          updated: e?.updated,
          timeCreated: e?.updated,
        },
      ];
    }
    async delete() {
      store.delete(this.key());
    }
    createReadStream() {
      const e = store.get(this.key());
      return Readable.from(e ? [e.buf] : []);
    }
  }
  class FakeBucket {
    constructor(private name: string) {}
    file(objectName: string) {
      return new FakeFile(this.name, objectName);
    }
  }
  class Storage {
    bucket(name: string) {
      return new FakeBucket(name);
    }
  }
  return { Storage };
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
  });

  it("serves the bytes of the first upload", async () => {
    const png = Buffer.from("first-png-bytes");
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
});
