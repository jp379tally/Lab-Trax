import { writeProductionUpload } from "./production-media-local-write";
/**
 * Move base64 photos OUT of legacy case blobs and into case-media storage.
 *
 * Legacy mobile cases are one JSON blob per case in `lab_cases.case_data`.
 * Early mobile builds embedded each captured photo directly in that blob as a
 * `data:image/jpeg;base64,...` string — both in `photos[]` and in the matching
 * `activityLog[].imageUri`. The blob is read and copied in full by case
 * detail, mobile sync, the nightly backup ZIP, and every restore, so a single
 * 10 MB photo is paid for over and over.
 *
 * Photos already have a proper home: a file in `uploads/case-media` (mirrored
 * to App Storage) plus a `legacy_case_media` ledger row that authorizes
 * serving it. This module does two things:
 *
 *   1. WRITE GUARD — `externalizeInlineMediaForWrite` runs on the legacy
 *      mobile sync endpoint so a newly written blob never embeds base64 again.
 *   2. MIGRATION — `runLegacyCaseMediaMigration` moves what is already stored,
 *      batched, resumable, and parity-checked per case, with the original blob
 *      backed up durably before it is rewritten.
 *
 * Both share the same externalization core, so a migrated blob and a freshly
 * synced blob reference a photo identically.
 *
 * FILE NAMING is deterministic: `legacy-<case hash>-<content hash>-media.<ext>`.
 * That matters more than it looks:
 *   - the same photo appearing in both `photos[]` and `activityLog[].imageUri`
 *     collapses to ONE file and ONE reference string, which keeps the desktop's
 *     "when was this added" lookup (activityLog imageUri -> timestamp) working;
 *   - re-running the migration, or re-syncing the same case from a stale
 *     offline client, produces the same name — so no duplicate files, no
 *     duplicate `photos[]` entries through `unionMediaList`, and the whole
 *     operation is idempotent;
 *   - the case hash scopes names per case, so two cases that happen to hold
 *     identical bytes never collide in the first-writer-wins ledger.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import {
  bindLegacyCaseMediaStrict,
  caseMediaDir,
  extractMediaFilenamesFromText,
} from "./case-media";
import {
  caseMediaObjectStorageAvailable,
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "./case-media-object-storage";
import {
  defaultLegacyCaseDataBackupStore,
  type LegacyCaseDataBackupLocation,
  type LegacyCaseDataBackupStore,
} from "./legacy-case-data-backup";

// ── Inline data-URI recognition ────────────────────────────────────────────

/**
 * Only base64 image/video payloads are externalized. Everything else that
 * happens to start with `data:` (tiny SVG icons declared as `data:image/svg+xml`
 * without base64, `data:text/...`, etc.) is left exactly as it is — this
 * migration must never alter a value it does not fully understand.
 */
const INLINE_MEDIA_RE = /^data:(image\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** Cheap pre-filter for "does this text contain an inline media payload at all". */
export function textContainsInlineMedia(text: string): boolean {
  return /data:(?:image|video)\/[a-z0-9.+-]+;base64,/i.test(text ?? "");
}

export interface ParsedInlineMedia {
  mimeType: string;
  bytes: Buffer;
}

/** Decode a `data:<mime>;base64,<payload>` string, or null if it isn't one. */
export function parseInlineMediaDataUri(value: unknown): ParsedInlineMedia | null {
  if (typeof value !== "string" || value.length < 32) return null;
  const m = INLINE_MEDIA_RE.exec(value);
  if (!m) return null;
  const mimeType = m[1]!.toLowerCase();
  const payload = m[2]!.replace(/\s+/g, "");
  if (!payload) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  // Reject a payload that does not round-trip: base64 decoding is lenient and
  // silently drops invalid characters, so a corrupt string would otherwise be
  // "externalized" into a file that is not the original data.
  if (bytes.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) {
    return null;
  }
  return { mimeType, bytes };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/mpeg": "mpeg",
};

function extensionFor(mimeType: string): string {
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) return known;
  const subtype = mimeType.split("/")[1] ?? "";
  const cleaned = subtype.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return cleaned || "bin";
}

/**
 * Deterministic case-media filename for an inline payload. Same case + same
 * bytes always yields the same name; different cases never share one.
 */
export function legacyMediaFileName(
  labCaseId: string,
  media: ParsedInlineMedia,
): string {
  const caseHash = createHash("sha256").update(labCaseId).digest("hex").slice(0, 10);
  const contentHash = createHash("sha256").update(media.bytes).digest("hex").slice(0, 32);
  return `legacy-${caseHash}-${contentHash}-media.${extensionFor(media.mimeType)}`;
}

/**
 * The reference written into the blob in place of the base64 payload.
 *
 * Deliberately RELATIVE: the absolute URLs older uploads stored
 * (`https://<host-of-the-day>/uploads/case-media/...`) go stale whenever the
 * domain changes, and both clients resolve a relative `/api/...` path against
 * their configured API origin and attach the bearer token to it. The form is
 * also exactly what `extractMediaFilenamesFromText` looks for, so ledger
 * binding and orphan-cleanup protection pick these files up with no change.
 */
export function legacyMediaReferenceUrl(fileName: string): string {
  return `/api/cases/attachment-file/${fileName}`;
}

// ── Deep JSON walk ─────────────────────────────────────────────────────────

/**
 * Every distinct inline media string anywhere in the parsed blob. A whole-tree
 * walk rather than a `photos`/`activityLog` lookup on purpose: the blob is
 * client-authored and has accumulated shapes over the years, and a payload
 * left behind in some forgotten key would keep the row bloated.
 */
export function collectInlineMediaDataUris(node: unknown, out = new Set<string>()): Set<string> {
  if (typeof node === "string") {
    if (INLINE_MEDIA_RE.test(node)) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectInlineMediaDataUris(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectInlineMediaDataUris(value, out);
    }
  }
  return out;
}

/**
 * Structural clone with exact string values swapped through `replacements`.
 * Key order is preserved, which is what lets the parity check compare the
 * reverse-mapped result against the original with `JSON.stringify`.
 */
export function replaceStringsDeep<T>(node: T, replacements: Map<string, string>): T {
  if (typeof node === "string") {
    const mapped = replacements.get(node);
    return (mapped === undefined ? node : mapped) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((item) => replaceStringsDeep(item, replacements)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = replaceStringsDeep(value, replacements);
    }
    return out as unknown as T;
  }
  return node;
}

// ── Media file writer ──────────────────────────────────────────────────────

export interface LegacyMediaWriteResult {
  /** Written to `uploads/case-media` (served directly, included in the nightly ZIP). */
  disk: boolean;
  /** Mirrored to App Storage (survives an autoscale redeploy wiping local disk). */
  objectStorage: boolean;
}

export interface LegacyMediaFileWriter {
  write(args: {
    fileName: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<LegacyMediaWriteResult>;
  /** Read the stored file back and confirm it is byte-identical. */
  verify(args: { fileName: string; bytes: Buffer }): Promise<boolean>;
}

function resolveInMediaDir(fileName: string): string {
  const resolved = path.resolve(caseMediaDir, fileName);
  if (resolved === caseMediaDir || !resolved.startsWith(caseMediaDir + path.sep)) {
    throw new Error(`Refusing to write outside the case-media directory: ${fileName}`);
  }
  return resolved;
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  }
  return Buffer.concat(chunks);
}

/**
 * Writes to local disk AND (when provisioned) App Storage — the same two
 * places `POST /media/upload` puts an uploaded photo, so a migrated photo is
 * indistinguishable from an uploaded one to every serving path.
 */
export const defaultLegacyMediaFileWriter: LegacyMediaFileWriter = {
  async write({ fileName, bytes, contentType }) {
    const target = resolveInMediaDir(fileName);
    await fsp.mkdir(caseMediaDir, { recursive: true });
    await writeProductionUpload(target, bytes, "legacy-media");
    let objectStorage = false;
    if (caseMediaObjectStorageAvailable()) {
      objectStorage = await writeCaseMediaToObjectStorage(fileName, bytes, contentType);
    }
    return { disk: true, objectStorage };
  },

  async verify({ fileName, bytes }) {
    const expected = createHash("sha256").update(bytes).digest("hex");
    let diskOk = false;
    try {
      const onDisk = await fsp.readFile(resolveInMediaDir(fileName));
      diskOk = createHash("sha256").update(onDisk).digest("hex") === expected;
    } catch {
      diskOk = false;
    }
    if (!caseMediaObjectStorageAvailable()) return diskOk;
    // App Storage is the durable copy; it must match too when configured.
    try {
      const opened = await openCaseMediaObjectStream(fileName);
      if (!opened) return false;
      const stored = await readStreamToBuffer(opened.stream);
      return diskOk && createHash("sha256").update(stored).digest("hex") === expected;
    } catch {
      return false;
    }
  },
};

// ── Externalization core ───────────────────────────────────────────────────

export interface ExternalizedMediaFile {
  fileName: string;
  mimeType: string;
  bytes: number;
  write: LegacyMediaWriteResult;
}

export interface ExternalizeInlineMediaResult {
  /** data-URI -> `/api/cases/attachment-file/<name>` for everything stored successfully. */
  replacements: Map<string, string>;
  files: ExternalizedMediaFile[];
  /** Inline payloads that could not be stored — these are LEFT INLINE, never dropped. */
  failures: Array<{ mimeType: string; bytes: number; reason: string }>;
}

/**
 * Store each distinct inline payload as a case-media file and return the
 * substitution map. A payload that cannot be stored (or cannot be read back
 * identically) is reported as a failure and simply left out of the map, so the
 * caller keeps the original base64 and nothing is ever lost.
 */
export async function externalizeInlineMedia(args: {
  labCaseId: string;
  dataUris: Iterable<string>;
  writer?: LegacyMediaFileWriter;
  /**
   * Default true. A photo that only reached this instance's local disk is
   * NOT stored: local disk is per-instance and wiped by the next redeploy, so
   * swapping the base64 for a reference to it is silent data loss — exactly
   * what `POST /media/upload` already refuses to do. Only an operator running
   * the migration on an install with no App Storage may turn this off.
   */
  requireDurableStorage?: boolean;
}): Promise<ExternalizeInlineMediaResult> {
  const writer = args.writer ?? defaultLegacyMediaFileWriter;
  const requireDurableStorage = args.requireDurableStorage !== false;
  const result: ExternalizeInlineMediaResult = {
    replacements: new Map(),
    files: [],
    failures: [],
  };
  for (const dataUri of args.dataUris) {
    if (result.replacements.has(dataUri)) continue;
    const media = parseInlineMediaDataUri(dataUri);
    if (!media) continue;
    const fileName = legacyMediaFileName(args.labCaseId, media);
    try {
      const write = await writer.write({
        fileName,
        bytes: media.bytes,
        contentType: media.mimeType,
      });
      if (requireDurableStorage && !write.objectStorage) {
        result.failures.push({
          mimeType: media.mimeType,
          bytes: media.bytes.length,
          reason:
            "durable media storage unavailable (App Storage not configured) — payload left inline",
        });
        continue;
      }
      if (!(await writer.verify({ fileName, bytes: media.bytes }))) {
        result.failures.push({
          mimeType: media.mimeType,
          bytes: media.bytes.length,
          reason: "stored file did not read back identically",
        });
        continue;
      }
      result.replacements.set(dataUri, legacyMediaReferenceUrl(fileName));
      result.files.push({
        fileName,
        mimeType: media.mimeType,
        bytes: media.bytes.length,
        write,
      });
    } catch (err) {
      result.failures.push({
        mimeType: media.mimeType,
        bytes: media.bytes.length,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Write-path guard for the legacy mobile sync endpoint.
 *
 * Scans the payloads the endpoint is about to merge and persist, stores every
 * inline photo it finds, and hands back the substitution map to apply before
 * serialization.
 *
 * Best-effort BY DESIGN: `POST /legacy/cases` is a whole-blob offline sync, so
 * failing the request over one unstorable photo would block every other edit
 * the client is carrying, and dropping the photo would lose it outright.
 * Anything that cannot be externalized stays inline and is logged; the
 * migration sweeps up stragglers on its next run.
 */
export async function externalizeInlineMediaForWrite(args: {
  labCaseId: string;
  payloads: unknown[];
  writer?: LegacyMediaFileWriter;
}): Promise<Map<string, string>> {
  const dataUris = new Set<string>();
  for (const payload of args.payloads) collectInlineMediaDataUris(payload, dataUris);
  if (dataUris.size === 0) return new Map();
  const outcome = await externalizeInlineMedia({
    labCaseId: args.labCaseId,
    dataUris,
    writer: args.writer,
    // Never negotiable on the write path: with no durable store the photo
    // stays inline rather than becoming a reference that 404s after the next
    // redeploy. The operator override exists only for the migration.
    requireDurableStorage: true,
  });
  if (outcome.failures.length > 0) {
    logger.warn(
      { labCaseId: args.labCaseId, failures: outcome.failures },
      "legacy case write: inline media left embedded (externalization failed)",
    );
  }
  if (outcome.files.length > 0) {
    logger.info(
      {
        labCaseId: args.labCaseId,
        files: outcome.files.length,
        bytes: outcome.files.reduce((sum, f) => sum + f.bytes, 0),
      },
      "legacy case write: inline media externalized to case-media storage",
    );
  }
  return outcome.replacements;
}

// ── Per-case parity check ──────────────────────────────────────────────────

export interface ParityCheckInput {
  originalCaseData: string;
  rewritten: unknown;
  replacements: Map<string, string>;
}

export interface ParityCheckResult {
  ok: boolean;
  failures: string[];
}

/**
 * Prove the rewrite is a pure substitution before the blob is allowed to
 * change. Three independent assertions:
 *
 *   1. REVERSIBILITY — mapping every reference back to its data URI must
 *      reproduce the original blob byte for byte. This is the strong one: it
 *      catches any dropped key, reordered array, or coerced value, not just
 *      missing photos.
 *   2. COMPLETENESS — no inline media may survive in the rewritten blob, or
 *      the row stays bloated and the case gets reprocessed forever.
 *   3. REFERENCE PRESERVATION — every case-media filename the blob already
 *      referenced must still be referenced, so an existing photo cannot be
 *      lost as a side effect of adding new ones.
 */
export function checkRewriteParity(input: ParityCheckInput): ParityCheckResult {
  const failures: string[] = [];

  const reverse = new Map<string, string>();
  for (const [dataUri, url] of input.replacements) reverse.set(url, dataUri);

  const restored = replaceStringsDeep(input.rewritten, reverse);
  if (JSON.stringify(restored) !== input.originalCaseData) {
    failures.push(
      "rewritten blob does not map back to the original — the change is not a pure substitution",
    );
  }

  const rewrittenJson = JSON.stringify(input.rewritten);
  if (textContainsInlineMedia(rewrittenJson)) {
    failures.push("rewritten blob still contains inline base64 media");
  }

  const before = new Set(extractMediaFilenamesFromText(input.originalCaseData));
  const after = new Set(extractMediaFilenamesFromText(rewrittenJson));
  for (const name of before) {
    if (!after.has(name)) failures.push(`pre-existing media reference lost: ${name}`);
  }

  return { ok: failures.length === 0, failures };
}

// ── Migration ──────────────────────────────────────────────────────────────

export type LegacyCaseMigrationStatus =
  | "migrated"
  | "would-migrate"
  | "skipped"
  | "failed";

export interface LegacyCaseMigrationCaseReport {
  caseId: string;
  status: LegacyCaseMigrationStatus;
  inlineMediaFound: number;
  fileNames: string[];
  beforeBytes: number;
  afterBytes: number;
  backup?: { location: LegacyCaseDataBackupLocation; key: string } | null;
  reason?: string;
}

export interface LegacyCaseMediaMigrationReport {
  runId: string;
  dryRun: boolean;
  scannedCases: number;
  migratedCases: number;
  skippedCases: number;
  failedCases: number;
  inlineMediaFound: number;
  filesWritten: number;
  ledgerBindings: number;
  bytesRemovedFromBlobs: number;
  /** Cases still holding inline media after this run — 0 means the sweep is done. */
  remainingCases: number;
  cases: LegacyCaseMigrationCaseReport[];
  errors: Array<{ caseId: string; message: string }>;
}

export interface LegacyCaseMediaMigrationOptions {
  /** Default true: inspect and parity-check everything, change nothing. */
  dryRun?: boolean;
  /**
   * Restrict the sweep to these case ids. Omitted, the run sweeps every case
   * still holding inline media — which is the point in production, but means
   * a caller that only means to touch its own rows (a test, or an operator
   * retrying one case) MUST pass this. An empty array selects nothing.
   */
  caseIds?: string[];
  /** Max cases to process in this run. Re-run to continue. */
  limit?: number;
  /** Cases fetched from the DB per batch (blobs are multi-megabyte). */
  batchSize?: number;
  runId?: string;
  /**
   * Refuse to rewrite a blob whose backup only reached ephemeral local disk,
   * and refuse to externalize a photo that only reached ephemeral local disk.
   * Default true — a data-retention change must be recoverable, and a
   * reference is only safe to write once the bytes are durably stored.
   */
  requireDurableBackup?: boolean;
  writer?: LegacyMediaFileWriter;
  backupStore?: LegacyCaseDataBackupStore;
  /** Test seam: runs after the parity check, just before the guarded UPDATE. */
  onBeforeCaseUpdate?: (caseId: string) => Promise<void> | void;
}

const DEFAULT_BATCH_SIZE = 5;

interface CandidateRow extends Record<string, unknown> {
  id: string;
  case_data: string;
}

/**
 * Cases still holding inline media, largest first (biggest win per case, and
 * the heaviest rows are the ones most likely to trip a timeout — do them while
 * the run is fresh). Soft-deleted rows are included: they can be restored, and
 * their photos have to survive that.
 */
async function fetchCandidates(
  limit: number,
  caseIds: string[] | null,
): Promise<CandidateRow[]> {
  const scope =
    caseIds === null
      ? sql``
      : sql` AND id IN (${sql.join(
          caseIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const rows = await db.execute<CandidateRow>(sql`
    SELECT id, case_data
    FROM lab_cases
    WHERE case_data LIKE '%;base64,%'${scope}
    ORDER BY octet_length(case_data) DESC
    LIMIT ${limit}
  `);
  return (rows as any).rows ?? (Array.isArray(rows) ? (rows as any) : []);
}

async function countRemaining(): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n
    FROM lab_cases
    WHERE case_data LIKE '%;base64,%'
  `);
  const list = (rows as any).rows ?? (Array.isArray(rows) ? (rows as any) : []);
  return Number(list[0]?.n ?? 0);
}

/**
 * Batched, resumable, verified sweep of the embedded photos already in the
 * database.
 *
 * Resumability needs no bookkeeping table: the selection query is "blobs that
 * still contain base64", so a migrated case drops out of it and a crash
 * mid-run simply leaves the remainder for the next invocation. Every case is
 * independent and commits on its own.
 *
 * Per case the order is deliberate:
 *   write + verify files -> parity-check the rewrite -> back up the original
 *   -> bind the ledger -> rewrite the blob under a row lock.
 * The files and their ledger rows exist and are proven readable BEFORE the
 * only destructive step, and the guarded UPDATE re-reads the row under
 * `FOR UPDATE` and refuses to write if a concurrent sync changed the blob
 * since it was read.
 */
export async function runLegacyCaseMediaMigration(
  options: LegacyCaseMediaMigrationOptions = {},
): Promise<LegacyCaseMediaMigrationReport> {
  const dryRun = options.dryRun !== false;
  const runId =
    options.runId ??
    `legacy-media-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 10000));
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 50));
  const requireDurableBackup = options.requireDurableBackup !== false;
  const writer = options.writer ?? defaultLegacyMediaFileWriter;
  const backupStore = options.backupStore ?? defaultLegacyCaseDataBackupStore;

  const report: LegacyCaseMediaMigrationReport = {
    runId,
    dryRun,
    scannedCases: 0,
    migratedCases: 0,
    skippedCases: 0,
    failedCases: 0,
    inlineMediaFound: 0,
    filesWritten: 0,
    ledgerBindings: 0,
    bytesRemovedFromBlobs: 0,
    remainingCases: 0,
    cases: [],
    errors: [],
  };

  const scopedIds = options.caseIds ? Array.from(new Set(options.caseIds)) : null;
  if (scopedIds !== null && scopedIds.length === 0) {
    report.remainingCases = await countRemaining();
    return report;
  }

  const processed = new Set<string>();
  while (report.scannedCases < limit) {
    const want = Math.min(batchSize, limit - report.scannedCases);
    // Over-fetch so a batch made entirely of already-seen rows (dry runs and
    // skips leave candidates in place) still makes progress.
    const batch = (await fetchCandidates(want + processed.size, scopedIds)).filter(
      (row) => !processed.has(row.id),
    );
    if (batch.length === 0) break;

    for (const row of batch.slice(0, want)) {
      processed.add(row.id);
      report.scannedCases += 1;
      try {
        const caseReport = await migrateOneCase({
          runId,
          dryRun,
          row,
          writer,
          backupStore,
          requireDurableBackup,
          onBeforeCaseUpdate: options.onBeforeCaseUpdate,
        });
        report.cases.push(caseReport);
        report.inlineMediaFound += caseReport.inlineMediaFound;
        if (caseReport.status === "migrated") {
          report.migratedCases += 1;
          report.filesWritten += caseReport.fileNames.length;
          report.bytesRemovedFromBlobs += caseReport.beforeBytes - caseReport.afterBytes;
        } else if (caseReport.status === "would-migrate") {
          report.filesWritten += caseReport.fileNames.length;
          report.bytesRemovedFromBlobs += caseReport.beforeBytes - caseReport.afterBytes;
        } else if (caseReport.status === "skipped") {
          report.skippedCases += 1;
        } else {
          report.failedCases += 1;
          if (caseReport.reason) {
            report.errors.push({ caseId: row.id, message: caseReport.reason });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failedCases += 1;
        report.errors.push({ caseId: row.id, message });
        report.cases.push({
          caseId: row.id,
          status: "failed",
          inlineMediaFound: 0,
          fileNames: [],
          beforeBytes: Buffer.byteLength(row.case_data ?? "", "utf8"),
          afterBytes: Buffer.byteLength(row.case_data ?? "", "utf8"),
          reason: message,
        });
        logger.error({ err: message, caseId: row.id, runId }, "legacy case media migration: case failed");
      }
    }
  }

  // Ledger bindings are counted from the per-case reports so a dry run reports
  // zero even though it wrote and verified the files.
  report.ledgerBindings = report.cases
    .filter((c) => c.status === "migrated")
    .reduce((sum, c) => sum + c.fileNames.length, 0);
  report.remainingCases = await countRemaining();

  logger.info(
    {
      runId,
      dryRun,
      scanned: report.scannedCases,
      migrated: report.migratedCases,
      skipped: report.skippedCases,
      failed: report.failedCases,
      bytesRemoved: report.bytesRemovedFromBlobs,
      remaining: report.remainingCases,
    },
    "legacy case media migration: run complete",
  );
  return report;
}

async function migrateOneCase(args: {
  runId: string;
  dryRun: boolean;
  row: CandidateRow;
  writer: LegacyMediaFileWriter;
  backupStore: LegacyCaseDataBackupStore;
  requireDurableBackup: boolean;
  onBeforeCaseUpdate?: (caseId: string) => Promise<void> | void;
}): Promise<LegacyCaseMigrationCaseReport> {
  const { row, runId, dryRun } = args;
  const originalCaseData = row.case_data ?? "";
  const beforeBytes = Buffer.byteLength(originalCaseData, "utf8");
  const base: LegacyCaseMigrationCaseReport = {
    caseId: row.id,
    status: "skipped",
    inlineMediaFound: 0,
    fileNames: [],
    beforeBytes,
    afterBytes: beforeBytes,
  };

  let original: unknown;
  try {
    original = JSON.parse(originalCaseData);
  } catch {
    return { ...base, reason: "case_data is not valid JSON" };
  }
  if (!original || typeof original !== "object") {
    return { ...base, reason: "case_data is not a JSON object" };
  }
  // A pure-substitution parity check needs the original to be reproducible
  // from its own parse. If Postgres holds a differently-formatted string (odd
  // whitespace, duplicate keys), skip rather than silently reformat the blob.
  if (JSON.stringify(original) !== originalCaseData) {
    return {
      ...base,
      reason: "case_data does not round-trip through JSON — refusing to rewrite",
    };
  }

  const dataUris = collectInlineMediaDataUris(original);
  if (dataUris.size === 0) {
    return { ...base, reason: "no inline base64 media found" };
  }
  base.inlineMediaFound = dataUris.size;

  const outcome = await externalizeInlineMedia({
    labCaseId: row.id,
    dataUris,
    writer: args.writer,
    requireDurableStorage: args.requireDurableBackup,
  });
  if (outcome.failures.length > 0 || outcome.replacements.size !== dataUris.size) {
    return {
      ...base,
      status: "failed",
      fileNames: outcome.files.map((f) => f.fileName),
      reason:
        outcome.failures[0]?.reason ??
        "not every inline payload could be stored in case-media storage",
    };
  }

  const rewritten = replaceStringsDeep(original, outcome.replacements);
  const parity = checkRewriteParity({
    originalCaseData,
    rewritten,
    replacements: outcome.replacements,
  });
  if (!parity.ok) {
    return {
      ...base,
      status: "failed",
      fileNames: outcome.files.map((f) => f.fileName),
      reason: `parity check failed: ${parity.failures.join("; ")}`,
    };
  }

  const rewrittenCaseData = JSON.stringify(rewritten);
  const afterBytes = Buffer.byteLength(rewrittenCaseData, "utf8");
  const fileNames = outcome.files.map((f) => f.fileName);

  if (dryRun) {
    return { ...base, status: "would-migrate", fileNames, afterBytes };
  }

  // Back up the original and read it back before anything destructive.
  const backup = await args.backupStore.write(runId, row.id, originalCaseData);
  if (args.requireDurableBackup && backup.location !== "object-storage") {
    return {
      ...base,
      status: "failed",
      fileNames,
      afterBytes,
      backup: { location: backup.location, key: backup.key },
      reason:
        "backup only reached ephemeral local disk (App Storage not configured) — pass allowLocalBackup to override",
    };
  }
  const readBack = await args.backupStore.read(runId, row.id);
  if (readBack !== originalCaseData) {
    return {
      ...base,
      status: "failed",
      fileNames,
      afterBytes,
      backup: { location: backup.location, key: backup.key },
      reason: "backup did not read back identically — refusing to rewrite the blob",
    };
  }

  if (args.onBeforeCaseUpdate) await args.onBeforeCaseUpdate(row.id);

  // Bind the ledger and rewrite the blob in ONE transaction, under the row
  // lock, using the tenant metadata from the locked row.
  //
  // Both halves of that matter. Binding must commit with the rewrite, because
  // the instant the blob points at these files the serving route authorizes
  // them from this ledger and nothing else — a binding that failed while the
  // rewrite succeeded is a photo the case can no longer show. And the
  // owner/organization must come from the locked read: binding on metadata
  // read earlier can leave a row authorizing the file to a lab the case has
  // since left, which the guarded rewrite would then decline to correct.
  //
  // `updated_at` is deliberately left alone: the case lists fall back to it
  // for a case whose blob carries no timestamp, so bumping it would silently
  // re-date cases. The projection trigger recomputes the projected list
  // columns from the new blob on its own.
  let bindError: string | null = null;
  const updated = await db.transaction(async (tx) => {
    const locked = await tx.execute<{
      case_data: string;
      owner_id: string;
      organization_id: string | null;
    }>(sql`
      SELECT case_data, owner_id, organization_id
      FROM lab_cases WHERE id = ${row.id} FOR UPDATE
    `);
    const lockedRow =
      ((locked as any).rows ?? (Array.isArray(locked) ? (locked as any) : []))[0] ?? null;
    if (!lockedRow) return "gone" as const;
    if (lockedRow.case_data !== originalCaseData) return "changed" as const;

    try {
      await bindLegacyCaseMediaStrict({
        tx: tx as any,
        labCaseId: row.id,
        organizationId: lockedRow.organization_id ?? null,
        ownerId: lockedRow.owner_id,
        fileNames,
      });
    } catch (err) {
      // Roll back rather than publish references the serving route rejects.
      bindError = err instanceof Error ? err.message : String(err);
      throw err;
    }

    await tx.execute(sql`
      UPDATE lab_cases SET case_data = ${rewrittenCaseData} WHERE id = ${row.id}
    `);
    return "ok" as const;
  }).catch((err) => {
    if (bindError) return "bind-failed" as const;
    throw err;
  });

  if (updated === "gone") {
    return { ...base, fileNames, afterBytes, reason: "case disappeared before rewrite" };
  }
  if (updated === "changed") {
    return {
      ...base,
      fileNames,
      afterBytes,
      reason: "case was modified concurrently — left for the next run",
    };
  }
  if (updated === "bind-failed") {
    return {
      ...base,
      status: "failed",
      fileNames,
      afterBytes,
      backup: { location: backup.location, key: backup.key },
      reason: `media ledger binding failed, blob left untouched: ${bindError}`,
    };
  }

  return {
    ...base,
    status: "migrated",
    fileNames,
    afterBytes,
    backup: { location: backup.location, key: backup.key },
  };
}

// ── Recovery ───────────────────────────────────────────────────────────────

export type LegacyCaseDataRestoreStatus =
  | "restored"
  | "would-restore"
  | "already-original"
  | "backup-not-found"
  | "case-not-found"
  | "failed";

export interface LegacyCaseDataRestoreCaseResult {
  caseId: string;
  status: LegacyCaseDataRestoreStatus;
  /** Size of the blob the backup holds. */
  backupBytes: number;
  reason?: string;
}

export interface LegacyCaseDataRestoreReport {
  runId: string;
  dryRun: boolean;
  restoredCases: number;
  cases: LegacyCaseDataRestoreCaseResult[];
}

/**
 * Put a case's ORIGINAL pre-migration blob back, from the backup the run took
 * before rewriting it.
 *
 * This is the operator-facing undo, and it exists as code rather than as
 * instructions because the stored object is an envelope
 * (`{ runId, caseId, capturedAt, caseData }`) — writing that object into
 * `lab_cases.case_data` by hand would replace the case with the envelope
 * instead of restoring it. The original is the `caseData` STRING inside.
 *
 * Restoring re-embeds the base64 photos, so the case becomes a migration
 * candidate again; the media files and their ledger rows are deliberately
 * left in place, and re-running the migration is idempotent (the filenames
 * are content-addressed, so it reproduces exactly the same references).
 */
export async function restoreLegacyCaseDataFromBackup(args: {
  runId: string;
  caseIds: string[];
  /** Default true: report what would be restored, change nothing. */
  dryRun?: boolean;
  backupStore?: LegacyCaseDataBackupStore;
}): Promise<LegacyCaseDataRestoreReport> {
  const dryRun = args.dryRun !== false;
  const backupStore = args.backupStore ?? defaultLegacyCaseDataBackupStore;
  const caseIds = Array.from(new Set(args.caseIds)).filter(Boolean);
  const report: LegacyCaseDataRestoreReport = {
    runId: args.runId,
    dryRun,
    restoredCases: 0,
    cases: [],
  };

  for (const caseId of caseIds) {
    const original = await backupStore.read(args.runId, caseId);
    if (original === null) {
      report.cases.push({
        caseId,
        status: "backup-not-found",
        backupBytes: 0,
        reason: `no backup for case ${caseId} in run ${args.runId}`,
      });
      continue;
    }
    const backupBytes = Buffer.byteLength(original, "utf8");

    try {
      const outcome = await db.transaction(async (tx) => {
        const locked = await tx.execute<{ case_data: string }>(sql`
          SELECT case_data FROM lab_cases WHERE id = ${caseId} FOR UPDATE
        `);
        const lockedRow =
          ((locked as any).rows ?? (Array.isArray(locked) ? (locked as any) : []))[0] ?? null;
        if (!lockedRow) return "case-not-found" as const;
        if (lockedRow.case_data === original) return "already-original" as const;
        if (dryRun) return "would-restore" as const;

        // `updated_at` is left alone for the same reason the migration leaves
        // it alone: the case lists fall back to it when the blob carries no
        // timestamp, so touching it would re-date the case.
        await tx.execute(sql`
          UPDATE lab_cases SET case_data = ${original} WHERE id = ${caseId}
        `);
        const verify = await tx.execute<{ case_data: string }>(sql`
          SELECT case_data FROM lab_cases WHERE id = ${caseId}
        `);
        const verifyRow =
          ((verify as any).rows ?? (Array.isArray(verify) ? (verify as any) : []))[0] ?? null;
        if (!verifyRow || verifyRow.case_data !== original) {
          // Roll back rather than leave a half-restored blob behind.
          throw new Error("restored blob did not read back identically");
        }
        return "restored" as const;
      });

      if (outcome === "restored") report.restoredCases += 1;
      report.cases.push({ caseId, status: outcome, backupBytes });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.cases.push({ caseId, status: "failed", backupBytes, reason: message });
      logger.error(
        { err: message, caseId, runId: args.runId },
        "legacy case data restore: case failed",
      );
    }
  }

  logger.info(
    {
      runId: args.runId,
      dryRun,
      requested: caseIds.length,
      restored: report.restoredCases,
    },
    "legacy case data restore: run complete",
  );
  return report;
}

/** Cheap status for the admin endpoint: how much bloat is left. */
export async function getLegacyCaseMediaMigrationStatus(): Promise<{
  remainingCases: number;
  remainingBytes: number;
  largestCaseBytes: number;
  objectStorageConfigured: boolean;
}> {
  const rows = await db.execute<{
    n: string;
    total: string | null;
    largest: string | null;
  }>(sql`
    SELECT count(*)::text AS n,
           coalesce(sum(octet_length(case_data)), 0)::text AS total,
           coalesce(max(octet_length(case_data)), 0)::text AS largest
    FROM lab_cases
    WHERE case_data LIKE '%;base64,%'
  `);
  const list = (rows as any).rows ?? (Array.isArray(rows) ? (rows as any) : []);
  const first = list[0] ?? {};
  return {
    remainingCases: Number(first.n ?? 0),
    remainingBytes: Number(first.total ?? 0),
    largestCaseBytes: Number(first.largest ?? 0),
    objectStorageConfigured: caseMediaObjectStorageAvailable(),
  };
}
