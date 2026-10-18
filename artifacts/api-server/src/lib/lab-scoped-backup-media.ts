/**
 * Scoped archive readers for private media outside the case-media filename
 * namespace: signed authorization forms and signatures, statement PDFs,
 * profile photos, logos, support report attachments and scan files.
 *
 * Every reader binds a reference to the identity of the scoped row that owns
 * it (scan readers also require the named scan job to be one the export
 * selected for this lab), keeps the original storage namespace in the archive
 * path, and stops the export on a missing, unsafe, foreign or ambiguous object
 * instead of omitting bytes. Archive layout beneath media/:
 *   local-uploads/<namespace>/<file>         -> uploads/<namespace>/<file>
 *   private-objects/<namespace>/<object key> -> PRIVATE_OBJECT_DIR/<namespace>/<object key>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { openPrivateBackupObject } from "./case-media-object-storage";
import { LAB_LOGO_EXTENSIONS } from "./lab-logo-storage";
import type { MediaRule } from "./lab-scoped-backup-contract";

export const LOCAL_UPLOAD_PREFIX = "local-uploads/";
export const PRIVATE_OBJECT_PREFIX = "private-objects/";
/** Generated statement filenames are opaque, so their exclusivity is checked in SQL. */
export const STATEMENT_PDF_PREFIX = `${LOCAL_UPLOAD_PREFIX}practice-statements/`;
/** A logo URL names its organization but not the stored extension. */
const LOGO_OWNER_PREFIX = "logo-owner/";
/** What follows "<user id>-" in an uploaded profile photo's file name. */
const PROFILE_PHOTO_SUFFIX =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

type Row = Record<string, unknown>;

export function safeBackupRelativePath(value: string): string {
  if (!value || /[\\\0?#%]/.test(value) || path.posix.isAbsolute(value) ||
      value.split("/").some(part => !part || part === "." || part === "..") ||
      value.includes(":")) throw new Error("Invalid or ambiguous backup media path.");
  return value;
}

function flatName(value: string): string {
  const name = safeBackupRelativePath(value);
  if (name.includes("/")) throw new Error("The stored file reference must be a single file name.");
  return name;
}

function referenceText(value: unknown): string {
  if (typeof value !== "string") throw new Error("The stored file reference is not text.");
  return value;
}

function ownerId(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !value) {
    throw new Error(`The row has no ${column} to bind its stored file to.`);
  }
  return value;
}

function exactKey(value: unknown, expected: string, owner: string): string {
  const key = referenceText(value);
  if (key !== expected) throw new Error(`The stored file key does not belong to this ${owner}.`);
  return safeBackupRelativePath(key);
}

/** Scan files are flat case-media names that embed their owning job/input. */
function scanKey(value: unknown, prefix: string, owner: string, allowExact = false): string {
  const key = flatName(referenceText(value));
  if (!(allowExact && key === prefix) && !(key.startsWith(`${prefix}-`) && key.length > prefix.length + 1)) {
    throw new Error(`The scan file key does not belong to this ${owner}.`);
  }
  return key;
}

/** The scan jobs and scan inputs that one export selected for its lab. */
export interface LabScanOwnership {
  jobs: ReadonlySet<string>;
  /** Scan input id to its scan job id, for the inputs of those jobs. */
  inputJobs: ReadonlyMap<string, string>;
}

/**
 * A scan file key names its scan job, but a row's own reference to a job does
 * not prove ownership: saved scan documents are selected by their own lab
 * column, and a foreign key only proves that the job exists. The job must be
 * one that the export selected for this lab, read in the same snapshot.
 */
function labScanJob(scans: LabScanOwnership | undefined, jobId: string | undefined, owner: string): string {
  if (!scans) {
    throw new Error("Scan files can only be exported together with this lab's scan jobs from the export snapshot.");
  }
  if (jobId === undefined || !scans.jobs.has(jobId)) {
    throw new Error(`The ${owner} does not belong to one of this lab's scan jobs.`);
  }
  return jobId;
}

/**
 * Collects the archive references for one private-media column of a row that
 * the server's ownership predicate selected. Returns false for kinds handled by
 * the case-media and invoice readers. Scan readers also need the lab's scan
 * jobs and inputs from the same export snapshot.
 */
export function collectPrivateLabMedia(
  kind: MediaRule["kind"], row: Row, value: unknown, files: Set<string>, scans?: LabScanOwnership,
): boolean {
  const caseMediaObject = (key: string) => files.add(`${PRIVATE_OBJECT_PREFIX}case-media/${key}`);
  const localUpload = (namespace: string, name: string) =>
    files.add(`${LOCAL_UPLOAD_PREFIX}${namespace}/${flatName(name)}`);
  switch (kind) {
    case "authorization": {
      // Uploaded forms: practice-authorizations/<lab>/<practice>/<document>.pdf.
      // Retired in-app signing kept its key under the legacy authorization id.
      const lab = ownerId(row, "lab_organization_id");
      const legacy = row.legacy_authorization_id != null && row.legacy_authorization_id !== "";
      caseMediaObject(exactKey(value, legacy
        ? `lab-authorizations/${lab}/${ownerId(row, "legacy_authorization_id")}/authorization.pdf`
        : `practice-authorizations/${lab}/${ownerId(row, "practice_organization_id")}/${ownerId(row, "id")}.pdf`,
      "authorization document"));
      return true;
    }
    case "legacy-evidence": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Retired authorization evidence is not a JSON object.");
      }
      const key = (value as Row).signatureObjectKey;
      if (key === undefined || key === null || key === "") return true;
      caseMediaObject(exactKey(key,
        `lab-authorizations/${ownerId(row, "lab_organization_id")}/${ownerId(row, "legacy_authorization_id")}/signature`,
        "retired authorization"));
      return true;
    }
    case "autopay-signature":
    case "autopay-document":
      caseMediaObject(exactKey(value,
        `provider-autopay/${ownerId(row, "id")}/${kind === "autopay-signature" ? "signature" : "authorization.pdf"}`,
        "autopay authorization"));
      return true;
    case "statement-pdf":
      localUpload("practice-statements", referenceText(value));
      return true;
    case "statement-bundle": {
      // Mirrors coerceStatementBundleManifest: the app ignores a manifest that is
      // not an object with an attachments array, and entries without a string
      // storageKey. Every storageKey it would try to serve must be archived, so
      // an empty or nested one stops the export.
      if (!value || typeof value !== "object") return true;
      const attachments = (value as Row).attachments;
      if (!Array.isArray(attachments)) return true;
      for (const attachment of attachments) {
        const key = attachment && typeof attachment === "object" ? (attachment as Row).storageKey : undefined;
        if (typeof key === "string") localUpload("practice-statements", key);
      }
      return true;
    }
    case "profile-photo": {
      // Uploads write the relative path /uploads/profile-photos/<user id>-<uuid>.jpg
      // (earlier releases used a millisecond timestamp). LabTrax never stores
      // its own photos as absolute URLs, so any http(s) link is external,
      // whatever its path, and like an inline data URI has no stored file here.
      const url = referenceText(value);
      const prefix = "/uploads/profile-photos/";
      if (!url.startsWith(prefix)) {
        if (/^(?:data:|https?:\/\/)/i.test(url)) return true;
        throw new Error("The profile photo location is not a LabTrax upload or an external link.");
      }
      const file = url.slice(prefix.length);
      const owner = `${ownerId(row, "id")}-`;
      if (!file.startsWith(owner) || !PROFILE_PHOTO_SUFFIX.test(file.slice(owner.length))) {
        throw new Error("The profile photo file is not one this user uploaded.");
      }
      localUpload("profile-photos", file);
      return true;
    }
    case "logo": {
      // Uploads store /api/organizations/<organization id>/logo?v=<timestamp>.
      const url = referenceText(value);
      const organizationId = flatName(ownerId(row, "id"));
      const base = `/api/organizations/${organizationId}/logo`;
      if (url !== base && !(url.startsWith(`${base}?v=`) && /^\d+$/.test(url.slice(base.length + 3)))) {
        throw new Error("The logo URL does not belong to this organization.");
      }
      files.add(`${LOGO_OWNER_PREFIX}${organizationId}`);
      return true;
    }
    case "support":
      // Retention redaction clears the filename before deleting the object;
      // that content has expired and must not be resurrected by a backup.
      if (row.filename === "") return true;
      // Keys are server-generated and unique per attachment row.
      files.add(`${PRIVATE_OBJECT_PREFIX}support-reports/${flatName(referenceText(value))}`);
      return true;
    case "scan-input": {
      const job = labScanJob(scans, ownerId(row, "job_id"), "scan input");
      caseMediaObject(scanKey(value, `scan-${job}-input-${ownerId(row, "id")}`, "scan input", true));
      return true;
    }
    case "scan-chunk": {
      // scan-<job>-input-<input>-chunk-<offset>-<random hex>, where the job is
      // the chunk's own input's job, not merely any job named in the key.
      const input = ownerId(row, "input_id");
      const job = labScanJob(scans, scans?.inputJobs.get(input), "scan input chunk");
      const prefix = `scan-${job}-input-${input}-chunk-${ownerId(row, "offset")}-`;
      const key = flatName(referenceText(value));
      if (!key.startsWith(prefix) || !/^[0-9a-f]+$/.test(key.slice(prefix.length))) {
        throw new Error("The scan file key does not belong to this scan input chunk.");
      }
      caseMediaObject(key);
      return true;
    }
    case "scan-output": {
      // An output without ready_at is a reservation the app never serves.
      if (row.ready_at === null || row.ready_at === undefined) return true;
      const job = labScanJob(scans, ownerId(row, "job_id"), "scan output");
      caseMediaObject(scanKey(value, `scan-${job}-${ownerId(row, "format")}`, "scan output"));
      return true;
    }
    case "scan-document": {
      // Saving a scan reuses its output's object: scan-<job>-<format>-<lease>.
      const job = labScanJob(scans, ownerId(row, "scan_job_id"), "saved scan document");
      caseMediaObject(scanKey(value, `scan-${job}`, "saved scan document"));
      return true;
    }
    default:
      return false;
  }
}

class MissingBackupMedia extends Error {}

/** Filesystem errors carry absolute server paths; report only the upload name. */
function localReadError(error: unknown, relative: string): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new MissingBackupMedia(`uploads/${relative} does not exist`);
  if (code === "ELOOP") return new Error(`uploads/${relative} is a symbolic link.`);
  return new Error(`uploads/${relative} could not be read (${typeof code === "string" ? code : "read failure"}).`);
}

/** Copies one regular file below uploads/ without following symbolic links. */
async function copyLocalUpload(relative: string, output: string): Promise<void> {
  const parts = safeBackupRelativePath(relative).split("/");
  let source = path.resolve(process.cwd(), "uploads");
  for (const part of ["", ...parts]) {
    if (part) source = path.join(source, part);
    const stat = await fs.promises.lstat(source).catch((error: unknown) => { throw localReadError(error, relative); });
    if (stat.isSymbolicLink()) throw new Error(`uploads/${relative} passes through a symbolic link.`);
  }
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch((error: unknown) => { throw localReadError(error, relative); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`uploads/${relative} is not a regular file.`);
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      fs.createWriteStream(output, { mode: 0o600, flags: "wx" }),
    );
    if ((await fs.promises.stat(output)).size !== stat.size) {
      throw new Error(`uploads/${relative} changed while it was being copied.`);
    }
  } finally {
    await handle.close();
  }
}

async function copyPrivateObject(relativeName: string, destination: string): Promise<void> {
  const object = await openPrivateBackupObject(safeBackupRelativePath(relativeName));
  if (!object) throw new MissingBackupMedia(`App Storage object ${relativeName} does not exist`);
  await object.copyTo(path.join(destination, PRIVATE_OBJECT_PREFIX, relativeName));
}

async function copyLogo(organizationId: string, destination: string): Promise<void> {
  const name = flatName(organizationId);
  const found = [];
  for (const extension of LAB_LOGO_EXTENSIONS) {
    const object = await openPrivateBackupObject(`lab-logos/${name}.${extension}`);
    if (object) found.push(object);
  }
  if (found.length === 0) throw new MissingBackupMedia(`no lab-logos/${name}.* object exists in App Storage`);
  if (found.length > 1) {
    throw new Error(
      `more than one stored logo file exists (${found.map(item => item.relativeName).join(", ")}), ` +
      "so the current logo is ambiguous. Re-upload the logo, then retry.",
    );
  }
  await found[0]!.copyTo(path.join(destination, PRIVATE_OBJECT_PREFIX, found[0]!.relativeName));
}

/**
 * Stages every private-media reference into the archive directory, preserving
 * its namespace. Returns the references it handled; any other reference belongs
 * to the case-media or invoice readers.
 */
export async function stagePrivateLabMedia(
  files: Set<string>,
  destination: string,
  origins?: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const handled = new Set<string>();
  for (const reference of files) {
    try {
      if (reference.startsWith(LOCAL_UPLOAD_PREFIX)) {
        await copyLocalUpload(reference.slice(LOCAL_UPLOAD_PREFIX.length), path.join(destination, reference));
      } else if (reference.startsWith(PRIVATE_OBJECT_PREFIX)) {
        await copyPrivateObject(reference.slice(PRIVATE_OBJECT_PREFIX.length), destination);
      } else if (reference.startsWith(LOGO_OWNER_PREFIX)) {
        await copyLogo(reference.slice(LOGO_OWNER_PREFIX.length), destination);
      } else continue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const source = origins?.get(reference) ?? reference;
      throw new Error(error instanceof MissingBackupMedia
        ? `Lab backup stopped: ${source} refers to a missing file (${message}). Restore or re-upload it, or clear the reference, then retry.`
        : `Lab backup stopped at ${source}: ${message}`);
    }
    handled.add(reference);
  }
  return handled;
}
