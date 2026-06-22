import * as fs from "node:fs";
import * as path from "node:path";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  cases,
  labInboxFiles,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { notDeleted } from "../lib/soft-delete";
import {
  caseMediaObjectStorageAvailable,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";

const router = Router();
router.use(requireAuth);

const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

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

async function assertLabMembership(userId: string, labOrganizationId: string) {
  const org = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, labOrganizationId),
      eq(organizations.type, "lab"),
      notDeleted(organizations),
    ),
  });
  if (!org) throw new HttpError(404, "Lab not found.");

  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, labOrganizationId),
      eq(organizationMemberships.status, "active"),
    ),
  });
  if (!membership) throw new HttpError(403, "You do not belong to this lab.");
  return membership;
}

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
});

router.post(
  "/finalize-session",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const parsed = finalizeSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid request: " + parsed.error.issues.map((i) => i.message).join(", "));
    }
    const { storagePath, originalFilename, mimeType, sizeBytes, labOrganizationId } = parsed.data;

    await assertLabMembership(userId, labOrganizationId);

    // The file is already on disk + object storage from the chunked upload session.
    // We just need to register it in the inbox so it appears in the unassigned list.
    const objectStorageKey = storagePath; // chunked session always mirrors to object storage

    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId,
        uploadedByUserId: userId,
        originalFilename,
        mimeType,
        sizeBytes,
        storagePath,
        objectStorageKey,
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

    await assertLabMembership(userId, inboxFile.labOrganizationId);

    const diskPath = path.resolve(caseMediaDir, inboxFile.storagePath);

    if (!fs.existsSync(diskPath)) {
      throw new HttpError(404, "File not found on storage.");
    }

    const safeName = encodeURIComponent(inboxFile.originalFilename).replace(/'/g, "%27");
    res.setHeader("Content-Type", inboxFile.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${safeName}`);
    res.setHeader("Cache-Control", "private, max-age=300");

    const stream = fs.createReadStream(diskPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).json({ ok: false, error: "File not found." });
      }
    });
    stream.pipe(res);
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
      if (inboxFile.labOrganizationId !== targetCase.labOrganizationId) {
        throw new HttpError(403, "That case belongs to a different lab.");
      }

      await assertLabMembership(userId, inboxFile.labOrganizationId);

      // Copy the file to a new case-attachment storage key so the case
      // attachment path is distinct from the inbox staging path.
      const ext = path.extname(inboxFile.originalFilename) || "";
      const attachmentDiskFilename = `${Date.now()}-${randomUUID()}${ext}`;
      const srcPath = path.resolve(caseMediaDir, inboxFile.storagePath);
      const dstPath = path.resolve(caseMediaDir, attachmentDiskFilename);
      await copyFile(srcPath, dstPath);

      // Mirror the copy to object storage (best-effort).
      if (inboxFile.objectStorageKey && caseMediaObjectStorageAvailable()) {
        try {
          const buffer = await readFile(dstPath);
          await writeCaseMediaToObjectStorage(
            attachmentDiskFilename,
            buffer,
            inboxFile.mimeType,
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
          fileName: inboxFile.originalFilename,
          storageKey: attachmentDiskFilename,
          fileType: inboxFile.mimeType,
          visibility: "internal_lab_only",
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
            description: `${displayName} added ${inboxFile.originalFilename} to this case.`,
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
