/**
 * Integration coverage for shrinking legacy case blobs (Task #4395).
 *
 * Legacy mobile cases live as one JSON blob per case in `lab_cases.case_data`,
 * and early mobile builds embedded each photo in it as base64 — 35 MB of JSON
 * for 41 cases, the largest single row 10 MB. Every read of the row pays for
 * it: case detail, mobile sync, the nightly backup ZIP, and every restore.
 *
 * These tests assert the two halves of the fix against a real database:
 *
 *   WRITE GUARD — POST /legacy/cases externalizes an inline photo to
 *   case-media storage, stores a reference instead, binds the ledger, and the
 *   photo is still served and still visible through the mobile read path.
 *
 *   MIGRATION — the batched sweep is a dry-runnable, resumable, parity-checked
 *   move of what is already stored: originals backed up and read back before
 *   any blob changes, files verified before the ledger binds, and a case that
 *   changed underneath the run left alone for the next one.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import request from "supertest";

const { mockCaseMediaObjects } = vi.hoisted(() => ({
  mockCaseMediaObjects: {
    available: false,
    files: new Map<string, Uint8Array>(),
  },
}));

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});
vi.mock("../lib/case-media-object-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media-object-storage.js")>();
  const { Readable } = await import("node:stream");
  return {
    ...actual,
    caseMediaObjectStorageAvailable: () => mockCaseMediaObjects.available,
    writeCaseMediaToObjectStorage: async (
      fileName: string,
      bytes: Buffer,
      _contentType: string,
    ) => {
      if (!mockCaseMediaObjects.available) return false;
      mockCaseMediaObjects.files.set(fileName, Uint8Array.from(bytes));
      return true;
    },
    openCaseMediaObjectStream: async (
      fileName: string,
      contentType = "application/octet-stream",
    ) => {
      const bytes = mockCaseMediaObjects.files.get(fileName);
      if (!mockCaseMediaObjects.available || !bytes) return null;
      return { stream: Readable.from([Buffer.from(bytes)]), contentType };
    },
  };
});

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function legacyId() {
  return `${Date.now()}${randomBytes(5).toString("hex")}`;
}

function sha(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

maybe("legacy case media externalization", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let lib: typeof import("../lib/legacy-case-media-externalize.js");
  let caseMediaMod: typeof import("../lib/case-media.js");

  const ownerUserId = rid("umedia");
  const orgId = rid("orgmedia");
  let ownerToken = "";

  /** Case ids created by this file, cleaned up at the end. */
  const createdCaseIds: string[] = [];
  /** Files written to uploads/case-media by this file, cleaned up at the end. */
  const writtenFileNames = new Set<string>();

  /**
   * In-memory media writer + backup store. Keeps the suite off App Storage
   * and off the shared media directory while still exercising the real
   * write -> verify -> parity -> backup -> bind -> rewrite ordering.
   */
  const storedFiles = new Map<string, Buffer>();
  const storedBackups = new Map<string, string>();
  const memoryWriter: import("../lib/legacy-case-media-externalize.js").LegacyMediaFileWriter =
    {
      async write({ fileName, bytes }) {
        storedFiles.set(fileName, Buffer.from(bytes));
        return { disk: true, objectStorage: true };
      },
      async verify({ fileName, bytes }) {
        const got = storedFiles.get(fileName);
        return !!got && got.equals(bytes);
      },
    };
  const memoryBackupStore: import("../lib/legacy-case-data-backup.js").LegacyCaseDataBackupStore =
    {
      async write(runId, caseId, caseData) {
        storedBackups.set(`${runId}/${caseId}`, caseData);
        return {
          location: "object-storage",
          key: `memory://${runId}/${caseId}`,
          bytes: Buffer.byteLength(caseData, "utf8"),
        };
      },
      async read(runId, caseId) {
        return storedBackups.get(`${runId}/${caseId}`) ?? null;
      },
    };

  function photoDataUri(seed: string, mime = "image/jpeg") {
    const bytes = Buffer.from(`jpeg-bytes-${seed}-`.repeat(64), "utf8");
    return { bytes, uri: `data:${mime};base64,${bytes.toString("base64")}` };
  }

  async function insertLegacyCase(caseData: unknown): Promise<string> {
    const { db, labCases } = dbMod as any;
    const id = legacyId();
    await db.insert(labCases).values({
      id,
      ownerId: ownerUserId,
      organizationId: orgId,
      caseData: JSON.stringify(caseData),
    });
    createdCaseIds.push(id);
    return id;
  }

  async function readCaseData(id: string): Promise<string> {
    const { db, labCases } = dbMod as any;
    const [row] = await db
      .select({ caseData: labCases.caseData })
      .from(labCases)
      .where(eq(labCases.id, id));
    return row?.caseData ?? "";
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-media-externalize";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    lib = await import("../lib/legacy-case-media-externalize.js");
    caseMediaMod = await import("../lib/case-media.js");

    const { db, users, organizations, organizationMemberships, userSessions } =
      dbMod as any;
    await db.insert(users).values({
      id: ownerUserId,
      username: `own_${ownerUserId}`,
      password: "x",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: `Media Lab ${orgId}`,
      type: "lab",
    });
    await db.insert(organizationMemberships).values({
      id: rid("member"),
      labId: orgId,
      userId: ownerUserId,
      role: "lab_admin",
      status: "active",
    });

    const sessionId = rid("sess");
    ownerToken = auth.signAccessToken(ownerUserId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId: ownerUserId,
      tokenHash: createHash("sha256").update(ownerToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN || !dbMod) return;
    const {
      db,
      labCases,
      legacyCaseMedia,
      users,
      organizations,
      organizationMemberships,
      userSessions,
    } = dbMod as any;
    if (createdCaseIds.length) {
      await db.delete(legacyCaseMedia).where(inArray(legacyCaseMedia.labCaseId, createdCaseIds));
      await db.delete(labCases).where(inArray(labCases.id, createdCaseIds));
    }
    await db.delete(userSessions).where(eq(userSessions.userId, ownerUserId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.labId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerUserId));
    for (const fileName of writtenFileNames) {
      await fsp
        .rm(path.resolve(caseMediaMod.caseMediaDir, fileName), { force: true })
        .catch(() => {});
    }
  });

  // ── Write guard ─────────────────────────────────────────────────────────

  it("never persists an inline photo sent to POST /legacy/cases", async () => {
    const photo = photoDataUri("write-guard");
    const id = legacyId();
    createdCaseIds.push(id);

    const res = await (async () => {
      mockCaseMediaObjects.available = true;
      try {
        return await request(appMod.default)
          .post("/api/legacy/cases")
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({
            id,
            ownerId: ownerUserId,
            caseData: JSON.stringify({
              id,
              ownerId: ownerUserId,
              caseNumber: "WG-1",
              affiliationKey: `org:${orgId}`,
              photos: [photo.uri],
              activityLog: [
                {
                  id: "log-1",
                  type: "photo",
                  description: "Photo added",
                  imageUri: photo.uri,
                  timestamp: Date.now(),
                },
              ],
            }),
          });
      } finally {
        mockCaseMediaObjects.available = false;
        mockCaseMediaObjects.files.clear();
      }
    })();
    expect(res.status).toBe(200);

    const stored = await readCaseData(id);
    expect(stored).not.toContain(";base64,");
    const parsed = JSON.parse(stored);

    // The photo is now a case-media reference, and the SAME reference is used
    // in photos[] and in the activityLog entry — the desktop resolves a
    // photo's "added" date by matching those two strings, so they must agree.
    const ref = parsed.photos[0] as string;
    expect(ref).toMatch(/^\/api\/cases\/attachment-file\//);
    expect(parsed.activityLog[0].imageUri).toBe(ref);

    // One file, holding exactly the original bytes.
    const fileNames = caseMediaMod.extractMediaFilenamesFromText(stored);
    expect(fileNames).toHaveLength(1);
    const fileName = fileNames[0]!;
    writtenFileNames.add(fileName);
    const onDisk = await fsp.readFile(path.resolve(caseMediaMod.caseMediaDir, fileName));
    expect(sha(onDisk)).toBe(sha(photo.bytes));

    // Bound in the ledger, which is what authorizes the serving route.
    const { db, legacyCaseMedia } = dbMod as any;
    const [binding] = await db
      .select()
      .from(legacyCaseMedia)
      .where(eq(legacyCaseMedia.fileName, fileName));
    expect(binding?.labCaseId).toBe(id);
    expect(binding?.organizationId).toBe(orgId);

    // And the photo is still visible: the mobile read path returns the
    // reference, and the file serves to a member of the case's lab.
    const detail = await request(appMod.default)
      .get(`/api/legacy/cases/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.case.photos[0]).toBe(ref);

    const served = await request(appMod.default)
      .get(`/api/cases/attachment-file/${fileName}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(served.status).toBe(200);
    expect(sha(served.body as Buffer)).toBe(sha(photo.bytes));
  });

  it("re-syncing the same photo does not append a second copy", async () => {
    const photo = photoDataUri("resync");
    const id = legacyId();
    createdCaseIds.push(id);
    const body = {
      id,
      ownerId: ownerUserId,
      caseData: JSON.stringify({
        id,
        ownerId: ownerUserId,
        caseNumber: "WG-2",
        affiliationKey: `org:${orgId}`,
        photos: [photo.uri],
        activityLog: [],
      }),
    };

    for (let i = 0; i < 2; i++) {
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send(body);
      expect(res.status).toBe(200);
    }

    const parsed = JSON.parse(await readCaseData(id));
    // Content-addressed naming means the second sync maps to the same
    // reference string, so the append-only media union dedupes it.
    expect(parsed.photos).toHaveLength(1);
    for (const f of caseMediaMod.extractMediaFilenamesFromText(JSON.stringify(parsed))) {
      writtenFileNames.add(f);
    }
  });

  it("keeps a photo inline when there is no durable place to put it", async () => {
    // Local disk is per-instance and wiped by the next redeploy, so a
    // reference to a disk-only file 404s on another instance and is gone
    // after a deploy. POST /media/upload already refuses disk-only storage;
    // removing the base64 in that situation would be silent data loss.
    const photo = photoDataUri("no-durable-store");
    const spy = vi
      .spyOn(lib.defaultLegacyMediaFileWriter, "write")
      .mockResolvedValue({ disk: true, objectStorage: false });
    try {
      const id = legacyId();
      createdCaseIds.push(id);
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          id,
          ownerId: ownerUserId,
          caseData: JSON.stringify({
            id,
            ownerId: ownerUserId,
            caseNumber: "WG-4",
            affiliationKey: `org:${orgId}`,
            photos: [photo.uri],
          }),
        });
      expect(res.status).toBe(200);
      expect(JSON.parse(await readCaseData(id)).photos[0]).toBe(photo.uri);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a photo inline when its media file cannot be authorized", async () => {
    // The serving route authorizes a legacy media file from the ledger and
    // nothing else, so a blob that references a file it could not bind shows
    // a broken photo. Simulate the conflict by binding the deterministic
    // filename to a different case first.
    const photo = photoDataUri("bind-conflict");
    const id = legacyId();
    createdCaseIds.push(id);
    const squatterCaseId = legacyId();
    createdCaseIds.push(squatterCaseId);
    const fileName = lib.legacyMediaFileName(id, {
      mimeType: "image/jpeg",
      bytes: photo.bytes,
    });
    writtenFileNames.add(fileName);

    const { db, legacyCaseMedia } = dbMod as any;
    await db.insert(legacyCaseMedia).values({
      fileName,
      labCaseId: squatterCaseId,
      organizationId: orgId,
      ownerId: ownerUserId,
    });

    const res = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        id,
        ownerId: ownerUserId,
        caseData: JSON.stringify({
          id,
          ownerId: ownerUserId,
          caseNumber: "WG-5",
          affiliationKey: `org:${orgId}`,
          photos: [photo.uri],
        }),
      });

    // The sync still succeeds — it carries more than this one photo — and the
    // photo is still there, in the only form that can currently be served.
    expect(res.status).toBe(200);
    expect(JSON.parse(await readCaseData(id)).photos[0]).toBe(photo.uri);

    // The other case's binding was not repointed.
    const [binding] = await db
      .select()
      .from(legacyCaseMedia)
      .where(eq(legacyCaseMedia.fileName, fileName));
    expect(binding?.labCaseId).toBe(squatterCaseId);
  });

  it("keeps a photo inline rather than losing it when storage fails", async () => {
    // A whole-blob offline sync must not fail (blocking every other edit it
    // carries) or silently drop a photo because media storage misbehaved.
    const photo = photoDataUri("storage-down");
    const spy = vi
      .spyOn(lib.defaultLegacyMediaFileWriter, "write")
      .mockRejectedValue(new Error("storage down"));
    try {
      const id = legacyId();
      createdCaseIds.push(id);
      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          id,
          ownerId: ownerUserId,
          caseData: JSON.stringify({
            id,
            ownerId: ownerUserId,
            caseNumber: "WG-3",
            affiliationKey: `org:${orgId}`,
            photos: [photo.uri],
          }),
        });
      expect(res.status).toBe(200);
      const parsed = JSON.parse(await readCaseData(id));
      expect(parsed.photos[0]).toBe(photo.uri);
    } finally {
      spy.mockRestore();
    }
  });

  // ── Migration ───────────────────────────────────────────────────────────

  /**
   * ALWAYS scope a migration run to the ids the test created.
   *
   * The unscoped sweep is deliberately greedy — in production it should find
   * every case still holding base64. Against a shared test database that is
   * catastrophic: an unscoped live run rewrites other suites' (and real
   * restored) case blobs to point at files this test only ever kept in
   * memory, destroying photos it does not own. Every call below goes through
   * this helper; none may call the migration directly.
   */
  async function runScoped(
    caseIds: string[],
    options: Partial<
      import("../lib/legacy-case-media-externalize.js").LegacyCaseMediaMigrationOptions
    > = {},
  ) {
    const report = await lib.runLegacyCaseMediaMigration({
      limit: 200,
      writer: memoryWriter,
      backupStore: memoryBackupStore,
      ...options,
      caseIds,
    });
    // Fail loudly rather than quietly damaging data if the scope is ever
    // widened: a run that reaches a row this file did not create has
    // rewritten someone else's blob to point at an in-memory file.
    const foreign = report.cases.filter((c) => !createdCaseIds.includes(c.caseId));
    if (foreign.length > 0) {
      throw new Error(
        `migration escaped its scope and touched ${foreign.length} foreign case(s): ` +
          foreign.map((c) => c.caseId).join(", "),
      );
    }
    return report;
  }

  it("dry run verifies the rewrite without changing any blob", async () => {
    const photo = photoDataUri("dry-run");
    const id = await insertLegacyCase({
      id: "seed",
      photos: [photo.uri, "https://old.host.test/uploads/case-media/kept.jpg"],
      activityLog: [{ type: "photo", imageUri: photo.uri, timestamp: 1 }],
    });
    const before = await readCaseData(id);

    const report = await runScoped([id], { dryRun: true });

    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("would-migrate");
    expect(entry?.inlineMediaFound).toBe(1);
    expect(entry!.afterBytes).toBeLessThan(entry!.beforeBytes);
    expect(report.migratedCases).toBe(0);
    expect(await readCaseData(id)).toBe(before);
  });

  it("moves embedded photos out, verifiably and reversibly", async () => {
    const photo = photoDataUri("live-run");
    const second = photoDataUri("live-run-2", "image/png");
    const id = await insertLegacyCase({
      id: "seed",
      caseNumber: "MIG-1",
      photos: [photo.uri, "https://old.host.test/uploads/case-media/kept.jpg"],
      videos: [],
      activityLog: [
        { id: "l1", type: "photo", imageUri: photo.uri, timestamp: 11 },
        { id: "l2", type: "photo", imageUri: second.uri, timestamp: 12 },
      ],
    });
    const original = await readCaseData(id);
    const runId = rid("run");

    const report = await runScoped([id], { dryRun: false, runId });

    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("migrated");
    expect(entry?.inlineMediaFound).toBe(2);
    expect(entry?.fileNames).toHaveLength(2);
    expect(entry!.afterBytes).toBeLessThan(entry!.beforeBytes);

    const after = await readCaseData(id);
    expect(after).not.toContain(";base64,");

    // The rewrite is a pure substitution: mapping the references back to the
    // original data URIs reproduces the original blob byte for byte.
    const parsedAfter = JSON.parse(after);
    const reverse = new Map<string, string>();
    for (const fileName of entry!.fileNames) {
      const bytes = storedFiles.get(fileName)!;
      const mime = fileName.endsWith(".png") ? "image/png" : "image/jpeg";
      reverse.set(
        lib.legacyMediaReferenceUrl(fileName),
        `data:${mime};base64,${bytes.toString("base64")}`,
      );
    }
    expect(JSON.stringify(lib.replaceStringsDeep(parsedAfter, reverse))).toBe(original);

    // Every photo still resolves: the pre-existing URL reference survived,
    // and each new file holds the exact original bytes.
    expect(parsedAfter.photos[1]).toBe("https://old.host.test/uploads/case-media/kept.jpg");
    expect(parsedAfter.activityLog[0].imageUri).toBe(parsedAfter.photos[0]);
    const firstFile = caseMediaMod.extractMediaFileName(parsedAfter.photos[0]);
    expect(sha(storedFiles.get(firstFile!)!)).toBe(sha(photo.bytes));

    // Ledger rows exist so the serving route can authorize the files.
    const { db, legacyCaseMedia } = dbMod as any;
    const bindings = await db
      .select()
      .from(legacyCaseMedia)
      .where(inArray(legacyCaseMedia.fileName, entry!.fileNames));
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b: any) => b.labCaseId === id)).toBe(true);

    // The original blob is recoverable from the backup taken during the run.
    expect(await memoryBackupStore.read(runId, id)).toBe(original);
  });

  it("is resumable: a migrated case is no longer a candidate", async () => {
    const photo = photoDataUri("resumable");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });

    const first = await runScoped([id], { dryRun: false });
    expect(first.cases.find((c) => c.caseId === id)?.status).toBe("migrated");

    const second = await runScoped([id], { dryRun: false });
    expect(second.cases.find((c) => c.caseId === id)).toBeUndefined();
  });

  it("honours the per-run limit so a large sweep can be done in batches", async () => {
    const a = await insertLegacyCase({ id: "a", photos: [photoDataUri("batch-a").uri] });
    const b = await insertLegacyCase({ id: "b", photos: [photoDataUri("batch-b").uri] });

    const first = await runScoped([a, b], { dryRun: false, limit: 1, batchSize: 1 });
    expect(first.scannedCases).toBe(1);

    const rest = await runScoped([a, b], { dryRun: false });
    for (const id of [a, b]) {
      expect(await readCaseData(id)).not.toContain(";base64,");
    }
    expect(first.migratedCases + rest.migratedCases).toBeGreaterThanOrEqual(2);
  });

  it("leaves a case alone when a concurrent sync changed it mid-run", async () => {
    const photo = photoDataUri("concurrent");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const { db, labCases } = dbMod as any;

    const report = await runScoped([id], {
      dryRun: false,
      // Simulate a mobile sync landing between the read and the guarded
      // rewrite. The rewrite must not clobber it.
      onBeforeCaseUpdate: async (caseId: string) => {
        if (caseId !== id) return;
        await db
          .update(labCases)
          .set({ caseData: JSON.stringify({ id: "seed", photos: [photo.uri], note: "newer" }) })
          .where(eq(labCases.id, id));
      },
    });

    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("skipped");
    expect(entry?.reason).toMatch(/modified concurrently/);
    expect(JSON.parse(await readCaseData(id)).note).toBe("newer");

    // Still a candidate, so the next run picks it up.
    const retry = await runScoped([id], { dryRun: false });
    expect(retry.cases.find((c) => c.caseId === id)?.status).toBe("migrated");
    expect(await readCaseData(id)).not.toContain(";base64,");
  });

  it("refuses to rewrite a blob whose backup did not read back", async () => {
    const photo = photoDataUri("bad-backup");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const before = await readCaseData(id);

    const report = await runScoped([id], {
      dryRun: false,
      backupStore: {
        write: async (runId, caseId, caseData) =>
          memoryBackupStore.write(runId, caseId, caseData),
        read: async () => "corrupted",
      },
    });
    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("failed");
    expect(entry?.reason).toMatch(/backup did not read back/);
    expect(await readCaseData(id)).toBe(before);
  });

  it("refuses to rewrite a blob whose backup only reached ephemeral disk", async () => {
    const photo = photoDataUri("disk-backup");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const before = await readCaseData(id);

    const diskOnlyStore = {
      write: async (runId: string, caseId: string, caseData: string) => {
        storedBackups.set(`${runId}/${caseId}`, caseData);
        return { location: "disk" as const, key: `/tmp/${caseId}.json`, bytes: 1 };
      },
      read: async (runId: string, caseId: string) =>
        storedBackups.get(`${runId}/${caseId}`) ?? null,
    };

    const blocked = await runScoped([id], { dryRun: false, backupStore: diskOnlyStore });
    expect(blocked.cases.find((c) => c.caseId === id)?.reason).toMatch(/ephemeral local disk/);
    expect(await readCaseData(id)).toBe(before);

    // The operator can still opt in explicitly (self-hosted, no App Storage).
    const allowed = await runScoped([id], {
      dryRun: false,
      requireDurableBackup: false,
      backupStore: diskOnlyStore,
    });
    expect(allowed.cases.find((c) => c.caseId === id)?.status).toBe("migrated");
  });

  it("does not rewrite a blob it cannot reproduce exactly", async () => {
    // A blob whose stored text differs from its own re-serialization (odd
    // spacing, duplicate keys) cannot be parity-checked as a pure
    // substitution, so it is reported and left untouched rather than
    // silently reformatted.
    const { db, labCases } = dbMod as any;
    const photo = photoDataUri("not-canonical");
    const id = legacyId();
    createdCaseIds.push(id);
    await db.insert(labCases).values({
      id,
      ownerId: ownerUserId,
      organizationId: orgId,
      caseData: `{ "photos": ["${photo.uri}"] }`,
    });
    const before = await readCaseData(id);

    const report = await runScoped([id], { dryRun: false });
    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("skipped");
    expect(entry?.reason).toMatch(/round-trip/);
    expect(await readCaseData(id)).toBe(before);

    // Clean up so it stops showing as a candidate for sibling suites.

    await db.delete(labCases).where(eq(labCases.id, id));
  });

  it("will not rewrite a blob when the photos have no durable home", async () => {
    const photo = photoDataUri("mig-no-durable-store");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const before = await readCaseData(id);

    const diskOnlyWriter = {
      write: async ({ fileName, bytes }: { fileName: string; bytes: Buffer }) => {
        storedFiles.set(fileName, Buffer.from(bytes));
        return { disk: true, objectStorage: false };
      },
      verify: memoryWriter.verify,
    };

    const blocked = await runScoped([id], { dryRun: false, writer: diskOnlyWriter });
    const entry = blocked.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("failed");
    expect(entry?.reason).toMatch(/durable media storage unavailable/);
    expect(await readCaseData(id)).toBe(before);

    // Same operator override as the backup: a self-hosted install with no
    // App Storage can accept local-disk media explicitly.
    const allowed = await runScoped([id], {
      dryRun: false,
      requireDurableBackup: false,
      writer: diskOnlyWriter,
    });
    expect(allowed.cases.find((c) => c.caseId === id)?.status).toBe("migrated");
  });

  it("will not rewrite a blob whose media cannot be bound to it", async () => {
    // A reference the serving route refuses to authorize is a lost photo, so
    // the binding and the rewrite have to commit together or not at all.
    const photo = photoDataUri("mig-bind-conflict");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const before = await readCaseData(id);
    const squatterCaseId = legacyId();
    createdCaseIds.push(squatterCaseId);
    const fileName = lib.legacyMediaFileName(id, {
      mimeType: "image/jpeg",
      bytes: photo.bytes,
    });

    const { db, legacyCaseMedia } = dbMod as any;
    await db.insert(legacyCaseMedia).values({
      fileName,
      labCaseId: squatterCaseId,
      organizationId: orgId,
      ownerId: ownerUserId,
    });

    const report = await runScoped([id], { dryRun: false });
    const entry = report.cases.find((c) => c.caseId === id);
    expect(entry?.status).toBe("failed");
    expect(entry?.reason).toMatch(/binding failed/);
    expect(await readCaseData(id)).toBe(before);

    await db.delete(legacyCaseMedia).where(eq(legacyCaseMedia.fileName, fileName));
  });

  it("authorizes migrated media against the lab the case belongs to now", async () => {
    // A stale binding would keep authorizing the file for a lab the case has
    // since left, so the run re-points its own bindings at the locked row's
    // tenant instead of trusting whatever was written earlier.
    const photo = photoDataUri("mig-tenant-move");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const fileName = lib.legacyMediaFileName(id, {
      mimeType: "image/jpeg",
      bytes: photo.bytes,
    });
    const formerOrgId = rid("orgformer");

    const { db, legacyCaseMedia } = dbMod as any;
    await db.insert(legacyCaseMedia).values({
      fileName,
      labCaseId: id,
      organizationId: formerOrgId,
      ownerId: ownerUserId,
    });

    const report = await runScoped([id], { dryRun: false });
    expect(report.cases.find((c) => c.caseId === id)?.status).toBe("migrated");

    const [binding] = await db
      .select()
      .from(legacyCaseMedia)
      .where(eq(legacyCaseMedia.fileName, fileName));
    expect(binding?.labCaseId).toBe(id);
    expect(binding?.organizationId).toBe(orgId);
  });

  it("restores a migrated case to the exact blob it had before the run", async () => {
    // The documented undo. The backup object is an envelope, so this is the
    // one procedure that must be exercised end to end: whatever the runbook
    // tells an operator to do has to put the ORIGINAL blob back, byte for
    // byte, not the envelope that wraps it.
    const photo = photoDataUri("restore-round-trip");
    const id = await insertLegacyCase({
      id: "seed",
      caseNumber: "RESTORE-1",
      photos: [photo.uri, "https://old.host.test/uploads/case-media/kept.jpg"],
      activityLog: [{ id: "l1", type: "photo", imageUri: photo.uri, timestamp: 7 }],
    });
    const original = await readCaseData(id);
    const runId = rid("restorerun");

    const migrated = await runScoped([id], { dryRun: false, runId });
    expect(migrated.cases.find((c) => c.caseId === id)?.status).toBe("migrated");
    const rewritten = await readCaseData(id);
    expect(rewritten).not.toBe(original);
    expect(rewritten).not.toContain(";base64,");

    // Dry run reports the restore without touching the column.
    const preview = await lib.restoreLegacyCaseDataFromBackup({
      runId,
      caseIds: [id],
      backupStore: memoryBackupStore,
    });
    expect(preview.cases[0]?.status).toBe("would-restore");
    expect(preview.restoredCases).toBe(0);
    expect(await readCaseData(id)).toBe(rewritten);

    const restore = await lib.restoreLegacyCaseDataFromBackup({
      runId,
      caseIds: [id],
      dryRun: false,
      backupStore: memoryBackupStore,
    });
    expect(restore.cases[0]?.status).toBe("restored");
    expect(restore.restoredCases).toBe(1);
    expect(await readCaseData(id)).toBe(original);

    // Restoring twice is a no-op, and the case can simply be migrated again —
    // to exactly the same references, because the filenames are content-addressed.
    const again = await lib.restoreLegacyCaseDataFromBackup({
      runId,
      caseIds: [id],
      dryRun: false,
      backupStore: memoryBackupStore,
    });
    expect(again.cases[0]?.status).toBe("already-original");

    const remigrated = await runScoped([id], { dryRun: false });
    expect(remigrated.cases.find((c) => c.caseId === id)?.status).toBe("migrated");
    expect(await readCaseData(id)).toBe(rewritten);
  });

  it("reports nothing to restore when the run never backed the case up", async () => {
    const photo = photoDataUri("restore-missing-backup");
    const id = await insertLegacyCase({ id: "seed", photos: [photo.uri] });
    const before = await readCaseData(id);

    const report = await lib.restoreLegacyCaseDataFromBackup({
      runId: rid("neverran"),
      caseIds: [id],
      dryRun: false,
      backupStore: memoryBackupStore,
    });

    expect(report.cases[0]?.status).toBe("backup-not-found");
    expect(report.restoredCases).toBe(0);
    expect(await readCaseData(id)).toBe(before);
  });

  it("reports remaining bloat for the admin status endpoint", async () => {
    const status = await lib.getLegacyCaseMediaMigrationStatus();
    expect(typeof status.remainingCases).toBe("number");
    expect(typeof status.remainingBytes).toBe("number");
    expect(status.remainingBytes).toBeGreaterThanOrEqual(0);
  });
});
