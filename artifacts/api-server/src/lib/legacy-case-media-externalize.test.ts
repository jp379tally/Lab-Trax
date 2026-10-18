/**
 * Unit coverage for the inline-media externalization core (no DB, no storage).
 *
 * These are the pure pieces the migration and the legacy write path both rely
 * on: recognizing an inline payload, naming its file deterministically,
 * rewriting the blob as a pure substitution, and proving that rewrite before
 * anything destructive happens.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  checkRewriteParity,
  collectInlineMediaDataUris,
  externalizeInlineMedia,
  legacyMediaFileName,
  legacyMediaReferenceUrl,
  parseInlineMediaDataUri,
  replaceStringsDeep,
  textContainsInlineMedia,
  type LegacyMediaFileWriter,
} from "./legacy-case-media-externalize";

function dataUri(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const PHOTO_A = Buffer.from("pretend-jpeg-bytes-A".repeat(10), "utf8");
const PHOTO_B = Buffer.from("pretend-png-bytes-B".repeat(10), "utf8");

/** In-memory writer so the pure tests never touch disk or App Storage. */
function memoryWriter(overrides: Partial<LegacyMediaFileWriter> = {}): {
  writer: LegacyMediaFileWriter;
  stored: Map<string, Buffer>;
} {
  const stored = new Map<string, Buffer>();
  const writer: LegacyMediaFileWriter = {
    async write({ fileName, bytes }) {
      stored.set(fileName, Buffer.from(bytes));
      return { disk: true, objectStorage: true };
    },
    async verify({ fileName, bytes }) {
      const got = stored.get(fileName);
      return !!got && got.equals(bytes);
    },
    ...overrides,
  };
  return { writer, stored };
}

describe("parseInlineMediaDataUri", () => {
  it("decodes a base64 image payload", () => {
    const parsed = parseInlineMediaDataUri(dataUri("image/jpeg", PHOTO_A));
    expect(parsed?.mimeType).toBe("image/jpeg");
    expect(parsed?.bytes.equals(PHOTO_A)).toBe(true);
  });

  it("decodes base64 video payloads too", () => {
    const parsed = parseInlineMediaDataUri(dataUri("video/mp4", PHOTO_B));
    expect(parsed?.mimeType).toBe("video/mp4");
    expect(parsed?.bytes.equals(PHOTO_B)).toBe(true);
  });

  it("ignores values it does not fully understand", () => {
    // Non-base64 data URIs, non-media types, ordinary URLs and local file
    // URIs all stay exactly as they are — this migration only touches
    // payloads it can decode and re-encode losslessly.
    expect(parseInlineMediaDataUri("data:image/svg+xml,<svg/>")).toBeNull();
    expect(parseInlineMediaDataUri("data:text/plain;base64,aGk=")).toBeNull();
    expect(
      parseInlineMediaDataUri("https://lab-trax.example/uploads/case-media/a.jpg"),
    ).toBeNull();
    expect(parseInlineMediaDataUri("file:///var/mobile/photo.jpg")).toBeNull();
    expect(parseInlineMediaDataUri(null)).toBeNull();
    expect(parseInlineMediaDataUri(42)).toBeNull();
  });

  it("rejects a payload that does not round-trip", () => {
    // Base64 decoding is lenient and silently drops junk; a payload we cannot
    // re-encode to the same string would produce a file that is NOT the
    // original bytes, so it must not be externalized.
    expect(parseInlineMediaDataUri("data:image/jpeg;base64,!!!!not-base64")).toBeNull();
    expect(parseInlineMediaDataUri("data:image/jpeg;base64,")).toBeNull();
  });

  it("tolerates whitespace inside the payload", () => {
    const wrapped = `data:image/png;base64,${PHOTO_B.toString("base64").replace(
      /(.{20})/g,
      "$1\n",
    )}`;
    expect(parseInlineMediaDataUri(wrapped)?.bytes.equals(PHOTO_B)).toBe(true);
  });
});

describe("legacyMediaFileName", () => {
  const media = parseInlineMediaDataUri(dataUri("image/jpeg", PHOTO_A))!;

  it("is stable for the same case and bytes", () => {
    expect(legacyMediaFileName("case-1", media)).toBe(
      legacyMediaFileName("case-1", media),
    );
  });

  it("scopes names per case so identical bytes never collide in the ledger", () => {
    expect(legacyMediaFileName("case-1", media)).not.toBe(
      legacyMediaFileName("case-2", media),
    );
  });

  it("maps the mime type to a sane extension", () => {
    expect(legacyMediaFileName("c", media).endsWith(".jpg")).toBe(true);
    const png = parseInlineMediaDataUri(dataUri("image/png", PHOTO_B))!;
    expect(legacyMediaFileName("c", png).endsWith(".png")).toBe(true);
    const heic = parseInlineMediaDataUri(dataUri("image/heic", PHOTO_B))!;
    expect(legacyMediaFileName("c", heic).endsWith(".heic")).toBe(true);
  });

  it("produces a plain basename the serving route will accept", () => {
    const name = legacyMediaFileName("weird/../case id", media);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain("/");
  });

  it("builds the relative reference the media helpers already recognize", () => {
    expect(legacyMediaReferenceUrl("abc.jpg")).toBe(
      "/api/cases/attachment-file/abc.jpg",
    );
  });
});

describe("collectInlineMediaDataUris", () => {
  it("finds payloads anywhere in the blob, de-duplicated", () => {
    const photo = dataUri("image/jpeg", PHOTO_A);
    const other = dataUri("image/png", PHOTO_B);
    const blob = {
      photos: [photo, "https://example.test/uploads/case-media/x.jpg"],
      videos: [],
      activityLog: [
        { type: "photo", imageUri: photo, timestamp: 1 },
        { type: "note", description: "no media" },
      ],
      nested: { deep: [{ stashed: other }] },
    };
    const found = collectInlineMediaDataUris(blob);
    expect(found.size).toBe(2);
    expect(found.has(photo)).toBe(true);
    expect(found.has(other)).toBe(true);
  });

  it("returns nothing for a blob with no inline media", () => {
    expect(
      collectInlineMediaDataUris({
        photos: ["/api/cases/attachment-file/a.jpg"],
        activityLog: [{ imageUri: "file:///var/mobile/p.jpg" }],
      }).size,
    ).toBe(0);
  });
});

describe("replaceStringsDeep", () => {
  it("swaps exact values and preserves structure and key order", () => {
    const blob = { a: "x", b: ["x", "y"], c: { d: "x", e: 1, f: null } };
    const out = replaceStringsDeep(blob, new Map([["x", "X"]]));
    expect(out).toEqual({ a: "X", b: ["X", "y"], c: { d: "X", e: 1, f: null } });
    expect(Object.keys(out.c)).toEqual(["d", "e", "f"]);
  });

  it("leaves unmapped values untouched", () => {
    const blob = { a: "keep" };
    expect(replaceStringsDeep(blob, new Map([["other", "X"]]))).toEqual(blob);
  });
});

describe("externalizeInlineMedia", () => {
  it("stores each payload once and returns the substitution map", async () => {
    const photo = dataUri("image/jpeg", PHOTO_A);
    const { writer, stored } = memoryWriter();
    const result = await externalizeInlineMedia({
      labCaseId: "case-1",
      dataUris: [photo, photo],
      writer,
    });
    expect(result.failures).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(stored.size).toBe(1);
    const [file] = result.files;
    expect(result.replacements.get(photo)).toBe(legacyMediaReferenceUrl(file!.fileName));
    expect(createHash("sha256").update(stored.get(file!.fileName)!).digest("hex")).toBe(
      createHash("sha256").update(PHOTO_A).digest("hex"),
    );
  });

  it("reports a failure instead of mapping when the file cannot be read back", async () => {
    const photo = dataUri("image/jpeg", PHOTO_A);
    const { writer } = memoryWriter({ verify: async () => false });
    const result = await externalizeInlineMedia({
      labCaseId: "case-1",
      dataUris: [photo],
      writer,
    });
    // Unmapped means the caller keeps the original base64 — never a data loss.
    expect(result.replacements.size).toBe(0);
    expect(result.failures[0]?.reason).toMatch(/read back/i);
  });

  it("reports a failure when the write itself throws", async () => {
    const photo = dataUri("image/jpeg", PHOTO_A);
    const { writer } = memoryWriter({
      write: async () => {
        throw new Error("storage down");
      },
    });
    const result = await externalizeInlineMedia({
      labCaseId: "case-1",
      dataUris: [photo],
      writer,
    });
    expect(result.replacements.size).toBe(0);
    expect(result.failures[0]?.reason).toBe("storage down");
  });
});

describe("checkRewriteParity", () => {
  const photo = dataUri("image/jpeg", PHOTO_A);
  const url = "/api/cases/attachment-file/legacy-a-b-media.jpg";
  const original = {
    id: "c1",
    photos: [photo, "https://host.test/uploads/case-media/kept.jpg"],
    activityLog: [{ type: "photo", imageUri: photo, timestamp: 5 }],
  };
  const originalCaseData = JSON.stringify(original);
  const replacements = new Map([[photo, url]]);

  it("accepts a pure substitution", () => {
    const rewritten = replaceStringsDeep(original, replacements);
    expect(checkRewriteParity({ originalCaseData, rewritten, replacements })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it("rejects a rewrite that changed anything else", () => {
    const rewritten: any = replaceStringsDeep(original, replacements);
    rewritten.activityLog[0].timestamp = 6;
    const result = checkRewriteParity({ originalCaseData, rewritten, replacements });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/pure substitution/);
  });

  it("rejects a rewrite that dropped a photo entirely", () => {
    const rewritten: any = replaceStringsDeep(original, replacements);
    rewritten.photos = [rewritten.photos[1]];
    const result = checkRewriteParity({ originalCaseData, rewritten, replacements });
    expect(result.ok).toBe(false);
  });

  it("rejects a rewrite that still carries inline media", () => {
    // Nothing substituted: the blob would stay bloated and be reprocessed
    // forever, so completeness is asserted separately from reversibility.
    const result = checkRewriteParity({
      originalCaseData,
      rewritten: original,
      replacements: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /still contains inline base64/.test(f))).toBe(true);
  });

  it("rejects a rewrite that lost an already-externalized reference", () => {
    const rewritten: any = replaceStringsDeep(original, replacements);
    rewritten.photos = [rewritten.photos[0]];
    const result = checkRewriteParity({ originalCaseData, rewritten, replacements });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /pre-existing media reference lost/.test(f))).toBe(
      true,
    );
  });
});

describe("textContainsInlineMedia", () => {
  it("matches the migration's candidate predicate", () => {
    expect(textContainsInlineMedia(JSON.stringify({ p: dataUri("image/jpeg", PHOTO_A) }))).toBe(
      true,
    );
    expect(
      textContainsInlineMedia(JSON.stringify({ p: "/api/cases/attachment-file/a.jpg" })),
    ).toBe(false);
  });
});
