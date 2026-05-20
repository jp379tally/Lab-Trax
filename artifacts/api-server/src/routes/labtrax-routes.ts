import express, { Router, type IRouter } from "express";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import archiver from "archiver";
import { uploadToOneDrive } from "../lib/onedrive";
import {
  getDesktopInstallerMetadata,
  uploadDesktopInstaller,
  installerKindFromUrl,
  DesktopInstallerNotConfiguredError,
  type DesktopInstallerKind,
} from "../lib/desktop-installer-storage";
import { runOneDriveBackup, runBackup, getBackupHourUtc, getBackupScheduleConfig, getLastSuccessfulBackupAt, getBackupStaleAlertSettings, getBackupHistoryRetentionDays, restartScheduledBackupJob, executeRestore, getRestoreState, SETTING_BACKUP_HOUR_UTC, SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, SETTING_BACKUP_SCHEDULE_DESTINATION, SETTING_BACKUP_SCHEDULE_PATH, SETTING_BACKUP_SCHEDULE_ENABLED, SETTING_BACKUP_LAST_SUCCESSFUL_AT, SETTING_BACKUP_HISTORY_RETENTION_DAYS, SETTING_BACKUP_HISTORY_MAX_ROWS, SETTING_ROLLING_BACKUP_ENABLED, SETTING_ROLLING_BACKUP_LAST_RUN_AT, SETTING_ROLLING_BACKUP_LAST_ERROR, ALL_SCHEDULE_SETTINGS, SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS, SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS, SETTING_BACKUP_STALE_DAYS, DEFAULT_BACKUP_STALE_DAYS, type BackupDestination } from "../lib/backup";
import { sendInstallerPublishFailureAlertEmail } from "../lib/mail";
import { cleanupOrphanedCaseMedia, runAndPersistCleanup, getCleanupAlertThresholds, getCleanupHistoryRetentionDays, getCleanupHourUtc, getCleanupProgress, getCleanupStuckTimeoutMinutes, cancelCleanup, CleanupAlreadyRunningError, SETTING_CLEANUP_MIN_REMOVED, SETTING_CLEANUP_MIN_FREED_MB, SETTING_CLEANUP_HISTORY_RETENTION_DAYS, SETTING_CLEANUP_HOUR_UTC, SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES } from "../lib/case-media";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { db } from "@workspace/db";
import { users, labCases, labPendingFiles, labPendingFileNoteEdits, organizations, organizationMemberships, cases as casesTable, caseAttachments, caseEvents, mediaCleanupRuns, systemSettings, installerChangelog, installerUploads, subscriptions, backupRuns, rxPracticeNameAliases } from "@workspace/db";
import { notDeleted } from "../lib/soft-delete";
import { eq, and, inArray, or, isNull, sql, desc, count, type SQL } from "drizzle-orm";
import { hashPassword } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { requireAuth, optionalAuth } from "../middlewares/auth";
import { parseOrganizationIdFromAffiliationKey } from "../lib/case-visibility";

// Look up the set of lab organization ids the given user is an active member
// of. This is the SINGLE source of truth used to decide which lab cases the
// user can see or write — clients never get to influence this set.
async function fetchUserActiveLabIds(userId: string): Promise<string[]> {
  const memberships = await db
    .select({ labId: organizationMemberships.labId })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
        eq(organizations.type, "lab")
      )
    );
  const ids = new Set<string>();
  for (const row of memberships) {
    if (row.labId) ids.add(row.labId);
  }
  return Array.from(ids);
}

import authRoutes from "./auth";
import organizationRoutes from "./organizations";
import caseRoutes from "./cases";
import doctorRoutes from "./doctors";
import invoiceRoutes from "./invoices";
import accountLinksRoutes, { smsInboundRouter } from "./account-links";
import financeRoutes, { generateForOrganization } from "./finance";
import pricingRoutes from "./pricing";
import statementRoutes from "./statements";
import billingRoutes from "./billing";
import notificationsRoutes from "./notifications";
import usersRoutes from "./users";

const verificationCodes = new Map<string, { code: string; expiresAt: number }>();
const passwordResetTokens = new Map<string, { userId: string; expiresAt: number }>();
const DEMO_SEED_USERS_ENABLED = process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true";
let cachedOpenAIClient: OpenAI | null | undefined;

function getOpenAIClient(): OpenAI | null {
  if (cachedOpenAIClient !== undefined) {
    return cachedOpenAIClient;
  }

  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    cachedOpenAIClient = null;
    return null;
  }

  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  cachedOpenAIClient = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return cachedOpenAIClient;
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isPlatformAdmin(req: any): boolean {
  const reqUser = req.user;
  if (!reqUser || reqUser.role !== "admin") return false;
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (!secret) return false;
  return req.headers["x-platform-admin-secret"] === secret;
}

// Service-to-service auth for a tiny, explicit set of admin endpoints that are
// safe to drive from CI/automation (e.g. the GitHub Actions "publish desktop
// installer" step). When the X-Platform-Admin-Secret header matches the env
// secret, attach a synthetic admin user and skip the JWT/session check.
// Otherwise fall through to the normal user requireAuth flow. The downstream
// isPlatformAdmin() call then succeeds for both paths because (a) the
// synthetic user has role:"admin" and (b) the header still matches.
//
// Disabling the CI path: unset PLATFORM_ADMIN_SECRET in the environment.
// Note: the existing isPlatformAdmin() check also requires PLATFORM_ADMIN_SECRET
// to be set, so unsetting it locks out CI **and** human admins; a deployment
// that wants only human admins on these endpoints should leave the secret set
// and simply not configure it on the GitHub Actions side.
function platformAdminUserOrSecret(req: any, res: any, next: any) {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  const header = req.headers["x-platform-admin-secret"];
  if (secret && header === secret && !req.user) {
    req.user = {
      id: null,
      username: "ci:platform-admin-secret",
      role: "admin",
      isActive: true,
    };
    return next();
  }
  return requireAuth(req, res, next);
}

function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

function normalizeLegacyCaseAffiliationName(name?: string | null) {
  return name?.trim().toLowerCase() || "";
}

function buildLegacyPrivateAffiliationKey(userId?: string | null) {
  return userId ? `private:${userId}` : null;
}

function buildLegacyOrganizationAffiliationKey(organizationId?: string | null) {
  return organizationId ? `org:${organizationId}` : null;
}

function buildLegacyLabAffiliationKey(name?: string | null) {
  const normalizedName = normalizeLegacyCaseAffiliationName(name);
  return normalizedName ? `lab:${normalizedName}` : null;
}

function resolveLegacyCaseAffiliationKeys(labCase: any) {
  const keys = new Set<string>();

  if (typeof labCase?.affiliationKey === "string" && labCase.affiliationKey.trim()) {
    keys.add(labCase.affiliationKey.trim());
  }

  const legacyLabAffiliationKey = buildLegacyLabAffiliationKey(
    typeof labCase?.affiliationName === "string" ? labCase.affiliationName : null
  );
  if (legacyLabAffiliationKey) {
    keys.add(legacyLabAffiliationKey);
  }

  if (keys.size === 0) {
    const privateAffiliationKey = buildLegacyPrivateAffiliationKey(
      typeof labCase?.ownerId === "string" ? labCase.ownerId : null
    );
    if (privateAffiliationKey) {
      keys.add(privateAffiliationKey);
    }
  }

  return Array.from(keys);
}

type LegacyChatThread = {
  id: string;
  participants: string[];
  createdAt: number;
  updatedAt: number;
};

type LegacyChatMessage = {
  id: string;
  conversationId: string;
  senderUsername: string;
  content: string;
  imageUri?: string;
  timestamp: number;
  readBy: string[];
};

type LegacyChatStore = {
  threads: LegacyChatThread[];
  messages: LegacyChatMessage[];
};

const legacyChatStorePath = path.join(
  process.cwd(),
  "server",
  ".data",
  "legacy-chat.json"
);

function normalizeUsernameKey(username?: string | null) {
  return username?.trim().toLowerCase() || "";
}

function buildDirectConversationId(usernameA?: string | null, usernameB?: string | null) {
  const normalizedUsers = [usernameA, usernameB]
    .map((value) => normalizeUsernameKey(value))
    .filter(Boolean)
    .sort();

  if (normalizedUsers.length < 2) {
    return null;
  }

  return `dm:${normalizedUsers.join("::")}`;
}

async function readLegacyChatStore(): Promise<LegacyChatStore> {
  try {
    const raw = await readFile(legacyChatStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      threads: Array.isArray(parsed?.threads) ? parsed.threads : [],
      messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
    };
  } catch {
    return { threads: [], messages: [] };
  }
}

async function writeLegacyChatStore(store: LegacyChatStore) {
  await mkdir(path.dirname(legacyChatStorePath), { recursive: true });
  await writeFile(legacyChatStorePath, JSON.stringify(store, null, 2), "utf8");
}

const DEFAULT_USERS = [
  { username: "labadmin_demo", password: "LabTraxDemo#2026", userType: "lab", role: "admin", email: "labadmin_demo@labtrax.local", accountNumber: "LAB-001" },
  { username: "labtech_demo", password: "LabTraxDemo#2026", userType: "lab", role: "user", email: "labtech_demo@labtrax.local", accountNumber: "LAB-002" },
  { username: "master_demo", password: "LabTraxDemo#2026", userType: "master_admin", role: "admin", email: "master_demo@labtrax.local", accountNumber: "MA-001" },
];

async function seedDefaultUsers() {
  if (!DEMO_SEED_USERS_ENABLED) {
    return;
  }

  const existingUsers = await db.select().from(users);
  const existingUsernames = new Set(existingUsers.map((user) => user.username.toLowerCase()));

  for (const def of DEFAULT_USERS) {
    if (existingUsernames.has(def.username.toLowerCase())) {
      continue;
    }

    const hashed = await hashPassword(def.password);
    await db.insert(users).values({
      username: def.username,
      password: hashed,
      email: (def as any).email || null,
      phone: (def as any).phone || null,
      userType: def.userType,
      role: def.role,
      accountNumber: (def as any).accountNumber || null,
      initials: def.username.slice(0, 2).toUpperCase(),
    });
    existingUsernames.add(def.username.toLowerCase());
    console.log(`[SEED] Created demo user: ${def.username}`);
  }
}

const casMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

const caseMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(casMediaDir, { recursive: true });
    cb(null, casMediaDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".bin";
    const safeBase = path
      .basename(file.originalname || "media", ext)
      .replace(/[^a-zA-Z0-9\-_]+/g, "-")
      .slice(0, 60) || "media";
    cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`);
  },
});

const caseMediaUpload = multer({
  storage: caseMediaStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Resumable chunked-upload session storage. Each session is one in-progress
// file split across many small HTTP requests so that a dropped connection or
// browser refresh only loses the current chunk, not the whole transfer.
const uploadSessionsDir = path.resolve(casMediaDir, ".sessions");
const MAX_RESUMABLE_FILE_BYTES = 200 * 1024 * 1024;
const MAX_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface UploadSessionMeta {
  sessionId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  finalName: string;
  createdAt: number;
}

function uploadSessionPaths(sessionId: string) {
  return {
    metaPath: path.resolve(uploadSessionsDir, `${sessionId}.json`),
    partPath: path.resolve(uploadSessionsDir, `${sessionId}.part`),
  };
}

function isSafeSessionId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

function readUploadSessionMeta(sessionId: string): UploadSessionMeta | null {
  if (!isSafeSessionId(sessionId)) return null;
  const { metaPath } = uploadSessionPaths(sessionId);
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.fileName === "string" &&
      typeof parsed.fileSize === "number" &&
      typeof parsed.mimeType === "string" &&
      typeof parsed.finalName === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed as UploadSessionMeta;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getCurrentUploadOffset(sessionId: string): number {
  const { partPath } = uploadSessionPaths(sessionId);
  try {
    return fs.statSync(partPath).size;
  } catch {
    return 0;
  }
}

function destroyUploadSession(sessionId: string): void {
  const { metaPath, partPath } = uploadSessionPaths(sessionId);
  try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
  try { fs.unlinkSync(partPath); } catch { /* ignore */ }
}

function pruneStaleUploadSessions(): void {
  try {
    if (!fs.existsSync(uploadSessionsDir)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(uploadSessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const sessionId = entry.slice(0, -5);
      const meta = readUploadSessionMeta(sessionId);
      if (!meta || now - meta.createdAt > SESSION_MAX_AGE_MS) {
        destroyUploadSession(sessionId);
      }
    }
  } catch {
    /* ignore */
  }
}

export async function registerRoutes(): Promise<IRouter> {
  const router: IRouter = Router();
  await seedDefaultUsers();

  fs.mkdirSync(casMediaDir, { recursive: true });
  fs.mkdirSync(uploadSessionsDir, { recursive: true });
  pruneStaleUploadSessions();
  // Static uploads are served via app.ts

  function buildPublicMediaUrl(req: express.Request, filename: string): string {
    const forwardedHost = req.header("x-forwarded-host");
    const host = forwardedHost || req.get("host") || "localhost";
    const forwardedProto = req.header("x-forwarded-proto");
    const protocol = forwardedProto
      ? forwardedProto.split(",")[0].trim()
      : (req.protocol || "https");
    return `${protocol}://${host}/api/cases/attachment-file/${filename}`;
  }

  // --- Resumable upload session lifecycle ----------------------------------
  // The single-shot /media/upload endpoint below still works for small files
  // and the mobile client. Web clients that want to survive dropped
  // connections / page refreshes should:
  //   1. POST /media/upload-session         -> { sessionId, uploadedBytes }
  //   2. PATCH /media/upload-session/:id    (binary chunks, with Upload-Offset)
  //   3. The PATCH that finishes the file returns { complete: true, url, ... }
  //   4. GET /media/upload-session/:id      can be called any time to re-check
  //      the server's current uploadedBytes (e.g. after a refresh).

  router.post("/media/upload-session", requireAuth, (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : NaN;
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
    if (!fileName) {
      return res.status(400).json({ error: "fileName is required" });
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: "fileSize must be a positive number" });
    }
    if (fileSize > MAX_RESUMABLE_FILE_BYTES) {
      return res.status(413).json({ error: "File exceeds maximum upload size" });
    }
    const ext = path.extname(fileName) || ".bin";
    const safeBase =
      path
        .basename(fileName, ext)
        .replace(/[^a-zA-Z0-9\-_]+/g, "-")
        .slice(0, 60) || "media";
    const finalName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`;
    const sessionId = randomBytes(16).toString("hex");
    const meta: UploadSessionMeta = {
      sessionId,
      userId: reqUser.id,
      fileName,
      fileSize,
      mimeType,
      finalName,
      createdAt: Date.now(),
    };
    try {
      fs.mkdirSync(uploadSessionsDir, { recursive: true });
      const { metaPath, partPath } = uploadSessionPaths(sessionId);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      fs.writeFileSync(partPath, "");
    } catch (error: any) {
      console.error("Failed to create upload session:", error?.message || error);
      return res.status(500).json({ error: "Could not create upload session" });
    }
    return res.status(201).json({
      sessionId,
      uploadedBytes: 0,
      fileSize,
    });
  });

  router.get("/media/upload-session/:id", requireAuth, (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const sessionId = req.params.id as string;
    const meta = readUploadSessionMeta(sessionId);
    if (!meta || meta.userId !== reqUser.id) {
      return res.status(404).json({ error: "Upload session not found" });
    }
    return res.json({
      sessionId: meta.sessionId,
      uploadedBytes: getCurrentUploadOffset(sessionId),
      fileSize: meta.fileSize,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
    });
  });

  router.delete("/media/upload-session/:id", requireAuth, (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const sessionId = req.params.id as string;
    const meta = readUploadSessionMeta(sessionId);
    if (meta && meta.userId === reqUser.id) {
      destroyUploadSession(sessionId);
    }
    return res.status(204).end();
  });

  router.patch("/media/upload-session/:id", requireAuth, (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const sessionId = req.params.id as string;
    const meta = readUploadSessionMeta(sessionId);
    if (!meta || meta.userId !== reqUser.id) {
      return res.status(404).json({ error: "Upload session not found" });
    }
    const offsetHeader = req.header("upload-offset");
    const offset = Number(offsetHeader);
    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: "Upload-Offset header is required" });
    }
    const currentOffset = getCurrentUploadOffset(sessionId);
    if (offset !== currentOffset) {
      // Client is out of sync; tell it the real offset so it can resume.
      return res.status(409).json({
        error: "Upload-Offset does not match server state",
        uploadedBytes: currentOffset,
        fileSize: meta.fileSize,
      });
    }
    const declaredLength = Number(req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESUMABLE_CHUNK_BYTES) {
      return res.status(413).json({ error: "Chunk exceeds maximum size" });
    }
    if (Number.isFinite(declaredLength) && currentOffset + declaredLength > meta.fileSize) {
      return res.status(400).json({ error: "Chunk would exceed declared file size" });
    }

    const { partPath, metaPath } = uploadSessionPaths(sessionId);
    const writeStream = fs.createWriteStream(partPath, { flags: "a" });
    let bytesInThisChunk = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      bytesInThisChunk += chunk.length;
      if (currentOffset + bytesInThisChunk > meta.fileSize) {
        aborted = true;
        writeStream.destroy();
        try { req.destroy(); } catch { /* ignore */ }
      }
    });

    const handleError = (err: any) => {
      if (res.headersSent) return;
      console.error("Chunk write error:", err?.message || err);
      // Don't destroy the session — the client can re-query the offset and
      // retry from whatever was successfully appended before the failure.
      res.status(500).json({
        error: "Failed to persist chunk",
        uploadedBytes: getCurrentUploadOffset(sessionId),
      });
    };

    writeStream.on("error", handleError);
    req.on("error", handleError);

    writeStream.on("finish", () => {
      if (aborted) {
        if (!res.headersSent) {
          res.status(400).json({
            error: "Chunk would exceed declared file size",
            uploadedBytes: getCurrentUploadOffset(sessionId),
          });
        }
        return;
      }
      const newOffset = getCurrentUploadOffset(sessionId);
      if (newOffset >= meta.fileSize) {
        const finalPath = path.resolve(casMediaDir, meta.finalName);
        try {
          fs.renameSync(partPath, finalPath);
          try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
        } catch (error: any) {
          console.error("Failed to finalize upload:", error?.message || error);
          return res.status(500).json({ error: "Failed to finalize upload" });
        }
        return res.json({
          sessionId,
          uploadedBytes: meta.fileSize,
          fileSize: meta.fileSize,
          complete: true,
          url: buildPublicMediaUrl(req, meta.finalName),
          filename: meta.finalName,
          size: meta.fileSize,
        });
      }
      return res.json({
        sessionId,
        uploadedBytes: newOffset,
        fileSize: meta.fileSize,
        complete: false,
      });
    });

    req.pipe(writeStream);
    return;
  });

  router.post("/media/upload", requireAuth, caseMediaUpload.single("file"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const forwardedHost = req.header("x-forwarded-host");
      const host = forwardedHost || req.get("host") || "localhost";
      const forwardedProto = req.header("x-forwarded-proto");
      const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : (req.protocol || "https");
      const url = `${protocol}://${host}/api/cases/attachment-file/${req.file.filename}`;
      return res.json({ url, filename: req.file.filename, size: req.file.size });
    } catch (error: any) {
      console.error("Media upload error:", error?.message || error);
      return res.status(500).json({ error: "Upload failed" });
    }
  });

  async function getRepairableLabDirectoryData() {
    const allUsers = await db.select().from(users);
    const labAdmins = allUsers.filter(
      (user) =>
        user.userType === "lab" &&
        user.role === "admin" &&
        !!user.practiceName?.trim()
    );

    const labOrganizations = await db
      .select()
      .from(organizations)
      .where(eq(organizations.type, "lab"));

    const allLabMemberships = labOrganizations.length
      ? await db
          .select()
          .from(organizationMemberships)
          .where(
            inArray(
              organizationMemberships.labId,
              labOrganizations.map((organization) => organization.id)
            )
          )
      : [];

    const activeMemberships = labOrganizations.length
      ? await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              inArray(
                organizationMemberships.labId,
                labOrganizations.map((organization) => organization.id)
              ),
              eq(organizationMemberships.status, "active")
            )
          )
      : [];

    const activeLabMemberIds = new Set(
      activeMemberships.map((membership) => membership.userId)
    );
    const anyLabMemberIds = new Set(
      allLabMemberships.map((membership) => membership.userId)
    );

    for (const adminUser of labAdmins) {
      if (
        !adminUser.id ||
        activeLabMemberIds.has(adminUser.id) ||
        anyLabMemberIds.has(adminUser.id)
      ) {
        continue;
      }

      const normalizedPracticeName = adminUser.practiceName!.trim().toLowerCase();
      let organization =
        labOrganizations.find(
          (entry) =>
            entry.createdByUserId === adminUser.id &&
            (entry.displayName || entry.name).toLowerCase().trim() ===
              normalizedPracticeName
        ) ||
        labOrganizations.find(
          (entry) =>
            (entry.displayName || entry.name).toLowerCase().trim() ===
              normalizedPracticeName
        );

      if (!organization) {
        const [createdOrganization] = await db
          .insert(organizations)
          .values({
            type: "lab",
            name: adminUser.practiceName!.trim(),
            displayName: adminUser.practiceName!.trim(),
            billingEmail: adminUser.email || null,
            phone: adminUser.practicePhone || adminUser.phone || null,
            addressLine1: adminUser.practiceAddress || null,
            createdByUserId: adminUser.id,
          })
          .returning();

        organization = createdOrganization;
        labOrganizations.push(createdOrganization);
      }

      const hasActiveMembership = activeMemberships.some(
        (membership) =>
          membership.labId === organization.id &&
          membership.userId === adminUser.id &&
          membership.status === "active"
      );

      if (!hasActiveMembership) {
        const [createdMembership] = await db
          .insert(organizationMemberships)
          .values({
            labId: organization.id,
            userId: adminUser.id,
            role: "owner",
            status: "active",
            approvedByUserId: adminUser.id,
            joinedAt: new Date(),
          })
          .returning();

        activeMemberships.push(createdMembership);
      }

      activeLabMemberIds.add(adminUser.id);
    }

    return {
      allUsers,
      labOrganizations,
      activeMemberships,
    };
  }

  router.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
  });

  router.get("/labs/groups", async (_req, res) => {
    try {
      const { allUsers, labOrganizations, activeMemberships } =
        await getRepairableLabDirectoryData();

      const memberUserIds = [
        ...new Set(activeMemberships.map((membership) => membership.userId)),
      ];
      const memberUsers = allUsers.filter((user) => memberUserIds.includes(user.id));
      const userMap = new Map(memberUsers.map((u) => [u.id, u]));

      const groups = labOrganizations
        .map((organization) => {
          const organizationMembershipsForGroup = activeMemberships.filter(
            (membership) => membership.labId === organization.id
          );
          const adminMembership = organizationMembershipsForGroup.find(
            (membership) =>
              membership.role === "owner" || membership.role === "admin"
          );
          const createdByUser = organization.createdByUserId
            ? userMap.get(organization.createdByUserId)
            : undefined;
          const adminUser = adminMembership
            ? userMap.get(adminMembership.userId)
            : createdByUser;

          if (!adminUser?.username) {
            return null;
          }

          return {
            organizationId: organization.id,
            practiceName: organization.displayName || organization.name,
            username: adminUser.username,
            practiceAddress: [
              organization.addressLine1,
              organization.city,
              organization.state,
              organization.zip,
            ]
              .filter(Boolean)
              .join(", "),
            memberCount: organizationMembershipsForGroup.length,
          };
        })
        .filter(Boolean);

      res.json({ groups });
    } catch (error: any) {
      console.error("List lab groups error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch lab groups" });
    }
  });

  // Public lab lookup used by the signup flow when a provider needs to find
  // their lab by name to enter an account number against. Returns a small
  // shape — id + name + display name + city/state — so the client can let
  // the user confirm they picked the right lab. Limited to 20 matches to
  // bound abuse.
  router.get("/labs/lookup", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) {
        return res.json({ labs: [] });
      }
      const allLabs = await db
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.type, "lab"),
            eq(organizations.isActive, true)
          )
        );
      const needle = q.toLowerCase();
      const matches = allLabs
        .filter((lab) => {
          const haystack = `${lab.name} ${lab.displayName ?? ""} ${lab.city ?? ""}`
            .toLowerCase();
          return haystack.includes(needle);
        })
        .slice(0, 20)
        .map((lab) => ({
          id: lab.id,
          name: lab.name,
          displayName: lab.displayName || lab.name,
          city: lab.city || null,
          state: lab.state || null,
        }));
      return res.json({ labs: matches });
    } catch (error: any) {
      console.error("Lab lookup error:", error?.message || error);
      return res.status(500).json({ error: "Lab lookup failed" });
    }
  });

  router.use("/auth", authRoutes);
  router.use("/users", usersRoutes);
  router.use("/organizations", organizationRoutes);
  router.use("/cases", caseRoutes);
  router.use("/doctors", doctorRoutes);
  router.use("/invoices", invoiceRoutes);
  router.use("/account-links", accountLinksRoutes);
  // Twilio inbound webhook — must be reachable without auth/CSRF since
  // Twilio cannot send our session cookies. Verified by phone match.
  router.use("/sms", smsInboundRouter);
  // Internal cron endpoint: token-protected; iterates active lab orgs and
  // generates due projected entries from each org's recurring rules. Mounted
  // BEFORE the auth-wrapped finance router so it does not require a user JWT.
  router.post("/finance/jobs/run-all", async (req, res) => {
    const expected = process.env.FINANCE_JOB_TOKEN;
    if (!expected) {
      return res.status(503).json({
        error: "FINANCE_JOB_TOKEN is not configured on the server.",
      });
    }
    const provided =
      (req.headers["x-finance-job-token"] as string | undefined) || "";
    if (provided !== expected) {
      return res.status(401).json({ error: "Invalid job token." });
    }
    try {
      const orgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.type, "lab"),
            eq(organizations.isActive, true)
          )
        );
      let totalCreated = 0;
      const perOrg: Array<{ organizationId: string; created: number; ruleCount: number }> = [];
      const failedOrgs: Array<{ organizationId: string; error: string }> = [];
      for (const o of orgs) {
        try {
          const r = await generateForOrganization(o.id, null);
          totalCreated += r.created;
          perOrg.push({ organizationId: o.id, created: r.created, ruleCount: r.ruleCount });
        } catch (err: any) {
          const message = err?.message || String(err);
          console.error(`finance run-all: org ${o.id} failed:`, message);
          failedOrgs.push({ organizationId: o.id, error: message });
        }
      }
      return res.json({
        ok: true,
        organizations: perOrg.length,
        failed: failedOrgs.length,
        failedOrgs,
        totalCreated,
        perOrg,
      });
    } catch (err: any) {
      console.error("finance run-all failed:", err?.message || err);
      return res.status(500).json({ error: "Generation failed." });
    }
  });

  router.use("/finance", financeRoutes);
  router.use("/pricing", pricingRoutes);
  router.use("/lab-orgs", statementRoutes);
  router.use("/billing", billingRoutes);
  router.use("/notifications", notificationsRoutes);

  router.post("/audit-log", (_req, res) => {
    res.json({ ok: true });
  });

  // Diagnostic endpoint: lets the client report its own React state for a
  // given user so we can see — from the deployment logs — exactly what the
  // device thinks is in `allCases`, what the server returned, and which
  // membership keys are active. Each field is logged on its own line so the
  // 80-char log truncation does not hide the values.
  router.post("/_debug/client-state", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      const body = (req.body || {}) as Record<string, unknown>;
      const tag = `[CLIENT_STATE u=${userId || "?"}]`;
      console.log(`${tag} marker=${String(body.marker ?? "")}`);
      console.log(`${tag} username=${String(body.username ?? "")}`);
      console.log(`${tag} build=${String(body.build ?? "")}`);
      console.log(`${tag} allCasesLen=${String(body.allCasesLen ?? "")}`);
      console.log(`${tag} casesLen=${String(body.casesLen ?? "")}`);
      console.log(`${tag} hasActiveLab=${String(body.hasActiveLab ?? "")}`);
      console.log(`${tag} activeLabKey=${String(body.activeLabKey ?? "")}`);
      console.log(`${tag} activeLabName=${String(body.activeLabName ?? "")}`);
      console.log(`${tag} fetchOk=${String(body.fetchOk ?? "")}`);
      console.log(`${tag} serverCount=${String(body.serverCount ?? "")}`);
      console.log(`${tag} sample0=${String(body.sample0 ?? "")}`);
      console.log(`${tag} sample1=${String(body.sample1 ?? "")}`);
      console.log(`${tag} sample2=${String(body.sample2 ?? "")}`);
      console.log(`${tag} cacheLen=${String(body.cacheLen ?? "")}`);
      console.log(`${tag} fetchStatus=${String(body.fetchStatus ?? "")}`);
      console.log(`${tag} fetchErr=${String(body.fetchErr ?? "")}`);
      console.log(`${tag} probeStatus=${String(body.probeStatus ?? "")}`);
      console.log(`${tag} probeBytes=${String(body.probeBytes ?? "")}`);
      console.log(`${tag} probeParseOk=${String(body.probeParseOk ?? "")}`);
      console.log(`${tag} probeCount=${String(body.probeCount ?? "")}`);
      console.log(`${tag} probeErr=${String(body.probeErr ?? "")}`);
      console.log(`${tag} note=${String(body.note ?? "")}`);
      res.json({ ok: true });
    } catch (e: any) {
      console.log(`[CLIENT_STATE] error: ${e?.message || e}`);
      res.json({ ok: true });
    }
  });

  router.post("/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const allUsers = await db.select().from(users);
    const existing = allUsers.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    return res.json({ available: !existing });
  });

  router.post("/legacy/cases", requireAuth, async (req, res) => {
    try {
      const { id, ownerId, caseData } = req.body;
      if (!id || !ownerId || !caseData) {
        return res.status(400).json({ error: "id, ownerId, and caseData are required" });
      }

      const callerUserId = (req as any).auth?.userId as string | undefined;
      if (!callerUserId) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const callerLabIdsList = await fetchUserActiveLabIds(callerUserId);
      const callerLabIds = new Set(callerLabIdsList);

      // Wrap the auth check + write in a single transaction with a row lock
      // (SELECT ... FOR UPDATE) so a concurrent writer cannot slip in between
      // the authorization decision and the upsert. This closes the
      // check-then-write TOCTOU window on the ownership/visibility boundary.
      let result: { authError?: { status: number; message: string }; restoredFromTrash?: boolean } = {};
      try {
        result = await db.transaction(async (tx) => {
          const lockedRows = await tx.execute<{
            id: string;
            owner_id: string;
            organization_id: string | null;
            case_data: string;
            deleted_at: Date | null;
          }>(
            sql`SELECT id, owner_id, organization_id, case_data, deleted_at
                FROM lab_cases
                WHERE id = ${id}
                FOR UPDATE`
          );
          const lockedRow = (lockedRows as any).rows?.[0] ?? (Array.isArray(lockedRows) ? (lockedRows as any)[0] : null);

          // Authorization, performed AFTER the row lock so the decision
          // cannot be invalidated by a concurrent writer.
          //
          // Domain rule: "only active members of a lab can change the
          // lab's information." Translated to this endpoint:
          //   INSERT: caller may only create a case under their own id.
          //   UPDATE of a LAB case: caller must be an active member of
          //     that lab. Being the original scanner (owner) is NOT
          //     enough — once a case lives in a lab it is the lab's
          //     data, and only members may modify it.
          //   UPDATE of a PRIVATE case: caller must be the owner.
          if (!lockedRow) {
            if (ownerId !== callerUserId) {
              return {
                authError: {
                  status: 403,
                  message: "Cannot create a case under another user.",
                },
              };
            }
          } else {
            const existingOwner = lockedRow.owner_id;
            const existingOrg = lockedRow.organization_id;
            if (existingOrg) {
              const isLabMember = callerLabIds.has(existingOrg);
              if (!isLabMember) {
                return {
                  authError: {
                    status: 403,
                    message:
                      "Only active members of this lab can modify its cases.",
                  },
                };
              }
            } else {
              const isExistingOwner = existingOwner === callerUserId;
              if (!isExistingOwner) {
                return {
                  authError: {
                    status: 403,
                    message: "Not authorized to modify this case.",
                  },
                };
              }
            }
          }

          const wasSoftDeleted = !!lockedRow?.deleted_at;

          let normalizedCaseData: any;
          try {
            normalizedCaseData =
              typeof caseData === "string" ? JSON.parse(caseData) : caseData;
          } catch {
            normalizedCaseData = null;
          }
          if (!normalizedCaseData || typeof normalizedCaseData !== "object") {
            normalizedCaseData = { id, ownerId };
          }
          if (!normalizedCaseData.id) normalizedCaseData.id = id;
          if (!normalizedCaseData.ownerId) normalizedCaseData.ownerId = ownerId;

          if (lockedRow?.case_data) {
            try {
              const existingCaseData = JSON.parse(lockedRow.case_data);
              if (
                !normalizedCaseData.affiliationKey &&
                existingCaseData?.affiliationKey
              ) {
                normalizedCaseData.affiliationKey =
                  existingCaseData.affiliationKey;
              }
              if (
                (normalizedCaseData.affiliationName === undefined ||
                  normalizedCaseData.affiliationName === null ||
                  normalizedCaseData.affiliationName === "") &&
                existingCaseData?.affiliationName
              ) {
                normalizedCaseData.affiliationName =
                  existingCaseData.affiliationName;
              }
            } catch {
              // Ignore malformed legacy payloads.
            }
          }

          // Resolve the organization_id column from the case's
          // affiliationKey ("org:<UUID>"). Domain rule: only an active
          // member of the target lab may put a case there. If the
          // caller isn't a member, the org tag is silently stripped and
          // the case becomes private to them.
          //
          // Two safety checks gate the assignment:
          //   (a) the target org actually exists as type='lab' (no
          //       references to phantom orgs are ever persisted), and
          //   (b) the caller is an active member of that lab.
          const candidateOrgId = parseOrganizationIdFromAffiliationKey(
            normalizedCaseData?.affiliationKey
          );
          let organizationIdFromKey: string | null = null;
          if (candidateOrgId && callerLabIds.has(candidateOrgId)) {
            const [orgRow] = await tx
              .select({ id: organizations.id })
              .from(organizations)
              .where(
                and(
                  eq(organizations.id, candidateOrgId),
                  eq(organizations.type, "lab")
                )
              )
              .limit(1);
            if (orgRow) {
              organizationIdFromKey = candidateOrgId;
            }
          }

          // Keep the JSON view consistent with the column when the
          // affiliation was rejected (caller not a member, or org
          // doesn't exist). Trim first so whitespace-padded keys cannot
          // leave a stale `org:` value in the JSON.
          if (!organizationIdFromKey) {
            const rawKey =
              typeof normalizedCaseData.affiliationKey === "string"
                ? normalizedCaseData.affiliationKey.trim()
                : "";
            if (rawKey.startsWith("org:")) {
              normalizedCaseData.affiliationKey = null;
              normalizedCaseData.affiliationName = null;
            }
          }

          // Force ownerId for safety: inserts get the caller; updates keep
          // the existing owner so a lab member editing a shared case never
          // changes its ownership. The body's ownerId is ignored.
          const safeOwnerId = lockedRow ? lockedRow.owner_id : callerUserId;
          normalizedCaseData.ownerId = safeOwnerId;

          // On first insert of a remake-linked legacy case, append a
          // reciprocal "remake_of" entry to the new case's local
          // activityLog so the case has a visible history record on its
          // own side (mirroring the `remade_by` event we write on the
          // canonical original below). Two-way traceability is required
          // by Task #331.
          if (
            !lockedRow &&
            normalizedCaseData.isRemake === true &&
            typeof normalizedCaseData.remakeOfCaseId === "string" &&
            normalizedCaseData.remakeOfCaseId.length > 0
          ) {
            const reasonStr =
              typeof normalizedCaseData.remakeReason === "string" &&
              normalizedCaseData.remakeReason.trim().length > 0
                ? normalizedCaseData.remakeReason.trim()
                : null;
            const charged =
              normalizedCaseData.remakeCharged === false ||
              normalizedCaseData.price === 0
                ? false
                : true;
            const entry = {
              type: "remake_of",
              timestamp: Date.now(),
              user: "SYS",
              description: `Created as a remake of case ${normalizedCaseData.remakeOfCaseId}${
                reasonStr ? ` — reason: ${reasonStr}` : ""
              } (charged: ${charged ? "yes" : "no"})`,
              metadata: {
                remakeOfCaseId: normalizedCaseData.remakeOfCaseId,
                remakeReason: reasonStr,
                remakeCharged: charged,
              },
            };
            if (!Array.isArray(normalizedCaseData.activityLog)) {
              normalizedCaseData.activityLog = [];
            }
            normalizedCaseData.activityLog.push(entry);
          }

          const serializedCaseData = JSON.stringify(normalizedCaseData);
          await tx
            .insert(labCases)
            .values({
              id,
              ownerId: safeOwnerId,
              organizationId: organizationIdFromKey,
              caseData: serializedCaseData,
              updatedAt: new Date(),
              deletedAt: null,
              deletedBy: null,
            })
            .onConflictDoUpdate({
              target: labCases.id,
              set: {
                ownerId: safeOwnerId,
                organizationId: organizationIdFromKey,
                caseData: serializedCaseData,
                updatedAt: new Date(),
                deletedAt: null,
                deletedBy: null,
              },
            });

          return {
            restoredFromTrash: wasSoftDeleted,
            isNewInsert: !lockedRow,
            normalizedCaseData,
            organizationIdFromKey,
          };
        });
      } catch (txErr: any) {
        console.error("Legacy upsert case tx error:", txErr?.message || txErr);
        return res.status(500).json({ error: "Failed to save case" });
      }

      // Cross-link a remake created from the legacy mobile app to its
      // original canonical case (when the original lives in the canonical
      // `cases` table and is in the same lab). We only do this on the
      // first insert of a legacy case so re-syncs from the mobile app
      // don't double-write history entries. All work here is best-effort
      // and never fails the primary save.
      try {
        const data = (result as any).normalizedCaseData;
        const orgId = (result as any).organizationIdFromKey as string | null;
        const isNew = !!(result as any).isNewInsert;
        if (
          isNew &&
          orgId &&
          data &&
          data.isRemake === true &&
          typeof data.remakeOfCaseId === "string" &&
          data.remakeOfCaseId.length > 0
        ) {
          const reason =
            typeof data.remakeReason === "string" && data.remakeReason.trim().length > 0
              ? String(data.remakeReason).trim()
              : null;
          const charged =
            data.price === 0 || data.remakeCharged === false ? false : true;
          const originalCanonical = await db.query.cases.findFirst({
            where: and(
              eq(casesTable.id, String(data.remakeOfCaseId)),
              eq(casesTable.labOrganizationId, orgId),
              notDeleted(casesTable),
            ),
          });
          if (originalCanonical) {
            await db.insert(caseEvents).values({
              caseId: originalCanonical.id,
              eventType: "remade_by",
              actorUserId: callerUserId,
              actorOrganizationId: orgId,
              actorInitials: "SYS",
              metadataJson: {
                source: "legacy",
                legacyCaseId: id,
                legacyCaseNumber: data.caseNumber ?? null,
                remakeReason: reason,
                remakeCharged: charged,
                note: `Legacy mobile case ${data.caseNumber ?? id} created as a remake of this case${reason ? ` (reason: ${reason})` : ""}, charged: ${charged ? "yes" : "no"}`,
              },
            });
          } else {
            // Original may live in legacy lab_cases — append a remade_by
            // entry to its activityLog so the timeline is two-way for
            // legacy↔legacy pairings too (Task #331).
            const [originalLegacy] = await db
              .select()
              .from(labCases)
              .where(
                and(
                  eq(labCases.id, String(data.remakeOfCaseId)),
                  isNull(labCases.deletedAt),
                ),
              );
            if (originalLegacy && originalLegacy.organizationId === orgId) {
              // labCases stores the case as a JSON string in caseData;
              // activityLog lives inside that JSON.
              let parsed: any = {};
              try {
                parsed = JSON.parse(originalLegacy.caseData);
              } catch {
                parsed = {};
              }
              const prevLog = Array.isArray(parsed.activityLog)
                ? parsed.activityLog
                : [];
              const entry = {
                type: "remade_by",
                timestamp: Date.now(),
                user: "SYS",
                description: `Legacy mobile case ${data.caseNumber ?? id} created as a remake of this case${reason ? ` — reason: ${reason}` : ""} (charged: ${charged ? "yes" : "no"})`,
                metadata: {
                  source: "legacy",
                  legacyCaseId: id,
                  legacyCaseNumber: data.caseNumber ?? null,
                  remakeReason: reason,
                  remakeCharged: charged,
                },
              };
              parsed.activityLog = [...prevLog, entry];
              await db
                .update(labCases)
                .set({
                  caseData: JSON.stringify(parsed),
                  updatedAt: new Date(),
                })
                .where(eq(labCases.id, originalLegacy.id));
            }
          }
        }
      } catch (linkErr: any) {
        req.log?.warn?.(
          { err: linkErr?.message || String(linkErr) },
          "legacy_remake_link_failed",
        );
      }

      if (result.authError) {
        return res
          .status(result.authError.status)
          .json({ error: result.authError.message });
      }
      return res.json({ success: true, restoredFromTrash: !!result.restoredFromTrash });
    } catch (error: any) {
      console.error("Legacy upsert case error:", error?.message || error);
      return res.status(500).json({ error: "Failed to save case" });
    }
  });

  // Visibility is decided server-side from the authenticated user's lab
  // memberships. The endpoint deliberately ignores any client-supplied
  // scope/owner/viewer parameters so a stale or buggy client cannot hide
  // its own cases or expose someone else's.
  //
  //   visible = (organization_id IS NULL AND owner_id = me)
  //          OR organization_id IN (my active lab ids)
  //
  router.get("/legacy/cases", requireAuth, async (req, res) => {
    // Detect when the client closes the connection before we finish writing
    // the response. Express logs `200 in XXms` on `finish`; this `close`
    // listener captures the case where the socket was destroyed while we
    // were still streaming bytes — the symptom we'd see if the client's
    // fetch is timing out or being aborted mid-body.
    const started = Date.now();
    let finished = false;
    res.on("finish", () => {
      finished = true;
    });
    res.on("close", () => {
      if (!finished) {
        const userId = (req as any).auth?.userId as string | undefined;
        console.log(
          `[CASES_ABORT] u=${userId || "?"} after=${Date.now() - started}ms`
        );
      }
    });
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      if (!userId) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const labIds = await fetchUserActiveLabIds(userId);

      const conditions = [
        and(isNull(labCases.organizationId), eq(labCases.ownerId, userId)),
      ];
      if (labIds.length > 0) {
        conditions.push(inArray(labCases.organizationId, labIds));
      }

      const [rows, desktopCaseRows] = await Promise.all([
        db
          .select()
          .from(labCases)
          .where(and(isNull(labCases.deletedAt), or(...conditions))),
        labIds.length > 0
          ? db
              .select()
              .from(casesTable)
              .where(inArray(casesTable.labOrganizationId, labIds))
          : Promise.resolve([] as any[]),
      ]);

      // Preload organization display info so we can keep the JSON payload
      // (affiliationKey/affiliationName) in sync with the authoritative
      // organization_id column. After the startup backfill, some legacy rows
      // have an organization_id set but no matching affiliationKey in the
      // JSON — without this sync the client's defense-in-depth filter would
      // hide cases the server is returning.
      const orgIdsInResult = Array.from(
        new Set(
          rows
            .map((r) => r.organizationId)
            .filter((id): id is string => !!id)
        )
      );
      const orgInfoById = new Map<string, { displayName: string | null; name: string | null }>();
      if (orgIdsInResult.length > 0) {
        const orgRows = await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, orgIdsInResult));
        for (const o of orgRows) {
          orgInfoById.set(o.id, { displayName: o.displayName, name: o.name });
        }
      }

      // Status map: desktop → mobile legacy format
      const DESKTOP_TO_MOBILE_STATUS: Record<string, string> = {
        received: "INTAKE",
        in_design: "DESIGN",
        in_milling: "MILLING",
        in_porcelain: "PORCELAIN",
        qc: "QC_CHECK",
        shipped: "DELIVERY",
        delivered: "COMPLETE",
        on_hold: "ON_HOLD",
        remake: "REMAKE",
        cancelled: "COMPLETE",
      };

      const mobileCases = rows
        .map((row) => {
          try {
            const parsed = JSON.parse(row.caseData);
            if (!parsed || typeof parsed !== "object") return null;
            if (typeof parsed.ownerId !== "string" || !parsed.ownerId) {
              parsed.ownerId = row.ownerId;
            }
            if (row.organizationId) {
              parsed.organizationId = row.organizationId;
              parsed.affiliationKey = `org:${row.organizationId}`;
              const orgInfo = orgInfoById.get(row.organizationId);
              if (orgInfo) {
                parsed.affiliationName =
                  orgInfo.displayName || orgInfo.name || parsed.affiliationName || null;
              }
            } else {
              parsed.organizationId = null;
              if (
                typeof parsed.affiliationKey === "string" &&
                parsed.affiliationKey.trim().startsWith("org:")
              ) {
                parsed.affiliationKey = null;
                parsed.affiliationName = null;
              }
            }
            // Strip large binary fields from the list payload — photos and
            // activityLog can each be several MB per case (base64-encoded
            // images). The detail endpoint (GET /legacy/cases/:id) returns
            // full data; the list only needs metadata for the case list view.
            delete parsed.photos;
            delete parsed.videos;
            delete parsed.activityLog;
            return parsed;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // Bridge desktop structured cases into legacy format so the mobile app
      // can see cases entered on the desktop. IDs are stable UUIDs so there
      // is no collision with the timestamp-prefixed mobile IDs.
      const mobileIdsSet = new Set(mobileCases.map((c: any) => c?.id).filter(Boolean));
      const bridgedDesktopCases = desktopCaseRows
        .filter((dc) => !mobileIdsSet.has(dc.id))
        .map((dc) => {
          const orgInfo = orgInfoById.get(dc.labOrganizationId ?? "");
          const affiliationName = orgInfo
            ? orgInfo.displayName || orgInfo.name
            : null;
          const firstName = dc.patientFirstName ?? "";
          const lastName = dc.patientLastName ?? "";
          const patientName = [firstName, lastName].filter(Boolean).join(" ");
          const initials =
            (firstName[0] ?? "") + (lastName[0] ?? "");
          const mobileStatus =
            DESKTOP_TO_MOBILE_STATUS[dc.status ?? ""] ?? "INTAKE";
          const createdMs = dc.createdAt ? new Date(dc.createdAt).getTime() : Date.now();
          const updatedMs = dc.updatedAt ? new Date(dc.updatedAt).getTime() : createdMs;
          return {
            id: dc.id,
            caseNumber: dc.caseNumber ?? "",
            doctorName: dc.doctorName ?? "",
            patientName,
            patientInitials: initials || "?",
            status: mobileStatus,
            isRush: dc.priority === "rush",
            notes: "",
            price: null,
            dueDate: dc.dueDate ?? null,
            organizationId: dc.labOrganizationId ?? null,
            affiliationKey: dc.labOrganizationId ? `org:${dc.labOrganizationId}` : null,
            affiliationName,
            ownerId: dc.createdByUserId ?? null,
            createdAt: createdMs,
            updatedAt: updatedMs,
            // Surface canonical remake linkage on the legacy bridge so the
            // mobile case detail (`app/case/[id].tsx`) can render the
            // remake banner + "remade by N" panel for canonical-side
            // remakes the same way it does for native legacy ones.
            isRemake: !!(dc as any).remakeOfCaseId,
            remakeOfCaseId: (dc as any).remakeOfCaseId ?? null,
            remakeReason: (dc as any).remakeReason ?? null,
            remakeCharged:
              (dc as any).remakeCharged === null || (dc as any).remakeCharged === undefined
                ? null
                : !!(dc as any).remakeCharged,
            _sourceTable: "cases",
          };
        });

      const cases = [...mobileCases, ...bridgedDesktopCases]
        .filter(Boolean)
        .sort(
          (a: any, b: any) =>
            (Number(b.updatedAt) || Number(b.createdAt) || 0) -
            (Number(a.updatedAt) || Number(a.createdAt) || 0)
        );

      const payload = { cases };
      try {
        const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        const userId2 = (req as any).auth?.userId as string | undefined;
        console.log(
          `[CASES_SIZE] u=${userId2 || "?"} count=${cases.length} bytes=${bytes}`
        );
      } catch {}
      return res.json(payload);
    } catch (error: any) {
      console.error("Legacy get cases error:", error?.message || error);
      return res.status(500).json({ error: "Failed to fetch cases" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Lab pending files: a server-backed shared inbox for files that have been
  // dropped/uploaded by any member of a lab but not yet attached to a specific
  // case. All members of the same lab can see, download, annotate, and assign
  // these files from any device.
  // ──────────────────────────────────────────────────────────────────────────

  async function getCallerLabOrganizationIds(reqUser: any): Promise<string[]> {
    if (!reqUser?.id) return [];
    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, reqUser.id),
          eq(organizationMemberships.status, "active")
        )
      );
    if (memberships.length === 0) return [];
    const labIds = memberships.map((m) => m.labId);
    const orgs = await db
      .select()
      .from(organizations)
      .where(inArray(organizations.id, labIds));
    return orgs
      .filter((o) => o.type === "lab" && o.isActive !== false)
      .map((o) => o.id);
  }

  router.get("/lab-pending-files", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const requestedOrgId =
        typeof req.query.organizationId === "string"
          ? (req.query.organizationId as string).trim()
          : "";

      const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
      const isMasterAdmin = reqUser.userType === "master_admin";

      let allowedOrgIds: string[];
      if (requestedOrgId) {
        if (!isMasterAdmin && !callerOrgIds.includes(requestedOrgId)) {
          return res.json({ files: [] });
        }
        allowedOrgIds = [requestedOrgId];
      } else {
        allowedOrgIds = callerOrgIds;
      }

      if (allowedOrgIds.length === 0) {
        return res.json({ files: [] });
      }

      const rows = await db
        .select({
          file: labPendingFiles,
          editorFirstName: users.firstName,
          editorLastName: users.lastName,
          editorUsername: users.username,
        })
        .from(labPendingFiles)
        .leftJoin(users, eq(users.id, labPendingFiles.notesEditedByUserId))
        .where(inArray(labPendingFiles.organizationId, allowedOrgIds));

      const files = rows
        .map(({ file: row, editorFirstName, editorLastName, editorUsername }) => {
          const fullName = [editorFirstName, editorLastName]
            .map((part) => (typeof part === "string" ? part.trim() : ""))
            .filter(Boolean)
            .join(" ");
          const currentEditorName =
            (row.notesEditedByUserId
              ? fullName || (editorUsername ? editorUsername.trim() : "")
              : "") || null;
          return {
          id: row.id,
          organizationId: row.organizationId,
          uploaderUserId: row.uploaderUserId,
          uploaderName: row.uploaderName || null,
          fileUrl: row.fileUrl,
          fileName: row.fileName,
          mimeType: row.mimeType,
          notes: row.notes || "",
          notesUpdatedAt: row.notesUpdatedAt
            ? row.notesUpdatedAt instanceof Date
              ? row.notesUpdatedAt.toISOString()
              : new Date(row.notesUpdatedAt as any).toISOString()
            : null,
          notesEditedByUserId: row.notesEditedByUserId || null,
          notesEditedByName: currentEditorName || row.notesEditedByName || null,
          createdAt:
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : new Date(row.createdAt as any).toISOString(),
          };
        })
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

      return res.json({ files });
    } catch (error: any) {
      console.error("List pending files error:", error?.message || error);
      return res.status(500).json({ error: "Failed to list pending files" });
    }
  });

  router.post("/lab-pending-files", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const {
        organizationId,
        fileUrl,
        fileName,
        mimeType,
        notes,
        uploaderName,
      } = req.body || {};

      if (
        typeof organizationId !== "string" ||
        !organizationId.trim() ||
        typeof fileUrl !== "string" ||
        !fileUrl.trim() ||
        typeof fileName !== "string" ||
        !fileName.trim() ||
        typeof mimeType !== "string" ||
        !mimeType.trim()
      ) {
        return res.status(400).json({
          error: "organizationId, fileUrl, fileName, and mimeType are required",
        });
      }

      const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
      const isMasterAdmin = reqUser.userType === "master_admin";
      if (!isMasterAdmin && !callerOrgIds.includes(organizationId)) {
        return res.status(403).json({
          error: "You are not a member of this lab.",
        });
      }

      const [inserted] = await db
        .insert(labPendingFiles)
        .values({
          organizationId,
          uploaderUserId: reqUser.id,
          uploaderName:
            (typeof uploaderName === "string" && uploaderName.trim()) ||
            reqUser.username ||
            null,
          fileUrl: fileUrl.trim(),
          fileName: fileName.trim(),
          mimeType: mimeType.trim(),
          notes: typeof notes === "string" ? notes : "",
        })
        .returning();

      return res.json({
        success: true,
        file: {
          id: inserted.id,
          organizationId: inserted.organizationId,
          uploaderUserId: inserted.uploaderUserId,
          uploaderName: inserted.uploaderName || null,
          fileUrl: inserted.fileUrl,
          fileName: inserted.fileName,
          mimeType: inserted.mimeType,
          notes: inserted.notes || "",
          notesUpdatedAt: null,
          notesEditedByUserId: null,
          notesEditedByName: null,
          createdAt:
            inserted.createdAt instanceof Date
              ? inserted.createdAt.toISOString()
              : new Date(inserted.createdAt as any).toISOString(),
        },
      });
    } catch (error: any) {
      console.error("Create pending file error:", error?.message || error);
      return res.status(500).json({ error: "Failed to save pending file" });
    }
  });

  router.patch("/lab-pending-files/:id", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const id = req.params.id as string;
      const { notes } = req.body || {};
      if (typeof notes !== "string") {
        return res.status(400).json({ error: "notes (string) is required" });
      }

      const [existing] = await db
        .select()
        .from(labPendingFiles)
        .where(eq(labPendingFiles.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Pending file not found" });
      }

      const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
      const isMasterAdmin = reqUser.userType === "master_admin";
      if (!isMasterAdmin && !callerOrgIds.includes(existing.organizationId)) {
        return res.status(403).json({
          error: "You are not a member of this lab.",
        });
      }

      const editorName =
        (typeof reqUser.username === "string" && reqUser.username) ||
        (typeof reqUser.displayName === "string" && reqUser.displayName) ||
        null;
      const now = new Date();
      const previousNotes = existing.notes ?? "";

      // Skip the no-op case so we don't pollute the audit log with edits that
      // didn't actually change anything (e.g. the user opened the editor and
      // hit save without typing).
      const noteChanged = previousNotes !== notes;

      await db.transaction(async (tx) => {
        await tx
          .update(labPendingFiles)
          .set({
            notes,
            notesUpdatedAt: now,
            notesEditedByUserId: reqUser.id,
            notesEditedByName: editorName,
          })
          .where(eq(labPendingFiles.id, id));

        if (noteChanged) {
          await tx.insert(labPendingFileNoteEdits).values({
            pendingFileId: id,
            editorUserId: reqUser.id,
            editorName,
            oldNotes: previousNotes,
            newNotes: notes,
            createdAt: now,
          });
        }
      });

      return res.json({
        success: true,
        notesUpdatedAt: now.toISOString(),
        notesEditedByUserId: reqUser.id,
        notesEditedByName: editorName,
      });
    } catch (error: any) {
      console.error("Update pending file error:", error?.message || error);
      return res.status(500).json({ error: "Failed to update pending file" });
    }
  });

  // Read-only audit log of every change made to a pending file's notes,
  // most-recent first. Only members of the file's lab (or master admins) can
  // see it, mirroring the access rules on the underlying file row.
  router.get(
    "/lab-pending-files/:id/note-history",
    requireAuth,
    async (req, res) => {
      try {
        const reqUser = (req as any).user;
        if (!reqUser) {
          return res.status(401).json({ error: "Authentication required." });
        }
        const id = req.params.id as string;

        const [existing] = await db
          .select()
          .from(labPendingFiles)
          .where(eq(labPendingFiles.id, id));
        if (!existing) {
          return res.status(404).json({ error: "Pending file not found" });
        }

        const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
        const isMasterAdmin = reqUser.userType === "master_admin";
        if (!isMasterAdmin && !callerOrgIds.includes(existing.organizationId)) {
          return res.status(403).json({
            error: "You are not a member of this lab.",
          });
        }

        const rows = await db
          .select()
          .from(labPendingFileNoteEdits)
          .where(eq(labPendingFileNoteEdits.pendingFileId, id))
          .orderBy(desc(labPendingFileNoteEdits.createdAt));

        const edits = rows.map((row) => ({
          id: row.id,
          editorUserId: row.editorUserId,
          editorName: row.editorName || null,
          oldNotes: row.oldNotes ?? "",
          newNotes: row.newNotes ?? "",
          createdAt:
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : new Date(row.createdAt as any).toISOString(),
        }));

        return res.json({ edits });
      } catch (error: any) {
        console.error(
          "List pending file note history error:",
          error?.message || error
        );
        return res.status(500).json({ error: "Failed to list note history" });
      }
    }
  );

  router.delete("/lab-pending-files/:id", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const id = req.params.id as string;

      const [existing] = await db
        .select()
        .from(labPendingFiles)
        .where(eq(labPendingFiles.id, id));
      if (!existing) {
        return res.json({ success: true, alreadyMissing: true });
      }

      const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
      const isMasterAdmin = reqUser.userType === "master_admin";
      if (!isMasterAdmin && !callerOrgIds.includes(existing.organizationId)) {
        return res.status(403).json({
          error: "You are not a member of this lab.",
        });
      }

      await db.delete(labPendingFiles).where(eq(labPendingFiles.id, id));
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Delete pending file error:", error?.message || error);
      return res.status(500).json({ error: "Failed to delete pending file" });
    }
  });

  // Attach a pending inbox file to a specific case. Records a
  // caseAttachments row that points at the previously uploaded file URL,
  // then deletes the pending file so it disappears from the inbox.
  router.post("/lab-pending-files/:id/attach", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const id = req.params.id as string;
      const { caseId } = req.body || {};
      if (typeof caseId !== "string" || !caseId.trim()) {
        return res.status(400).json({ error: "caseId is required" });
      }

      const [pending] = await db
        .select()
        .from(labPendingFiles)
        .where(eq(labPendingFiles.id, id));
      if (!pending) {
        return res.status(404).json({ error: "Pending file not found" });
      }

      const callerOrgIds = await getCallerLabOrganizationIds(reqUser);
      const isMasterAdmin = reqUser.userType === "master_admin";
      if (!isMasterAdmin && !callerOrgIds.includes(pending.organizationId)) {
        return res.status(403).json({ error: "You are not a member of this lab." });
      }

      const [targetCase] = await db
        .select()
        .from(casesTable)
        .where(eq(casesTable.id, caseId.trim()));
      if (!targetCase) {
        return res.status(404).json({ error: "Case not found" });
      }
      if (targetCase.labOrganizationId !== pending.organizationId) {
        return res.status(403).json({
          error: "Case does not belong to this lab.",
        });
      }

      // Insert the attachment and remove the pending file in a single
      // transaction so a mid-flight failure can't leave the file in both
      // the inbox and the case attachments list.
      await db.transaction(async (tx) => {
        await tx.insert(caseAttachments).values({
          caseId: targetCase.id,
          uploadedByUserId: reqUser.id,
          uploadedByOrganizationId: pending.organizationId,
          fileName: pending.fileName,
          storageKey: pending.fileUrl,
          fileType: pending.mimeType,
        });
        await tx.delete(labPendingFiles).where(eq(labPendingFiles.id, id));
      });

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Attach pending file error:", error?.message || error);
      return res.status(500).json({ error: "Failed to attach pending file" });
    }
  });

  // ── Single-case fetch: returns full caseData including photos and
  //    activityLog that are stripped from the list endpoint to keep it lean.
  router.get("/legacy/cases/:caseId", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      if (!userId) return res.status(401).json({ error: "Authentication required." });

      const caseId = req.params.caseId as string;
      const labIds = await fetchUserActiveLabIds(userId);

      const rows = await db
        .select()
        .from(labCases)
        .where(and(eq(labCases.id, caseId), isNull(labCases.deletedAt)));

      if (rows.length) {
        const row = rows[0]!;
        // Enforce the same visibility rule as the list endpoint
        const isOwner = row.ownerId === userId;
        const isLabMember = row.organizationId ? labIds.includes(row.organizationId) : false;
        if (!isOwner && !isLabMember) {
          return res.status(403).json({ error: "Access denied." });
        }
        let parsed: any;
        try {
          parsed = JSON.parse(row.caseData);
        } catch {
          return res.status(500).json({ error: "Failed to parse case data." });
        }
        return res.json({ case: parsed });
      }

      // Not found in lab_cases — check the desktop cases table so that cases
      // created on the desktop also show history when opened in the mobile app.
      const desktopRows = await db
        .select()
        .from(casesTable)
        .where(and(eq(casesTable.id, caseId), isNull(casesTable.deletedAt)));

      if (!desktopRows.length) return res.status(404).json({ error: "Case not found." });
      const dc = desktopRows[0]!;

      // Authorization: caller must be a member of the case's lab
      if (!labIds.includes(dc.labOrganizationId)) {
        return res.status(403).json({ error: "Access denied." });
      }

      // Fetch any file attachments so the mobile history shows them
      const attachmentRows = await db
        .select()
        .from(caseAttachments)
        .where(and(eq(caseAttachments.caseId, caseId), isNull(caseAttachments.deletedAt)));

      const DESKTOP_TO_MOBILE_STATUS: Record<string, string> = {
        received: "INTAKE", in_design: "DESIGN", in_milling: "MILLING",
        in_porcelain: "PORCELAIN", qc: "QC_CHECK", shipped: "DELIVERY",
        delivered: "COMPLETE", on_hold: "ON_HOLD", remake: "REMAKE", cancelled: "COMPLETE",
      };

      const createdMs = dc.createdAt ? new Date(dc.createdAt).getTime() : Date.now();
      const updatedMs = dc.updatedAt ? new Date(dc.updatedAt).getTime() : createdMs;
      const mobileStatus = DESKTOP_TO_MOBILE_STATUS[dc.status ?? ""] ?? "INTAKE";
      const firstName = dc.patientFirstName ?? "";
      const lastName = dc.patientLastName ?? "";
      const patientName = [firstName, lastName].filter(Boolean).join(" ");
      const initials = (firstName[0] ?? "") + (lastName[0] ?? "");

      // Build a minimal activityLog so the History tab has content
      const activityLog: any[] = [
        {
          id: `desktop-created-${dc.id}`,
          type: "status",
          timestamp: createdMs,
          description: "Case received",
          user: "Lab",
        },
      ];

      if (dc.status && dc.status !== "received") {
        activityLog.push({
          id: `desktop-status-${dc.id}`,
          type: "status",
          timestamp: updatedMs,
          description: `Status: ${mobileStatus.charAt(0) + mobileStatus.slice(1).toLowerCase().replace(/_/g, " ")}`,
          user: "Lab",
        });
      }

      for (const att of attachmentRows) {
        const attMs = att.createdAt ? new Date(att.createdAt).getTime() : createdMs;
        const isPhoto = att.fileType?.startsWith("image/");
        activityLog.push({
          id: `desktop-att-${att.id}`,
          type: isPhoto ? "photo" : "document",
          timestamp: attMs,
          description: att.fileName ?? (isPhoto ? "Photo added" : "File added"),
          user: "Lab",
        });
      }

      // Sort chronologically
      activityLog.sort((a, b) => a.timestamp - b.timestamp);

      const synthesized: any = {
        id: dc.id,
        caseNumber: dc.caseNumber ?? "",
        doctorName: dc.doctorName ?? "",
        patientName,
        patientInitials: initials || "?",
        status: mobileStatus,
        isRush: dc.priority === "rush",
        notes: "",
        price: null,
        dueDate: dc.dueDate ?? null,
        organizationId: dc.labOrganizationId ?? null,
        affiliationKey: dc.labOrganizationId ? `org:${dc.labOrganizationId}` : null,
        ownerId: dc.createdByUserId ?? null,
        createdAt: createdMs,
        updatedAt: updatedMs,
        needsAiReview: dc.needsAiReview ?? false,
        aiImportSource: dc.aiImportSource ?? null,
        isRemake: !!dc.remakeOfCaseId,
        remakeOfCaseId: dc.remakeOfCaseId ?? null,
        remakeReason: dc.remakeReason ?? null,
        remakeCharged: dc.remakeCharged ?? null,
        photos: [],
        activityLog,
        _sourceTable: "cases",
      };

      return res.json({ case: synthesized });
    } catch (error: any) {
      console.error("Legacy get case by id error:", error?.message || error);
      return res.status(500).json({ error: "Failed to fetch case." });
    }
  });

  router.delete("/legacy/cases/:caseId", requireAuth, async (req, res) => {
    try {
      const caseId = req.params.caseId as string;
      const reqUser = (req as any).user;
      if (!reqUser) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const [existing] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, caseId));

      if (!existing) {
        // Idempotent: nothing to delete is treated as success so retries
        // don't fail the client.
        return res.json({ success: true, alreadyMissing: true });
      }

      // Authorization: only the owner, an admin/owner of an org the case
      // owner belongs to, or a master_admin may delete a case. This prevents
      // a buggy or compromised client from wiping data that doesn't belong
      // to its user.
      const isMasterAdmin = reqUser.userType === "master_admin";
      const isOwner = existing.ownerId === reqUser.id;
      let isOrgAdminForOwner = false;
      if (!isMasterAdmin && !isOwner) {
        const callerMemberships = await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.userId, reqUser.id),
              eq(organizationMemberships.status, "active")
            )
          );
        const callerAdminLabIds = callerMemberships
          .filter((m) => m.role === "admin" || m.role === "owner")
          .map((m) => m.labId);
        if (callerAdminLabIds.length > 0) {
          const ownerMemberships = await db
            .select()
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.userId, existing.ownerId),
                eq(organizationMemberships.status, "active"),
                inArray(organizationMemberships.labId, callerAdminLabIds)
              )
            );
          isOrgAdminForOwner = ownerMemberships.length > 0;
        }
      }

      if (!isMasterAdmin && !isOwner && !isOrgAdminForOwner) {
        return res
          .status(403)
          .json({ error: "Not authorized to delete this case." });
      }

      // SAFEGUARD: do NOT physically delete. Mark as deleted so an admin can
      // recover the case from the trash if the deletion was unintended (e.g.
      // a buggy client or accidental tap).
      await db
        .update(labCases)
        .set({
          deletedAt: new Date(),
          deletedBy: reqUser.username || reqUser.id || "unknown",
        })
        .where(eq(labCases.id, caseId));
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Legacy delete case error:", error?.message || error);
      return res.status(500).json({ error: "Failed to delete case" });
    }
  });

  // Helper: returns the set of owner_ids an admin/owner caller can manage.
  // master_admin sees everything; org admins see themselves + members of any
  // org where they are admin/owner.
  async function getAdminScopedOwnerIds(
    reqUser: any
  ): Promise<{ scope: "all" | "owners"; ownerIds: Set<string> }> {
    if (reqUser?.userType === "master_admin") {
      return { scope: "all", ownerIds: new Set() };
    }
    const ownerIds = new Set<string>();
    if (reqUser?.id) ownerIds.add(reqUser.id);
    const callerMemberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, reqUser.id),
          eq(organizationMemberships.status, "active")
        )
      );
    const callerAdminLabIds = callerMemberships
      .filter((m) => m.role === "admin" || m.role === "owner")
      .map((m) => m.labId);
    if (callerAdminLabIds.length > 0) {
      const peers = await db
        .select()
        .from(organizationMemberships)
        .where(
          and(
            inArray(organizationMemberships.labId, callerAdminLabIds),
            eq(organizationMemberships.status, "active")
          )
        );
      peers.forEach((m) => ownerIds.add(m.userId));
    }
    return { scope: "owners", ownerIds };
  }

  // Admin: list soft-deleted cases (the "trash"), scoped to caller's org(s)
  router.get("/admin/cases/trash", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const { scope, ownerIds } = await getAdminScopedOwnerIds(reqUser);
      const all = await db.select().from(labCases);
      const trashed = all
        .filter((r) => !!(r as any).deletedAt)
        .filter((r) => scope === "all" || ownerIds.has(r.ownerId))
        .map((r) => {
          let parsed: any = null;
          try { parsed = JSON.parse(r.caseData); } catch {}
          return {
            id: r.id,
            ownerId: r.ownerId,
            deletedAt: (r as any).deletedAt,
            deletedBy: (r as any).deletedBy,
            updatedAt: r.updatedAt,
            caseNumber: parsed?.caseNumber,
            patientName: parsed?.patientName || parsed?.patientInitials,
            doctorName: parsed?.doctorName,
          };
        })
        .sort((a, b) => {
          const ad = a.deletedAt ? new Date(a.deletedAt as any).getTime() : 0;
          const bd = b.deletedAt ? new Date(b.deletedAt as any).getTime() : 0;
          return bd - ad;
        });
      return res.json({ cases: trashed });
    } catch (error: any) {
      console.error("Trash list error:", error?.message || error);
      return res.status(500).json({ error: "Failed to list trash" });
    }
  });

  // Admin: restore a soft-deleted case (scoped to caller's org/master_admin)
  router.post("/admin/cases/:caseId/restore", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const caseId = req.params.caseId as string;
      const [existing] = await db
        .select()
        .from(labCases)
        .where(eq(labCases.id, caseId));
      if (!existing) {
        return res.status(404).json({ error: "Case not found." });
      }
      const { scope, ownerIds } = await getAdminScopedOwnerIds(reqUser);
      if (scope !== "all" && !ownerIds.has(existing.ownerId)) {
        return res
          .status(403)
          .json({ error: "Not authorized to restore this case." });
      }
      await db
        .update(labCases)
        .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
        .where(eq(labCases.id, caseId));
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Restore case error:", error?.message || error);
      return res.status(500).json({ error: "Failed to restore case" });
    }
  });

  router.get("/legacy/chat", requireAuth, async (req, res) => {
    try {
      const currentUserId = (req as any).auth?.userId;
      const currentUsername = (req as any).user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      if (!normalizedCurrentUsername) {
        return res.json({ conversations: [], messages: [] });
      }

      const store = await readLegacyChatStore();

      const dmThreads = store.threads.filter((thread) =>
        thread.participants.some(
          (participant) =>
            normalizeUsernameKey(participant) === normalizedCurrentUsername
        )
      );

      const activeLabMemberships = currentUserId
        ? await db.query.organizationMemberships.findMany({
            where: and(
              eq(organizationMemberships.userId, currentUserId),
              eq(organizationMemberships.status, "active")
            ),
            with: { organization: true } as any,
          })
        : [];

      const labChannelThreads: typeof store.threads = [];
      const labChannelMeta: Map<string, string> = new Map();
      for (const membership of activeLabMemberships) {
        const channelId = `lab:${membership.labId}`;
        const orgRecord = await db.query.organizations.findFirst({
          where: eq(organizations.id, membership.labId),
        });
        const orgName =
          (orgRecord as any)?.displayName || (orgRecord as any)?.name || "Lab";
        labChannelMeta.set(channelId, `${orgName} Channel`);
        const existing = store.threads.find((t) => t.id === channelId);
        if (existing) {
          if (!dmThreads.find((t) => t.id === channelId)) {
            labChannelThreads.push(existing);
          }
        } else {
          labChannelThreads.push({
            id: channelId,
            participants: [currentUsername],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }

      const relevantThreads = [...dmThreads, ...labChannelThreads];
      const relevantConversationIds = new Set(relevantThreads.map((thread) => thread.id));
      const relevantMessages = store.messages.filter((message) =>
        relevantConversationIds.has(message.conversationId)
      );

      const conversations = relevantThreads
        .map((thread) => {
          const isLabChannel = thread.id.startsWith("lab:");
          const channelName = isLabChannel
            ? labChannelMeta.get(thread.id) || "Lab Channel"
            : thread.participants.find(
                (participant) =>
                  normalizeUsernameKey(participant) !== normalizedCurrentUsername
              ) || "Unknown User";

          const threadMessages = relevantMessages
            .filter((message) => message.conversationId === thread.id)
            .sort((a, b) => a.timestamp - b.timestamp);
          const lastMessage = threadMessages[threadMessages.length - 1];
          const unreadCount = threadMessages.filter(
            (message) =>
              normalizeUsernameKey(message.senderUsername) !==
                normalizedCurrentUsername &&
              !message.readBy.includes(normalizedCurrentUsername)
          ).length;

          return {
            id: thread.id,
            clientId: thread.id,
            clientName: channelName,
            isLabChannel,
            lastMessage: lastMessage
              ? lastMessage.imageUri
                ? "Photo"
                : lastMessage.content
              : "",
            lastMessageTime:
              lastMessage?.timestamp || thread.updatedAt || thread.createdAt,
            unreadCount,
          };
        })
        .sort((a, b) => {
          if (a.isLabChannel && !b.isLabChannel) return -1;
          if (!a.isLabChannel && b.isLabChannel) return 1;
          return b.lastMessageTime - a.lastMessageTime;
        });

      const messages = relevantMessages
        .map((message) => ({
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderUsername,
          senderType:
            normalizeUsernameKey(message.senderUsername) ===
            normalizedCurrentUsername
              ? "lab"
              : "office",
          content: message.content,
          imageUri: message.imageUri,
          timestamp: message.timestamp,
          read: message.readBy.includes(normalizedCurrentUsername),
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      return res.json({ conversations, messages });
    } catch (error: any) {
      console.error("Legacy get chat error:", error?.message || error);
      return res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  router.post("/legacy/chat/send", requireAuth, async (req, res) => {
    try {
      const currentUserId = (req as any).auth?.userId;
      const currentUsername = (req as any).user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      const labChannelId =
        typeof req.body?.labChannelId === "string" ? req.body.labChannelId.trim() : "";
      const targetUsername =
        typeof req.body?.targetUsername === "string" ? req.body.targetUsername.trim() : "";
      const content =
        typeof req.body?.content === "string" ? req.body.content.trim() : "";
      const imageUri =
        typeof req.body?.imageUri === "string" ? req.body.imageUri.trim() : undefined;

      if (!normalizedCurrentUsername) {
        return res.status(401).json({ error: "Not authenticated." });
      }
      if (!content && !imageUri) {
        return res.status(400).json({ error: "A message or image is required." });
      }

      const store = await readLegacyChatStore();
      const now = Date.now();

      if (labChannelId && labChannelId.startsWith("lab:")) {
        const orgId = labChannelId.replace(/^lab:/, "");
        const membership = currentUserId
          ? await db.query.organizationMemberships.findFirst({
              where: and(
                eq(organizationMemberships.userId, currentUserId),
                eq(organizationMemberships.labId, orgId),
                eq(organizationMemberships.status, "active")
              ),
            })
          : null;
        if (!membership) {
          return res.status(403).json({ error: "You are not a member of this lab." });
        }
        const allOrgMembers = await db.query.organizationMemberships.findMany({
          where: and(
            eq(organizationMemberships.labId, orgId),
            eq(organizationMemberships.status, "active")
          ),
        });
        const memberIds = allOrgMembers.map((m) => m.userId);
        const memberUsers =
          memberIds.length > 0
            ? await db.select().from(users).where(inArray(users.id, memberIds))
            : [];
        const participants = memberUsers.map((u) => u.username);

        const existingThread = store.threads.find((t) => t.id === labChannelId);
        if (existingThread) {
          existingThread.participants = participants;
          existingThread.updatedAt = now;
        } else {
          store.threads.push({ id: labChannelId, participants, createdAt: now, updatedAt: now });
        }

        const message: LegacyChatMessage = {
          id: randomBytes(16).toString("hex"),
          conversationId: labChannelId,
          senderUsername: currentUsername,
          content,
          ...(imageUri ? { imageUri } : {}),
          timestamp: now,
          readBy: [normalizedCurrentUsername],
        };
        store.messages.push(message);
        await writeLegacyChatStore(store);
        return res.json({ success: true, conversationId: labChannelId, messageId: message.id });
      }

      if (!targetUsername) {
        return res.status(400).json({ error: "A target user or lab channel is required." });
      }
      if (normalizeUsernameKey(targetUsername) === normalizedCurrentUsername) {
        return res.status(400).json({ error: "You cannot message yourself." });
      }

      const allUsers = await db.select().from(users);
      const targetUser = allUsers.find(
        (user) =>
          normalizeUsernameKey(user.username) === normalizeUsernameKey(targetUsername)
      );
      if (!targetUser?.username) {
        return res.status(404).json({ error: "Target user not found." });
      }

      const conversationId =
        buildDirectConversationId(currentUsername, targetUser.username) ||
        buildDirectConversationId(currentUsername, targetUsername);
      if (!conversationId) {
        return res.status(400).json({ error: "Could not create a conversation." });
      }

      const existingThread = store.threads.find((thread) => thread.id === conversationId);
      const participants = [currentUsername, targetUser.username].filter(
        (value, index, values) => values.indexOf(value) === index
      );

      if (existingThread) {
        existingThread.participants = participants;
        existingThread.updatedAt = now;
      } else {
        store.threads.push({ id: conversationId, participants, createdAt: now, updatedAt: now });
      }

      const message: LegacyChatMessage = {
        id: randomBytes(16).toString("hex"),
        conversationId,
        senderUsername: currentUsername,
        content,
        ...(imageUri ? { imageUri } : {}),
        timestamp: now,
        readBy: [normalizedCurrentUsername],
      };
      store.messages.push(message);
      await writeLegacyChatStore(store);
      return res.json({ success: true, conversationId, messageId: message.id });
    } catch (error: any) {
      console.error("Legacy send chat error:", error?.message || error);
      return res.status(500).json({ error: "Failed to send message" });
    }
  });

  router.post("/legacy/chat/read", requireAuth, async (req, res) => {
    try {
      const currentUsername = (req as any).user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      const conversationId =
        typeof req.body?.conversationId === "string"
          ? req.body.conversationId.trim()
          : "";

      if (!normalizedCurrentUsername || !conversationId) {
        return res.status(400).json({ error: "A conversation id is required." });
      }

      const store = await readLegacyChatStore();
      const thread = store.threads.find((entry) => entry.id === conversationId);
      const isParticipant = thread?.participants.some(
        (participant) => normalizeUsernameKey(participant) === normalizedCurrentUsername
      );

      if (!thread || !isParticipant) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      let changed = false;
      for (const message of store.messages) {
        if (
          message.conversationId === conversationId &&
          normalizeUsernameKey(message.senderUsername) !== normalizedCurrentUsername &&
          !message.readBy.includes(normalizedCurrentUsername)
        ) {
          message.readBy.push(normalizedCurrentUsername);
          changed = true;
        }
      }

      if (changed) {
        await writeLegacyChatStore(store);
      }

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Legacy read chat error:", error?.message || error);
      return res.status(500).json({ error: "Failed to update message read status" });
    }
  });

  router.post("/send-phone-code", async (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }
    const code = generateCode();
    const key = `phone:${phone.trim()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (twilioSid && twilioToken && twilioFrom) {
      try {
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
        const params = new URLSearchParams();
        params.append("To", phone.trim());
        params.append("From", twilioFrom);
        params.append("Body", `Your LabTrax verification code is: ${code}. It expires in 10 minutes.`);
        const twilioResp = await globalThis.fetch(twilioUrl, {
          method: "POST",
          headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        const twilioData = await twilioResp.json() as any;
        if (twilioData.error_code) {
          console.error(`[SMS VERIFICATION] Twilio error: ${twilioData.message}`);
          return res.status(500).json({ error: "Failed to send verification code. Please try again." });
        }
      } catch (err: any) {
        console.error(`[SMS VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code. Please try again." });
      }
    } else {
      console.log(`[SMS VERIFICATION] Twilio not configured. Dev mode only — code masked for security.`);
    }

    const isDev = process.env.NODE_ENV === "development";
    return res.json({ success: true, message: "Verification code sent via SMS.", ...(isDev && (!twilioSid || !twilioToken || !twilioFrom) ? { demoCode: code } : {}) });
  });

  router.post("/verify-phone-code", (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "Phone and code required" });
    const key = `phone:${phone.trim()}`;
    const stored = verificationCodes.get(key);
    if (!stored) return res.json({ verified: false, error: "No code sent. Please request a new one." });
    if (Date.now() > stored.expiresAt) { verificationCodes.delete(key); return res.json({ verified: false, error: "Code expired." }); }
    if (stored.code !== code.trim()) return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    return res.json({ verified: true });
  });

  router.post("/send-email-code", async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") return res.status(400).json({ error: "Email required" });
    const code = generateCode();
    const key = `email:${email.trim().toLowerCase()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpPort = process.env.SMTP_PORT;
    const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";

    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465",
          auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: email.trim(),
          subject: "LabTrax - Email Verification Code",
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">LabTrax</h2>
              <p style="margin: 4px 0 0; opacity: 0.85;">Email Verification</p>
            </div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Your verification code is:</p>
              <p style="text-align: center; margin: 24px 0;">
                <span style="display: inline-block; background: #F0F4FF; padding: 16px 40px; border-radius: 8px; font-size: 28px; font-weight: bold; color: #4A6CF7; letter-spacing: 6px;">${code}</span>
              </p>
              <p style="color: #666; font-size: 13px;">This code expires in 10 minutes.</p>
            </div>
          </div>`,
        });
      } catch (err: any) {
        console.error(`[EMAIL VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code." });
      }
    } else {
      console.log(`[EMAIL VERIFICATION] SMTP not configured. Dev mode only — code masked for security.`);
    }

    const isDev = process.env.NODE_ENV === "development";
    return res.json({ success: true, message: "Verification code sent.", ...(isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoCode: code } : {}) });
  });

  router.post("/verify-email-code", (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code required" });
    const key = `email:${email.trim().toLowerCase()}`;
    const stored = verificationCodes.get(key);
    if (!stored) return res.json({ verified: false, error: "No code sent." });
    if (Date.now() > stored.expiresAt) { verificationCodes.delete(key); return res.json({ verified: false, error: "Code expired." }); }
    if (stored.code !== code.trim()) return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    return res.json({ verified: true });
  });

  router.post("/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent." });

      const token = generateResetToken();
      passwordResetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });

      const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_INTERNAL_APP_DOMAIN || "localhost:5000";
      const protocol = domain.includes("localhost") ? "http" : "https";
      const resetLink = `${protocol}://${domain}/reset-password?token=${token}`;

      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";

      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465", auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: smtpFrom, to: user.email!,
          subject: "LabTrax - Password Reset",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Password Reset</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p><p>Click below to reset your password:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a></p>
              <p style="color: #666; font-size: 13px;">Expires in 30 minutes. Username: <strong>${user.username}</strong></p>
            </div></div>`,
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Reset link generated for ${user.email} — token masked for security.`);
      }

      const isDev = process.env.NODE_ENV === "development";
      return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent.", ...(isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoResetLink: resetLink } : {}) });
    } catch (error: any) {
      console.error("Forgot password error:", error?.message || error);
      return res.status(500).json({ error: "Failed to process request." });
    }
  });

  router.post("/forgot-username", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: "If an account with that email exists, your username has been sent." });

      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";

      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465", auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: smtpFrom, to: user.email!,
          subject: "LabTrax - Username Recovery",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Username Recovery</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Your username is: <strong>${user.username}</strong></p>
            </div></div>`,
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Username reminder generated for ${user.email} — masked for security.`);
      }
      return res.json({ success: true, message: "If an account with that email exists, your username has been sent." });
    } catch (error: any) {
      return res.status(500).json({ error: "Failed to process request." });
    }
  });

  router.post("/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required." });
      const resetData = passwordResetTokens.get(token);
      if (!resetData) return res.status(400).json({ error: "Invalid or expired reset token." });
      if (Date.now() > resetData.expiresAt) { passwordResetTokens.delete(token); return res.status(400).json({ error: "Reset token has expired." }); }

      const hashed = await hashPassword(newPassword);
      await db.update(users).set({ password: hashed }).where(eq(users.id, resetData.userId));
      passwordResetTokens.delete(token);
      return res.json({ success: true, message: "Password has been reset successfully." });
    } catch (error: any) {
      return res.status(500).json({ error: "Failed to reset password." });
    }
  });

  router.post("/send-case-update-text", requireAuth, async (req, res) => {
    const { providerPhone, caseNumber, patientName, status, message } = req.body;
    if (!providerPhone || !caseNumber) return res.status(400).json({ error: "Provider phone and case number required" });

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioSid || !twilioToken || !twilioFrom) return res.status(500).json({ error: "Twilio not configured" });

    const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams();
    params.append("To", providerPhone);
    params.append("From", twilioFrom);
    params.append("Body", message);

    try {
      await globalThis.fetch(twilioUrl, {
        method: "POST",
        headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      return res.json({ success: true, message: `Text sent to ${providerPhone}` });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to send text" });
    }
  });

  async function convertPdfToImageBase64s(rawPdfBase64: string): Promise<string[]> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rx-pdf-"));
    const pdfPath = path.join(tmpDir, "input.pdf");
    const outputPrefix = path.join(tmpDir, "page");
    try {
      await writeFile(pdfPath, Buffer.from(rawPdfBase64, "base64"));
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("pdftoppm", ["-jpeg", "-r", "150", "-f", "1", "-l", "3", pdfPath, outputPrefix]);
        let stderr = "";
        proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString().slice(0, 500); });
        proc.on("close", (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`pdftoppm exited ${code}: ${stderr}`));
        });
        proc.on("error", reject);
      });
      const allFiles = await readdir(tmpDir);
      const jpgFiles = allFiles
        .filter((f) => f.startsWith("page") && (f.endsWith(".jpg") || f.endsWith(".jpeg")))
        .sort();
      const images: string[] = [];
      for (const file of jpgFiles) {
        const data = await readFile(path.join(tmpDir, file));
        images.push(`data:image/jpeg;base64,${data.toString("base64")}`);
      }
      return images;
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  router.post("/analyze-prescription", optionalAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ success: false, error: "AI integrations are not configured." });

      const { imageBase64, additionalImages } = req.body;
      if (!imageBase64) return res.status(400).json({ success: false, error: "No image provided" });

      // Strip the data URI prefix to measure the raw base64 payload.
      const commaIdx = (imageBase64 as string).indexOf(",");
      const rawB64 = commaIdx >= 0 ? (imageBase64 as string).substring(commaIdx + 1) : (imageBase64 as string);
      console.log("AI analyze-prescription: received, primary image length:", imageBase64.length, "raw b64 length:", rawB64.length, "additional pages:", Array.isArray(additionalImages) ? additionalImages.length : 0);

      // A real prescription photo JPEG is always well above 3 KB. Fewer than
      // 5 000 raw-base64 chars (~3.75 KB) indicates a corrupted / partial read
      // on the client — fail fast with a helpful message rather than burning an
      // OpenAI call that will always return "unsupported image".
      if (rawB64.length < 5000) {
        return res.status(400).json({
          success: false,
          error: "IMAGE_TOO_SMALL",
          message: "The photo appears to be corrupted or incomplete. Please retake it and try again.",
        });
      }

      const isHEIC = imageBase64.includes("data:image/heic") || imageBase64.includes("data:image/heif");
      if (isHEIC) return res.status(400).json({ success: false, error: "HEIC format is not supported. Please convert to JPEG or PNG first." });

      const imageContents: Array<{ type: "image_url"; image_url: { url: string; detail: "auto" } }> = [];

      // PDF detection: raw base64 of any PDF starts with 'JVBERi' (base64 of '%PDF-').
      // On iOS, PDFs picked from the document picker arrive here with raw PDF bytes
      // wrapped in a fake data:image/jpeg;base64,... prefix. We detect the real
      // content via the magic-byte signature and render each page via pdftoppm.
      const isPdf = rawB64.startsWith("JVBERi");
      if (isPdf) {
        console.log("AI analyze-prescription: PDF detected, converting pages via pdftoppm");
        let pdfImages: string[];
        try {
          pdfImages = await convertPdfToImageBase64s(rawB64);
        } catch (pdfErr: any) {
          console.log("AI analyze-prescription: PDF conversion failed:", pdfErr?.message);
          return res.status(400).json({
            success: false,
            error: "PDF prescriptions could not be processed. Please photograph the printed prescription instead.",
          });
        }
        if (pdfImages.length === 0) {
          return res.status(400).json({
            success: false,
            error: "PDF could not be rendered. Please photograph the prescription instead.",
          });
        }
        console.log("AI analyze-prescription: PDF converted to", pdfImages.length, "page(s)");
        for (const img of pdfImages) {
          imageContents.push({ type: "image_url", image_url: { url: img, detail: "auto" } });
        }
      } else {
        let primaryUrl = imageBase64;
        if (!primaryUrl.startsWith("data:")) {
          primaryUrl = `data:image/jpeg;base64,${primaryUrl}`;
        }
        imageContents.push({ type: "image_url", image_url: { url: primaryUrl, detail: "auto" } });

        if (additionalImages && Array.isArray(additionalImages)) {
          for (const img of additionalImages) {
            if (typeof img === "string" && img.length > 100) {
              let imgUrl = img;
              if (!imgUrl.startsWith("data:")) {
                imgUrl = `data:image/jpeg;base64,${imgUrl}`;
              }
              imageContents.push({ type: "image_url", image_url: { url: imgUrl, detail: "auto" } });
            }
          }
        }
      }

      const systemPrompt = `You are a dental laboratory prescription reader. Analyze the dental prescription image(s) and extract all available information. Return ONLY valid JSON with these fields (use null for any field you cannot determine):

{
  "doctorName": "Dr. Full Name",
  "patientName": "Patient Full Name",
  "patientInitials": "PI",
  "caseType": "one of: Crown & Bridge, Removable, Implant, Orthodontic, Other",
  "toothIndices": "comma-separated tooth numbers like 3,5,14",
  "shade": "shade value like A2, B1, etc.",
  "material": "one of: Zirconia, E max, PFM, Gold, Composite, Acrylic, Flexible, PMMA, Metal Framework, Titanium, Other",
  "dueDate": "MM/DD/YYYY format",
  "isRush": false,
  "notes": "any additional notes or special instructions",
  "practiceName": "dental practice or office name",
  "practiceAddress": "practice address",
  "practicePhone": "practice phone number"
}

Important rules:
- Read ALL pages if multiple images are provided
- For tooth numbers, use Universal Numbering System (1-32)
- If you see FDI notation, convert to Universal
- Only set isRush to true if explicitly marked as rush/urgent
- For caseType, match to the closest category listed above
- Extract the shade exactly as written on the prescription
- NAME FORMAT: If a patient name or doctor name contains a comma (e.g. "Kidder, Daniel" or "Sharpstein, Daniel"), the prescription is using Last, First format. You MUST swap it to First Last order and remove the comma. Examples: "Kidder, Daniel" → "Daniel Kidder", "Dr. Sharpstein, Daniel" → "Dr. Daniel Sharpstein". Always output names in natural First Last order with no commas.
- Return ONLY the JSON object, no other text`;

      const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "auto" } }> = [
        { type: "text", text: `Analyze this dental prescription (${imageContents.length} page${imageContents.length > 1 ? "s" : ""}).` },
        ...imageContents,
      ];

      const baseMessages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userContent },
      ];

      let response: any;
      try {
        response = await openai.chat.completions.create({
          model: "gpt-5.1",
          messages: baseMessages,
          max_completion_tokens: 1000,
        });
        console.log("AI analyze-prescription: used gpt-5.1");
      } catch (modelErr: any) {
        console.log("AI analyze-prescription: gpt-5.1 failed, falling back to gpt-4o:", modelErr?.message);
        response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: baseMessages,
          max_completion_tokens: 1000,
          temperature: 0.1,
        });
        console.log("AI analyze-prescription: used gpt-4o (fallback)");
      }

      const text = response.choices?.[0]?.message?.content || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("AI analyze-prescription: No JSON found in response:", text.substring(0, 200));
        return res.json({ success: false, error: "AI could not parse the prescription" });
      }

      const data = JSON.parse(jsonMatch[0]);

      function fixNameOrder(name: string | null | undefined): string | null | undefined {
        if (!name || typeof name !== "string") return name;
        const commaIdx = name.indexOf(",");
        if (commaIdx === -1) return name;
        const prefix = name.match(/^(Dr\.|Dr|Mr\.|Mrs\.|Ms\.|Prof\.)\s*/i)?.[0] || "";
        const nameWithoutPrefix = name.slice(prefix.length);
        const commaIdxInner = nameWithoutPrefix.indexOf(",");
        if (commaIdxInner === -1) return name;
        const last = nameWithoutPrefix.slice(0, commaIdxInner).trim();
        const first = nameWithoutPrefix.slice(commaIdxInner + 1).trim();
        return `${prefix}${first} ${last}`.trim();
      }

      const cleanedData: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined && value !== "" && value !== "null") {
          if ((key === "doctorName" || key === "patientName") && typeof value === "string") {
            cleanedData[key] = fixNameOrder(value) ?? value;
          } else {
            cleanedData[key] = value;
          }
        }
      }

      console.log("AI analyze-prescription: Success, fields:", Object.keys(cleanedData).join(", "));
      return res.json({ success: true, data: cleanedData });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error("AI analyze-prescription error:", errMsg);
      return res.status(500).json({ success: false, error: "AI analysis failed. Please try again.", detail: errMsg });
    }
  });

  router.post("/crop-document", optionalAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured." });

      const { imageBase64 } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      let base64Data: string;
      let rawBuffer: Buffer;
      let rotatedBuffer: Buffer;
      let rotatedDataUrl: string;

      try {
        base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        rawBuffer = Buffer.from(base64Data, "base64");
        if (rawBuffer.length < 100) return res.status(400).json({ error: "Unable to process this image." });
      } catch { return res.status(400).json({ error: "Unable to process this image." }); }

      try {
        rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
        rotatedDataUrl = `data:image/jpeg;base64,${rotatedBuffer.toString("base64")}`;
      } catch { return res.status(500).json({ error: "Unable to process this image." }); }

      let aiResult: any = null;
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-5.1",
          messages: [
            { role: "system", content: `You are a professional document scanner. Detect any document in the photo and return TIGHT crop coordinates that isolate ONLY the document. Use percentage coordinates (0-100). Return ONLY valid JSON: { "documentDetected": true, "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 }, "rotation": 0, "documentType": "prescription" }` },
            { role: "user", content: [
              { type: "text", text: "Detect the document in this photo." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } },
            ]},
          ],
          max_completion_tokens: 250,
        });
        const text = response.choices?.[0]?.message?.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) aiResult = JSON.parse(jsonMatch[0]);
      } catch { return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl }); }

      if (!aiResult?.documentDetected || !aiResult?.crop) return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });

      try {
        const metadata = await sharp(rotatedBuffer).metadata();
        const imgW = metadata.width || 1;
        const imgH = metadata.height || 1;
        const left = Math.max(0, Math.round((aiResult.crop.left / 100) * imgW));
        const top = Math.max(0, Math.round((aiResult.crop.top / 100) * imgH));
        const right = Math.min(imgW, Math.round((aiResult.crop.right / 100) * imgW));
        const bottom = Math.min(imgH, Math.round((aiResult.crop.bottom / 100) * imgH));
        const cropW = Math.max(1, right - left);
        const cropH = Math.max(1, bottom - top);

        let pipeline = sharp(rotatedBuffer).extract({ left, top, width: cropW, height: cropH });
        const rotation = aiResult.rotation || 0;
        if (rotation === 90 || rotation === 180 || rotation === 270) pipeline = pipeline.rotate(rotation);
        const croppedBuffer = await pipeline.sharpen({ sigma: 1.2 }).normalize().jpeg({ quality: 92 }).toBuffer();
        return res.json({ documentDetected: true, croppedImageBase64: `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`, documentType: aiResult.documentType });
      } catch { return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl }); }
    } catch { return res.status(500).json({ error: "Unable to process this image." }); }
  });

  router.post("/document-to-pdf", optionalAuth, async (req, res) => {
    try {
      const { images } = req.body;
      if (!images || !Array.isArray(images) || images.length === 0) return res.status(400).json({ error: "No images provided" });

      const pageImages: { buffer: Buffer; width: number; height: number }[] = [];
      for (const img of images) {
        try {
          if (typeof img !== "string" || (!img.startsWith("data:") && img.length < 100)) continue;
          const b64 = img.replace(/^data:image\/\w+;base64,/, "");
          const buf = Buffer.from(b64, "base64");
          if (buf.length < 100) continue;
          const rotated = await sharp(buf).rotate().jpeg({ quality: 95 }).toBuffer();
          const meta = await sharp(rotated).metadata();
          pageImages.push({ buffer: rotated, width: meta.width || 612, height: meta.height || 792 });
        } catch {}
      }
      if (pageImages.length === 0) return res.status(400).json({ error: "No valid images" });

      const PDF_W = 612;
      const PDF_H = 792;
      const MARGIN = 18;
      let objCount = 0;
      const newObj = () => { objCount++; return objCount; };
      const catalogId = newObj();
      const pagesId = newObj();
      const pageObjIds: number[] = [];
      const imgObjIds: number[] = [];
      const contentObjIds: number[] = [];
      for (const _pg of pageImages) { pageObjIds.push(newObj()); imgObjIds.push(newObj()); contentObjIds.push(newObj()); }

      const objStrs: { id: number; str: string }[] = [];
      objStrs.push({ id: catalogId, str: `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n` });
      objStrs.push({ id: pagesId, str: `${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>\nendobj\n` });

      for (let i = 0; i < pageImages.length; i++) {
        const pg = pageImages[i];
        const scale = Math.min((PDF_W - MARGIN * 2) / pg.width, (PDF_H - MARGIN * 2) / pg.height);
        const drawW = Math.round(pg.width * scale), drawH = Math.round(pg.height * scale);
        const drawX = Math.round((PDF_W - drawW) / 2), drawY = Math.round((PDF_H - drawH) / 2);
        const contentStr = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Img${i} Do\nQ\n`;
        objStrs.push({ id: contentObjIds[i], str: `${contentObjIds[i]} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}endstream\nendobj\n` });
        objStrs.push({ id: pageObjIds[i], str: `${pageObjIds[i]} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_W} ${PDF_H}] /Contents ${contentObjIds[i]} 0 R /Resources << /XObject << /Img${i} ${imgObjIds[i]} 0 R >> >> >>\nendobj\n` });
        objStrs.push({ id: imgObjIds[i], str: `${imgObjIds[i]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.buffer.length} >>\nstream\n` });
      }

      const sortedObjs = objStrs.sort((a, b) => a.id - b.id);
      let output = Buffer.from("%PDF-1.4\n");
      const xrefOffsets: number[] = new Array(objCount + 1).fill(0);
      for (const obj of sortedObjs) {
        xrefOffsets[obj.id] = output.length;
        if (obj.str.includes("/DCTDecode")) {
          const imgIdx = imgObjIds.indexOf(obj.id);
          if (imgIdx >= 0) {
            output = Buffer.concat([output, Buffer.from(obj.str), pageImages[imgIdx].buffer, Buffer.from("\nendstream\nendobj\n")]);
          } else { output = Buffer.concat([output, Buffer.from(obj.str)]); }
        } else { output = Buffer.concat([output, Buffer.from(obj.str)]); }
      }

      const xrefOffset = output.length;
      let xrefStr = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i <= objCount; i++) xrefStr += `${String(xrefOffsets[i]).padStart(10, "0")} 00000 n \n`;
      xrefStr += `trailer\n<< /Size ${objCount + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      output = Buffer.concat([output, Buffer.from(xrefStr)]);

      return res.json({ success: true, pdfBase64: `data:application/pdf;base64,${output.toString("base64")}`, pageCount: pageImages.length });
    } catch (err: any) { return res.status(500).json({ error: "PDF generation failed" }); }
  });

  router.post("/smile-process", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured." });

      const { imageBase64, mode } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      let prompt = "";
      if (mode === "whiten") prompt = "Edit this photo to whiten and brighten the person's teeth to a natural, beautiful Hollywood-white shade. Keep everything else the same.";
      else if (mode === "symmetry") prompt = "Edit this photo to make the person's visible teeth perfectly symmetrical and even. Keep everything else the same.";
      else if (mode === "both") prompt = "Edit this photo to whiten teeth AND make them perfectly symmetrical. Keep everything else the same.";
      else return res.status(400).json({ error: "Invalid mode." });

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      const imgFile = await toFile(imgBuffer, "image.png", { type: "image/png" });
      const response = await openai.images.edit({ model: "gpt-image-1", image: imgFile, prompt, size: "1024x1024" });
      const outputBase64 = response.data?.[0]?.b64_json;
      if (!outputBase64) return res.status(500).json({ error: "AI did not return an image." });
      return res.json({ imageBase64: `data:image/png;base64,${outputBase64}` });
    } catch (err: any) { return res.status(500).json({ error: "Failed to process image" }); }
  });

  router.delete("/admin/cleanup-email", async (req, res) => {
    try {
      const { email, adminKey } = req.body;
      const cleanupKey = process.env.LABTRAX_ADMIN_CLEANUP_KEY;
      if (!cleanupKey) return res.status(404).json({ error: "Not found" });
      if (adminKey !== cleanupKey) return res.status(403).json({ error: "Unauthorized" });
      if (!email) return res.status(400).json({ error: "Email required" });
      const allUsers = await db.select().from(users);
      const matches = allUsers.filter(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (matches.length === 0) return res.json({ success: true, deleted: 0, message: "No users found" });
      let deletedCount = 0;
      for (const u of matches) {
        // Soft-delete: users is a protected table. See lib/soft-delete.ts.
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, u.id));
        deletedCount++;
      }
      return res.json({ success: true, deleted: deletedCount, found: matches.length });
    } catch { return res.status(500).json({ error: "Cleanup failed" }); }
  });

  // ── Admin Data Backup ─────────────────────────────────────────────────────
  router.get("/admin/backup", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }

      const allUsers = await db.select().from(users);
      const allCases = await db.select().from(labCases);

      const safeUsers = allUsers.map(u => {
        const { password: _pw, ...rest } = u as any;
        return rest;
      });

      const manifest = {
        version: "1.0",
        appName: "LabTrax",
        exportedAt: new Date().toISOString(),
        exportedBy: reqUser.username || reqUser.id,
        counts: {
          users: safeUsers.length,
          cases: allCases.length,
        },
        tables: ["users", "lab_cases"],
        note: "Passwords are excluded from user records for security. Media files are included in the media/ directory.",
      };

      const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
      const mediaExists = fs.existsSync(mediaDir);

      const dateStr = new Date().toISOString().split("T")[0];
      const filename = `labtrax-backup-${dateStr}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");

      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err: Error) => {
        console.error("Backup archive error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Backup failed." });
      });
      archive.pipe(res);

      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      archive.append(JSON.stringify(safeUsers, null, 2), { name: "data/users.json" });
      archive.append(JSON.stringify(allCases, null, 2), { name: "data/cases.json" });

      if (mediaExists) {
        archive.directory(mediaDir, "media");
      }

      await archive.finalize();
      return;
    } catch (e: any) {
      console.error("Backup endpoint error:", e?.message);
      if (!res.headersSent) res.status(500).json({ error: "Backup failed." });
      return;
    }
  });

  // ── Admin: clean up orphaned case-media files ────────────────────────────
  // Removes files in `uploads/case-media/` that no `case_attachments.storageKey`
  // references. Pass `?dryRun=true` (or `{ dryRun: true }`) to preview without
  // deleting. Also reachable as a cron via `scripts/cleanup-orphaned-case-media`
  // using the shared `MEDIA_CLEANUP_JOB_TOKEN` instead of an admin JWT.
  const cleanupAuth = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const tokenHeader =
      (req.headers["x-media-cleanup-job-token"] as string | undefined) || "";
    const expectedToken = process.env.MEDIA_CLEANUP_JOB_TOKEN;

    if (tokenHeader) {
      if (!expectedToken) {
        return res.status(503).json({
          error: "MEDIA_CLEANUP_JOB_TOKEN is not configured on the server.",
        });
      }
      if (tokenHeader !== expectedToken) {
        return res.status(401).json({ error: "Invalid job token." });
      }
      (req as any).cleanupTriggeredBy = "scheduler";
      return next();
    }

    return requireAuth(req, res, (err?: any) => {
      if (err) return next(err);
      const reqUser = (req as any).user;
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      (req as any).cleanupTriggeredBy = `admin:${
        reqUser.username || reqUser.id
      }`;
      return next();
    });
  };

  router.get("/admin/cleanup/orphaned-media/runs", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const limitRaw = (req.query as any)?.limit;
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50),
    );
    try {
      const runs = await db
        .select()
        .from(mediaCleanupRuns)
        .orderBy(desc(mediaCleanupRuns.startedAt))
        .limit(limit);
      return res.json({ runs });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to fetch cleanup runs." });
    }
  });

  router.post("/admin/cleanup/orphaned-media", cleanupAuth, async (req, res) => {
    const triggeredBy =
      ((req as any).cleanupTriggeredBy as string | undefined) || "unknown";
    const dryRun = (() => {
      const q = (req.query as any)?.dryRun;
      const b = (req.body as any)?.dryRun;
      const v = q ?? b;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v.toLowerCase() !== "false";
      // Default to dry-run for safety.
      return true;
    })();

    const includeAll = (() => {
      const q = (req.query as any)?.includeAll;
      const b = (req.body as any)?.includeAll;
      const v = q ?? b;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v.toLowerCase() === "true";
      return false;
    })();

    const sampleLimit = (() => {
      const q = (req.query as any)?.sampleLimit;
      const b = (req.body as any)?.sampleLimit;
      const v = q ?? b;
      const n =
        typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.min(n, 100000);
      return undefined;
    })();

    try {
      const { runId, report, status, errorMessage } = await runAndPersistCleanup(triggeredBy, {
        dryRun,
        // `includeAll` returns the full orphan filename list (useful for
        // forensic review); otherwise honor `sampleLimit` or the default.
        ...(includeAll
          ? { sampleLimit: Number.MAX_SAFE_INTEGER }
          : sampleLimit !== undefined
            ? { sampleLimit }
            : {}),
      });
      return res.json({ ok: true, runId, triggeredBy, status, errorMessage, ...report });
    } catch (e: any) {
      return res
        .status(500)
        .json({ error: e?.message || "Orphaned media cleanup failed." });
    }
  });

  router.get("/admin/cleanup/orphaned-media/status", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    return res.json(getCleanupProgress());
  });

  router.post("/admin/cleanup/orphaned-media/run", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const triggeredBy = `admin:${reqUser.username || reqUser.id}`;
    try {
      const { runId, report, status, errorMessage } = await runAndPersistCleanup(triggeredBy, {
        dryRun: false,
      });
      return res.json({ ok: true, runId, triggeredBy, status, errorMessage, ...report });
    } catch (e: unknown) {
      if (e instanceof CleanupAlreadyRunningError) {
        return res.status(409).json({ error: e.message });
      }
      const msg = e instanceof Error ? e.message : "Orphaned media cleanup failed.";
      return res.status(500).json({ error: msg });
    }
  });

  router.post("/admin/cleanup/orphaned-media/cancel", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const progress = getCleanupProgress();
    if (progress.stage === "idle") {
      return res.status(409).json({ error: "No cleanup run is currently in progress." });
    }
    cancelCleanup();
    return res.json({ ok: true, message: "Cancellation requested." });
  });

  // ── Admin: cleanup alert settings ────────────────────────────────────────
  router.get("/admin/settings/cleanup-alerts", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(
          sql`${systemSettings.key} in (${SETTING_CLEANUP_MIN_REMOVED}, ${SETTING_CLEANUP_MIN_FREED_MB})`,
        );
      const dbMinRemovedRaw = rows.find((r) => r.key === SETTING_CLEANUP_MIN_REMOVED)?.value ?? null;
      const dbMinFreedMbRaw = rows.find((r) => r.key === SETTING_CLEANUP_MIN_FREED_MB)?.value ?? null;
      const envMinRemoved = parseInt(process.env.CLEANUP_ALERT_MIN_REMOVED || "1", 10) || 1;
      const envMinFreedMb = parseFloat(process.env.CLEANUP_ALERT_MIN_FREED_MB || "0") || 0;
      const minRemoved = Math.max(
        1,
        dbMinRemovedRaw !== null ? parseInt(dbMinRemovedRaw, 10) || 1 : envMinRemoved,
      );
      const minFreedMb = dbMinFreedMbRaw !== null ? parseFloat(dbMinFreedMbRaw) || 0 : envMinFreedMb;
      return res.json({
        minRemoved,
        minFreedMb,
        dbMinRemoved: dbMinRemovedRaw !== null ? Number(dbMinRemovedRaw) : null,
        dbMinFreedMb: dbMinFreedMbRaw !== null ? Number(dbMinFreedMbRaw) : null,
        envMinRemoved,
        envMinFreedMb,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to fetch cleanup alert settings." });
    }
  });

  router.put("/admin/settings/cleanup-alerts", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const body = req.body as any;
      const minRemoved = typeof body?.minRemoved === "number" ? body.minRemoved : parseInt(String(body?.minRemoved ?? ""), 10);
      const minFreedMb = typeof body?.minFreedMb === "number" ? body.minFreedMb : parseFloat(String(body?.minFreedMb ?? ""));
      if (!Number.isFinite(minRemoved) || !Number.isInteger(minRemoved) || minRemoved < 1) {
        return res.status(400).json({ error: "minRemoved must be a positive integer." });
      }
      if (!Number.isFinite(minFreedMb) || minFreedMb < 0) {
        return res.status(400).json({ error: "minFreedMb must be a non-negative number." });
      }
      await db
        .insert(systemSettings)
        .values({ key: SETTING_CLEANUP_MIN_REMOVED, value: String(minRemoved) })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(minRemoved), updatedAt: new Date() } });
      await db
        .insert(systemSettings)
        .values({ key: SETTING_CLEANUP_MIN_FREED_MB, value: String(minFreedMb) })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(minFreedMb), updatedAt: new Date() } });
      return res.json({ success: true, minRemoved, minFreedMb });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to save cleanup alert settings." });
    }
  });

  router.delete("/admin/settings/cleanup-alerts", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const field = (req.query as any).field as string | undefined;
    const validFields: Record<string, string> = {
      minRemoved: SETTING_CLEANUP_MIN_REMOVED,
      minFreedMb: SETTING_CLEANUP_MIN_FREED_MB,
    };
    if (field && !validFields[field]) {
      return res.status(400).json({ error: "Invalid field. Must be one of: minRemoved, minFreedMb." });
    }
    try {
      const keysToDelete = field ? [validFields[field]] : Object.values(validFields);
      for (const key of keysToDelete) {
        await db.delete(systemSettings).where(eq(systemSettings.key, key));
      }
      return res.json({ success: true, reset: field ?? "all" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to reset cleanup alert settings." });
    }
  });

  // ── Admin: cleanup schedule settings ─────────────────────────────────────
  router.get("/admin/settings/cleanup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const [hourUtc, { retentionDays, dbRetentionDays, envRetentionDays }, { stuckTimeoutMinutes, dbStuckTimeoutMinutes, envStuckTimeoutMinutes }] =
        await Promise.all([
          getCleanupHourUtc(),
          getCleanupHistoryRetentionDays(),
          getCleanupStuckTimeoutMinutes(),
        ]);
      const envHourUtc = Math.max(
        0,
        Math.min(23, parseInt(process.env.CLEANUP_HOUR_UTC || "8", 10) || 8),
      );
      const hourRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, SETTING_CLEANUP_HOUR_UTC));
      const dbHourRaw = hourRows[0]?.value ?? null;
      const dbHourUtc =
        dbHourRaw !== null
          ? Math.max(0, Math.min(23, parseInt(dbHourRaw, 10) || 0))
          : null;
      return res.json({
        hourUtc,
        dbHourUtc,
        envHourUtc,
        retentionDays,
        dbRetentionDays,
        envRetentionDays,
        stuckTimeoutMinutes,
        dbStuckTimeoutMinutes,
        envStuckTimeoutMinutes,
      });
    } catch (e: any) {
      return res
        .status(500)
        .json({ error: e?.message || "Failed to fetch cleanup schedule settings." });
    }
  });

  router.put("/admin/settings/cleanup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const body = req.body as any;
      const hourUtc =
        typeof body?.hourUtc === "number"
          ? body.hourUtc
          : parseInt(String(body?.hourUtc ?? ""), 10);
      const retentionDays =
        typeof body?.retentionDays === "number"
          ? body.retentionDays
          : parseInt(String(body?.retentionDays ?? ""), 10);
      const stuckTimeoutMinutes =
        typeof body?.stuckTimeoutMinutes === "number"
          ? body.stuckTimeoutMinutes
          : parseInt(String(body?.stuckTimeoutMinutes ?? ""), 10);
      if (
        !Number.isFinite(hourUtc) ||
        !Number.isInteger(hourUtc) ||
        hourUtc < 0 ||
        hourUtc > 23
      ) {
        return res
          .status(400)
          .json({ error: "hourUtc must be an integer between 0 and 23." });
      }
      if (
        !Number.isFinite(retentionDays) ||
        !Number.isInteger(retentionDays) ||
        retentionDays < 1
      ) {
        return res
          .status(400)
          .json({ error: "retentionDays must be a positive integer." });
      }
      if (
        !Number.isFinite(stuckTimeoutMinutes) ||
        !Number.isInteger(stuckTimeoutMinutes) ||
        stuckTimeoutMinutes < 1
      ) {
        return res
          .status(400)
          .json({ error: "stuckTimeoutMinutes must be a positive integer." });
      }
      await db
        .insert(systemSettings)
        .values({ key: SETTING_CLEANUP_HOUR_UTC, value: String(hourUtc) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: String(hourUtc), updatedAt: new Date() },
        });
      await db
        .insert(systemSettings)
        .values({ key: SETTING_CLEANUP_HISTORY_RETENTION_DAYS, value: String(retentionDays) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: String(retentionDays), updatedAt: new Date() },
        });
      await db
        .insert(systemSettings)
        .values({ key: SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES, value: String(stuckTimeoutMinutes) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: String(stuckTimeoutMinutes), updatedAt: new Date() },
        });
      return res.json({ success: true, hourUtc, retentionDays, stuckTimeoutMinutes });
    } catch (e: any) {
      return res
        .status(500)
        .json({ error: e?.message || "Failed to save cleanup schedule settings." });
    }
  });

  router.delete("/admin/settings/cleanup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const field = (req.query as any).field as string | undefined;
    const validFields: Record<string, string> = {
      hourUtc: SETTING_CLEANUP_HOUR_UTC,
      retentionDays: SETTING_CLEANUP_HISTORY_RETENTION_DAYS,
      stuckTimeoutMinutes: SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES,
    };
    if (field && !validFields[field]) {
      return res.status(400).json({ error: "Invalid field. Must be one of: hourUtc, retentionDays, stuckTimeoutMinutes." });
    }
    try {
      const keysToDelete = field ? [validFields[field]] : Object.values(validFields);
      for (const key of keysToDelete) {
        await db.delete(systemSettings).where(eq(systemSettings.key, key));
      }
      return res.json({ success: true, reset: field ?? "all" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to reset cleanup schedule settings." });
    }
  });

  // ── Admin: backup schedule settings ──────────────────────────────────────
  router.get("/admin/settings/backup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    // Read access only requires admin role — the data is not sensitive.
    if (!reqUser || reqUser.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const hourUtc = await getBackupHourUtc();
      const envHourUtc = Math.max(
        0,
        Math.min(23, parseInt(process.env.BACKUP_HOUR_UTC || "7", 10) || 7),
      );
      const settingKeys = [
        SETTING_BACKUP_HOUR_UTC,
        SETTING_ROLLING_BACKUP_ENABLED,
        SETTING_ROLLING_BACKUP_LAST_RUN_AT,
        SETTING_ROLLING_BACKUP_LAST_ERROR,
        SETTING_BACKUP_LAST_SUCCESSFUL_AT,
        SETTING_BACKUP_STALE_DAYS,
      ];
      const rows = await db
        .select()
        .from(systemSettings)
        .where(inArray(systemSettings.key, settingKeys));
      const rowMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));

      const dbHourRaw = rowMap[SETTING_BACKUP_HOUR_UTC] ?? null;
      const dbHourUtc =
        dbHourRaw !== null
          ? Math.max(0, Math.min(23, parseInt(dbHourRaw, 10) || 0))
          : null;

      const rollingEnabledRaw = rowMap[SETTING_ROLLING_BACKUP_ENABLED] ?? null;
      const rollingBackupEnabled = rollingEnabledRaw === null ? true : rollingEnabledRaw !== "false";
      const rollingBackupLastRunAt = rowMap[SETTING_ROLLING_BACKUP_LAST_RUN_AT] ?? null;
      const rollingBackupLastError = rowMap[SETTING_ROLLING_BACKUP_LAST_ERROR] ?? null;
      const lastSuccessfulBackupAt = rowMap[SETTING_BACKUP_LAST_SUCCESSFUL_AT] ?? null;
      const staleDaysRaw = rowMap[SETTING_BACKUP_STALE_DAYS] ?? null;
      const staleAfterDays =
        staleDaysRaw !== null && Number.isFinite(parseInt(staleDaysRaw, 10))
          ? parseInt(staleDaysRaw, 10)
          : DEFAULT_BACKUP_STALE_DAYS;

      return res.json({
        hourUtc,
        dbHourUtc,
        envHourUtc,
        rollingBackupEnabled,
        rollingBackupLastRunAt,
        rollingBackupLastError,
        lastSuccessfulBackupAt,
        staleAfterDays,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to fetch backup schedule settings." });
    }
  });

  router.patch("/admin/settings/backup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    // Toggle access only requires admin role — same policy as GET.
    if (!reqUser || reqUser.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const body = req.body as any;
      if (typeof body?.rollingBackupEnabled !== "boolean") {
        return res.status(400).json({ error: "rollingBackupEnabled (boolean) is required." });
      }
      const value = body.rollingBackupEnabled ? "true" : "false";
      await db
        .insert(systemSettings)
        .values({ key: SETTING_ROLLING_BACKUP_ENABLED, value })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
      return res.json({ success: true, rollingBackupEnabled: body.rollingBackupEnabled });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to update rolling backup setting." });
    }
  });

  router.put("/admin/settings/backup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const body = req.body as any;
      const hourUtc =
        typeof body?.hourUtc === "number"
          ? body.hourUtc
          : parseInt(String(body?.hourUtc ?? ""), 10);
      if (
        !Number.isFinite(hourUtc) ||
        !Number.isInteger(hourUtc) ||
        hourUtc < 0 ||
        hourUtc > 23
      ) {
        return res.status(400).json({ error: "hourUtc must be an integer between 0 and 23." });
      }
      await db
        .insert(systemSettings)
        .values({ key: SETTING_BACKUP_HOUR_UTC, value: String(hourUtc) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: String(hourUtc), updatedAt: new Date() },
        });
      return res.json({ success: true, hourUtc });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to save backup schedule settings." });
    }
  });

  router.delete("/admin/settings/backup-schedule", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const field = (req.query as any).field as string | undefined;
    if (field && field !== "hourUtc") {
      return res.status(400).json({ error: "Invalid field. Must be: hourUtc." });
    }
    try {
      await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_BACKUP_HOUR_UTC));
      return res.json({ success: true, reset: field ?? "all" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to reset backup schedule settings." });
    }
  });

  // ── Admin Desktop Installer ───────────────────────────────────────────────
  const SETTING_DESKTOP_INSTALLER_URL = "desktop_installer_url";
  const SETTING_DESKTOP_INSTALLER_VERSION = "desktop_installer_version";
  const SETTING_DESKTOP_INSTALLER_RELEASE_NOTES = "desktop_installer_release_notes";
  const SETTING_MOBILE_BUILD_LAST_TRIGGER = "mobile_build_last_trigger";
  const SETTING_MOBILE_VERSION_HISTORY = "mobile_app_version_history";
  const MOBILE_VERSION_HISTORY_MAX_ROWS = 20;

  function validateInstallerUrl(url: string): string | null {
    if (url.startsWith("https://") || url.startsWith("/downloads/")) return null;
    return "URL must start with https:// or /downloads/.";
  }

  function validateInstallerVersion(version: string): string | null {
    if (/^\d+\.\d+\.\d+$/.test(version)) return null;
    return "Version must follow the format X.Y.Z (e.g. 1.2.0).";
  }

  router.get("/desktop-installer", requireAuth, async (req, res) => {
    const envVersion = process.env.DESKTOP_INSTALLER_VERSION ?? "1.0.0";
    const envUrl =
      process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Windows-Portable.zip";
    const dbRows = await db
      .select()
      .from(systemSettings)
      .where(
        inArray(systemSettings.key, [
          SETTING_DESKTOP_INSTALLER_URL,
          SETTING_DESKTOP_INSTALLER_VERSION,
          SETTING_DESKTOP_INSTALLER_RELEASE_NOTES,
        ]),
      );
    const byKey = Object.fromEntries(dbRows.map((r) => [r.key, r.value]));
    const rawUrl = byKey[SETTING_DESKTOP_INSTALLER_URL] ?? envUrl;
    const version = byKey[SETTING_DESKTOP_INSTALLER_VERSION] ?? envVersion;
    const releaseNotes = byKey[SETTING_DESKTOP_INSTALLER_RELEASE_NOTES] ?? null;
    const urlError = validateInstallerUrl(rawUrl);
    if (urlError) {
      return res.status(503).json({ error: "Desktop installer is not configured." });
    }
    const fileName = rawUrl.split("/").pop() ?? "LabTrax-Windows-Portable.zip";
    const activeKind = installerKindFromUrl(rawUrl);
    const isLocalDownload = rawUrl.startsWith("/downloads/");
    const installerObject = activeKind
      ? await getDesktopInstallerMetadata(activeKind).catch((err) => {
          req.log.error({ err }, "Failed to read desktop installer metadata from App Storage");
          return null;
        })
      : null;
    // For locally-served downloads we know whether the file exists in App
    // Storage; for external https:// URLs we can't check without a HEAD request,
    // so report them as available and let the browser handle a 404.
    const available = isLocalDownload ? installerObject !== null : true;
    return res.json({
      version,
      downloadUrl: rawUrl,
      fileName,
      releaseNotes,
      installerObject,
      available,
    });
  });

  router.get("/admin/settings/desktop-installer", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const envVersion = process.env.DESKTOP_INSTALLER_VERSION ?? "1.0.0";
    const envUrl =
      process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Windows-Portable.zip";
    const dbRows = await db
      .select()
      .from(systemSettings)
      .where(
        inArray(systemSettings.key, [
          SETTING_DESKTOP_INSTALLER_URL,
          SETTING_DESKTOP_INSTALLER_VERSION,
          SETTING_DESKTOP_INSTALLER_RELEASE_NOTES,
        ]),
      );
    const byKey = Object.fromEntries(dbRows.map((r) => [r.key, r.value]));
    const updatedAtByKey = Object.fromEntries(
      dbRows.map((r) => [r.key, r.updatedAt as Date | null] as const),
    );
    const dbUrl = byKey[SETTING_DESKTOP_INSTALLER_URL] ?? null;
    const dbVersion = byKey[SETTING_DESKTOP_INSTALLER_VERSION] ?? null;
    const dbReleaseNotes = byKey[SETTING_DESKTOP_INSTALLER_RELEASE_NOTES] ?? null;
    const rawUrl = dbUrl ?? envUrl;
    const version = dbVersion ?? envVersion;
    const urlError = validateInstallerUrl(rawUrl);
    const fileName = urlError ? null : (rawUrl.split("/").pop() ?? "LabTrax-Windows-Portable.zip");
    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const githubRepoPattern = /^https:\/\/github\.com\/[^/]+\/[^/]+(\/)?$/;
    const repoUrlWarning =
      repoUrl !== null && !githubRepoPattern.test(repoUrl)
        ? "GITHUB_REPO_URL does not look like a valid https://github.com/<owner>/<repo> URL. The Actions link may not work correctly."
        : undefined;
    const activeKind = urlError ? null : installerKindFromUrl(rawUrl);
    let installerObject: Awaited<ReturnType<typeof getDesktopInstallerMetadata>> | null = null;
    let installerObjectError: string | null = null;
    if (activeKind) {
      try {
        installerObject = await getDesktopInstallerMetadata(activeKind);
      } catch (err) {
        req.log.error({ err }, "Failed to read desktop installer metadata from App Storage");
        installerObjectError =
          (err as Error)?.message || "Could not read installer metadata from storage.";
      }
    }
    // Status badge: classify the active download URL so admins see at a glance
    // whether the link will actually work.
    //   - "external": URL is https://… so we can't introspect it; assume ok.
    //   - "missing":  /downloads/ URL but no installer of that kind in App Storage.
    //   - "stale":    file is uploaded but predates the latest version/URL change.
    //   - "ok":       file is present and was uploaded at/after the last settings change.
    //   - "unknown":  url is invalid (urlError set) or storage read failed.
    const versionUpdatedAt = updatedAtByKey[SETTING_DESKTOP_INSTALLER_VERSION] ?? null;
    const urlUpdatedAt = updatedAtByKey[SETTING_DESKTOP_INSTALLER_URL] ?? null;
    const settingsUpdatedAt =
      versionUpdatedAt && urlUpdatedAt
        ? versionUpdatedAt > urlUpdatedAt
          ? versionUpdatedAt
          : urlUpdatedAt
        : (versionUpdatedAt ?? urlUpdatedAt ?? null);
    let installerStatus: "ok" | "missing" | "stale" | "external" | "unknown";
    let installerStatusMessage: string | null = null;
    if (urlError || installerObjectError) {
      installerStatus = "unknown";
      if (installerObjectError) {
        installerStatusMessage = installerObjectError;
      }
    } else if (!rawUrl.startsWith("/downloads/")) {
      installerStatus = "external";
      installerStatusMessage =
        "External URL — LabTrax can't verify whether this download still works.";
    } else if (!installerObject) {
      installerStatus = "missing";
      installerStatusMessage =
        activeKind === "exe"
          ? "No LabTrax-Setup.exe is uploaded — this download link will return 404."
          : activeKind === "dmg"
            ? "No LabTrax.dmg is uploaded — this download link will return 404."
            : "No LabTrax-Windows-Portable.zip is uploaded — this download link will return 404.";
    } else if (
      settingsUpdatedAt &&
      new Date(installerObject.uploadedAt).getTime() < settingsUpdatedAt.getTime() - 1000
    ) {
      installerStatus = "stale";
      installerStatusMessage = `Installer was uploaded before the current v${version} settings were saved — upload a fresh build so the download matches.`;
    } else {
      installerStatus = "ok";
    }
    return res.json({
      version,
      dbVersion,
      envVersion,
      downloadUrl: rawUrl,
      dbDownloadUrl: dbUrl,
      envDownloadUrl: envUrl,
      fileName,
      installerObjectError,
      repoUrl,
      urlError: urlError ?? null,
      repoUrlWarning,
      releaseNotes: dbReleaseNotes,
      dbReleaseNotes,
      installerObject,
      activeKind,
      installerStatus,
      installerStatusMessage,
      settingsUpdatedAt: settingsUpdatedAt ? settingsUpdatedAt.toISOString() : null,
    });
  });

  // Admin upload of the Windows portable installer zip → App Storage.
  // Guarded by the standard X-Platform-Admin-Secret check via isPlatformAdmin().
  const installerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  });
  router.post(
    "/admin/desktop-installer/upload",
    platformAdminUserOrSecret,
    (req, res, next) => {
      if (!isPlatformAdmin(req)) {
        res.status(403).json({ error: "Admin access required." });
        return;
      }
      installerUpload.single("file")(req, res, (err: any) => {
        if (err) {
          const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
          res.status(status).json({ error: err?.message || "Upload failed." });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const file = (req as any).file as
        | { originalname: string; mimetype: string; buffer: Buffer; size: number }
        | undefined;
      if (!file || !file.buffer || file.size === 0) {
        return res
          .status(400)
          .json({ error: "Missing 'file' field — attach the portable zip, Windows .exe, or macOS .dmg installer." });
      }
      const name = file.originalname || "";
      const isZipName = /\.zip$/i.test(name);
      const isExeName = /\.exe$/i.test(name);
      const isDmgName = /\.dmg$/i.test(name);
      if (!isZipName && !isExeName && !isDmgName) {
        return res.status(400).json({
          error:
            "File must be one of LabTrax-Windows-Portable.zip, LabTrax-Setup.exe, or LabTrax.dmg.",
        });
      }
      let kind: DesktopInstallerKind;
      if (isExeName) {
        kind = "exe";
        const isExeMime =
          file.mimetype === "application/vnd.microsoft.portable-executable" ||
          file.mimetype === "application/x-msdownload" ||
          file.mimetype === "application/x-msdos-program" ||
          file.mimetype === "application/octet-stream";
        // Windows PE files start with the "MZ" magic bytes (0x4D 0x5A).
        const isExeMagic =
          file.buffer.length >= 2 &&
          file.buffer[0] === 0x4d &&
          file.buffer[1] === 0x5a;
        if (!isExeMime || !isExeMagic) {
          return res.status(400).json({
            error:
              "File must be a Windows .exe installer (LabTrax-Setup.exe).",
          });
        }
      } else if (isDmgName) {
        kind = "dmg";
        const isDmgMime =
          file.mimetype === "application/x-apple-diskimage" ||
          file.mimetype === "application/octet-stream";
        // Apple DMG files end with a 512-byte "koly" trailer; the magic
        // signature ("koly" = 0x6B 0x6F 0x6C 0x79) sits at the start of
        // that trailing block. This is the standard way to validate a DMG
        // since the file's leading bytes vary by encoding.
        const isDmgMagic =
          file.buffer.length >= 512 &&
          file.buffer[file.buffer.length - 512] === 0x6b &&
          file.buffer[file.buffer.length - 511] === 0x6f &&
          file.buffer[file.buffer.length - 510] === 0x6c &&
          file.buffer[file.buffer.length - 509] === 0x79;
        if (!isDmgMime || !isDmgMagic) {
          return res.status(400).json({
            error:
              "File must be a macOS .dmg installer (LabTrax.dmg).",
          });
        }
      } else {
        kind = "zip";
        const isZipMime =
          file.mimetype === "application/zip" ||
          file.mimetype === "application/x-zip-compressed" ||
          file.mimetype === "application/octet-stream";
        const isZipMagic =
          file.buffer.length >= 4 &&
          file.buffer[0] === 0x50 &&
          file.buffer[1] === 0x4b &&
          (file.buffer[2] === 0x03 || file.buffer[2] === 0x05 || file.buffer[2] === 0x07);
        if (!isZipMime || !isZipMagic) {
          return res
            .status(400)
            .json({ error: "File must be a .zip archive (LabTrax-Windows-Portable.zip)." });
        }
      }
      const checksumSha256 = createHash("sha256").update(file.buffer).digest("hex");
      const forceRaw =
        (req.query as any)?.force ?? (req.body as any)?.force;
      const forceUpload =
        forceRaw === true ||
        forceRaw === "1" ||
        forceRaw === "true";
      if (!forceUpload) {
        try {
          const previous = await db
            .select({
              checksumSha256: installerUploads.checksumSha256,
              createdAt: installerUploads.createdAt,
              uploadedByUsername: installerUploads.uploadedByUsername,
            })
            .from(installerUploads)
            .orderBy(desc(installerUploads.createdAt))
            .limit(1);
          const last = previous[0];
          if (last?.checksumSha256 && last.checksumSha256 === checksumSha256) {
            return res.status(409).json({
              error:
                "This is the same file as your previous upload — did you forget to rebuild?",
              code: "duplicate_installer",
              previousUpload: {
                checksumSha256: last.checksumSha256,
                createdAt: last.createdAt,
                uploadedByUsername: last.uploadedByUsername ?? null,
              },
            });
          }
        } catch (dupErr) {
          req.log?.warn?.({ err: dupErr }, "Failed to check for duplicate installer upload");
        }
      }
      try {
        const meta = await uploadDesktopInstaller(file.buffer, kind);
        try {
          let activeVersion: string | null = null;
          try {
            const rows = await db
              .select({ key: systemSettings.key, value: systemSettings.value })
              .from(systemSettings)
              .where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_VERSION));
            activeVersion = rows[0]?.value ?? null;
          } catch {
            activeVersion = null;
          }
          if (!activeVersion) {
            activeVersion = process.env.DESKTOP_INSTALLER_VERSION || null;
          }
          const reqUser = (req as any).user as { id?: string; username?: string } | undefined;
          await db.insert(installerUploads).values({
            sizeBytes: meta.size,
            version: activeVersion,
            checksumSha256,
            uploadedByUserId: reqUser?.id ?? null,
            uploadedByUsername: reqUser?.username ?? null,
          });
        } catch (logErr) {
          req.log?.warn?.({ err: logErr }, "Failed to record installer upload entry");
        }
        return res.json({ success: true, kind, installerObject: meta });
      } catch (e: any) {
        if (e instanceof DesktopInstallerNotConfiguredError) {
          return res.status(503).json({ error: e.message });
        }
        req.log?.error?.({ err: e }, "Desktop installer upload failed");
        return res
          .status(500)
          .json({ error: e?.message || "Failed to upload installer." });
      }
    },
  );

  // CI calls this when the auto-publish step in build-windows.yml / release.yml
  // fails (upload or settings PUT returned non-2xx). We email the platform
  // admin recipient list (same recipients as the cleanup alert) with the
  // workflow run URL, version, stage, and error so the lab can re-run or
  // fall back to a manual upload quickly. Gated by the standard
  // X-Platform-Admin-Secret header — disable by unsetting PLATFORM_ADMIN_SECRET.
  router.post(
    "/admin/desktop-installer/publish-failure",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const asStr = (v: unknown): string | null => {
        if (typeof v !== "string") return null;
        const t = v.trim();
        return t.length > 0 ? t : null;
      };
      const stageRaw = asStr(body.stage);
      const stage =
        stageRaw && ["upload", "settings", "unknown"].includes(stageRaw.toLowerCase())
          ? stageRaw.toLowerCase()
          : "unknown";
      const httpStatusRaw = body.httpStatus;
      const httpStatus =
        typeof httpStatusRaw === "number" && Number.isFinite(httpStatusRaw)
          ? Math.trunc(httpStatusRaw)
          : null;
      const errorMessage = asStr(body.errorMessage);
      const runUrl = asStr(body.runUrl);
      const runId = asStr(body.runId);
      const commitSha = asStr(body.commitSha);
      const ref = asStr(body.ref);
      const version = asStr(body.version);
      const workflowName = asStr(body.workflowName);

      let adminEmails: string[] = [];
      try {
        const admins = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.role, "admin"));
        adminEmails = admins
          .map((u) => u.email)
          .filter((e): e is string => Boolean(e));
      } catch (e: any) {
        req.log?.error?.({ err: e }, "publish-failure: failed to load admin emails");
        return res
          .status(500)
          .json({ error: "Failed to load admin recipient list." });
      }

      try {
        await sendInstallerPublishFailureAlertEmail({
          adminEmails,
          workflowName,
          runUrl,
          runId,
          commitSha,
          ref,
          version,
          stage,
          httpStatus,
          errorMessage,
        });
      } catch (e: any) {
        req.log?.error?.({ err: e }, "publish-failure: send alert email failed");
        return res
          .status(500)
          .json({ error: e?.message || "Failed to send alert email." });
      }

      req.log?.warn?.(
        { runUrl, runId, version, stage, httpStatus, recipients: adminEmails.length },
        "Desktop installer auto-publish failure reported by CI; admin alert dispatched.",
      );
      return res.json({
        success: true,
        recipients: adminEmails.length,
      });
    },
  );

  router.put("/admin/settings/desktop-installer", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const body = req.body as any;
    const downloadUrl = typeof body?.downloadUrl === "string" ? body.downloadUrl.trim() : null;
    const version = typeof body?.version === "string" ? body.version.trim() : null;
    if (!downloadUrl) {
      return res.status(400).json({ error: "downloadUrl is required." });
    }
    const urlErr = validateInstallerUrl(downloadUrl);
    if (urlErr) {
      return res.status(400).json({ error: urlErr });
    }
    if (version !== null && version !== "") {
      const versionErr = validateInstallerVersion(version);
      if (versionErr) {
        return res.status(400).json({ error: versionErr });
      }
    }
    const releaseNotes =
      typeof body?.releaseNotes === "string" ? body.releaseNotes.trim() || null : null;
    try {
      const ops: Promise<unknown>[] = [
        db
          .insert(systemSettings)
          .values({ key: SETTING_DESKTOP_INSTALLER_URL, value: downloadUrl })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: downloadUrl, updatedAt: new Date() },
          }),
      ];
      if (version !== null && version !== "") {
        ops.push(
          db
            .insert(systemSettings)
            .values({ key: SETTING_DESKTOP_INSTALLER_VERSION, value: version })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: version, updatedAt: new Date() },
            }),
        );
      }
      if (releaseNotes !== null) {
        ops.push(
          db
            .insert(systemSettings)
            .values({ key: SETTING_DESKTOP_INSTALLER_RELEASE_NOTES, value: releaseNotes })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: releaseNotes, updatedAt: new Date() },
            }),
        );
      } else {
        ops.push(
          db
            .delete(systemSettings)
            .where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_RELEASE_NOTES)),
        );
      }
      await Promise.all(ops);
      try {
        const reqUser = (req as any).user as { id?: string; username?: string } | undefined;
        await db.insert(installerChangelog).values({
          downloadUrl,
          version: version || null,
          releaseNotes,
          savedByUserId: reqUser?.id ?? null,
          savedByUsername: reqUser?.username ?? null,
        });
      } catch (logErr) {
        req.log?.warn?.({ err: logErr }, "Failed to record installer changelog entry");
      }
      return res.json({ success: true, downloadUrl, version, releaseNotes });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to save installer settings." });
    }
  });

  router.get("/admin/settings/desktop-installer/release-notes-file", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const versionParam = typeof (req.query as any).version === "string"
      ? (req.query as any).version.trim()
      : "";
    if (!versionParam) {
      return res.status(400).json({ error: "version query parameter is required." });
    }
    const overridePath = process.env.RELEASE_NOTES_PATH?.trim();
    const notesPath = overridePath
      ? path.resolve(overridePath)
      : path.resolve(process.cwd(), "artifacts/labtrax-desktop/RELEASE_NOTES.md");
    let raw: string;
    try {
      raw = await readFile(notesPath, "utf8");
    } catch {
      return res.status(404).json({ error: "RELEASE_NOTES.md not found on this server." });
    }
    const normalizedVersion = versionParam.startsWith("v") ? versionParam : `v${versionParam}`;
    const lines = raw.split(/\r?\n/);
    let inBlock = false;
    const blockLines: string[] = [];
    for (const line of lines) {
      if (/^## v/.test(line)) {
        if (inBlock) break;
        const heading = line.replace(/^##\s+/, "").trim();
        if (heading === normalizedVersion) {
          inBlock = true;
        }
        continue;
      }
      if (inBlock) {
        blockLines.push(line);
      }
    }
    const notes = inBlock
      ? blockLines.join("\n").replace(/^\s+/, "").replace(/\s+$/, "") || null
      : null;
    return res.json({ version: normalizedVersion, notes });
  });

  router.get("/admin/settings/desktop-installer/history", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const limitRaw = Number((req.query as any).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    try {
      const rows = await db
        .select({
          id: installerChangelog.id,
          downloadUrl: installerChangelog.downloadUrl,
          version: installerChangelog.version,
          releaseNotes: installerChangelog.releaseNotes,
          savedByUserId: installerChangelog.savedByUserId,
          savedByUsername: installerChangelog.savedByUsername,
          createdAt: installerChangelog.createdAt,
        })
        .from(installerChangelog)
        .orderBy(desc(installerChangelog.createdAt))
        .limit(limit);
      const entries = rows.map((r) => {
        // CI publishes go through the X-Platform-Admin-Secret path which has no
        // real user id (savedByUserId is NULL). Manual uploads always carry the
        // admin's id. Username may be NULL on older rows or "ci:platform-admin-secret"
        // on newer ones, so don't rely on it to classify the source.
        const isCi =
          r.savedByUserId === null &&
          (r.savedByUsername === null ||
            r.savedByUsername === "ci:platform-admin-secret" ||
            (typeof r.releaseNotes === "string" &&
              r.releaseNotes.startsWith("Auto-published")));
        const source: "ci" | "manual" = isCi ? "ci" : "manual";
        let ciMetadata: { runId: string | null; commitSha: string | null; releaseTag: string | null } | null = null;
        if (isCi) {
          const notes = r.releaseNotes ?? "";
          const runMatch = notes.match(/run\s+(\d+)/i);
          const commitMatch = notes.match(/commit\s+([0-9a-f]{7,40})/i);
          const tagMatch = notes.match(/from release\s+(\S+?)\s/i);
          ciMetadata = {
            runId: runMatch ? runMatch[1] : null,
            commitSha: commitMatch ? commitMatch[1] : null,
            releaseTag: tagMatch ? tagMatch[1] : null,
          };
        }
        return { ...r, source, ciMetadata };
      });
      return res.json({ entries });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to load installer history." });
    }
  });

  router.get("/admin/desktop-installer/uploads", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const limitRaw = Number((req.query as any).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    try {
      const rows = await db
        .select({
          id: installerUploads.id,
          sizeBytes: installerUploads.sizeBytes,
          version: installerUploads.version,
          checksumSha256: installerUploads.checksumSha256,
          uploadedByUserId: installerUploads.uploadedByUserId,
          uploadedByUsername: installerUploads.uploadedByUsername,
          createdAt: installerUploads.createdAt,
        })
        .from(installerUploads)
        .orderBy(desc(installerUploads.createdAt))
        .limit(limit);
      return res.json({ uploads: rows });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to load installer uploads." });
    }
  });

  router.delete("/admin/desktop-installer/uploads", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const deleted = await db
        .delete(installerUploads)
        .returning({ id: installerUploads.id });
      return res.json({ success: true, deletedCount: deleted.length });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to clear installer upload history." });
    }
  });

  router.delete("/admin/desktop-installer/uploads/:id", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Upload id is required." });
    }
    try {
      const deleted = await db
        .delete(installerUploads)
        .where(eq(installerUploads.id, id))
        .returning({ id: installerUploads.id });
      if (deleted.length === 0) {
        return res.status(404).json({ error: "Upload entry not found." });
      }
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to delete installer upload entry." });
    }
  });

  router.delete("/admin/settings/desktop-installer", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      await db
        .delete(systemSettings)
        .where(
          inArray(systemSettings.key, [
            SETTING_DESKTOP_INSTALLER_URL,
            SETTING_DESKTOP_INSTALLER_VERSION,
            SETTING_DESKTOP_INSTALLER_RELEASE_NOTES,
          ]),
        );
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to reset installer settings." });
    }
  });

  // ── Admin: Subscriptions list ─────────────────────────────────────────────
  // Returns a paginated list of all subscription rows with provider, status,
  // currentPeriodEnd, and masked IDs. Platform-admin-secret gated.
  router.get("/admin/subscriptions", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
    const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
    const providerFilter = req.query.provider as string | undefined;
    const statusFilter = req.query.status as string | undefined;

    const conditions: SQL<unknown>[] = [isNull(subscriptions.deletedAt)];
    const validProviders = ["stripe", "revenuecat", "none"];
    if (providerFilter && validProviders.includes(providerFilter)) {
      conditions.push(eq(subscriptions.provider, providerFilter));
    }
    const validStatuses = ["trialing", "active", "past_due", "grace", "locked", "canceled", "legacy_free"];
    if (statusFilter && validStatuses.includes(statusFilter)) {
      conditions.push(eq(subscriptions.status, statusFilter));
    }

    const whereClause = and(...conditions);

    try {
      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(subscriptions)
          .where(whereClause)
          .orderBy(desc(subscriptions.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(subscriptions).where(whereClause),
      ]);

      // subjectType values: "lab_org" | "provider_org" (→ organizations table)
      //                      "user" (→ users table)
      const ORG_SUBJECT_TYPES = new Set(["lab_org", "provider_org"]);

      const orgIds = rows
        .filter((r) => ORG_SUBJECT_TYPES.has(r.subjectType))
        .map((r) => r.subjectId)
        .filter(Boolean);
      // Treat any subject that is not an org type as a user record
      // (covers "user", "provider_user", and any future variants)
      const userIds = rows
        .filter((r) => !ORG_SUBJECT_TYPES.has(r.subjectType))
        .map((r) => r.subjectId)
        .filter(Boolean);

      const [orgRows, userRows] = await Promise.all([
        orgIds.length > 0
          ? db
              .select({ id: organizations.id, name: organizations.name, type: organizations.type })
              .from(organizations)
              .where(inArray(organizations.id, orgIds))
          : ([] as { id: string; name: string; type: string }[]),
        userIds.length > 0
          ? db
              .select({
                id: users.id,
                username: users.username,
                firstName: users.firstName,
                lastName: users.lastName,
                email: users.email,
              })
              .from(users)
              .where(inArray(users.id, userIds))
          : ([] as { id: string; username: string; firstName: string | null; lastName: string | null; email: string | null }[]),
      ]);

      const orgMap = new Map(orgRows.map((o) => [o.id, { name: o.name, type: o.type }]));
      const userMap = new Map(
        userRows.map((u) => [
          u.id,
          {
            name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username,
            email: u.email,
          },
        ])
      );

      function maskId(id: string | null | undefined): string | null {
        if (!id) return null;
        if (id.length <= 8) return "****";
        return id.slice(0, 4) + "****" + id.slice(-4);
      }

      const items = rows.map((r) => {
        const isOrg = ORG_SUBJECT_TYPES.has(r.subjectType);
        const orgInfo = isOrg ? orgMap.get(r.subjectId) : null;
        const userInfo = !isOrg ? userMap.get(r.subjectId) : null;
        return {
          id: r.id,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          subjectName: orgInfo?.name ?? userInfo?.name ?? r.subjectId,
          subjectOrgType: orgInfo?.type ?? null,
          subjectEmail: userInfo?.email ?? null,
          provider: r.provider,
          status: r.status,
          currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: r.cancelAtPeriodEnd,
          paymentMethodOnFile: r.paymentMethodOnFile,
          revenueCatAppUserId: maskId(r.revenueCatAppUserId),
          stripeCustomerId: maskId(r.stripeCustomerId),
          stripeSubscriptionId: maskId(r.stripeSubscriptionId),
          createdAt: r.createdAt.toISOString(),
        };
      });

      return res.json({ ok: true, items, total, limit, offset });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to fetch subscriptions." });
    }
  });

  // ── Admin Backup → OneDrive (legacy) ─────────────────────────────────────
  router.post("/admin/backup/onedrive", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const result = await runOneDriveBackup(
        `manual:${reqUser.username || reqUser.id}`,
      );
      return res.json({ success: true, ...result });
    } catch (e: any) {
      console.error("OneDrive backup error:", e?.message);
      return res
        .status(500)
        .json({ error: e?.message || "OneDrive backup failed." });
    }
  });

  // ── Admin Backup: run now ─────────────────────────────────────────────────
  router.post("/admin/backup/run", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const reqUser = (req as any).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const destination = body.destination as BackupDestination | undefined;
    if (destination !== "onedrive" && destination !== "local" && destination !== "network") {
      return res.status(400).json({ error: "destination must be one of: onedrive, local, network." });
    }
    const destPath = typeof body.path === "string" ? body.path.trim() : undefined;
    if ((destination === "local" || destination === "network") && !destPath) {
      return res.status(400).json({ error: "path is required for local and network destinations." });
    }
    try {
      const triggeredBy = `manual:${(reqUser as any)?.username || "admin"}`;
      const result = await runBackup(triggeredBy, destination, destPath);
      return res.json({ ok: true, size: result.size, completedAt: result.completedAt, fileName: result.fileName });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Backup failed." });
    }
  });

  // ── Admin Backup: schedule get ────────────────────────────────────────────
  // Convert interval+unit → intervalMinutes (stored in DB).
  function toIntervalMinutes(interval: number, unit: "minutes" | "hours"): number {
    return unit === "hours" ? interval * 60 : interval;
  }
  // Convert stored intervalMinutes back to { interval, unit } for the API response.
  function fromIntervalMinutes(
    minutes: number | null,
  ): { interval: number | null; unit: "minutes" | "hours" | null } {
    if (minutes === null) return { interval: null, unit: null };
    if (minutes >= 60 && minutes % 60 === 0) return { interval: minutes / 60, unit: "hours" };
    return { interval: minutes, unit: "minutes" };
  }

  router.get("/admin/backup/schedule", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const [config, lastSuccessfulBackupAt, staleAlertSettings, staleDaysRow] = await Promise.all([
        getBackupScheduleConfig(),
        getLastSuccessfulBackupAt(),
        getBackupStaleAlertSettings(),
        db.select().from(systemSettings).where(eq(systemSettings.key, SETTING_BACKUP_STALE_DAYS)).limit(1),
      ]);
      const { interval, unit } = fromIntervalMinutes(config.intervalMinutes);
      const staleDaysRaw = staleDaysRow[0]?.value ?? null;
      const staleAfterDays = staleDaysRaw !== null ? parseInt(staleDaysRaw, 10) : DEFAULT_BACKUP_STALE_DAYS;
      return res.json({
        ok: true,
        interval,
        unit,
        destination: config.destination,
        path: config.path,
        enabled: config.enabled,
        lastSuccessfulBackupAt,
        staleAlertThresholdDays: staleAlertSettings.thresholdDays,
        staleAlertRateLimitDays: staleAlertSettings.rateLimitDays,
        staleAfterDays: Number.isFinite(staleAfterDays) ? staleAfterDays : DEFAULT_BACKUP_STALE_DAYS,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch backup schedule.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin Backup: schedule save ───────────────────────────────────────────
  router.put("/admin/backup/schedule", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const intervalRaw = typeof body.interval === "number" ? body.interval : parseInt(String(body.interval ?? ""), 10);
    const unit = body.unit as "minutes" | "hours" | undefined;
    const destination = body.destination as BackupDestination | undefined;
    const destPath = typeof body.path === "string" ? body.path.trim() || null : null;
    const enabled = body.enabled === true || body.enabled === "true";
    const staleAfterDaysRaw = body.staleAfterDays !== undefined
      ? (typeof body.staleAfterDays === "number" ? body.staleAfterDays : parseInt(String(body.staleAfterDays), 10))
      : null;

    const staleThresholdRaw =
      typeof body.staleAlertThresholdDays === "number"
        ? body.staleAlertThresholdDays
        : typeof body.staleAlertThresholdDays === "string"
          ? parseInt(body.staleAlertThresholdDays, 10)
          : null;
    const staleRateLimitRaw =
      typeof body.staleAlertRateLimitDays === "number"
        ? body.staleAlertRateLimitDays
        : typeof body.staleAlertRateLimitDays === "string"
          ? parseInt(body.staleAlertRateLimitDays, 10)
          : null;

    if (!Number.isFinite(intervalRaw) || intervalRaw <= 0) {
      return res.status(400).json({ error: "interval must be a positive integer." });
    }
    if (unit !== "minutes" && unit !== "hours") {
      return res.status(400).json({ error: "unit must be 'minutes' or 'hours'." });
    }
    if (staleAfterDaysRaw !== null && (!Number.isInteger(staleAfterDaysRaw) || staleAfterDaysRaw < 1 || staleAfterDaysRaw > 365)) {
      return res.status(400).json({ error: "staleAfterDays must be an integer between 1 and 365." });
    }
    const intervalMinutes = toIntervalMinutes(intervalRaw, unit);
    const VALID_INTERVALS = [15, 30, 60, 120, 240, 480, 1440];
    if (!VALID_INTERVALS.includes(intervalMinutes)) {
      return res.status(400).json({
        error: `Computed intervalMinutes (${intervalMinutes}) is not a supported value. Valid combinations: 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 24 h.`,
      });
    }
    if (destination !== "onedrive" && destination !== "local" && destination !== "network") {
      return res.status(400).json({ error: "destination must be one of: onedrive, local, network." });
    }
    if ((destination === "local" || destination === "network") && !destPath) {
      return res.status(400).json({ error: "path is required for local and network destinations." });
    }
    // Reject SFTP URLs with embedded passwords — credentials must not be stored
    // at rest in system_settings. Use SSH key authentication or mount the remote
    // share as a local filesystem path.
    if (destPath && destPath.startsWith("sftp://")) {
      try {
        const u = new URL(destPath);
        if (u.password) {
          return res.status(400).json({
            error:
              "SFTP URLs must not contain an embedded password (credentials at rest risk). " +
              "Use SSH key-based authentication and omit the password from the URL: sftp://user@host/path",
          });
        }
      } catch {
        return res.status(400).json({ error: "Invalid SFTP URL." });
      }
    }
    if (staleThresholdRaw !== null && (!Number.isFinite(staleThresholdRaw) || !Number.isInteger(staleThresholdRaw) || staleThresholdRaw < 1 || staleThresholdRaw > 365)) {
      return res.status(400).json({ error: "staleAlertThresholdDays must be an integer between 1 and 365." });
    }
    if (staleRateLimitRaw !== null && (!Number.isFinite(staleRateLimitRaw) || !Number.isInteger(staleRateLimitRaw) || staleRateLimitRaw < 1 || staleRateLimitRaw > 365)) {
      return res.status(400).json({ error: "staleAlertRateLimitDays must be an integer between 1 and 365." });
    }

    try {
      const upsert = async (key: string, value: string | null) => {
        if (value === null) {
          await db.delete(systemSettings).where(eq(systemSettings.key, key));
        } else {
          await db
            .insert(systemSettings)
            .values({ key, value })
            .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
        }
      };
      await upsert(SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, String(intervalMinutes));
      await upsert(SETTING_BACKUP_SCHEDULE_DESTINATION, destination);
      await upsert(SETTING_BACKUP_SCHEDULE_PATH, destPath);
      await upsert(SETTING_BACKUP_SCHEDULE_ENABLED, enabled ? "true" : "false");
      if (staleThresholdRaw !== null) {
        await upsert(SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS, String(staleThresholdRaw));
      }
      if (staleRateLimitRaw !== null) {
        await upsert(SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS, String(staleRateLimitRaw));
      }
      if (staleAfterDaysRaw !== null && Number.isFinite(staleAfterDaysRaw) && staleAfterDaysRaw >= 1) {
        await upsert(SETTING_BACKUP_STALE_DAYS, String(staleAfterDaysRaw));
      }

      // Restart the in-process recurring job with the new settings.
      void restartScheduledBackupJob();

      return res.json({ ok: true, interval: intervalRaw, unit, destination, path: destPath, enabled, staleAfterDays: staleAfterDaysRaw ?? DEFAULT_BACKUP_STALE_DAYS });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save backup schedule.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin Backup: schedule disable ───────────────────────────────────────
  router.delete("/admin/backup/schedule", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      await db
        .insert(systemSettings)
        .values({ key: SETTING_BACKUP_SCHEDULE_ENABLED, value: "false" })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: "false", updatedAt: new Date() },
        });
      void restartScheduledBackupJob();
      return res.json({ ok: true, enabled: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to disable backup schedule.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin Backup: history ─────────────────────────────────────────────────
  router.get("/admin/backup/history", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin" || reqUser.userType !== "lab") {
      return res.status(403).json({ error: "Lab admin access required." });
    }
    try {
      const rows = await db
        .select()
        .from(backupRuns)
        .orderBy(sql`${backupRuns.completedAt} DESC`)
        .limit(20);
      return res.json({ ok: true, runs: rows });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch backup history.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin Backup: history retention settings (GET) ────────────────────────
  router.get("/admin/backup/history-retention", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const retention = await getBackupHistoryRetentionDays();
      return res.json({ ok: true, ...retention });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch backup history retention settings.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Rx Practice Name Aliases ─────────────────────────────────────────────
  // GET /rx-practice-aliases?labOrganizationId=&rxName=
  router.get("/rx-practice-aliases", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { labOrganizationId, rxName } = req.query as Record<string, unknown>;
    if (typeof labOrganizationId !== "string" || !labOrganizationId.trim()) {
      return res.status(400).json({ error: "labOrganizationId is required" });
    }
    if (typeof rxName !== "string" || !rxName.trim()) {
      return res.status(400).json({ error: "rxName is required" });
    }

    // Verify caller is an active member of this lab.
    const membership = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, reqUser.id),
          eq(organizationMemberships.labId, labOrganizationId.trim()),
          eq(organizationMemberships.status, "active"),
          eq(organizations.type, "lab")
        )
      )
      .limit(1);
    if (membership.length === 0) {
      return res.status(403).json({ error: "Not a member of this lab" });
    }

    const normalizedRxName = rxName.trim().toLowerCase();
    const row = await db
      .select({ providerOrganizationId: rxPracticeNameAliases.providerOrganizationId })
      .from(rxPracticeNameAliases)
      .where(
        and(
          eq(rxPracticeNameAliases.labOrganizationId, labOrganizationId.trim()),
          eq(rxPracticeNameAliases.rxName, normalizedRxName)
        )
      )
      .limit(1);

    if (row.length === 0) {
      return res.json({ ok: true, data: { found: false, providerOrganizationId: null } });
    }
    return res.json({ ok: true, data: { found: true, providerOrganizationId: row[0].providerOrganizationId } });
  });

  // POST /rx-practice-aliases — upsert an alias
  router.post("/rx-practice-aliases", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { labOrganizationId, rxName, providerOrganizationId } = body;
    if (typeof labOrganizationId !== "string" || !labOrganizationId.trim()) {
      return res.status(400).json({ error: "labOrganizationId is required" });
    }
    if (typeof rxName !== "string" || !rxName.trim()) {
      return res.status(400).json({ error: "rxName is required" });
    }
    if (typeof providerOrganizationId !== "string" || !providerOrganizationId.trim()) {
      return res.status(400).json({ error: "providerOrganizationId is required" });
    }

    // Verify caller is an active member of this lab.
    const membership = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, reqUser.id),
          eq(organizationMemberships.labId, labOrganizationId.trim()),
          eq(organizationMemberships.status, "active"),
          eq(organizations.type, "lab")
        )
      )
      .limit(1);
    if (membership.length === 0) {
      return res.status(403).json({ error: "Not a member of this lab" });
    }

    const normalizedRxName = rxName.trim().toLowerCase();
    await db
      .insert(rxPracticeNameAliases)
      .values({
        labOrganizationId: labOrganizationId.trim(),
        rxName: normalizedRxName,
        providerOrganizationId: providerOrganizationId.trim(),
        createdByUserId: reqUser.id,
      })
      .onConflictDoUpdate({
        target: [rxPracticeNameAliases.labOrganizationId, rxPracticeNameAliases.rxName],
        set: { providerOrganizationId: providerOrganizationId.trim() },
      });

    return res.json({ ok: true, data: { found: true, providerOrganizationId: providerOrganizationId.trim() } });
  });

  // ── Admin Backup: restore — status poll ──────────────────────────────────
  router.get("/admin/backup/restore/status", platformAdminUserOrSecret, (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    return res.json({ ok: true, ...getRestoreState() });
  });

  // ── Admin Backup: restore — upload file ──────────────────────────────────
  // Security: platformAdminUserOrSecret guard runs BEFORE multer so that
  // unauthenticated requests are rejected before any bytes are read.
  const restoreTmpDir = path.join(os.tmpdir(), "labtrax-restore-uploads");
  const restoreUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(restoreTmpDir, { recursive: true });
        cb(null, restoreTmpDir);
      },
      filename: (_req, _file, cb) => {
        cb(null, `restore-${Date.now()}-${randomBytes(4).toString("hex")}.zip.enc`);
      },
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const name = file.originalname ?? "";
      if (!name.endsWith(".zip.enc") && !name.endsWith(".zip") && file.mimetype !== "application/octet-stream") {
        return cb(new Error("Only .zip.enc backup files are accepted."));
      }
      cb(null, true);
    },
  });

  router.post(
    "/admin/backup/restore",
    platformAdminUserOrSecret,
    (req: any, res: any, next: any) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      // Reject concurrent restores before reading any bytes.
      const currentState = getRestoreState();
      if (currentState.phase !== "idle" && currentState.phase !== "done" && currentState.phase !== "error") {
        return res.status(409).json({ error: "A restore is already in progress.", phase: currentState.phase });
      }
      next();
    },
    restoreUpload.single("file"),
    async (req: any, res: any) => {
      const uploadedFile = req.file as Express.Multer.File | undefined;
      if (!uploadedFile) {
        return res.status(400).json({ error: "No backup file uploaded. Send the .zip.enc file as the 'file' field." });
      }
      const reqUser = req.user;
      const triggeredBy = `restore:${reqUser?.username || "admin"}`;
      // Respond immediately with 202, restore runs async.
      res.status(202).json({ ok: true, phase: "decrypting", message: "Restore started." });
      // Run the restore pipeline in background.
      (async () => {
        let filePath: string | undefined = uploadedFile.path;
        try {
          const encryptedBuffer = fs.readFileSync(filePath);
          // Delete temp upload file once in memory.
          try { fs.unlinkSync(filePath); filePath = undefined; } catch { /* ignore */ }
          await executeRestore(encryptedBuffer, triggeredBy);
        } catch (err: unknown) {
          req.log?.error(
            { err: err instanceof Error ? err.message : String(err) },
            "[restore] Restore pipeline failed",
          );
        } finally {
          if (filePath) {
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
          }
        }
      })().catch(() => { /* handled above */ });
    },
  );

  // ── Admin Backup: restore — from OneDrive (latest backup) ────────────────
  router.post("/admin/backup/restore/from-onedrive", platformAdminUserOrSecret, async (req: any, res: any) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const currentState = getRestoreState();
    if (currentState.phase !== "idle" && currentState.phase !== "done" && currentState.phase !== "error") {
      return res.status(409).json({ error: "A restore is already in progress.", phase: currentState.phase });
    }
    const reqUser = req.user;
    const triggeredBy = `restore-onedrive:${reqUser?.username || "admin"}`;
    // Respond 202, fetch + restore runs async.
    res.status(202).json({ ok: true, phase: "uploading", message: "Fetching latest backup from OneDrive…" });
    (async () => {
      try {
        // List LabTrax Backups folder, find the most-recently-modified .zip.enc
        const folderPath = "LabTrax Backups";
        const { getOneDriveAccessToken: _getToken } = await import("../lib/onedrive") as any;
        const token = await _getToken();
        const listResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(folderPath)}:/children?$top=500`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!listResp.ok) {
          const errText = await listResp.text();
          throw new Error(`Failed to list OneDrive backups: ${listResp.status} ${errText.slice(0, 200)}`);
        }
        const listData = await listResp.json() as any;
        const items: Array<{ name: string; id: string; lastModifiedDateTime: string; size: number }> =
          (listData.value ?? []).filter((item: any) =>
            typeof item.name === "string" && item.name.endsWith(".zip.enc"),
          );
        if (items.length === 0) {
          throw new Error("No .zip.enc backup files found in the LabTrax Backups folder on OneDrive.");
        }
        items.sort((a, b) =>
          new Date(b.lastModifiedDateTime).getTime() - new Date(a.lastModifiedDateTime).getTime(),
        );
        const latest = items[0]!;
        // Download the file content.
        const downloadResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(latest.id)}/content`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!downloadResp.ok) {
          const errText = await downloadResp.text();
          throw new Error(`Failed to download backup from OneDrive: ${downloadResp.status} ${errText.slice(0, 200)}`);
        }
        const arrayBuffer = await downloadResp.arrayBuffer();
        const encryptedBuffer = Buffer.from(arrayBuffer);
        await executeRestore(encryptedBuffer, triggeredBy);
      } catch (err: unknown) {
        req.log?.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[restore] OneDrive restore pipeline failed",
        );
      }
    })().catch(() => { /* handled above */ });
  });

  // ── Admin Backup: history retention settings (PUT) ────────────────────────
  router.put("/admin/backup/history-retention", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { retentionDays, maxRows } = req.body as {
      retentionDays?: unknown;
      maxRows?: unknown;
    };

    if (retentionDays !== undefined) {
      const parsed = parseInt(String(retentionDays), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: "retentionDays must be a positive integer." });
      }
    }
    if (maxRows !== undefined) {
      const parsed = parseInt(String(maxRows), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: "maxRows must be a positive integer." });
      }
    }

    try {
      const upsert = async (key: string, value: string | null) => {
        if (value === null) {
          await db.delete(systemSettings).where(eq(systemSettings.key, key));
        } else {
          await db
            .insert(systemSettings)
            .values({ key, value })
            .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
        }
      };

      if (retentionDays !== undefined) {
        await upsert(SETTING_BACKUP_HISTORY_RETENTION_DAYS, String(parseInt(String(retentionDays), 10)));
      }
      if (maxRows !== undefined) {
        await upsert(SETTING_BACKUP_HISTORY_MAX_ROWS, String(parseInt(String(maxRows), 10)));
      }

      const retention = await getBackupHistoryRetentionDays();
      return res.json({ ok: true, ...retention });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save backup history retention settings.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin: Mobile Build ────────────────────────────────────────────────────
  // Returns current build numbers from app.json and last-triggered build info.
  router.get("/admin/mobile-build/info", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const appJsonPath = path.resolve(process.cwd(), "artifacts/labtrax/app.json");
    let iosBuildNumber: string | null = null;
    let androidVersionCode: number | null = null;
    let expoVersion: string | null = null;
    let appJsonError: string | null = null;
    try {
      const raw = await readFile(appJsonPath, "utf8");
      const appJson = JSON.parse(raw) as {
        expo?: { version?: string; ios?: { buildNumber?: string }; android?: { versionCode?: number } };
      };
      iosBuildNumber = appJson.expo?.ios?.buildNumber ?? null;
      androidVersionCode = appJson.expo?.android?.versionCode ?? null;
      expoVersion = appJson.expo?.version ?? null;
    } catch (err) {
      appJsonError = (err as Error).message ?? "Could not read app.json.";
    }

    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const tokenConfigured = !!process.env.GITHUB_ACTIONS_TOKEN;

    const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\/)?$/;
    const repoMatch = repoUrl ? githubRepoPattern.exec(repoUrl) : null;
    const repoOwner = repoMatch?.[1] ?? null;
    const repoName = repoMatch?.[2] ?? null;

    const settingRows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, [SETTING_MOBILE_BUILD_LAST_TRIGGER, SETTING_MOBILE_VERSION_HISTORY]));
    const settingMap = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));

    let lastTrigger: {
      platform: string;
      profile: string;
      triggeredAt: string;
      triggeredByUsername: string;
    } | null = null;
    const lastTriggerRaw = settingMap[SETTING_MOBILE_BUILD_LAST_TRIGGER];
    if (lastTriggerRaw) {
      try {
        lastTrigger = JSON.parse(lastTriggerRaw) as typeof lastTrigger;
      } catch {
        /* ignore malformed row */
      }
    }

    type VersionHistoryEntry = { version: string; changedByUsername: string; changedAt: string };
    let versionHistory: VersionHistoryEntry[] = [];
    const historyRaw = settingMap[SETTING_MOBILE_VERSION_HISTORY];
    if (historyRaw) {
      try {
        const parsed = JSON.parse(historyRaw) as unknown;
        if (Array.isArray(parsed)) versionHistory = parsed as VersionHistoryEntry[];
      } catch {
        /* ignore malformed row */
      }
    }

    // Fetch eas-build.yml runs from GitHub Actions API and correlate to the
    // last trigger record. We fetch the most recent 10 runs so we can find
    // the first one whose created_at is at or after triggeredAt (with a
    // 2-minute tolerance for clock skew between GitHub and our server).
    // When a trigger is very recent, GitHub may not have created the run yet —
    // in that case we return null so the frontend can display "Pending".
    let latestRun: {
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
    } | null = null;
    const ghToken = process.env.GITHUB_ACTIONS_TOKEN;
    if (ghToken && repoOwner && repoName) {
      try {
        const runsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/eas-build.yml/runs?per_page=10&branch=main`;
        const runsRes = await fetch(runsUrl, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (runsRes.ok) {
          const runsBody = await runsRes.json() as {
            workflow_runs?: Array<{
              id: number;
              status: string;
              conclusion: string | null;
              html_url: string;
              created_at: string;
            }>;
          };
          const runs = runsBody.workflow_runs ?? [];
          if (lastTrigger?.triggeredAt) {
            // Allow 2-minute tolerance: the run may have been created slightly
            // before our server recorded triggeredAt due to clock skew.
            const windowMs = 2 * 60 * 1000;
            const triggeredAtMs = new Date(lastTrigger.triggeredAt).getTime();
            const thresholdMs = triggeredAtMs - windowMs;
            // runs are sorted newest-first by GitHub; find the oldest run
            // within our window (i.e., the first one actually dispatched by
            // this trigger) by scanning from oldest to newest among candidates.
            const candidates = runs.filter(
              (r) => new Date(r.created_at).getTime() >= thresholdMs,
            );
            // candidates are newest-first; the last element is the oldest match,
            // which corresponds to the specific trigger we dispatched.
            latestRun = candidates.at(-1) ?? null;
          } else {
            latestRun = runs[0] ?? null;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Failed to fetch latest GitHub Actions run for mobile build");
      }
    }

    return res.json({
      iosBuildNumber,
      androidVersionCode,
      expoVersion,
      appJsonError,
      repoUrl,
      repoOwner,
      repoName,
      tokenConfigured,
      lastTrigger,
      latestRun,
      versionHistory: versionHistory.slice(0, 5),
    });
  });

  // Updates the expo.version field in app.json and git-commits the change.
  router.put("/admin/mobile-build/app-version", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const { version } = req.body as { version?: unknown };
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version.trim())) {
      return res.status(400).json({ error: "version must be a valid semver string (x.y.z)." });
    }
    const newVersion = version.trim();

    const appJsonPath = path.resolve(process.cwd(), "artifacts/labtrax/app.json");
    let appJson: Record<string, unknown>;
    try {
      const raw = await readFile(appJsonPath, "utf8");
      appJson = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return res.status(500).json({ error: `Could not read app.json: ${(err as Error).message}` });
    }

    const expo = appJson.expo as Record<string, unknown> | undefined;
    if (!expo || typeof expo !== "object") {
      return res.status(500).json({ error: "app.json is missing the expo key." });
    }
    expo.version = newVersion;

    try {
      await writeFile(appJsonPath, JSON.stringify(appJson, null, 2) + "\n", "utf8");
    } catch (err) {
      return res.status(500).json({ error: `Could not write app.json: ${(err as Error).message}` });
    }

    const reqUser = (req as any).user as { username?: string } | undefined;
    const author = reqUser?.username ?? "labtrax-admin";

    // Record version history in system_settings (capped at MOBILE_VERSION_HISTORY_MAX_ROWS).
    // This is part of the success contract — a failure here returns 500 so no audit record is silently lost.
    const [historyRow] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_MOBILE_VERSION_HISTORY));
    let history: { version: string; changedByUsername: string; changedAt: string }[] = [];
    if (historyRow?.value) {
      try {
        const parsed = JSON.parse(historyRow.value) as unknown;
        if (Array.isArray(parsed)) history = parsed as typeof history;
      } catch { /* malformed JSON — start fresh */ }
    }
    history.unshift({ version: newVersion, changedByUsername: author, changedAt: new Date().toISOString() });
    if (history.length > MOBILE_VERSION_HISTORY_MAX_ROWS) history = history.slice(0, MOBILE_VERSION_HISTORY_MAX_ROWS);
    await db
      .insert(systemSettings)
      .values({ key: SETTING_MOBILE_VERSION_HISTORY, value: JSON.stringify(history) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(history), updatedAt: new Date() } });

    // Attempt a git commit; failures are non-fatal — the file has already been updated.
    await new Promise<void>((resolve) => {
      const git = spawn("git", ["add", appJsonPath], { stdio: "ignore" });
      git.on("close", (addCode) => {
        if (addCode !== 0) { resolve(); return; }
        const commit = spawn(
          "git",
          ["commit", "-m", `chore: bump mobile app version to ${newVersion} (via settings panel by ${author})`],
          { stdio: "ignore" },
        );
        commit.on("close", () => resolve());
      });
    });

    return res.json({ ok: true, expoVersion: newVersion });
  });

  router.delete("/admin/mobile-build/version-history", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    await db
      .delete(systemSettings)
      .where(eq(systemSettings.key, SETTING_MOBILE_VERSION_HISTORY));

    return res.json({ ok: true });
  });

  // Triggers a GitHub Actions workflow_dispatch for eas-build.yml.
  router.post("/admin/mobile-build/trigger", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const token = process.env.GITHUB_ACTIONS_TOKEN;
    if (!token) {
      return res.status(503).json({
        error: "GITHUB_ACTIONS_TOKEN is not configured. Set it as an environment secret to enable mobile builds.",
      });
    }

    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\/)?$/;
    const repoMatch = repoUrl ? githubRepoPattern.exec(repoUrl) : null;
    const repoOwner = repoMatch?.[1] ?? null;
    const repoName = repoMatch?.[2] ?? null;
    if (!repoOwner || !repoName) {
      return res.status(503).json({
        error: "GITHUB_REPO_URL is not set or not a valid https://github.com/<owner>/<repo> URL.",
      });
    }

    const { platform, profile } = req.body as { platform?: unknown; profile?: unknown };
    const validPlatforms = ["all", "ios", "android"] as const;
    const validProfiles = ["production", "preview", "development"] as const;
    const chosenPlatform = validPlatforms.includes(platform as any) ? (platform as string) : "all";
    const chosenProfile = validProfiles.includes(profile as any) ? (profile as string) : "production";

    const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/eas-build.yml/dispatches`;
    let ghRes: Response;
    try {
      ghRes = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { platform: chosenPlatform, profile: chosenProfile },
        }),
      });
    } catch (err) {
      req.log.error({ err }, "GitHub API request failed for mobile build trigger");
      return res.status(502).json({ error: "Could not reach the GitHub API. Check server connectivity." });
    }

    if (!ghRes.ok) {
      let detail = "";
      try {
        const body = await ghRes.json() as { message?: string };
        detail = body.message ? ` — ${body.message}` : "";
      } catch { /* ignore */ }
      req.log.error(
        { status: ghRes.status, url: dispatchUrl },
        "GitHub workflow_dispatch returned a non-2xx response",
      );
      return res.status(502).json({
        error: `GitHub rejected the workflow dispatch (HTTP ${ghRes.status})${detail}. Verify that GITHUB_ACTIONS_TOKEN has workflow write access and that the eas-build.yml workflow exists on the main branch.`,
      });
    }

    const reqUser = (req as any).user as { username?: string } | undefined;
    const triggerRecord = {
      platform: chosenPlatform,
      profile: chosenProfile,
      triggeredAt: new Date().toISOString(),
      triggeredByUsername: reqUser?.username ?? "unknown",
    };

    try {
      await db
        .insert(systemSettings)
        .values({ key: SETTING_MOBILE_BUILD_LAST_TRIGGER, value: JSON.stringify(triggerRecord) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: JSON.stringify(triggerRecord), updatedAt: new Date() },
        });
    } catch (err) {
      req.log.warn({ err }, "Failed to persist mobile build last-trigger record");
    }

    return res.json({ ok: true, trigger: triggerRecord });
  });

  // Returns the status of the most recent eas-build.yml GitHub Actions run.
  router.get("/admin/mobile-build/status", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const token = process.env.GITHUB_ACTIONS_TOKEN;
    if (!token) {
      return res.status(503).json({
        error: "GITHUB_ACTIONS_TOKEN is not configured.",
      });
    }

    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\/)?$/;
    const repoMatch = repoUrl ? githubRepoPattern.exec(repoUrl) : null;
    const repoOwner = repoMatch?.[1] ?? null;
    const repoName = repoMatch?.[2] ?? null;
    if (!repoOwner || !repoName) {
      return res.status(503).json({
        error: "GITHUB_REPO_URL is not set or not a valid https://github.com/<owner>/<repo> URL.",
      });
    }

    const runsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/eas-build.yml/runs?per_page=1`;
    let ghRes: Response;
    try {
      ghRes = await fetch(runsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (err) {
      req.log.error({ err }, "GitHub API request failed for mobile build status");
      return res.status(502).json({ error: "Could not reach the GitHub API." });
    }

    if (!ghRes.ok) {
      req.log.error({ status: ghRes.status, url: runsUrl }, "GitHub workflow runs returned a non-2xx response");
      return res.status(502).json({ error: `GitHub API returned HTTP ${ghRes.status}.` });
    }

    const body = await ghRes.json() as {
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        created_at: string;
        updated_at: string;
      }>;
    };

    const run = body.workflow_runs?.[0] ?? null;
    if (!run) {
      return res.json({ run: null });
    }

    return res.json({
      run: {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      },
    });
  });

  // ── Admin: Build Counter Recovery ─────────────────────────────────────────
  // Applies a corrected build counter to either build-number.json (desktop) or
  // app.json (mobile) when the GitHub Actions push step failed during a build.
  // Uses the GitHub Contents API (BUILD_BOT_TOKEN > GITHUB_ACTIONS_TOKEN) so
  // the commit lands directly on main even when branch protection is active.
  // Falls back to a local git commit when no GitHub token is configured.
  router.post("/admin/settings/build-counter", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const { target, buildNumber } = req.body as { target?: unknown; buildNumber?: unknown };

    if (target !== "desktop" && target !== "mobile") {
      return res.status(400).json({ error: "target must be \"desktop\" or \"mobile\"." });
    }
    if (typeof buildNumber !== "number" || !Number.isInteger(buildNumber) || buildNumber < 1) {
      return res.status(400).json({ error: "buildNumber must be a positive integer." });
    }

    const reqUser = (req as any).user as { username?: string } | undefined;
    const actor = reqUser?.username ?? "labtrax-admin";

    // Resolve GitHub token and repo coordinates.
    const ghToken = process.env.BUILD_BOT_TOKEN ?? process.env.GITHUB_ACTIONS_TOKEN ?? null;
    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\/)?$/;
    const repoMatch = repoUrl ? githubRepoPattern.exec(repoUrl) : null;
    const repoOwner = repoMatch?.[1] ?? null;
    const repoName = repoMatch?.[2] ?? null;
    const useGitHub = !!(ghToken && repoOwner && repoName);

    if (target === "desktop") {
      const filePath = "artifacts/labtrax-desktop/build-number.json";
      const absPath = path.resolve(process.cwd(), filePath);
      const newContent = JSON.stringify({ buildNumber }, null, 2) + "\n";
      const commitMessage = `chore: apply desktop build counter fallback (buildNumber=${buildNumber}) [skip ci]\n\nApplied via Settings panel by ${actor}.`;

      if (useGitHub) {
        // Fetch current file SHA from GitHub so we can update it.
        const contentsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
        let currentSha: string;
        try {
          const getRes = await fetch(`${contentsUrl}?ref=main`, {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });
          if (!getRes.ok) {
            const body = await getRes.json().catch(() => ({})) as { message?: string };
            return res.status(502).json({
              error: `GitHub could not read the current file (HTTP ${getRes.status})${body.message ? `: ${body.message}` : ""}. Verify GITHUB_REPO_URL and that the token has Contents: Read access.`,
            });
          }
          const fileData = await getRes.json() as { sha: string };
          currentSha = fileData.sha;
        } catch (err) {
          req.log.error({ err }, "GitHub API request failed reading build-number.json");
          return res.status(502).json({ error: "Could not reach the GitHub API to read the current file." });
        }

        // Commit the updated file via GitHub Contents API.
        const encodedContent = Buffer.from(newContent, "utf8").toString("base64");
        let putRes: Response;
        try {
          putRes = await fetch(contentsUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
              message: commitMessage,
              content: encodedContent,
              sha: currentSha,
              branch: "main",
              committer: { name: "LabTrax Admin", email: "admin@labtrax.app" },
            }),
          });
        } catch (err) {
          req.log.error({ err }, "GitHub API request failed updating build-number.json");
          return res.status(502).json({ error: "Could not reach the GitHub API to commit the file." });
        }

        if (!putRes.ok) {
          const body = await putRes.json().catch(() => ({})) as { message?: string };
          req.log.error({ status: putRes.status }, "GitHub Contents API returned non-2xx for build-number.json");
          return res.status(502).json({
            error: `GitHub rejected the commit (HTTP ${putRes.status})${body.message ? `: ${body.message}` : ""}. Make sure the token has Contents: Read & Write access on main.`,
          });
        }

        const putBody = await putRes.json() as { commit?: { sha?: string; html_url?: string } };
        const commitSha = putBody.commit?.sha ?? null;
        const commitUrl = putBody.commit?.html_url ?? null;

        // Also update the local file so the running API sees the new value.
        try {
          await writeFile(absPath, newContent, "utf8");
        } catch {
          /* non-fatal — the GitHub commit is the source of truth */
        }

        req.log.info({ buildNumber, commitSha, actor }, "Desktop build counter applied via GitHub API");
        return res.json({ ok: true, target: "desktop", buildNumber, commitSha, commitUrl });
      }

      // No GitHub token — fall back to local git commit.
      try {
        await writeFile(absPath, newContent, "utf8");
      } catch (err) {
        return res.status(500).json({ error: `Could not write build-number.json: ${(err as Error).message}` });
      }

      await new Promise<void>((resolve) => {
        const git = spawn("git", ["add", absPath], { stdio: "ignore" });
        git.on("close", (addCode) => {
          if (addCode !== 0) { resolve(); return; }
          const commit = spawn("git", ["commit", "-m", commitMessage], { stdio: "ignore" });
          commit.on("close", () => resolve());
        });
      });

      req.log.info({ buildNumber, actor }, "Desktop build counter applied via local git (no GitHub token)");
      return res.json({ ok: true, target: "desktop", buildNumber, commitSha: null, commitUrl: null });
    }

    // target === "mobile"
    const filePath = "artifacts/labtrax/app.json";
    const absPath = path.resolve(process.cwd(), filePath);
    let appJson: Record<string, unknown>;
    try {
      const raw = await readFile(absPath, "utf8");
      appJson = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return res.status(500).json({ error: `Could not read app.json: ${(err as Error).message}` });
    }

    const expo = appJson.expo as Record<string, unknown> | undefined;
    if (!expo || typeof expo !== "object") {
      return res.status(500).json({ error: "app.json is missing the expo key." });
    }
    const ios = expo.ios as Record<string, unknown> | undefined;
    const android = expo.android as Record<string, unknown> | undefined;
    if (ios && typeof ios === "object") {
      ios.buildNumber = String(buildNumber);
    }
    if (android && typeof android === "object") {
      android.versionCode = buildNumber;
    }

    const newContent = JSON.stringify(appJson, null, 2) + "\n";
    const commitMessage = `chore: apply mobile build counter fallback (buildNumber=${buildNumber}) [skip ci]\n\nApplied via Settings panel by ${actor}.`;

    if (useGitHub) {
      const contentsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
      let currentSha: string;
      try {
        const getRes = await fetch(`${contentsUrl}?ref=main`, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!getRes.ok) {
          const body = await getRes.json().catch(() => ({})) as { message?: string };
          return res.status(502).json({
            error: `GitHub could not read the current file (HTTP ${getRes.status})${body.message ? `: ${body.message}` : ""}. Verify GITHUB_REPO_URL and that the token has Contents: Read access.`,
          });
        }
        const fileData = await getRes.json() as { sha: string };
        currentSha = fileData.sha;
      } catch (err) {
        req.log.error({ err }, "GitHub API request failed reading app.json");
        return res.status(502).json({ error: "Could not reach the GitHub API to read the current file." });
      }

      const encodedContent = Buffer.from(newContent, "utf8").toString("base64");
      let putRes: Response;
      try {
        putRes = await fetch(contentsUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            message: commitMessage,
            content: encodedContent,
            sha: currentSha,
            branch: "main",
            committer: { name: "LabTrax Admin", email: "admin@labtrax.app" },
          }),
        });
      } catch (err) {
        req.log.error({ err }, "GitHub API request failed updating app.json");
        return res.status(502).json({ error: "Could not reach the GitHub API to commit the file." });
      }

      if (!putRes.ok) {
        const body = await putRes.json().catch(() => ({})) as { message?: string };
        req.log.error({ status: putRes.status }, "GitHub Contents API returned non-2xx for app.json");
        return res.status(502).json({
          error: `GitHub rejected the commit (HTTP ${putRes.status})${body.message ? `: ${body.message}` : ""}. Make sure the token has Contents: Read & Write access on main.`,
        });
      }

      const putBody = await putRes.json() as { commit?: { sha?: string; html_url?: string } };
      const commitSha = putBody.commit?.sha ?? null;
      const commitUrl = putBody.commit?.html_url ?? null;

      // Update local file too.
      try {
        await writeFile(absPath, newContent, "utf8");
      } catch {
        /* non-fatal */
      }

      req.log.info({ buildNumber, commitSha, actor }, "Mobile build counter applied via GitHub API");
      return res.json({
        ok: true,
        target: "mobile",
        buildNumber,
        iosBuildNumber: String(buildNumber),
        androidVersionCode: buildNumber,
        commitSha,
        commitUrl,
      });
    }

    // No GitHub token — fall back to local git commit.
    try {
      await writeFile(absPath, newContent, "utf8");
    } catch (err) {
      return res.status(500).json({ error: `Could not write app.json: ${(err as Error).message}` });
    }

    await new Promise<void>((resolve) => {
      const git = spawn("git", ["add", absPath], { stdio: "ignore" });
      git.on("close", (addCode) => {
        if (addCode !== 0) { resolve(); return; }
        const commit = spawn("git", ["commit", "-m", commitMessage], { stdio: "ignore" });
        commit.on("close", () => resolve());
      });
    });

    req.log.info({ buildNumber, actor }, "Mobile build counter applied via local git (no GitHub token)");
    return res.json({
      ok: true,
      target: "mobile",
      buildNumber,
      iosBuildNumber: String(buildNumber),
      androidVersionCode: buildNumber,
      commitSha: null,
      commitUrl: null,
    });
  });

  return router;
}
