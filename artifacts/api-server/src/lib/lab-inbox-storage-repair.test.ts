/**
 * Tests: one-time idempotent repair of legacy lab-inbox rows whose
 * storagePath / objectStorageKey hold a full public URL instead of the bare
 * stored filename (repairLabInboxStorageNames in lab-inbox-storage-repair.ts).
 *
 * Proves:
 *  1. URL-shaped values (both /api/cases/attachment-file/ and
 *     /uploads/case-media/ forms) are rewritten to the bare filename.
 *  2. Already-clean rows are left untouched.
 *  3. Non-normalizable values (external URLs, empty basenames) are left
 *     untouched and the row is NEVER deleted (Lab Data Protection).
 *  4. Partial repair: when only one of the two columns normalizes, that
 *     column is fixed and the other is left as-is.
 *  5. The pass is idempotent: a second run performs no writes and leaves
 *     every row byte-identical (including updatedAt).
 *
 * DB rows are real (skipped without DATABASE_URL, same convention as
 * sibling route tests).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("lab-inbox storage repair (one-time backfill)", () => {
  let dbMod: typeof import("@workspace/db");
  let repairMod: typeof import("./lab-inbox-storage-repair.js");

  const userId = rid("urep");
  const labOrgId = rid("labrep");

  async function insertInboxFile(opts: {
    storagePath: string;
    objectStorageKey: string | null;
  }): Promise<string> {
    const { db, labInboxFiles } = dbMod as any;
    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labOrgId,
        uploadedByUserId: userId,
        originalFilename: "legacy-scan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: opts.storagePath,
        objectStorageKey: opts.objectStorageKey,
      })
      .returning();
    return row.id as string;
  }

  async function getRow(id: string) {
    const { db, labInboxFiles } = dbMod as any;
    return db.query.labInboxFiles.findFirst({
      where: eq(labInboxFiles.id, id),
    });
  }

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    repairMod = await import("./lab-inbox-storage-repair.js");

    const { db, users, organizations } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `inbox_repair_${userId}`,
      password: "x",
    });
    await db.insert(organizations).values({
      id: labOrgId,
      type: "lab",
      name: rid("InboxRepairLab"),
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, labInboxFiles, organizations, users } = dbMod as any;
    await db
      .delete(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("repairs URL-shaped rows, skips unrepairable ones, and is idempotent", async () => {
    const bareA = `legacy-${rid("a")}.pdf`;
    const bareB = `legacy-${rid("b")}.jpg`;
    const bareClean = `clean-${rid("c")}.pdf`;
    const bareKeyOnly = `keyonly-${rid("d")}.pdf`;

    // 1. Both columns are attachment-file URLs.
    const idBothUrls = await insertInboxFile({
      storagePath: `https://lab.example.com/api/cases/attachment-file/${bareA}`,
      objectStorageKey: `https://lab.example.com/api/cases/attachment-file/${bareA}`,
    });

    // 2. uploads/case-media URL form, null objectStorageKey.
    const idUploadsUrl = await insertInboxFile({
      storagePath: `https://lab.example.com/uploads/case-media/${bareB}`,
      objectStorageKey: null,
    });

    // 3. Already clean — must not be touched.
    const idClean = await insertInboxFile({
      storagePath: bareClean,
      objectStorageKey: bareClean,
    });

    // 4. External URL with no media marker — cannot be normalized.
    const idExternal = await insertInboxFile({
      storagePath: "https://evil.example.com/some/other/file.pdf",
      objectStorageKey: "https://evil.example.com/some/other/file.pdf",
    });

    // 5. URL that normalizes to an empty filename — cannot be normalized.
    const idEmptyName = await insertInboxFile({
      storagePath: "https://lab.example.com/uploads/case-media/",
      objectStorageKey: null,
    });

    // 6. Partial: storagePath unrepairable, objectStorageKey repairable.
    const idPartial = await insertInboxFile({
      storagePath: "https://evil.example.com/x/y.pdf",
      objectStorageKey: `https://lab.example.com/uploads/case-media/${bareKeyOnly}`,
    });

    const cleanBefore = await getRow(idClean);

    // ── First run ────────────────────────────────────────────────────────
    const first = await repairMod.repairLabInboxStorageNames();
    // At least our 5 dirty rows were scanned (shared dev DB may add more).
    expect(first.scanned).toBeGreaterThanOrEqual(5);
    expect(first.repaired).toBeGreaterThanOrEqual(3);

    const bothUrls = await getRow(idBothUrls);
    expect(bothUrls.storagePath).toBe(bareA);
    expect(bothUrls.objectStorageKey).toBe(bareA);

    const uploadsUrl = await getRow(idUploadsUrl);
    expect(uploadsUrl.storagePath).toBe(bareB);
    expect(uploadsUrl.objectStorageKey).toBeNull();

    // Clean row untouched (updatedAt included).
    const cleanAfter = await getRow(idClean);
    expect(cleanAfter.storagePath).toBe(bareClean);
    expect(cleanAfter.objectStorageKey).toBe(bareClean);
    expect(cleanAfter.updatedAt?.getTime()).toBe(
      cleanBefore.updatedAt?.getTime(),
    );

    // Unrepairable rows: untouched, NOT deleted.
    const external = await getRow(idExternal);
    expect(external).toBeTruthy();
    expect(external.storagePath).toBe(
      "https://evil.example.com/some/other/file.pdf",
    );
    expect(external.objectStorageKey).toBe(
      "https://evil.example.com/some/other/file.pdf",
    );

    const emptyName = await getRow(idEmptyName);
    expect(emptyName).toBeTruthy();
    expect(emptyName.storagePath).toBe(
      "https://lab.example.com/uploads/case-media/",
    );

    // Partial repair: only the repairable column changed.
    const partial = await getRow(idPartial);
    expect(partial.storagePath).toBe("https://evil.example.com/x/y.pdf");
    expect(partial.objectStorageKey).toBe(bareKeyOnly);

    // ── Second run: idempotent ───────────────────────────────────────────
    const rowsAfterFirst = await Promise.all(
      [idBothUrls, idUploadsUrl, idClean, idExternal, idEmptyName, idPartial].map(
        getRow,
      ),
    );

    const second = await repairMod.repairLabInboxStorageNames();

    const rowsAfterSecond = await Promise.all(
      [idBothUrls, idUploadsUrl, idClean, idExternal, idEmptyName, idPartial].map(
        getRow,
      ),
    );

    for (let i = 0; i < rowsAfterFirst.length; i++) {
      expect(rowsAfterSecond[i].storagePath).toBe(rowsAfterFirst[i].storagePath);
      expect(rowsAfterSecond[i].objectStorageKey).toBe(
        rowsAfterFirst[i].objectStorageKey,
      );
      expect(rowsAfterSecond[i].updatedAt?.getTime()).toBe(
        rowsAfterFirst[i].updatedAt?.getTime(),
      );
    }

    // Repaired rows no longer match the dirty predicate; the remaining
    // unrepairable rows are scanned again but produce no writes.
    // (No exact global count assertions — shared dev DB.)
    expect(second.repaired).toBe(0);
  });

  it("normalizeInboxStorageName rejects traversal shapes and empty results", async () => {
    const { normalizeInboxStorageName } = repairMod;
    expect(normalizeInboxStorageName(null)).toBeNull();
    expect(normalizeInboxStorageName("")).toBeNull();
    expect(
      normalizeInboxStorageName("https://evil.example.com/a/b.pdf"),
    ).toBeNull();
    expect(
      normalizeInboxStorageName("https://h/uploads/case-media/"),
    ).toBeNull();
    expect(
      normalizeInboxStorageName("https://h/api/cases/attachment-file/f.pdf"),
    ).toBe("f.pdf");
    expect(normalizeInboxStorageName("bare-file.pdf")).toBe("bare-file.pdf");
  });
});
