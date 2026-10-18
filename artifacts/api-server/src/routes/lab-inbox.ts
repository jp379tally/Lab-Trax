import * as fs from "node:fs";
import * as path from "node:path";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  cases,
  labInboxFiles,
  notifications,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { notDeleted } from "../lib/soft-delete";
import {
  caseMediaObjectStorageAvailable,
  caseMediaObjectStorageKeyExists,
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";
// Shared with the startup repair pass (lab-inbox-storage-repair.ts), which
// permanently rewrites legacy URL-shaped rows.  The read-time normalization
// below remains as defense-in-depth for rows created between deploys.
import { normalizeInboxStorageName } from "../lib/lab-inbox-storage-repair";
import { deliverInAppNotification } from "../lib/in-app-notifications";
import { assertProviderCapability } from "../lib/provider-capabilities";
import { requireMembership } from "../lib/rbac";
import { assertOrganizationMutationAllowed } from "../lib/entitlement-write-guard";

const router = Router();
router.use(requireAuth);

const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

const PROVIDER_INBOX_ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type DetectedProviderInboxFile = {
  mimeType: string;
  extensions: readonly string[];
};

function detectProviderInboxFile(buffer: Buffer): DetectedProviderInboxFile | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mimeType: "application/pdf", extensions: [".pdf"] };
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"] };
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { mimeType: "image/png", extensions: [".png"] };
  }
  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return { mimeType: "image/gif", extensions: [".gif"] };
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extensions: [".webp"] };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) {
      return { mimeType: "image/heic", extensions: [".heic"] };
    }
    if (["mif1", "msf1"].includes(brand)) {
      return { mimeType: "image/heif", extensions: [".heif"] };
    }
  }
  return null;
}

function providerInboxFileMatchesDeclaration(
  file: Express.Multer.File,
  buffer: Buffer,
): boolean {
  const declaredMime = (file.mimetype ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const detected = detectProviderInboxFile(buffer);
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  return Boolean(
    detected &&
      detected.mimeType === declaredMime &&
      detected.extensions.includes(extension),
  );
}

const inboxStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(caseMediaDir, { recursive: true });
    cb(null, caseMediaDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".bin";
    const safeBase = path
      .basename(file.originalname || "file", ext)
      .replace(/[^a-zA-Z0-9\-_]+/g, "-")
      .slice(0, 60) || "file";
    cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`);
  },
});

const inboxUpload = multer({
  storage: inboxStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

const providerInboxUpload = multer({
  storage: inboxStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const declaredMime = (file.mimetype ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (PROVIDER_INBOX_ALLOWED_MIMES.has(declaredMime)) {
      cb(null, true);
      return;
    }
    cb(
      new HttpError(
        415,
        "File type is not allowed. Please attach a PDF or image (JPEG, PNG, GIF, WebP, or HEIC).",
      ),
    );
  },
});

const inboxNoteSchema = z
  .string()
  .trim()
  .max(2000, "Note must be 2000 characters or fewer.")
  .optional()
  .nullable()
  .transform((value) => (value ? value : null));

function parseInboxNote(value: unknown): string | null {
  const parsed = inboxNoteSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "Invalid note: " + parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }
  return parsed.data;
}

async function assertLabMembership(userId: string, labOrganizationId: string) {
  const org = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, labOrganizationId),
      eq(organizations.type, "lab"),
      notDeleted(organizations),
    ),
  });
  if (!org) throw new HttpError(404, "Lab not found.");

  return requireMembership(userId, labOrganizationId);
}

/**
 * Verify that a provider user is linked to the given lab. A provider is
 * considered "linked" when they hold an active membership in a provider-type
 * organization whose parentLabOrganizationId equals the target lab org id.
 * Throws HttpError(404) when the lab doesn't exist, HttpError(403) when the
 * provider has no qualifying link.
 */
async function assertProviderLabLink(userId: string, labOrganizationId: string) {
  const labOrg = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, labOrganizationId),
      eq(organizations.type, "lab"),
      notDeleted(organizations),
    ),
  });
  if (!labOrg) throw new HttpError(404, "Lab not found.");

  // Collect all orgs this user actively belongs to
  const memberships = await db
    .select({ labId: organizationMemberships.labId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      )
    );

  const memberOrgIds = memberships.map((m) => m.labId).filter((x): x is string => !!x);
  if (memberOrgIds.length === 0) throw new HttpError(403, "You are not linked to this lab.");

  // Check if any of those orgs is a provider org belonging to the target lab
  const linked = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        inArray(organizations.id, memberOrgIds),
        eq(organizations.type, "provider"),
        eq(organizations.parentLabOrganizationId, labOrganizationId),
        notDeleted(organizations),
      )
    );

  if (linked.length === 0) {
    throw new HttpError(403, "You are not linked to this lab.");
  }
  // This legacy surface is not practice-selected. Require every qualifying
  // provider subject to be writable rather than letting an active membership
  // mask a deactivated one.
  for (const organization of linked) {
    await assertOrganizationMutationAllowed(organization.id);
  }
}

/**
 * Read authorization for one inbox row's file.
 *
 * Lab members keep their existing access to everything in their lab's inbox.
 * On top of that, the provider who sent a row may re-open the file they
 * themselves submitted, under exactly the conditions that already let them
 * see that row in GET /provider-sent — a provider account, the communication
 * capability, and an active link to the lab. Tying the two together means the
 * Sent list and the file behind it can never disagree about who may look.
 */
async function assertInboxFileReadAccess(
  userId: string,
  inboxFile: typeof labInboxFiles.$inferSelect,
): Promise<void> {
  if (inboxFile.uploadedByUserId === userId) {
    const actor = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { userType: true },
    });
    if (actor?.userType === "provider") {
      await assertProviderCapability(userId, "communication");
      await assertProviderLabLink(userId, inboxFile.labOrganizationId);
      return;
    }
  }
  await assertLabMembership(userId, inboxFile.labOrganizationId);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /lab-inbox/provider-upload
//
// Provider-accessible inbox upload. Parallel to POST /lab-inbox/upload but
// accepts labOrganizationId as a QUERY PARAM (not body) so authorization can
// be checked BEFORE Multer accepts any bytes. Auth: authenticated provider
// linked (via provider-org membership with parentLabOrganizationId) to the
// target lab. Non-authorized requests are rejected before any file lands on
// disk.
//
// Either a file, a non-empty note, or both must be provided. Submitting with
// neither returns 400.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-upload auth gate for the provider-upload route.
 * Runs as a plain Express middleware BEFORE Multer so that unauthorized
 * requests are rejected before any file bytes are written to disk.
 * labOrganizationId is read from req.query (available before body parsing).
 */
async function requireProviderLabLinkGate(
  req: Request,
  res: Response,
  next: Function,
): Promise<void> {
  try {
    const userId = (req as any).auth?.userId as string | undefined;
    if (!userId) {
      res.status(401).json({ ok: false, error: "Unauthorized." });
      return;
    }

    const labOrganizationId =
      typeof req.query.labOrganizationId === "string"
        ? req.query.labOrganizationId.trim()
        : "";
    if (!labOrganizationId) {
      res.status(400).json({ ok: false, error: "labOrganizationId query param is required." });
      return;
    }

    // Check provider identity before any file is accepted
    const actor = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { userType: true },
    });
    if (!actor || actor.userType !== "provider") {
      res.status(403).json({ ok: false, error: "Only provider accounts can use this endpoint." });
      return;
    }
    await assertProviderCapability(userId, "communication");

    // Check lab link before any file is accepted
    await assertProviderLabLink(userId, labOrganizationId);

    next();
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message });
      return;
    }
    next(err);
  }
}

router.post(
  "/provider-upload",
  // Auth gate runs BEFORE Multer — no file is written to disk for unauthorized requests
  requireProviderLabLinkGate,
  providerInboxUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    // labOrganizationId was already validated in the pre-Multer gate
    const labOrganizationId = req.query.labOrganizationId as string;

    // Read optional provider context fields (multer populates req.body with
    // non-file multipart fields so these arrive alongside the file).
    const providerNote =
      typeof req.body?.note === "string" && req.body.note.trim()
        ? req.body.note.trim()
        : null;

    // Require at least a file or a non-empty note.
    if (!req.file && !providerNote) {
      throw new HttpError(400, "Please provide a note or attach a file.");
    }

    // File-related values — null when no file was uploaded.
    let diskFilename: string | null = null;
    let diskPath: string | null = null;
    let contentType: string | null = null;
    let objectStorageKey: string | null = null;

    if (req.file) {
      diskFilename = req.file.filename;
      diskPath = path.resolve(caseMediaDir, diskFilename);
      const buffer = await readFile(diskPath);
      if (!providerInboxFileMatchesDeclaration(req.file, buffer)) {
        fs.rmSync(diskPath, { force: true });
        throw new HttpError(
          415,
          "The file contents do not match a supported PDF or image format.",
        );
      }
      contentType = (req.file.mimetype ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();

      // Mirror to object storage as best-effort — disk remains the fallback.
      if (caseMediaObjectStorageAvailable()) {
        try {
          const written = await writeCaseMediaToObjectStorage(
            diskFilename,
            buffer,
            contentType,
          );
          if (written) objectStorageKey = diskFilename;
        } catch (err: any) {
          req.log.warn({ err: err?.message }, "Provider inbox upload: object storage mirror failed; disk-only");
        }
      }
    }

    let row: typeof labInboxFiles.$inferSelect;
    try {
      // Validate submitted case IDs: each must belong to a case whose
      // providerOrganizationId is in the caller's scoped provider org set AND
      // whose labOrganizationId matches the target lab. This prevents a provider
      // from linking cross-provider or cross-lab cases to their upload.
      let providerCaseIds: string | null = null;
      if (typeof req.body?.caseIds === "string" && req.body.caseIds.trim()) {
        const rawIds: string[] = String(req.body.caseIds)
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is string => s.length > 0);
        const uniqueIds: string[] = Array.from(new Set(rawIds));
        if (uniqueIds.length > 0) {
          const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(userId);
          if (providerOrgIds.length === 0) {
            throw new HttpError(403, "No linked provider organizations found.");
          }
          // Validate all submitted IDs are accessible to this provider + lab
          const validCases = await db
            .select({ id: cases.id })
            .from(cases)
            .where(
              and(
                inArray(cases.id, uniqueIds),
                inArray(cases.providerOrganizationId, providerOrgIds),
                eq(cases.labOrganizationId, labOrganizationId),
                notDeleted(cases),
              ),
            );
          const validIds = new Set(validCases.map((c) => c.id as string));
          const invalid = uniqueIds.filter((id) => !validIds.has(id));
          if (invalid.length > 0) {
            throw new HttpError(
              400,
              `One or more submitted case IDs are not accessible: ${invalid.join(", ")}`,
            );
          }
          providerCaseIds = uniqueIds.join(",");
        }
      }

      const [inserted] = await db
        .insert(labInboxFiles)
        .values({
          labOrganizationId,
          uploadedByUserId: userId,
          originalFilename: req.file
            ? req.file.originalname || diskFilename
            : null,
          mimeType: contentType,
          sizeBytes: req.file ? req.file.size : null,
          storagePath: diskFilename,
          objectStorageKey,
          note: providerNote,
          linkedCaseIds: providerCaseIds,
        })
        .returning()
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to save inbox file." }),
        );
      row = inserted;
    } catch (err: unknown) {
      // DB insert failed — remove the file from disk so no orphaned file remains.
      if (diskPath) fs.unlink(diskPath, () => {});
      throw err;
    }

    // Best-effort: notify lab admin/manager/owner members that a provider has
    // sent a message. Errors here are non-fatal and must not block the response.
    try {
      const labAdmins = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, labOrganizationId),
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.role, ["owner", "admin", "manager"]),
          ),
        );

      if (labAdmins.length > 0) {
        // Resolve linked case numbers for the notification body.
        const caseIdList: string[] = row.linkedCaseIds
          ? row.linkedCaseIds.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

        let caseNumbers: string[] = [];
        if (caseIdList.length > 0) {
          const caseRows = await db
            .select({ caseNumber: cases.caseNumber })
            .from(cases)
            .where(inArray(cases.id, caseIdList));
          caseNumbers = caseRows.map((c) => c.caseNumber);
        }

        const noteExcerpt = row.note ? row.note.slice(0, 200) : "";
        const caseRef =
          caseNumbers.length > 0
            ? ` (case${caseNumbers.length > 1 ? "s" : ""}: ${caseNumbers.join(", ")})`
            : "";
        const body: string =
          (noteExcerpt + caseRef).trim() || row.originalFilename || "New provider message";

        await deliverInAppNotification({
          labOrganizationId,
          recipientUserIds: labAdmins.map((member) => member.userId),
          category: "doctor_practice_message",
          type: "provider_message",
          title: "Provider sent a message",
          body,
          dataJson: { labInboxFileId: row.id, caseIds: caseIdList },
        });
      }
    } catch (err: any) {
      req.log?.warn?.({ err: err?.message }, "Provider upload: failed to notify lab admins (non-fatal)");
    }

    return ok(res, row, 201);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /lab-inbox/provider-sent
//
// Provider-accessible history of the caller's own inbox submissions
// (note/file drops made via POST /provider-upload) for a given lab, most
// recent first. Scoped strictly to uploadedByUserId so a provider only ever
// sees what they personally sent — never other providers' submissions.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/provider-sent",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = req.query["labOrganizationId"] as string | undefined;

    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }

    const actor = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { userType: true },
    });
    if (!actor || actor.userType !== "provider") {
      throw new HttpError(403, "Only provider accounts can use this endpoint.");
    }
    await assertProviderCapability(userId, "communication");

    await assertProviderLabLink(userId, labOrganizationId);

    const rows = await db
      .select({
        id: labInboxFiles.id,
        note: labInboxFiles.note,
        originalFilename: labInboxFiles.originalFilename,
        mimeType: labInboxFiles.mimeType,
        sizeBytes: labInboxFiles.sizeBytes,
        linkedCaseIds: labInboxFiles.linkedCaseIds,
        createdAt: labInboxFiles.createdAt,
      })
      .from(labInboxFiles)
      .where(
        and(
          eq(labInboxFiles.labOrganizationId, labOrganizationId),
          eq(labInboxFiles.uploadedByUserId, userId),
        ),
      )
      .orderBy(desc(labInboxFiles.createdAt));

    return ok(res, rows);
  }),
);

router.post(
  "/upload",
  inboxUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;

    if (!req.file) {
      throw new HttpError(400, "No file uploaded.");
    }

    const labOrganizationId =
      (req.body as any)?.labOrganizationId as string | undefined;
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }

    await assertLabMembership(userId, labOrganizationId);
    let note: string | null;
    try {
      note = parseInboxNote((req.body as any)?.note);
    } catch (err) {
      // Multer has already written the upload. Retire it recoverably when note
      // validation rejects the request instead of leaving an untracked file.
      const uploadedPath = path.resolve(caseMediaDir, req.file.filename);
      if (fs.existsSync(uploadedPath)) {
        const trashDir = path.resolve(caseMediaDir, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(
          uploadedPath,
          path.resolve(trashDir, `${Date.now()}__${path.basename(req.file.filename)}`),
        );
      }
      throw err;
    }

    const diskFilename = req.file.filename;
    const contentType = req.file.mimetype || "application/octet-stream";

    // Mirror to object storage as best-effort — disk remains the fallback.
    let objectStorageKey: string | null = null;
    if (caseMediaObjectStorageAvailable()) {
      try {
        const buffer = await readFile(path.resolve(caseMediaDir, diskFilename));
        const written = await writeCaseMediaToObjectStorage(
          diskFilename,
          buffer,
          contentType,
        );
        if (written) objectStorageKey = diskFilename;
      } catch (err: any) {
        req.log.warn({ err: err?.message }, "Lab inbox: object storage mirror failed; disk-only");
      }
    }

    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId,
        uploadedByUserId: userId,
        originalFilename: req.file.originalname || diskFilename,
        mimeType: contentType,
        sizeBytes: req.file.size,
        storagePath: diskFilename,
        objectStorageKey,
        note,
      })
      .returning()
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to save inbox file." }),
      );

    return ok(res, row, 201);
  }),
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = req.query["labOrganizationId"] as string | undefined;

    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }

    await assertLabMembership(userId, labOrganizationId);

    const rows = await db
      .select({
        id: labInboxFiles.id,
        labOrganizationId: labInboxFiles.labOrganizationId,
        uploadedByUserId: labInboxFiles.uploadedByUserId,
        originalFilename: labInboxFiles.originalFilename,
        mimeType: labInboxFiles.mimeType,
        sizeBytes: labInboxFiles.sizeBytes,
        storagePath: labInboxFiles.storagePath,
        objectStorageKey: labInboxFiles.objectStorageKey,
        note: labInboxFiles.note,
        linkedCaseIds: labInboxFiles.linkedCaseIds,
        createdAt: labInboxFiles.createdAt,
        updatedAt: labInboxFiles.updatedAt,
        uploaderUsername: users.username,
        uploaderInitials: users.initials,
        uploaderFirstName: users.firstName,
        uploaderLastName: users.lastName,
      })
      .from(labInboxFiles)
      .leftJoin(users, eq(users.id, labInboxFiles.uploadedByUserId))
      .where(
        and(
          eq(labInboxFiles.labOrganizationId, labOrganizationId),
          isNull(labInboxFiles.assignedAt),
        ),
      )
      .orderBy(desc(labInboxFiles.createdAt));

    return ok(res, rows);
  }),
);

const finalizeSessionSchema = z.object({
  storagePath: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  labOrganizationId: z.string().min(1),
  note: inboxNoteSchema,
});

router.post(
  "/finalize-session",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const parsed = finalizeSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid request: " + parsed.error.issues.map((i) => i.message).join(", "));
    }
    const { storagePath, originalFilename, mimeType, sizeBytes, labOrganizationId, note } = parsed.data;

    await assertLabMembership(userId, labOrganizationId);

    // The client may send either a bare filename or a full public URL;
    // canonicalize to the bare stored filename BEFORE both the existence
    // check and the DB insert so serving routes can always resolve the row.
    const normalizedName = normalizeInboxStorageName(storagePath);
    if (!normalizedName) {
      throw new HttpError(400, "Invalid storagePath: could not resolve a stored filename.");
    }

    // Verify the chunked upload actually landed in object storage before committing
    // the DB row.  Without this check, a failed or partial upload would register an
    // inbox entry whose file is permanently missing after a server restart.
    if (caseMediaObjectStorageAvailable()) {
      const fileExists = await caseMediaObjectStorageKeyExists(normalizedName);
      if (!fileExists) {
        throw new HttpError(
          409,
          "Upload not found in storage. The chunked upload may be incomplete — please retry the upload.",
        );
      }
    }

    // The file is already in object storage from the chunked upload session.
    // We just need to register it in the inbox so it appears in the unassigned list.
    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId,
        uploadedByUserId: userId,
        originalFilename,
        mimeType,
        sizeBytes,
        storagePath: normalizedName,
        objectStorageKey: normalizedName,
        note,
      })
      .returning()
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to save inbox file." }),
      );

    return ok(res, row, 201);
  }),
);

router.get(
  "/:fileId/file",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const fileId = String(req.params["fileId"] ?? "");

    const inboxFile = await db.query.labInboxFiles.findFirst({
      where: eq(labInboxFiles.id, fileId),
    });

    if (!inboxFile) throw new HttpError(404, "Inbox file not found.");

    // Lab members, plus the provider who sent this row, may open the file.
    await assertInboxFileReadAccess(userId, inboxFile);

    // Read-time repair: legacy rows may carry a full public URL in
    // storagePath / objectStorageKey instead of the bare stored filename.
    const diskFileName = normalizeInboxStorageName(inboxFile.storagePath);
    const diskPath = diskFileName ? path.resolve(caseMediaDir, diskFileName) : null;
    const safeName = encodeURIComponent(inboxFile.originalFilename ?? "file").replace(/'/g, "%27");

    if (diskPath && fs.existsSync(diskPath)) {
      res.setHeader("Content-Type", inboxFile.mimeType || "application/octet-stream");
      // Inbox files are untrusted user uploads. Always download rather than
      // render under the API origin, and prevent MIME sniffing.
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=300");
      const stream = fs.createReadStream(diskPath);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.status(404).json({ ok: false, error: "File not found." });
        }
      });
      stream.pipe(res);
      return;
    }

    // Disk file missing — try object storage (chunked-upload path).
    // Fall back to the normalized storagePath when objectStorageKey itself
    // does not normalize (legacy URL-shaped rows stored the URL in both).
    const objectKey =
      normalizeInboxStorageName(inboxFile.objectStorageKey) ?? diskFileName;
    const objStream = objectKey
      ? await openCaseMediaObjectStream(objectKey, inboxFile.mimeType ?? undefined)
      : null;

    if (!objStream) {
      throw new HttpError(404, "File not found on storage.");
    }

    res.setHeader("Content-Type", objStream.contentType);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    objStream.stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).json({ ok: false, error: "File not found." });
      }
    });
    objStream.stream.pipe(res);
  }),
);

router.delete(
  "/:fileId",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const fileId = String(req.params["fileId"] ?? "");

    const inboxFile = await db.query.labInboxFiles.findFirst({
      where: eq(labInboxFiles.id, fileId),
    });
    if (!inboxFile) throw new HttpError(404, "Inbox file not found.");
    if (inboxFile.assignedAt) {
      throw new HttpError(409, "Cannot delete a file that has already been assigned to a case.");
    }
    await assertLabMembership(userId, inboxFile.labOrganizationId);

    if (inboxFile.storagePath) {
      const srcPath = path.resolve(caseMediaDir, inboxFile.storagePath);
      if (fs.existsSync(srcPath)) {
        const trashDir = path.resolve(caseMediaDir, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        const trashName = `${Date.now()}__${path.basename(inboxFile.storagePath)}`;
        fs.renameSync(srcPath, path.resolve(trashDir, trashName));
      }
    }

    await db.delete(labInboxFiles).where(eq(labInboxFiles.id, fileId));

    return ok(res, { deleted: true });
  }),
);

router.patch(
  "/:fileId",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const fileId = String(req.params["fileId"] ?? "");
    const note = parseInboxNote(req.body?.note);

    const inboxFile = await db.query.labInboxFiles.findFirst({
      where: eq(labInboxFiles.id, fileId),
      columns: {
        labOrganizationId: true,
        assignedAt: true,
      },
    });
    if (!inboxFile) throw new HttpError(404, "Inbox file not found.");

    await assertLabMembership(userId, inboxFile.labOrganizationId);
    if (inboxFile.assignedAt) {
      throw new HttpError(409, "Cannot update a note after the document has been assigned.");
    }

    const [updated] = await db
      .update(labInboxFiles)
      .set({ note, updatedAt: new Date() })
      .where(
        and(
          eq(labInboxFiles.id, fileId),
          isNull(labInboxFiles.assignedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw new HttpError(409, "Cannot update a note after the document has been assigned.");
    }

    return ok(res, updated);
  }),
);

const bulkDeleteLabInboxSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(50),
  labOrganizationId: z.string().min(1),
});

router.delete(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const parsed = bulkDeleteLabInboxSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid request: " + parsed.error.issues.map((i) => i.message).join(", "));
    }
    const { fileIds, labOrganizationId } = parsed.data;
    await assertLabMembership(userId, labOrganizationId);

    const rows = await db.query.labInboxFiles.findMany({
      where: and(
        inArray(labInboxFiles.id, fileIds),
        eq(labInboxFiles.labOrganizationId, labOrganizationId),
        isNull(labInboxFiles.assignedAt),
      ),
    });

    if (rows.length > 0) {
      const trashDir = path.resolve(caseMediaDir, ".trash");
      fs.mkdirSync(trashDir, { recursive: true });

      for (const file of rows) {
        if (file.storagePath) {
          const srcPath = path.resolve(caseMediaDir, file.storagePath);
          if (fs.existsSync(srcPath)) {
            const trashName = `${Date.now()}__${path.basename(file.storagePath)}`;
            fs.renameSync(srcPath, path.resolve(trashDir, trashName));
          }
        }
      }

      await db
        .delete(labInboxFiles)
        .where(inArray(labInboxFiles.id, rows.map((r) => r.id)));
    }

    return ok(res, { deletedCount: rows.length });
  }),
);

router.post(
  "/:fileId/assign",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const fileId = String(req.params["fileId"] ?? "");
    const body = z
      .object({ caseId: z.string().min(1) })
      .safeParse(req.body);

    if (!body.success) {
      throw new HttpError(400, "caseId is required.");
    }
    const { caseId } = body.data;

    // Load actor info before the transaction (read-only, no lock needed).
    const [actorUser, targetCase] = await Promise.all([
      db.query.users.findFirst({ where: eq(users.id, userId) }),
      db.query.cases.findFirst({
        where: and(eq(cases.id, caseId), notDeleted(cases)),
      }),
    ]);

    if (!targetCase) throw new HttpError(404, "Case not found.");

    const displayName =
      actorUser
        ? [actorUser.firstName, actorUser.lastName].filter(Boolean).join(" ") ||
          actorUser.username
        : "Someone";
    const actorInitials =
      actorUser?.initials ?? actorUser?.username?.slice(0, 2).toUpperCase() ?? "?";

    // Transactional assign — prevents double-assign races.
    const { attachment } = await db.transaction(async (tx) => {
      // Re-read inbox file inside the transaction with a SELECT … FOR UPDATE equivalent
      // (Drizzle doesn't expose advisory locks, but re-reading inside the tx ensures
      // we see the committed state of assignedAt before mutating).
      const inboxFile = await tx.query.labInboxFiles.findFirst({
        where: eq(labInboxFiles.id, fileId),
      });

      if (!inboxFile) throw new HttpError(404, "Inbox file not found.");
      if (inboxFile.assignedAt) {
        throw new HttpError(409, "This file has already been assigned to a case.");
      }
      if (!inboxFile.storagePath) {
        throw new HttpError(400, "This entry has no file and cannot be assigned to a case.");
      }
      if (inboxFile.labOrganizationId !== targetCase.labOrganizationId) {
        throw new HttpError(403, "That case belongs to a different lab.");
      }

      await assertLabMembership(userId, inboxFile.labOrganizationId);

      // Copy the file to a new case-attachment storage key so the case
      // attachment path is distinct from the inbox staging path.
      const ext = path.extname(inboxFile.originalFilename ?? "") || "";
      const attachmentDiskFilename = `${Date.now()}-${randomUUID()}${ext}`;
      // Read-time repair: legacy rows may carry a full public URL instead of
      // the bare stored filename (same normalization as the serving route).
      const srcFileName = normalizeInboxStorageName(inboxFile.storagePath);
      const srcPath = srcFileName ? path.resolve(caseMediaDir, srcFileName) : null;
      const dstPath = path.resolve(caseMediaDir, attachmentDiskFilename);

      if (srcPath && fs.existsSync(srcPath)) {
        await copyFile(srcPath, dstPath);
      } else {
        // Disk file missing — file was uploaded via the chunked/mobile path and
        // only lives in object storage.  Download it so the attachment gets its
        // own local copy for the object-storage mirror step below.
        const objectKey =
          normalizeInboxStorageName(inboxFile.objectStorageKey) ?? srcFileName;
        if (!objectKey || !caseMediaObjectStorageAvailable()) {
          throw new HttpError(404, "Inbox file not found on disk or object storage.");
        }
        const objStream = await openCaseMediaObjectStream(
          objectKey,
          inboxFile.mimeType ?? undefined,
        );
        if (!objStream) {
          throw new HttpError(404, "Inbox file not found on disk or object storage.");
        }
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          objStream.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          objStream.stream.on("end", resolve);
          objStream.stream.on("error", reject);
        });
        fs.mkdirSync(caseMediaDir, { recursive: true });
        await writeFile(dstPath, Buffer.concat(chunks));
      }

      const resolvedMimeType = inboxFile.mimeType ?? "application/octet-stream";

      // Mirror the new attachment key to object storage (best-effort).
      if (caseMediaObjectStorageAvailable()) {
        try {
          const buffer = await readFile(dstPath);
          await writeCaseMediaToObjectStorage(
            attachmentDiskFilename,
            buffer,
            resolvedMimeType,
          );
        } catch (err: any) {
          req.log.warn({ err: err?.message }, "Lab inbox assign: object storage copy failed; disk-only");
        }
      }

      const [att] = await tx
        .insert(caseAttachments)
        .values({
          caseId,
          uploadedByUserId: userId,
          uploadedByOrganizationId: inboxFile.labOrganizationId,
          fileName: inboxFile.originalFilename ?? "",
          storageKey: attachmentDiskFilename,
          fileType: resolvedMimeType,
          visibility: "internal_lab_only",
          note: inboxFile.note,
        })
        .returning()
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to create case attachment." }),
        );

      await tx
        .update(labInboxFiles)
        .set({
          assignedAt: new Date(),
          assignedToCaseId: caseId,
          assignedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(labInboxFiles.id, fileId))
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to mark inbox file as assigned." }),
        );

      await tx
        .insert(caseEvents)
        .values({
          caseId,
          eventType: "file_assigned_from_inbox",
          actorUserId: userId,
          actorOrganizationId: inboxFile.labOrganizationId,
          actorInitials,
          metadataJson: {
            attachmentId: att.id,
            fileName: inboxFile.originalFilename,
            fileType: inboxFile.mimeType,
            description: `${displayName} added ${inboxFile.originalFilename ?? "a file"} to this case.`,
            ...(inboxFile.note ? { providerNote: inboxFile.note } : {}),
          },
        })
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to record timeline event." }),
        );

      return { attachment: att };
    });

    return ok(res, { attachmentId: attachment.id, caseId });
  }),
);

export default router;
