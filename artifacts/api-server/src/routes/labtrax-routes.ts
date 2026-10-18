import express, {
  Router,
  type IRouter,
  type RequestHandler,
} from "express";
import {
  SETTING_ADMIN_PIN,
  loadAdminPinCache,
  getEffectiveAdminPin,
  isAdminPinDefault,
  isAdminPinConfiguredAsync,
  setDbAdminPin,
} from "../lib/admin-pin";
import {
  DEFAULT_DEMO_USERS,
  resolveDemoSeedPassword,
} from "../lib/demo-seed-config";
import { normalizePhoneE164 } from "../lib/account-link-sms";
import { allocatePlatformAccountNumber } from "../lib/platform-account-number";
import { normalizeRxPracticeName, normalizeRxDoctorName } from "../lib/rx-practice-normalize";
import { normalizeMaterialName, cleanStepValue } from "../lib/material-mapping";
import { normalizeCaseHierarchy } from "../lib/case-category";
import { createHash, randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import archiver from "archiver";
import {
  getDesktopInstallerMetadata,
  getDesktopInstallerSlots,
  getDesktopInstallerDownloadInfo,
  uploadDesktopInstaller,
  installerKindFromUrl,
  DesktopInstallerNotConfiguredError,
  type DesktopInstallerKind,
} from "../lib/desktop-installer-storage";
import { dispatchInstallerAlert } from "../lib/desktop-installer-alerts";
import {
  dispatchDatabaseIdentityAlert,
  parseDatabaseIdentityAlertRequest,
  selectLabAdminRecipients,
} from "../lib/database-identity-alerts";
import { runDesktopInstallerHealthCheck } from "../lib/desktop-installer-health";
import { getDownloadInterruptionStats } from "../lib/download-interruptions";
import { sendInstallerPublishFailureAlertEmail, sendMail, getAppBaseUrl } from "../lib/mail";
import { cleanupOrphanedCaseMedia, runAndPersistCleanup, getCleanupAlertThresholds, getCleanupHistoryRetentionDays, getCleanupHourUtc, getCleanupProgress, getCleanupStuckTimeoutMinutes, cancelCleanup, CleanupAlreadyRunningError, SETTING_CLEANUP_MIN_REMOVED, SETTING_CLEANUP_MIN_FREED_MB, SETTING_CLEANUP_HISTORY_RETENTION_DAYS, SETTING_CLEANUP_HOUR_UTC, SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES, bindLegacyCaseMedia, bindLegacyCaseMediaStrict, extractMediaFileName, extractMediaFilenamesFromText } from "../lib/case-media";
import { writeCaseMediaToObjectStorage, openCaseMediaObjectStream, deleteCaseMediaFromObjectStorage, caseMediaObjectStorageAvailable } from "../lib/case-media-object-storage";
import {
  externalizeInlineMediaForWrite,
  getLegacyCaseMediaMigrationStatus,
  replaceStringsDeep,
  restoreLegacyCaseDataFromBackup,
  runLegacyCaseMediaMigration,
} from "../lib/legacy-case-media-externalize";
import { convertPdfBufferToImageDataUrls } from "../lib/pdf-to-images";
import { PdfConversionError, MAX_RX_PDF_PAGES } from "../lib/prescription-limits";
import { boundedOperation } from "../lib/bounded-operation";
import { timeRequestStage } from "../middlewares/request-performance";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import { getMailerConfig } from "../lib/mailer";
import sharp from "sharp";
import { db } from "@workspace/db";
import { notDeleted, softDeleteById } from "../lib/soft-delete";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { HttpError, wrapDbError } from "../lib/http";
import { extractBearerToken } from "../lib/auth";
import { getAccessCookie } from "../lib/cookies";
import { createLabLookupToken, labLookupSelectionKey } from "../lib/lab-lookup-token";
import { requireAuth, optionalAuth } from "../middlewares/auth";
import { createAdminProviderSubscriptionRouter } from "./admin-provider-subscriptions";
import { writeAuditLog } from "../lib/audit";
import { softDeleteLegacyCases } from "../lib/legacy-case-delete.js";
import {
  SDR1_ORG_ID,
  SDR1_CLEANUP_CONFIRM,
  classifySdr1LegacyRows,
  namesMatch,
} from "../lib/sdr1-legacy-cleanup";
import {
  RECOVERY_DATA_UNAVAILABLE_MESSAGE,
  recoveryDataAvailable,
} from "../lib/recovery-billing-scope";
import {
  createVerificationCode,
  verifyCode,
  normalizeEmailTarget,
  normalizePhoneTarget,
} from "../lib/verification";
import {
  createRateLimit,
  createUserRateLimit,
  createUserAndDestinationRateLimit,
  createSendCodeThrottle,
  checkSendCodeAllowed,
  recordSendCodeSuccess,
  getClientIp,
} from "../lib/rate-limit";
import { parseOrganizationIdFromAffiliationKey } from "../lib/case-visibility";
import { getUncachableStripeClient, isStripeConfigured } from "../lib/stripeClient";
import { deliverInAppNotification } from "../lib/in-app-notifications";
import { ADMIN_ROLES, BILLING_ROLES } from "../lib/rbac";
import {
  assertDefaultBillingMutationAllowed,
  assertOrganizationMutationAllowed,
} from "../lib/entitlement-write-guard";
import { eq, and, inArray, or, isNull, isNotNull, sql, desc, count, type SQL } from "drizzle-orm";
import { users, userSessions, labCases, labLocations, labPendingFiles, labPendingFileNoteEdits, organizations, organizationMemberships, cases as casesTable, caseAttachments, caseEvents, caseRestorations, mediaCleanupRuns, systemSettings, installerChangelog, installerUploads, subscriptions, backupRuns, rxPracticeNameAliases, rxDoctorPracticeMemory, bankTransactions, invoices, notifications, labAuthorizationTemplates, practiceAuthorizationDocuments, scanJobs, scanOutputs } from "@workspace/db";
import { getOneDriveStatus, downloadFileFromOneDrive, oneDriveItemIdFromPath } from "../lib/onedrive";
import { streamLabScopedBackupDownload } from "../lib/lab-scoped-backup";
import { runBackup, generateBackupForDownload, recordDesktopReportedBackupRun, streamBackupDownload, getBackupHourUtc, getBackupScheduleConfig, getBackupScheduleState, getFullArchiveIntervalMinutes, getOffsiteProtectionStatus, getOffsiteFreshness, getUndeliveredBackupAlert, getBackupAlertDeliveryLog, findUndeliveredBackupAlert, getLastSuccessfulBackupAt, getBackupStaleAlertSettings, getBackupHistoryRetentionDays, restartScheduledBackupJob, runScheduledBackupNow, executeRestore, getRestoreState, parseAndValidateBackupManifest, SETTING_BACKUP_HOUR_UTC, SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, SETTING_BACKUP_SCHEDULE_DESTINATION, SETTING_BACKUP_SCHEDULE_PATH, SETTING_BACKUP_SCHEDULE_ENABLED, SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT, SETTING_BACKUP_LAST_SUCCESSFUL_AT, SETTING_BACKUP_HISTORY_RETENTION_DAYS, SETTING_BACKUP_HISTORY_MAX_ROWS, ALL_SCHEDULE_SETTINGS, SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS, SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS, SETTING_BACKUP_STALE_DAYS, DEFAULT_BACKUP_STALE_DAYS, type BackupDestination } from "../lib/backup";
import {
  finishBackupLiveRun,
  getBackupLiveStatus,
  withBackupRun,
} from "../lib/backup-phase";
import {
  backupErrorMessage,
  backupDownloadErrorMessage,
  backupSettingsErrorMessage,
  backupStatusErrorMessage,
  partialBackupMessage,
} from "../lib/backup-error-copy";
import { getGoogleDriveStatus } from "../lib/google-drive";

const asyncHandler = (handler: any) => (req: any, res: any, next: any) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const ok = (res: any, data: unknown) => res.json({ ok: true, data });

/** Live-run confirmation token for the legacy inline-media externalization. */
const LEGACY_CASE_MEDIA_CONFIRM = "EXTERNALIZE_LEGACY_CASE_MEDIA";
/** Live-run confirmation token for putting an original case blob back. */
const LEGACY_CASE_DATA_RESTORE_CONFIRM = "RESTORE_LEGACY_CASE_DATA";

// ── Append-only union helpers for the legacy mobile case blob ──────────
// The mobile app rebuilds its in-memory case list from the LIST endpoint
// (GET /legacy/cases), which strips activityLog/photos/videos to keep the
// payload small. When the client then appends a single note/photo/status
// entry and PUTs the WHOLE case back via POST /legacy/cases, those arrays
// contain only the one new item — everything else was stripped client-side.
// A naive replace of case_data would therefore destroy the case's entire
// history and every previously-uploaded photo/video (this is exactly the
// "history only keeps one event / my photo disappeared" bug). To make the
// endpoint safe for EVERY client, including already-installed app builds,
// we union the incoming arrays with what is already stored: entries are
// only ever added, never dropped. No mobile surface deletes individual
// photos or activity entries, so union semantics cannot resurrect an
// intentional deletion.
import { canonicalStatusToLegacy } from "../lib/case-status";
import {
  acquireCaseLocationStatusLock,
  resolveLocatedCaseStatus,
} from "../lib/case-location-status";
function activityEntryKey(entry: any): string {
  if (entry && typeof entry === "object") {
    if (entry.id != null && entry.id !== "") return `id:${String(entry.id)}`;
    // No stable id (older/legacy entries): build a content signature from as
    // many discriminators as are available so two genuinely-distinct events
    // are not collapsed into one. imageUri/attachmentId/user separate media
    // and authored entries that may otherwise share type+timestamp.
    return [
      "sig",
      entry.type ?? "",
      entry.timestamp ?? "",
      entry.description ?? "",
      entry.imageUri ?? "",
      entry.attachmentId ?? "",
      entry.user ?? "",
    ].join("|");
  }
  return `raw:${JSON.stringify(entry)}`;
}

function unionActivityLog(existing: unknown, incoming: unknown): any[] {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const e of [...ex, ...inc]) {
    const k = activityEntryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => {
    const ta = typeof a?.timestamp === "number" ? a.timestamp : 0;
    const tb = typeof b?.timestamp === "number" ? b.timestamp : 0;
    return ta - tb;
  });
  return out;
}

function unionMediaList(existing: unknown, incoming: unknown): any[] {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of [...ex, ...inc]) {
    const k = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function unionLocationHistory(existing: unknown, incoming: unknown): any[] {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const entry of [...ex, ...inc]) {
    const key =
      entry && typeof entry === "object" && entry.id
        ? `id:${String(entry.id)}`
        : `raw:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  out.sort((a, b) => {
    const ta = Date.parse(String(a?.movedAt ?? ""));
    const tb = Date.parse(String(b?.movedAt ?? ""));
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
  return out;
}

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
        eq(organizations.type, "lab"),
        isNull(organizationMemberships.deletedAt)
      )
    );
  const ids = new Set<string>();
  for (const row of memberships) {
    if (row.labId) ids.add(row.labId);
  }
  return Array.from(ids);
}

import authRoutes from "./auth";
import organizationRoutes, { publicInviteRouter } from "./organizations";
import permissionsRouter from "./permissions";
import caseRoutes, { freezeInvoicesForDeletedCases } from "./cases";
import doctorRoutes from "./doctors";
import practiceRoutes from "./practices";
import invoiceRoutes from "./invoices";
import accountLinksRoutes, { getLinkedLabsForUser } from "./account-links";
import financeRoutes, { generateForOrganization, runVendorLinkBackfill } from "./finance";
import accountsPayableRoutes from "./accounts-payable";
import listsRoutes from "./lists";
import locationsRoutes from "./locations";
import caseExceptionRoutes from "./case-exceptions";
import vocabularyRoutes from "./vocabulary";
import aiMemoryRoutes from "./ai-memory";
import pricingRoutes from "./pricing";
import catalogRoutes from "./catalog";
import statementRoutes from "./statements";
import statsRoutes from "./stats";
import savedCardAnalyticsRoutes from "./saved-card-analytics";
import billingRoutes from "./billing";
import paymentSessionRoutes from "./payment-sessions";
import ownerRoutes from "./owner";
import { auditedOrganizationRecoveryRouter, requireRecoveryAutomation } from "./audited-organization-recovery";
import creatorRoutes from "./creator";
import { requireCreator } from "../lib/creator-auth";
import notificationsRoutes from "./notifications";
import vacationRoutes from "./vacation";
import usersRoutes from "./users";
import { registerAiChatRoutes } from "./ai-chat";
import { registerAiAgentRoutes } from "./ai-agent";
import { registerAiTtsRoutes } from "./ai-tts";
import { registerAiSttRoutes } from "./ai-stt";
import labInboxRoutes from "./lab-inbox";
import providerRoutes from "./provider";
import providerMessengerRoutes from "./provider-messenger";
import supportReportsRouter from "./support-reports";

const passwordResetTokens = new Map<string, { userId: string; expiresAt: number }>();
// Username-recovery tokens: single-use, time-limited links that require the
// account password before the username is revealed (never emailed in plain
// text). `attempts` counts wrong-password tries; the token is invalidated
// after USERNAME_RECOVERY_MAX_ATTEMPTS failures.
const usernameRecoveryTokens = new Map<string, { userId: string; expiresAt: number; attempts: number }>();
const USERNAME_RECOVERY_MAX_ATTEMPTS = 5;
let cachedOpenAIClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI | null {
  if (cachedOpenAIClient != null) {
    return cachedOpenAIClient;
  }

  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
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

// ─── Admin PIN cache ─────────────────────────────────────────────────────────
// Shared module — see src/lib/admin-pin.ts for the implementation.

const SETTING_ADMIN_PIN_RESET_CODE = "admin_pin_reset_code";
const SETTING_ADMIN_PIN_RESET_EXPIRES = "admin_pin_reset_expires";

async function sendAdminPinResetEmail(email: string, code: string): Promise<void> {
  const result = await sendMail({
    to: email.trim(),
    subject: "LabTrax - Admin PIN Reset Code",
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">LabTrax</h2>
            <p style="margin: 4px 0 0; opacity: 0.85;">Admin PIN Reset</p>
          </div>
          <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
            <p>Your admin PIN reset code is:</p>
            <p style="text-align: center; margin: 24px 0;">
              <span style="display: inline-block; background: #F0F4FF; padding: 16px 40px; border-radius: 8px; font-size: 28px; font-weight: bold; color: #4A6CF7; letter-spacing: 6px;">${code}</span>
            </p>
            <p style="color: #666; font-size: 13px;">This code expires in 10 minutes. If you did not request a PIN reset, you can ignore this email.</p>
          </div>
        </div>`,
    text: `Your LabTrax admin PIN reset code is: ${code}. It expires in 10 minutes.`,
  });
  // A skipped send (SMTP unconfigured, test runner, reserved/undeliverable
  // test domain) is not an error — only a genuine delivery failure throws.
  if (
    !result.sent &&
    result.reason &&
    !["smtp_not_configured", "reserved_domain", "undeliverable_domain", "disabled_in_test"].includes(result.reason)
  ) {
    throw new Error("Email delivery failed.");
  }
}

function maskEmailAddress(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function isPlatformAdmin(req: any): boolean {
  if (req._platformAdminSessionVerified) return req.user?.role === "admin";
  const reqUser = req.user;
  if (!reqUser || reqUser.role !== "admin") return false;
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (secret && req.headers["x-platform-admin-secret"] === secret) return true;
  const effectivePin = getEffectiveAdminPin();
  if (req.headers["x-platform-admin-pin"] === effectivePin) return true;
  return false;
}

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
  requireAuth(req, res, async (err?: unknown) => {
    if (err) return next(err);
    const sessionHeader = req.headers["x-platform-admin-session"] as string | undefined;
    if (sessionHeader) {
      const colonIdx = sessionHeader.indexOf(":");
      if (colonIdx > 0) {
        const hUserId = sessionHeader.slice(0, colonIdx);
        const hSessionId = sessionHeader.slice(colonIdx + 1);
        if (req.user?.id === hUserId && hSessionId) {
          const key = `padmin_sess:${hUserId}:${hSessionId}`;
          try {
            const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
            if (row) {
              const data = JSON.parse(row.value ?? "{}");
              const exp = data?.expiresAt ? new Date(data.expiresAt) : null;
              if (exp && exp > new Date()) req._platformAdminSessionVerified = true;
            }
          } catch {
            // Session lookup failure falls through to the header checks.
          }
        }
      }
    }
    next();
  });
}

export function requireAuthenticatedPlatformAdmin(req: any, res: any, next: any) {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Platform creator/admin access required." });
    }
    platformAdminUserOrSecret(req, res, (sessionErr?: unknown) => {
      if (sessionErr) return next(sessionErr);
      if (
        req._platformAdminSessionVerified ||
        req.headers["x-platform-admin-pin"] === getEffectiveAdminPin()
      ) {
        return next();
      }
      return res.status(403).json({ error: "Platform admin unlock required." });
    });
  });
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

async function seedDefaultUsers() {
  const demoSeedPassword = resolveDemoSeedPassword(process.env);
  if (demoSeedPassword === null) {
    return;
  }

  // Only fetch the field this seed check actually needs. Selecting the full
  // users row makes startup depend on every optional profile column already
  // existing in production, so an additive schema rollout can crash the API
  // before routes mount.
  const existingUsers = await db
    .select({ username: users.username })
    .from(users);
  const existingUsernames = new Set(existingUsers.map((user) => user.username.toLowerCase()));

  for (const def of DEFAULT_DEMO_USERS) {
    if (existingUsernames.has(def.username.toLowerCase())) {
      continue;
    }

    const hashed = await hashPassword(demoSeedPassword);
    await db.insert(users).values({ // provider-account-lint:allow — intentional demo seed
      username: def.username,
      password: hashed,
      email: (def as any).email || null,
      phone: (def as any).phone || null,
      userType: def.userType,
      role: def.role,
      accountNumber: (def as any).accountNumber || null,
      initials: def.username.slice(0, 2).toUpperCase(),
      emailVerifiedAt: new Date(),
    }).catch((err: unknown): never => wrapDbError(err, {
      duplicate: `Demo user '${def.username}' already exists.`,
      fallback: `Failed to seed demo user '${def.username}'.`,
    }));
    existingUsernames.add(def.username.toLowerCase());
    console.log(`[SEED] Created demo user: ${def.username}`);
  }

  const demoUsernames = DEFAULT_DEMO_USERS.map((u) => u.username.toLowerCase());
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(
      and(
        inArray(sql`lower(${users.username})`, demoUsernames),
        isNull(users.emailVerifiedAt)
      )
    );
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

// Abuse control for verification-code sends: per-identifier + per-IP rolling
// windows plus a resend cooldown. Throttled requests get a 429 before the
// handler runs, so no email/SMS is dispatched. See createSendCodeThrottle.
const SEND_CODE_WINDOW_MS = 10 * 60_000;
const sendEmailCodeThrottle = createSendCodeThrottle({
  channel: "email",
  field: "email",
  cooldownMs: 30_000,
  windowMs: SEND_CODE_WINDOW_MS,
  maxPerIdentifier: 5,
  maxPerIp: 10,
});
const sendPhoneCodeThrottle = createSendCodeThrottle({
  channel: "sms",
  field: "phone",
  cooldownMs: 30_000,
  windowMs: SEND_CODE_WINDOW_MS,
  maxPerIdentifier: 5,
  maxPerIp: 10,
});
const passwordResetRateLimit = createRateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  message: "Too many password reset requests. Please wait 15 minutes and try again.",
});
const publicLabLookupRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many lab searches. Please try again later.",
});
const requireLookupAuthWhenProvided: RequestHandler = (req, res, next) => {
  const token = extractBearerToken(req) ?? getAccessCookie(req);
  if (!token) {
    next();
    return;
  }
  void requireAuth(req, res, next);
};
const throttleAnonymousLabLookup: RequestHandler = (req, res, next) => {
  if ((req as any).auth?.userId) {
    next();
    return;
  }
  publicLabLookupRateLimit(req, res, next);
};
const checkUsernameRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 5,
  message: "Too many username availability checks. Please try again later.",
});
const platformAdminUnlockRateLimit = createUserRateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  message: "Too many platform admin unlock attempts. Please wait 15 minutes and try again.",
});

const adminPinSetRateLimit = createUserRateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  message: "Too many admin PIN change attempts. Please wait 15 minutes and try again.",
});
const sendCaseUpdateTextRateLimit = createUserAndDestinationRateLimit({
  windowMs: 10 * 60_000,
  maxPerUser: 5,
  maxPerDestination: 10,
});

export async function registerRoutes(): Promise<IRouter> {
  const router: IRouter = Router();
  await seedDefaultUsers();
  // Warm the PIN cache so isPlatformAdmin() has a value on first request.
  loadAdminPinCache().catch(() => {});
  router.use("/creator", creatorRoutes);
  router.use("/admin/backup/audited-organization-recovery", platformAdminUserOrSecret,
    requireRecoveryAutomation, auditedOrganizationRecoveryRouter());
  router.use("/admin/provider-subscriptions", requireCreator, createAdminProviderSubscriptionRouter((_req, _res, next) => next()));
  router.use("/admin/subscriptions", requireCreator, createAdminProviderSubscriptionRouter((_req, _res, next) => next()));

  // ── Admin PIN management (requires signed-in admin user, NOT isPlatformAdmin)
  router.get("/admin/pin/status", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    await loadAdminPinCache();
    return res.json({ isDefault: isAdminPinDefault() });
  });

  router.post("/admin/pin/set", requireAuth, adminPinSetRateLimit, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const { currentPin, newPin } = req.body as Record<string, unknown>;
    if (typeof currentPin !== "string" || typeof newPin !== "string") {
      return res.status(400).json({ error: "currentPin and newPin are required" });
    }
    if (!/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ error: "New PIN must be exactly 4 digits" });
    }
    await loadAdminPinCache();
    if (currentPin !== getEffectiveAdminPin()) {
      return res.status(403).json({ error: "Current PIN is incorrect" });
    }
    if (newPin === "0000") {
      return res.status(400).json({ error: "Choose a PIN other than 0000" });
    }
    await db
      .insert(systemSettings)
      .values({ key: SETTING_ADMIN_PIN, value: newPin, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: newPin, updatedAt: new Date() } });
    setDbAdminPin(newPin);
    return res.json({ ok: true });
  });

  router.post("/admin/pin/forgot", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const userRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, reqUser.id))
      .limit(1);
    const email = userRows[0]?.email;
    if (!email) {
      return res.status(400).json({ error: "No email address on your account. Ask another admin to reset your PIN." });
    }
    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db
      .insert(systemSettings)
      .values({ key: SETTING_ADMIN_PIN_RESET_CODE, value: code, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: code, updatedAt: new Date() } });
    await db
      .insert(systemSettings)
      .values({ key: SETTING_ADMIN_PIN_RESET_EXPIRES, value: expires, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: expires, updatedAt: new Date() } });
    try {
      await sendAdminPinResetEmail(email, code);
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : "Failed to send email" });
    }
    return res.json({ ok: true, maskedEmail: maskEmailAddress(email) });
  });

  router.post("/admin/pin/verify-reset", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    const { code } = req.body as Record<string, unknown>;
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "A 6-digit verification code is required" });
    }
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, [SETTING_ADMIN_PIN_RESET_CODE, SETTING_ADMIN_PIN_RESET_EXPIRES]));
    const storedCode = rows.find((r) => r.key === SETTING_ADMIN_PIN_RESET_CODE)?.value;
    const expiresStr = rows.find((r) => r.key === SETTING_ADMIN_PIN_RESET_EXPIRES)?.value;
    if (!storedCode || !expiresStr) {
      return res.status(400).json({ error: "No reset in progress. Request a new code." });
    }
    if (new Date(expiresStr) < new Date()) {
      return res.status(400).json({ error: "Code expired. Request a new code." });
    }
    if (code !== storedCode) {
      return res.status(400).json({ error: "Incorrect code — please try again." });
    }
    // Reset PIN to default (null = 0000) and clear reset tokens.
    await db.delete(systemSettings).where(inArray(systemSettings.key, [SETTING_ADMIN_PIN, SETTING_ADMIN_PIN_RESET_CODE, SETTING_ADMIN_PIN_RESET_EXPIRES]));
    setDbAdminPin(null);
    return res.json({ ok: true });
  });

  // ── Security config — used by clients to check PIN state before case deletion
  router.get("/admin/security/config", requireAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (!reqUser || reqUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      const adminPinConfigured = await isAdminPinConfiguredAsync();
      const adminPinIsDefault = isAdminPinDefault();
      return res.json({ ok: true, adminPinConfigured, adminPinIsDefault });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get security config." });
    }
  });

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
      void (async () => {
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
        // Persist to App Storage so the file survives autoscale redeploys and is
        // reachable from every instance (local disk is ephemeral + per-instance).
        if (!caseMediaObjectStorageAvailable()) {
          // Same silent-data-loss guard as the single-shot /media/upload path:
          // a disk-only file 404s on other instances and after a redeploy.
          console.error(
            "Chunked upload: object storage unavailable (PRIVATE_OBJECT_DIR unset); refusing disk-only storage of case media.",
          );
          if (!res.headersSent) {
            return res.status(500).json({ error: "Media storage is not configured" });
          }
          return;
        }
        try {
          const buffer = await readFile(finalPath);
          const contentType = meta.mimeType || "application/octet-stream";
          const ok = await writeCaseMediaToObjectStorage(meta.finalName, buffer, contentType);
          if (!ok) {
            throw new Error("writeCaseMediaToObjectStorage returned false");
          }
        } catch (storageErr: any) {
          console.error(
            "Chunked upload: failed to persist to object storage:",
            storageErr?.message || storageErr,
          );
          if (!res.headersSent) {
            return res.status(500).json({ error: "Failed to persist upload" });
          }
          return;
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
      })().catch((err: unknown) => {
        console.error(
          "Chunked upload finalize failed:",
          (err as any)?.message || err,
        );
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to finalize upload" });
        }
      });
    });

    req.pipe(writeStream);
    return;
  });

  router.post("/media/upload", requireAuth, caseMediaUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      // Persist to App Storage so the file survives autoscale redeploys and is
      // reachable from every instance (local disk is ephemeral + per-instance).
      // We must await this before reporting success, otherwise the serving
      // route on a different instance would 404 on the URL we just returned.
      if (!caseMediaObjectStorageAvailable()) {
        // Without object storage the file lives only on this instance's
        // ephemeral disk: it 404s on other instances and is wiped on the
        // next redeploy. Returning a URL anyway is silent data loss (this is
        // how mobile-uploaded case photos went missing on web/desktop), so we
        // fail loudly instead of handing back a link that will break.
        console.error(
          "Media upload: object storage unavailable (PRIVATE_OBJECT_DIR unset); refusing disk-only storage of case media.",
        );
        return res.status(500).json({ error: "Media storage is not configured" });
      }
      try {
        const diskPath = path.resolve(casMediaDir, req.file.filename);
        const buffer = await readFile(diskPath);
        const contentType = req.file.mimetype || "application/octet-stream";
        const ok = await writeCaseMediaToObjectStorage(req.file.filename, buffer, contentType);
        if (!ok) {
          throw new Error("writeCaseMediaToObjectStorage returned false");
        }
      } catch (storageErr: any) {
        console.error(
          "Media upload: failed to persist to object storage:",
          storageErr?.message || storageErr,
        );
        return res.status(500).json({ error: "Failed to persist upload" });
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
        const createdOrganization = await db.transaction(async (tx) => {
          const platformAccountNumber = await allocatePlatformAccountNumber({
            tx,
          });
          const [created] = await tx
            .insert(organizations)
            .values({
              type: "lab",
              name: adminUser.practiceName!.trim(),
              displayName: adminUser.practiceName!.trim(),
              billingEmail: adminUser.email || null,
              phone: adminUser.practicePhone || adminUser.phone || null,
              addressLine1: adminUser.practiceAddress || null,
              createdByUserId: adminUser.id,
              platformAccountNumber,
            })
            .returning();
          return created;
        });

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

  router.get("/labs/groups", requireAuth, async (_req, res) => {
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
            phone: organization.phone || null,
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

  // Public signup searches are throttled and receive a short-lived encrypted
  // reference instead of the database ID. Signed-in join flows still receive
  // the organization ID required by their follow-up join request.
  router.get(
    "/labs/lookup",
    requireLookupAuthWhenProvided,
    throttleAnonymousLabLookup,
    async (req, res) => {
      try {
        const q = String(req.query.q || "").trim();
        if (q.length < 2) {
          return res.json({ labs: [] });
        }
        const authenticated = Boolean((req as any).auth?.userId);
        const allLabs = await db
          .select()
          .from(organizations)
          .where(
            and(
              eq(organizations.type, "lab"),
              eq(organizations.isActive, true),
            ),
          );
        const needle = q.toLowerCase();
        const matches = allLabs
          .filter((lab) => {
            const haystack =
              `${lab.name} ${lab.displayName ?? ""} ${lab.addressLine1 ?? ""} ${lab.city ?? ""} ${lab.state ?? ""} ${lab.zip ?? ""}`.toLowerCase();
            return haystack.includes(needle);
          })
          .slice(0, authenticated ? 20 : 5)
          .map((lab) =>
            authenticated
              ? {
                  id: lab.id,
                  name: lab.name,
                  displayName: lab.displayName || lab.name,
                  addressLine1: lab.addressLine1 || null,
                  city: lab.city || null,
                  state: lab.state || null,
                  zip: lab.zip || null,
                  phone: lab.phone || null,
                }
              : {
                  id: createLabLookupToken(lab.id),
                  selectionKey: labLookupSelectionKey(lab.id),
                  displayName: lab.displayName || lab.name,
                  city: lab.city || null,
                  state: lab.state || null,
                },
          );
        return res.json({ labs: matches });
      } catch (error: any) {
        console.error("Lab lookup error:", error?.message || error);
        return res.status(500).json({ error: "Lab lookup failed" });
      }
    },
  );

  // Public practice lookup used by the signup flow when a provider wants to
  // join an existing practice (mirrors /labs/lookup for the lab-join flow).
  // Returns a small shape — id + name + city/state + parent lab name — so the
  // user can confirm they picked the right practice. Limited to 20 matches to
  // bound abuse. Must be registered BEFORE the auth-gated /practices router.
  router.get("/practices/lookup", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) {
        return res.json({ practices: [] });
      }
      const allPractices = await db
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.type, "provider"),
            eq(organizations.isActive, true),
            notDeleted(organizations)
          )
        );
      const needle = q.toLowerCase();
      const matches = allPractices
        .filter((practice) => {
          const haystack =
            `${practice.name} ${practice.displayName ?? ""} ${practice.addressLine1 ?? ""} ${practice.city ?? ""} ${practice.state ?? ""} ${practice.zip ?? ""}`.toLowerCase();
          return haystack.includes(needle);
        })
        .slice(0, 20);

      // Resolve parent lab names so the user can disambiguate practices with
      // similar names ("Smile Dental — via Custom Dental Lab").
      const parentLabIds = [
        ...new Set(
          matches
            .map((p) => p.parentLabOrganizationId)
            .filter((id): id is string => !!id)
        ),
      ];
      const parentLabs = parentLabIds.length
        ? await db
            .select()
            .from(organizations)
            .where(inArray(organizations.id, parentLabIds))
        : [];
      const parentLabById = new Map(parentLabs.map((lab) => [lab.id, lab]));

      const result = matches.map((practice) => {
        const parentLab = practice.parentLabOrganizationId
          ? parentLabById.get(practice.parentLabOrganizationId)
          : undefined;
        return {
          id: practice.id,
          name: practice.name,
          displayName: practice.displayName || practice.name,
          addressLine1: practice.addressLine1 || null,
          city: practice.city || null,
          state: practice.state || null,
          zip: practice.zip || null,
          phone: practice.phone || null,
          parentLabName: parentLab
            ? parentLab.displayName || parentLab.name
            : null,
        };
      });
      return res.json({ practices: result });
    } catch (error: any) {
      console.error("Practice lookup error:", error?.message || error);
      return res.status(500).json({ error: "Practice lookup failed" });
    }
  });

  router.use("/auth", authRoutes);
  router.use("/users", usersRoutes);
  // Public invite preview (no auth) must mount BEFORE the auth-gated org
  // router so an unauthenticated invitee can render the accept/deny page.
  router.use("/organizations", publicInviteRouter);
  router.use("/organizations", organizationRoutes);
  router.use("/organizations", permissionsRouter);
  router.use("/cases", caseRoutes);
  router.use("/doctors", doctorRoutes);
  router.use("/practices", practiceRoutes);
  router.use("/invoices", invoiceRoutes);
  router.use("/billing-recovery", (await import("./recovery-billing")).default);
  router.use("/account-links", accountLinksRoutes);
  // Public secure statement link (from SMS). Authorization is the unguessable,
  // time-limited token, scoped to exactly one recipient — no session needed.
  router.get("/statement-links/:token", async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      if (!token || token.length > 512) {
        return res.status(404).send("Statement link not found or expired.");
      }
      const { getStatementLinkPdf } = await import("../lib/statements.js");
      const result = await getStatementLinkPdf(token);
      if (!result) {
        return res
          .status(404)
          .send("This statement link is invalid or has expired.");
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${result.filename}"`
      );
      res.setHeader("Content-Length", String(result.pdfBuffer.length));
      return res.end(result.pdfBuffer);
    } catch (error: any) {
      req.log?.error?.(
        { err: error },
        "Failed to serve statement link"
      );
      return res.status(500).send("Failed to load statement.");
    }
  });
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

  // ── Admin: vendor-link backfill preview (dry-run, no writes) ──────────────
  // These system-wide bookkeeping tools require the explicit platform-admin
  // unlock; a tenant admin role alone is not sufficient.
  router.get(
    "/admin/finance/vendor-link-backfill/preview",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Platform admin unlock required." });
      }
      try {
        const labFilter = req.query.labId as string | undefined;
        let labIds: string[];
        if (labFilter) {
          labIds = [labFilter];
        } else {
          const rows = await db
            .selectDistinct({ labOrganizationId: bankTransactions.labOrganizationId })
            .from(bankTransactions)
            .where(isNull(bankTransactions.deletedAt));
          labIds = rows.map((r) => r.labOrganizationId);
        }
        const report = await runVendorLinkBackfill(labIds, false);
        return res.json({ ok: true, dryRun: true, ...report });
      } catch (err: any) {
        return res.status(500).json({ error: err?.message || "Preview failed." });
      }
    }
  );

  // ── Admin: vendor-link backfill run (applies changes) ──────────────────────
  router.post(
    "/admin/finance/vendor-link-backfill/run",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Platform admin unlock required." });
      }
      try {
        const labFilter = (req.body as any)?.labId as string | undefined;
        let labIds: string[];
        if (labFilter) {
          labIds = [labFilter];
        } else {
          const rows = await db
            .selectDistinct({ labOrganizationId: bankTransactions.labOrganizationId })
            .from(bankTransactions)
            .where(isNull(bankTransactions.deletedAt));
          labIds = rows.map((r) => r.labOrganizationId);
        }
        const report = await runVendorLinkBackfill(labIds, true);
        return res.json({ ok: true, dryRun: false, ...report });
      } catch (err: any) {
        return res.status(500).json({ error: err?.message || "Backfill failed." });
      }
    }
  );

  router.use("/finance", financeRoutes);
  // Accounts Payable (Enter Bills / Pay Bills) and the AP/AR aging reports
  // share the /finance prefix. Express falls through to this router for any
  // path the register routes above do not handle.
  router.use("/finance", accountsPayableRoutes);
  router.use("/lists", listsRoutes);
  router.use("/stats", statsRoutes);
  router.use("/analytics", savedCardAnalyticsRoutes);
  router.use("/locations", locationsRoutes);
  router.use("/case-exceptions", caseExceptionRoutes);
  router.use("/vocabulary", vocabularyRoutes);
  router.use("/ai-memory", aiMemoryRoutes);
  router.use("/lab-inbox", labInboxRoutes);
  router.use("/provider", providerRoutes);
  router.use("/provider-messenger", providerMessengerRoutes);
  router.use("/support-reports", supportReportsRouter());
  router.use("/pricing", pricingRoutes);
  router.use("/catalog", catalogRoutes);
  router.use("/lab-orgs", statementRoutes);
  router.use("/billing", billingRoutes);
  router.use("/billing", paymentSessionRoutes);
  router.use("/owner", ownerRoutes);
  router.use("/notifications", notificationsRoutes);
  router.use("/vacation", vacationRoutes);
  registerAiChatRoutes(router);
  registerAiAgentRoutes(router);
  registerAiTtsRoutes(router);
  registerAiSttRoutes(router);

  router.post("/audit-log", requireAuth, (_req, res) => {
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

  router.post("/debug/event", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      const body = (req.body || {}) as Record<string, unknown>;
      const tag = String(body.tag ?? "UNKNOWN");
      const payload = body.payload ?? {};
      req.log.info({ tag, payload, u: userId }, "[MOBILE_DEBUG]");
    } catch {}
    res.status(204).end();
  });

  router.post("/check-username", checkUsernameRateLimit, async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const allUsers = await db.select().from(users);
    const existing = allUsers.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    return res.json({ available: !existing });
  });

  router.post("/legacy/cases", requireAuth, async (req, res) => {
    // Guard: if the new mobile client (mobile/2+) sends a canonical UUID as
    // the case ID to this legacy endpoint, it is a routing bug — the canonical
    // PATCH /api/cases/:id path should have been used instead. Return 410 so
    // the mistake surfaces loudly in logs. Non-UUID IDs (client-generated,
    // stored in lab_cases) are still valid here and pass through unchanged.
    const clientHeader = req.headers["x-labtrax-client"];
    const incomingId = req.body?.id;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      typeof clientHeader === "string" &&
      clientHeader.startsWith("mobile/") &&
      typeof incomingId === "string" &&
      UUID_RE.test(incomingId)
    ) {
      return res.status(410).json({
        error:
          "Canonical UUID cases must use PATCH /api/cases/:id, not the legacy cases endpoint.",
      });
    }
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

      // ── Keep base64 photos OUT of the blob ────────────────────────────────
      // Older mobile builds embed a captured photo directly in caseData as a
      // `data:image/...;base64,...` string (in `photos[]` and in the matching
      // `activityLog[].imageUri`). One such photo can make a case row 10 MB,
      // and that row is read and copied in full by case detail, mobile sync,
      // the nightly backup ZIP, and every restore.
      //
      // Store each payload as a normal case-media file and substitute a
      // reference before the blob is merged and persisted. Done here, OUTSIDE
      // the transaction, so the (network) storage writes never run while the
      // case row is locked. The existing row is pre-read unlocked purely to
      // catch payloads already sitting in the stored blob; the locked re-read
      // inside the transaction stays authoritative, and any data URI that
      // appeared in between is simply left inline for the migration to sweep.
      //
      // Substitution is content-addressed, so the same photo arriving again
      // from a stale offline client maps to the same reference string and
      // `unionMediaList` dedupes it instead of appending a second copy.
      let inlineMediaReplacements = new Map<string, string>();
      try {
        const [preRead] = await db
          .select({ caseData: labCases.caseData })
          .from(labCases)
          .where(eq(labCases.id, id))
          .limit(1);
        let preReadParsed: unknown = null;
        if (preRead?.caseData) {
          try {
            preReadParsed = JSON.parse(preRead.caseData);
          } catch {
            preReadParsed = null;
          }
        }
        let incomingParsed: unknown = caseData;
        if (typeof caseData === "string") {
          try {
            incomingParsed = JSON.parse(caseData);
          } catch {
            incomingParsed = null;
          }
        }
        inlineMediaReplacements = await externalizeInlineMediaForWrite({
          labCaseId: id,
          payloads: [incomingParsed, preReadParsed],
        });
      } catch (mediaErr: any) {
        // Never fail a whole-blob offline sync over media externalization —
        // the payload stays inline and the migration picks it up later.
        req.log?.warn?.(
          { err: mediaErr?.message || String(mediaErr) },
          "legacy_case_inline_media_externalize_failed",
        );
      }

      // Wrap the auth check + write in a single transaction with a row lock
      // (SELECT ... FOR UPDATE) so a concurrent writer cannot slip in between
      // the authorization decision and the upsert. This closes the
      // check-then-write TOCTOU window on the ownership/visibility boundary.
      let result: { authError?: { status: number; message: string }; restoredFromTrash?: boolean } = {};
      try {
        result = await db.transaction(async (tx) => {
          await acquireCaseLocationStatusLock(tx);
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
            await assertDefaultBillingMutationAllowed(callerUserId);
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
              await assertOrganizationMutationAllowed(existingOrg);
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
          // Swap every inline photo we managed to store above for its
          // case-media reference. Unmapped payloads (a storage failure, or a
          // data URI that arrived after the pre-read) pass through untouched
          // rather than being dropped. The swap is provisional until the
          // ledger binding below commits — see there for how it is undone.
          if (inlineMediaReplacements.size > 0) {
            normalizedCaseData = replaceStringsDeep(
              normalizedCaseData,
              inlineMediaReplacements,
            );
          }
          if (!normalizedCaseData.id) normalizedCaseData.id = id;
          if (!normalizedCaseData.ownerId) normalizedCaseData.ownerId = ownerId;
          const requestedInitialLabLocationId =
            typeof normalizedCaseData.labLocationId === "string" &&
            normalizedCaseData.labLocationId
              ? normalizedCaseData.labLocationId
              : null;
          // Physical move history is server-authored. Never accept it from a
          // whole-blob mobile upload, including the first insert.
          normalizedCaseData.locationHistory = [];
          delete normalizedCaseData.labLocationId;

          if (lockedRow?.case_data) {
            try {
              let existingCaseData = JSON.parse(lockedRow.case_data);
              // Apply the same substitution to the stored side before the
              // union merge, so a photo that was embedded in the stored blob
              // and re-sent inline by the client collapses to one reference
              // instead of appearing twice.
              if (inlineMediaReplacements.size > 0) {
                existingCaseData = replaceStringsDeep(
                  existingCaseData,
                  inlineMediaReplacements,
                );
              }
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

              // Append-only merge of history + media so a stale client
              // (one that loaded the case from the list endpoint, where
              // these arrays are stripped) can never wipe the stored
              // timeline or previously-uploaded photos/videos. See the
              // unionActivityLog / unionMediaList helpers above.
              normalizedCaseData.activityLog = unionActivityLog(
                existingCaseData?.activityLog,
                normalizedCaseData?.activityLog,
              );
              normalizedCaseData.photos = unionMediaList(
                existingCaseData?.photos,
                normalizedCaseData?.photos,
              );
              normalizedCaseData.videos = unionMediaList(
                existingCaseData?.videos,
                normalizedCaseData?.videos,
              );
              normalizedCaseData.locationHistory = unionLocationHistory(
                existingCaseData?.locationHistory,
                [],
              );
              // The authoritative station changes only through validated case
              // locate routes, which append history atomically. A stale mobile
              // whole-blob sync must not clear or rewind it.
              if (existingCaseData?.labLocationId !== undefined) {
                normalizedCaseData.labLocationId = existingCaseData.labLocationId;
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
          if (!lockedRow && organizationIdFromKey && requestedInitialLabLocationId) {
            const [initialLocation] = await tx
              .select({ id: labLocations.id })
              .from(labLocations)
              .where(
                and(
                  eq(labLocations.id, requestedInitialLabLocationId),
                  eq(labLocations.labOrganizationId, organizationIdFromKey),
                ),
              )
              .limit(1);
            if (initialLocation) {
              normalizedCaseData.labLocationId = initialLocation.id;
            }
          }

          const selectedLocationId =
            typeof normalizedCaseData.labLocationId === "string" &&
            normalizedCaseData.labLocationId
              ? normalizedCaseData.labLocationId
              : null;
          if (selectedLocationId && organizationIdFromKey) {
            const location = await tx.query.labLocations.findFirst({
              where: and(
                eq(labLocations.id, selectedLocationId),
                eq(labLocations.labOrganizationId, organizationIdFromKey),
              ),
            });
            if (location) {
              const authoritativeStatus = resolveLocatedCaseStatus({
                labOrganizationId: organizationIdFromKey,
                labLocationId: selectedLocationId,
                location,
              });
              normalizedCaseData.status =
                canonicalStatusToLegacy(authoritativeStatus);
              if (authoritativeStatus === "complete") {
                normalizedCaseData.assignedBarcode = null;
              }
            } else {
              // Preserve the legacy endpoint's established behavior: foreign
              // or deleted station ids are sanitized rather than making the
              // whole offline case sync fail.
              normalizedCaseData.labLocationId = null;
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

          // ── Authorize the externalized photos before pointing at them ──
          // The blob is about to stop carrying these photos and start
          // referencing files, and the serving route authorizes those files
          // from the legacy media ledger and nothing else. So the ledger rows
          // must commit WITH this write, under the same row lock, against the
          // tenant this write is actually establishing (`organizationIdFromKey`
          // / `safeOwnerId`) — a binding written against stale metadata can
          // authorize a file to a lab the case no longer belongs to.
          //
          // The savepoint matters: a binding failure must not fail a
          // whole-blob offline sync (that would block every other edit the
          // client is carrying), so it falls back to leaving the photos
          // inline. Reverting is exact — the substitution was a pure string
          // swap, so applying its inverse over the merged result restores
          // every data URI, and the migration sweeps the case up later.
          if (inlineMediaReplacements.size > 0) {
            const newFileNames = Array.from(inlineMediaReplacements.values())
              .map((url) => extractMediaFileName(url))
              .filter((name): name is string => !!name);
            try {
              await tx.transaction(async (inner) => {
                await bindLegacyCaseMediaStrict({
                  tx: inner as any,
                  labCaseId: id,
                  organizationId: organizationIdFromKey,
                  ownerId: safeOwnerId,
                  fileNames: newFileNames,
                });
              });
            } catch (bindErr: any) {
              req.log?.warn?.(
                { err: bindErr?.message || String(bindErr), caseId: id },
                "legacy_case_media_strict_bind_failed_keeping_inline",
              );
              const reverse = new Map<string, string>();
              for (const [dataUri, url] of inlineMediaReplacements) {
                reverse.set(url, dataUri);
              }
              normalizedCaseData = replaceStringsDeep(normalizedCaseData, reverse);
            }
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

      const legacyResult = result as {
        isNewInsert?: boolean;
        organizationIdFromKey?: string | null;
        normalizedCaseData?: any;
      };
      const createdLegacyCase = legacyResult.isNewInsert && legacyResult.organizationIdFromKey
        ? legacyResult.normalizedCaseData
        : null;
      if (createdLegacyCase) {
        const isRush =
          createdLegacyCase.priority === "rush" ||
          createdLegacyCase.isRush === true;
        await deliverInAppNotification({
          labOrganizationId: legacyResult.organizationIdFromKey!,
          category: isRush ? "rush_case" : "new_case",
          type: isRush ? "rush_case_created" : "case_created",
          title: isRush
            ? `Rush case: ${createdLegacyCase.caseNumber ?? id}`
            : `New case: ${createdLegacyCase.caseNumber ?? id}`,
          body: `Mobile case ${createdLegacyCase.caseNumber ?? id} was created.`,
          dataJson: {
            caseId: id,
            caseNumber: createdLegacyCase.caseNumber ?? null,
            legacyCaseId: id,
          },
        });
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
              // Re-read inside a transaction-scoped row lock. A stale
              // whole-blob write must not replace an internal exception entry
              // that another server operation just appended.
              await db.transaction(async (tx) => {
                const [lockedLegacy] = await tx
                  .select({ caseData: labCases.caseData })
                  .from(labCases)
                  .where(eq(labCases.id, originalLegacy.id))
                  .for("update");
                let parsed: any = {};
                try {
                  parsed = JSON.parse(lockedLegacy?.caseData ?? "{}");
                } catch {
                  parsed = {};
                }
                const prevLog = Array.isArray(parsed.activityLog)
                  ? parsed.activityLog
                  : [];
                parsed.activityLog = [
                  ...prevLog,
                  {
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
                  },
                ];
                await tx
                  .update(labCases)
                  .set({
                    caseData: JSON.stringify(parsed),
                    updatedAt: new Date(),
                  })
                  .where(eq(labCases.id, originalLegacy.id));
              });
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

      // Bind every media file referenced by this legacy case to it
      // (first-writer-wins) so the file-serving route can authorize them and
      // the orphan cleanup never trashes them. Best-effort — a binding
      // failure must not fail the case save. Uses the persisted, merged
      // caseData (so previously-uploaded photos stay bound on re-sync).
      try {
        const persisted = (result as any).normalizedCaseData;
        if (persisted) {
          const fileNames = extractMediaFilenamesFromText(
            JSON.stringify(persisted),
          );
          if (fileNames.length > 0) {
            await bindLegacyCaseMedia({
              labCaseId: id,
              organizationId:
                ((result as any).organizationIdFromKey as string | null) ??
                null,
              ownerId: ((result as any).normalizedCaseData?.ownerId ??
                callerUserId) as string,
              fileNames,
            });
          }
        }
      } catch (bindErr: any) {
        req.log?.warn?.(
          { err: bindErr?.message || String(bindErr) },
          "legacy_case_media_bind_failed",
        );
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
          // Mobile and server now share canonical lowercase statuses, so the
          // structured-case status passes through unchanged.
          const mobileStatus = dc.status ?? "received";
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
            expectedDeliveryDate: dc.expectedDeliveryDate
              ? new Date(dc.expectedDeliveryDate).toISOString()
              : null,
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
      if (existing.organizationId) {
        await assertOrganizationMutationAllowed(existing.organizationId);
      } else {
        await assertDefaultBillingMutationAllowed(reqUser.id);
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
      let attachmentStorageKey = pending.fileUrl;
      const scanMatch = pending.fileUrl.match(/^\/api\/labtrax\/scans\/([^/]+)\/outputs\/(ply|stl)$/);
      if (scanMatch) {
        const [generated] = await db.select({ storageKey: scanOutputs.storageKey })
          .from(scanOutputs)
          .innerJoin(scanJobs, eq(scanJobs.id, scanOutputs.jobId))
          .where(and(
            eq(scanJobs.id, scanMatch[1]!),
            eq(scanJobs.labOrganizationId, pending.organizationId),
            eq(scanJobs.status, "completed"),
            eq(scanOutputs.format, scanMatch[2]!),
            isNotNull(scanOutputs.readyAt),
          ))
          .limit(1);
        if (!generated) return res.status(409).json({ error: "Generated scan output is not ready." });
        attachmentStorageKey = generated.storageKey;
      }
      await db.transaction(async (tx) => {
        await tx.insert(caseAttachments).values({
          caseId: targetCase.id,
          uploadedByUserId: reqUser.id,
          uploadedByOrganizationId: pending.organizationId,
          fileName: pending.fileName,
          storageKey: attachmentStorageKey,
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

      // Fetch restorations so the mobile Rx Summary can render for cases
      // created on the desktop (including AI-imported iTero cases).
      const restorationRows = await db
        .select()
        .from(caseRestorations)
        .where(eq(caseRestorations.caseId, caseId));

      // Human-readable labels for the canonical lowercase statuses, used only
      // for activity-log descriptions. The status values themselves pass
      // through unchanged — mobile and server share the canonical vocabulary.
      const STATUS_LABEL: Record<string, string> = {
        received: "Intake", in_design: "Design", scan: "Scan",
        in_milling: "Mill", post_mill: "Post Mill",
        sintering_furnace: "Sintering Furnace", model_room: "Model Room",
        in_porcelain: "Porcelain", qc: "Quality Check", complete: "Complete",
        shipped: "Shipping", delivered: "Delivered",
        on_hold: "On Hold", remake: "Remake", cancelled: "Cancelled",
      };

      const createdMs = dc.createdAt ? new Date(dc.createdAt).getTime() : Date.now();
      const updatedMs = dc.updatedAt ? new Date(dc.updatedAt).getTime() : createdMs;
      const mobileStatus = dc.status ?? "received";
      const firstName = dc.patientFirstName ?? "";
      const lastName = dc.patientLastName ?? "";
      const patientName = [firstName, lastName].filter(Boolean).join(" ");
      const initials = (firstName[0] ?? "") + (lastName[0] ?? "");

      // Build a UNIFIED, chronological activityLog for desktop-created cases so
      // the mobile History tab shows the same complete timeline the desktop
      // shows. Previously this synthesized a minimal log (created + one status +
      // one entry per attachment) and ignored case_events / case_notes entirely,
      // which is why mobile appeared to "only keep one event at a time".
      //
      // Source of truth = case_events (every note, status change, attachment,
      // restoration, remake, etc. is recorded there). Media events are enriched
      // with a viewable absolute imageUri + attachmentId + fileType so the mobile
      // timeline can render a pressable thumbnail. This handler is READ-ONLY —
      // no writes occur, so the protected-table guarantees are unaffected.
      const eventRows = await db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, caseId));

      // Absolute file URL for an attachment (mobile native cannot resolve
      // relative URLs). Mirrors the host/proto resolution used by /media/upload.
      const fwdHost = req.header("x-forwarded-host");
      const fileHost = fwdHost || req.get("host") || "localhost";
      const fwdProto = req.header("x-forwarded-proto");
      const fileProto = fwdProto
        ? fwdProto.split(",")[0]!.trim()
        : req.protocol || "https";
      const attachmentFileUrl = (attId: string) =>
        `${fileProto}://${fileHost}/api/cases/${caseId}/attachments/${attId}/file`;

      // Best-effort human description for less-common event types. Returns null
      // to omit purely-internal events (dedup detection, auto-link, deletions).
      const humanizeEvent = (type: string, meta: any): string | null => {
        switch (type) {
          case "location_changed":
            return meta?.toLocation
              ? `Moved to ${meta.toLocation}`
              : "Location changed";
          case "restoration_added":
            return "Restoration added";
          case "restoration_updated":
            return "Restoration updated";
          case "restoration_deleted":
            return "Restoration removed";
          case "invoice_generated":
            return "Invoice generated";
          case "invoice_paid":
            return "Invoice paid";
          case "remake_of":
            return meta?.remakeOfCaseId
              ? `Created as a remake of case ${meta.remakeOfCaseId}`
              : "Created as a remake";
          case "remade_by":
            return "Remade by a new case";
          case "provider_submission_received":
            return "Provider submission received";
          case "provider_submission_approved":
            return "Provider submission approved";
          case "provider_submission_rejected":
            return "Provider submission rejected";
          case "ai_review_acknowledged":
            return "AI import reviewed";
          case "files_attached_from_zip":
            return "Files attached";
          default:
            return null;
        }
      };

      const attachmentById = new Map(attachmentRows.map((a) => [a.id, a]));
      const usedAttachmentIds = new Set<string>();
      const activityLog: any[] = [];

      for (const ev of eventRows) {
        const meta: any = (ev.metadataJson as any) || {};
        const ts = ev.occurredAt
          ? new Date(ev.occurredAt).getTime()
          : createdMs;
        const actor = ev.actorInitials || "Lab";
        switch (ev.eventType) {
          case "case_created":
          case "case_created_from_itero":
            activityLog.push({
              id: `evt-${ev.id}`,
              type: "created",
              timestamp: ts,
              description: "Case received",
              user: actor,
            });
            break;
          case "status_changed": {
            const canonical = String(meta.toStatus ?? "");
            const label = STATUS_LABEL[canonical] ?? canonical;
            activityLog.push({
              id: `evt-${ev.id}`,
              type: "station_change",
              station: canonical || undefined,
              timestamp: ts,
              description: `Case moved to ${label}`,
              user: actor,
            });
            break;
          }
          case "note_added":
            activityLog.push({
              id: `evt-${ev.id}`,
              type: "note",
              timestamp: ts,
              description: String(meta.noteText ?? ""),
              user: actor,
              visibility: meta.visibility ?? null,
            });
            break;
          case "case_attachment_added": {
            const attId = String(meta.attachmentId ?? "");
            const att = attId ? attachmentById.get(attId) : undefined;
            const fileType = String(att?.fileType ?? meta.fileType ?? "");
            const isVideo = fileType.startsWith("video/");
            const isPhoto = fileType.startsWith("image/");
            if (attId) usedAttachmentIds.add(attId);
            activityLog.push({
              id: `evt-${ev.id}`,
              type: isVideo ? "video" : isPhoto ? "photo" : "document",
              timestamp: ts,
              description:
                att?.fileName ??
                meta.fileName ??
                (isPhoto
                  ? "Photo added to case"
                  : isVideo
                    ? "Video added to case"
                    : "File added to case"),
              user: actor,
              attachmentId: attId || undefined,
              fileType: fileType || undefined,
              imageUri: attId ? attachmentFileUrl(attId) : undefined,
            });
            break;
          }
          default: {
            const desc = humanizeEvent(ev.eventType, meta);
            if (desc) {
              activityLog.push({
                id: `evt-${ev.id}`,
                type: "note",
                timestamp: ts,
                description: desc,
                user: actor,
              });
            }
          }
        }
      }

      // Include any attachments that have no corresponding case_attachment_added
      // event (older data, or files attached via paths that didn't log an event).
      for (const att of attachmentRows) {
        if (usedAttachmentIds.has(att.id)) continue;
        const ts = att.createdAt
          ? new Date(att.createdAt).getTime()
          : createdMs;
        const fileType = att.fileType ?? "";
        const isVideo = fileType.startsWith("video/");
        const isPhoto = fileType.startsWith("image/");
        activityLog.push({
          id: `att-${att.id}`,
          type: isVideo ? "video" : isPhoto ? "photo" : "document",
          timestamp: ts,
          description:
            att.fileName ??
            (isPhoto
              ? "Photo added to case"
              : isVideo
                ? "Video added to case"
                : "File added to case"),
          user: "Lab",
          attachmentId: att.id,
          fileType: fileType || undefined,
          imageUri: attachmentFileUrl(att.id),
        });
      }

      // Guarantee a "Case received" anchor even if no creation event was logged.
      if (!activityLog.some((e) => e.type === "created")) {
        activityLog.push({
          id: `desktop-created-${dc.id}`,
          type: "created",
          timestamp: createdMs,
          description: "Case received",
          user: "Lab",
        });
      }

      // Sort chronologically
      activityLog.sort((a, b) => a.timestamp - b.timestamp);

      // Surface image attachments in the mobile "Photos" section too.
      const photos = attachmentRows
        .filter((a) => (a.fileType ?? "").startsWith("image/"))
        .map((a) => attachmentFileUrl(a.id));

      // Resolve the suggested practice name so the mobile banner can render it
      // without a second round-trip — mirrors the canonical /api/cases/:id shape.
      let suggestedPracticeName: string | null = null;
      const suggestedProviderOrgId = (dc as any).suggestedProviderOrgId ?? null;
      if (suggestedProviderOrgId) {
        const suggestedOrg = await db.query.organizations.findFirst({
          where: eq(organizations.id, suggestedProviderOrgId),
        });
        suggestedPracticeName = suggestedOrg?.name ?? null;
      }

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
        providerOrganizationId: dc.providerOrganizationId ?? null,
        suggestedProviderOrgId,
        suggestedPracticeName,
        suggestedDoctorName: (dc as any).suggestedDoctorName ?? null,
        photos,
        activityLog,
        restorations: restorationRows.map((r) => ({
          id: r.id,
          toothNumber: r.toothNumber,
          restorationType: r.restorationType,
          restorationSubtype: r.restorationSubtype ?? null,
          material: r.material ?? null,
          shade: r.shade ?? null,
          notes: r.notes ?? null,
          quantity: r.quantity ?? 1,
        })),
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
      // Authorization: only the owner, a master_admin, or an admin/owner of
      // the case's own organization (where the owner is also a member) may
      // delete a case. Membership in another shared organization is not enough.
      const isMasterAdmin = reqUser.userType === "master_admin";
      const isOwner = existing.ownerId === reqUser.id;
      let isOrgAdminForOwner = false;
      if (!isMasterAdmin && !isOwner && existing.organizationId) {
        const callerMemberships = await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.userId, reqUser.id),
              eq(organizationMemberships.labId, existing.organizationId),
              eq(organizationMemberships.status, "active"),
              isNull(organizationMemberships.deletedAt)
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
                eq(organizationMemberships.labId, existing.organizationId),
                isNull(organizationMemberships.deletedAt)
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

      if (existing.organizationId) {
        await assertOrganizationMutationAllowed(existing.organizationId);
      } else {
        await assertDefaultBillingMutationAllowed(reqUser.id);
      }

      // SAFEGUARD: do NOT physically delete. Soft-delete through the shared
      // helper so the legacy path sets deleted_at + deleted_by AND writes an
      // audit entry (matching the canonical case-delete path), and so an admin
      // can recover the case from the trash if the deletion was unintended.
      await softDeleteLegacyCases({
        ids: [caseId],
        deletedBy: reqUser.username || reqUser.id || "unknown",
        actorUserId: reqUser.id ?? null,
        organizationId: existing.organizationId ?? null,
        req,
      });
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
        await assertOrganizationMutationAllowed(orgId);
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
      await assertDefaultBillingMutationAllowed(currentUserId);
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
      if (conversationId.startsWith("lab:")) {
        await assertOrganizationMutationAllowed(
          conversationId.replace(/^lab:/, ""),
        );
      } else {
        await assertDefaultBillingMutationAllowed(
          (req as any).auth.userId as string,
        );
      }
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

  router.post("/send-phone-code", sendPhoneCodeThrottle, optionalAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }

    const { isConfigured: smsConfigured, isDevOrTest } = await import("../lib/sms.js");
    const inDevOrTest = isDevOrTest();

    if (!smsConfigured()) {
      if (!inDevOrTest) {
        req.log.error({ phone: `***${phone.slice(-4)}` }, "SMS verification failed: SMS provider not configured");
        return res.status(503).json({ error: "SMS delivery is not configured on this server." });
      }
      req.log.info({ phone: `***${phone.slice(-4)}` }, "SMS verification: provider not configured, returning demo code (dev/test)");
      const code = generateCode();
      await createVerificationCode({
        channel: "sms",
        target: normalizePhoneTarget(phone),
        code,
        userId: (req as any).auth?.userId ?? null,
      });
      return res.json({ success: true, message: "Verification code sent via SMS.", demoCode: code });
    }

    const code = generateCode();
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      return res.status(400).json({ error: "Invalid phone number format." });
    }

    req.log.info({ phone: `***${phone.slice(-4)}` }, "SMS verification: sending code via provider");

    const { sendSms } = await import("../lib/sms.js");
    const smsResult = await sendSms({
      to: phoneE164,
      body: `Your LabTrax verification code is: ${code}. It expires in 10 minutes.`,
      log: req.log,
    });

    if (!smsResult.ok && !smsResult.skipped) {
      req.log.error(
        {
          phone: `***${phone.slice(-4)}`,
          providerErrorCode: smsResult.errorCode,
          providerErrorMessage: smsResult.errorMessage,
        },
        "SMS verification: provider returned error"
      );
      return res.status(500).json({ error: "Failed to send verification code. Please try again." });
    }

    await createVerificationCode({
      channel: "sms",
      target: normalizePhoneTarget(phone),
      code,
      userId: (req as any).auth?.userId ?? null,
    });

    req.log.info({ phone: `***${phone.slice(-4)}`, providerStatus: smsResult.messageId }, "SMS verification: code dispatched successfully");
    return res.json({ success: true, message: "Verification code sent via SMS." });
  });

  router.post("/verify-phone-code", optionalAuth, async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "Phone and code required" });
    const target = normalizePhoneTarget(phone);
    const result = await verifyCode({ channel: "sms", target, code: String(code) });
    if (!result.verified) {
      return res.json({ verified: false, error: result.error });
    }
    // Bind the verification to the requesting user when authenticated, else to
    // the user the code was originally issued to. Only set the durable flag
    // when the verified phone actually belongs to that account.
    const boundUserId = (req as any).auth?.userId ?? result.userId ?? null;
    if (boundUserId) {
      const user = await db.query.users.findFirst({ where: eq(users.id, boundUserId) });
      if (user && normalizePhoneTarget(user.phone ?? "") === target) {
        await db
          .update(users)
          .set({ phoneVerifiedAt: new Date() })
          .where(eq(users.id, boundUserId));
        await writeAuditLog({
          req,
          userId: boundUserId,
          action: "phone_verified",
          entityType: "user",
          entityId: boundUserId,
        });
      }
    }
    return res.json({ verified: true });
  });

  router.post("/send-email-code", sendEmailCodeThrottle, optionalAuth, async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") return res.status(400).json({ error: "Email required" });
    const code = generateCode();
    await createVerificationCode({
      channel: "email",
      target: normalizeEmailTarget(email),
      code,
      userId: (req as any).auth?.userId ?? null,
    });

    const result = await sendMail({
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
    // A skipped send (SMTP unconfigured, the test runner, or a reserved/
    // undeliverable test domain like @test.local) is not an error — only a
    // genuine delivery failure should surface as a 500 so the client can retry.
    if (
      !result.sent &&
      result.reason &&
      !["smtp_not_configured", "reserved_domain", "undeliverable_domain", "disabled_in_test"].includes(result.reason)
    ) {
      req.log?.error?.({ reason: result.reason }, "[EMAIL VERIFICATION] send failed");
      return res.status(500).json({ error: "Failed to send verification code." });
    }

    const smtpConfigured = !!getMailerConfig();
    const isDev = process.env.NODE_ENV === "development";
    return res.json({ success: true, message: "Verification code sent.", ...(isDev && !smtpConfigured ? { demoCode: code } : {}) });
  });

  router.post("/verify-email-code", optionalAuth, async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code required" });
    const target = normalizeEmailTarget(email);
    const result = await verifyCode({ channel: "email", target, code: String(code) });
    if (!result.verified) {
      return res.json({ verified: false, error: result.error });
    }
    const boundUserId = (req as any).auth?.userId ?? result.userId ?? null;
    if (boundUserId) {
      const user = await db.query.users.findFirst({ where: eq(users.id, boundUserId) });
      if (user && normalizeEmailTarget(user.email ?? "") === target) {
        await db
          .update(users)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(users.id, boundUserId));
        await writeAuditLog({
          req,
          userId: boundUserId,
          action: "email_verified",
          entityType: "user",
          entityId: boundUserId,
        });
      }
    }
    return res.json({ verified: true });
  });

  router.post("/forgot-password", passwordResetRateLimit, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent." });

      const token = generateResetToken();
      passwordResetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });

      const resetLink = `${getAppBaseUrl()}/desktop/reset-password?token=${token}`;

      await sendMail({
        to: user.email!,
        subject: "LabTrax - Password Reset",
        html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Password Reset</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p><p>Click below to reset your password:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a></p>
              <p style="color: #666; font-size: 13px;">Expires in 30 minutes. Username: <strong>${user.username}</strong></p>
            </div></div>`,
      });

      const smtpConfigured = !!getMailerConfig();
      const isDev = process.env.NODE_ENV === "development";
      return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent.", ...(isDev && !smtpConfigured ? { demoResetLink: resetLink } : {}) });
    } catch (error: any) {
      console.error("Forgot password error:", error?.message || error);
      return res.status(500).json({ error: "Failed to process request." });
    }
  });

  router.post("/forgot-username", passwordResetRateLimit, async (req, res) => {
    const NEUTRAL_MESSAGE = "If an account with that email exists, a link has been sent.";
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: NEUTRAL_MESSAGE });

      const token = generateResetToken();
      usernameRecoveryTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000, attempts: 0 });

      // The link opens the desktop web view-username page, which asks for the
      // account password before revealing the username. The username itself is
      // deliberately NOT included anywhere in this email.
      const recoveryLink = `${getAppBaseUrl()}/desktop/view-username?username_token=${token}`;

      await sendMail({
        to: user.email!,
        subject: "LabTrax - Username Recovery",
        html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Username Recovery</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>We received a request to recover the username for this email address.</p>
              <p>Click below and enter your LabTrax password to view your username:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${recoveryLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">View my username</a></p>
              <p style="color: #666; font-size: 13px;">This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p>
            </div></div>`,
        text: `We received a request to recover the username for this email address.\n\nOpen this link and enter your LabTrax password to view your username:\n${recoveryLink}\n\nThis link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.`,
      });

      const smtpConfigured = !!getMailerConfig();
      const isDev = process.env.NODE_ENV === "development";
      return res.json({ success: true, message: NEUTRAL_MESSAGE, ...(isDev && !smtpConfigured ? { demoRecoveryLink: recoveryLink } : {}) });
    } catch (error: any) {
      console.error("Forgot username error:", error?.message || error);
      return res.status(500).json({ error: "Failed to process request." });
    }
  });

  // Second factor of the username-recovery flow: the emailed token proves
  // control of the inbox; the password proves knowledge of the account
  // credentials. Only when both check out is the username revealed (on
  // screen — never emailed).
  router.post("/view-username", passwordResetRateLimit, async (req, res) => {
    const EXPIRED_ERROR = "This link is invalid or has expired. Please request a new one.";
    try {
      const { token, password } = req.body;
      if (!token || typeof token !== "string" || !password || typeof password !== "string") {
        return res.status(400).json({ error: "Token and password are required." });
      }
      const recovery = usernameRecoveryTokens.get(token);
      if (!recovery) return res.status(400).json({ error: EXPIRED_ERROR, code: "TOKEN_INVALID" });
      if (Date.now() > recovery.expiresAt) {
        usernameRecoveryTokens.delete(token);
        return res.status(400).json({ error: EXPIRED_ERROR, code: "TOKEN_INVALID" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, recovery.userId));
      if (!user || !user.password) {
        usernameRecoveryTokens.delete(token);
        return res.status(400).json({ error: EXPIRED_ERROR, code: "TOKEN_INVALID" });
      }

      // Match the login handler's comparison: bcrypt hashes are compared with
      // bcrypt; legacy plain-text passwords (pre-upgrade accounts) compare
      // directly. No hash upgrade here — that stays a login-flow concern.
      const valid = user.password.startsWith("$2")
        ? await verifyPassword(password, user.password)
        : user.password === password;

      if (!valid) {
        recovery.attempts += 1;
        if (recovery.attempts >= USERNAME_RECOVERY_MAX_ATTEMPTS) {
          usernameRecoveryTokens.delete(token);
          return res.status(400).json({ error: "Too many incorrect attempts. Please request a new link.", code: "TOKEN_INVALID" });
        }
        return res.status(401).json({ error: "Incorrect password. Please try again." });
      }

      // Single-use: a successful reveal consumes the token.
      usernameRecoveryTokens.delete(token);
      return res.json({ success: true, username: user.username });
    } catch (error: any) {
      console.error("View username error:", error?.message || error);
      return res.status(500).json({ error: "Failed to process request." });
    }
  });

  router.post("/reset-password", passwordResetRateLimit, async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required." });
      const resetData = passwordResetTokens.get(token);
      if (!resetData) return res.status(400).json({ error: "Invalid or expired reset token." });
      if (Date.now() > resetData.expiresAt) { passwordResetTokens.delete(token); return res.status(400).json({ error: "Reset token has expired." }); }

      const hashed = await hashPassword(newPassword);
      const revokedAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ password: hashed })
          .where(eq(users.id, resetData.userId));
        await tx
          .update(userSessions)
          .set({ revokedAt })
          .where(
            and(
              eq(userSessions.userId, resetData.userId),
              isNull(userSessions.revokedAt),
            ),
          );
      });
      passwordResetTokens.delete(token);
      return res.json({ success: true, message: "Password has been reset successfully." });
    } catch (error: any) {
      return res.status(500).json({ error: "Failed to reset password." });
    }
  });

  router.post("/send-case-update-text", requireAuth, async (req, res) => {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const caseNumber =
      typeof body.caseNumber === "string" ? body.caseNumber.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!caseNumber || !message) {
      return res.status(400).json({ error: "Case number and message are required." });
    }
    if (caseNumber.length > 100 || message.length > 1600) {
      return res.status(400).json({ error: "Case number or message is too long." });
    }

    const userId = (req as any).auth.userId as string;
    const labMemberships = await db
      .select({ labId: organizationMemberships.labId })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMemberships.labId),
      )
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
          eq(organizations.type, "lab"),
          eq(organizations.isActive, true),
          isNull(organizations.deletedAt),
        ),
      );
    const labIds = labMemberships.map((membership) => membership.labId);
    if (labIds.length === 0) {
      return res.status(404).json({ error: "Case not found." });
    }

    // Scope the case-number lookup to the caller's active lab memberships.
    // Require a unique match because case numbers can repeat across labs.
    const matchingCases = await db
      .select({
        id: casesTable.id,
        providerOrganizationId: casesTable.providerOrganizationId,
      })
      .from(casesTable)
      .where(
        and(
          eq(casesTable.caseNumber, caseNumber),
          inArray(casesTable.labOrganizationId, labIds),
          isNull(casesTable.deletedAt),
        ),
      )
      .limit(2);
    if (matchingCases.length !== 1) {
      return res.status(404).json({ error: "Case not found." });
    }

    const providerOrganization = await db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, matchingCases[0]!.providerOrganizationId),
        eq(organizations.type, "provider"),
        eq(organizations.isActive, true),
        isNull(organizations.deletedAt),
      ),
      columns: { phone: true },
    });
    const destination = normalizePhoneE164(providerOrganization?.phone);
    if (!destination) {
      return res.status(409).json({
        error: "The case provider does not have a valid phone number on file.",
      });
    }

    // Keep accepting the legacy field, but only as a consistency check. The
    // actual destination always comes from the provider organization on the
    // authorized case, never from the request.
    if (body.providerPhone !== undefined) {
      if (
        typeof body.providerPhone !== "string" ||
        normalizePhoneE164(body.providerPhone) !== destination
      ) {
        return res.status(400).json({
          error: "The phone number does not match the case provider.",
        });
      }
    }

    const limited = sendCaseUpdateTextRateLimit(userId, destination);
    if (limited) {
      res.setHeader("Retry-After", String(limited.retryAfter));
      return res.status(429).json({
        error: "Too many case-update texts. Please try again later.",
      });
    }

    const { sendSms } = await import("../lib/sms.js");
    const result = await sendSms({
      to: destination,
      body: message,
      log: req.log,
    });
    if (!result.ok && !result.skipped) {
      return res.status(500).json({ error: result.errorMessage ?? "Failed to send text" });
    }
    return res.json({ success: true, message: "Text sent to the case provider." });
  });

  async function convertPdfToImageBase64s(rawPdfBase64: string, signal?: AbortSignal): Promise<string[]> {
    return convertPdfBufferToImageDataUrls(Buffer.from(rawPdfBase64, "base64"), MAX_RX_PDF_PAGES, 30_000, signal);
  }

  router.post(["/analyze-prescription", "/cases/analyze-rx"], optionalAuth, async (req, res) => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const budgetMs = req.body?.desktopReader === true ? 105_000 : 65_000;
    const deadline = setTimeout(() => controller.abort(new Error("Analysis deadline expired")), budgetMs);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    };
    res.once("close", disconnect);
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ success: false, error: "AI integrations are not configured." });

      const requestStartedAt = Date.now();
      const { imageBase64, additionalImages, fast } = req.body;
      if (!imageBase64 || typeof imageBase64 !== "string") return res.status(400).json({ success: false, error: "No image provided" });

      // Strip the data URI prefix to measure the raw base64 payload.
      const commaIdx = (imageBase64 as string).indexOf(",");
      const rawB64 = commaIdx >= 0 ? (imageBase64 as string).substring(commaIdx + 1) : (imageBase64 as string);
      req.log.info({ payloadBytes: Number(req.headers["content-length"]) || 0, pageCount: 1 + (Array.isArray(additionalImages) ? additionalImages.length : 0) }, "AI analyze-prescription: received");

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

      const imageContents: Array<{ type: "image_url"; image_url: { url: string; detail: "high" } }> = [];

      // PDF detection: raw base64 of any PDF starts with 'JVBERi' (base64 of '%PDF-').
      // On iOS, PDFs picked from the document picker arrive here with raw PDF bytes
      // wrapped in a fake data:image/jpeg;base64,... prefix. We detect the real
      // content via the magic-byte signature and render each page via pdftoppm.
      const isPdf = rawB64.startsWith("JVBERi");
      if (isPdf) {
        const pdfConversionStartedAt = Date.now();
        req.log.info("AI analyze-prescription: PDF detected, converting pages");
        let pdfImages: string[];
        try {
          pdfImages = await convertPdfToImageBase64s(rawB64, controller.signal);
        } catch (pdfErr: any) {
          if (controller.signal.aborted) throw controller.signal.reason;
          req.log.warn(
            { durationMs: Date.now() - pdfConversionStartedAt, reason: pdfErr instanceof PdfConversionError ? pdfErr.reason : "unreadable" },
            "AI analyze-prescription: PDF conversion failed"
          );
          return res.status(400).json({
            success: false,
            error: pdfErr instanceof PdfConversionError && pdfErr.reason === "oversized" ? pdfErr.message : "PDF prescriptions could not be processed. Please photograph the printed prescription instead.",
          });
        }
        if (pdfImages.length === 0) {
          return res.status(400).json({
            success: false,
            error: "PDF could not be rendered. Please photograph the prescription instead.",
          });
        }
        req.log.info(
          {
            pageCount: pdfImages.length,
            durationMs: Date.now() - pdfConversionStartedAt,
          },
          "AI analyze-prescription: PDF converted"
        );
        for (const img of pdfImages) {
          imageContents.push({ type: "image_url", image_url: { url: img, detail: "high" } });
        }
      } else {
        let primaryUrl = imageBase64;
        if (!primaryUrl.startsWith("data:")) {
          primaryUrl = `data:image/jpeg;base64,${primaryUrl}`;
        }
        imageContents.push({ type: "image_url", image_url: { url: primaryUrl, detail: "high" } });

        if (additionalImages && Array.isArray(additionalImages)) {
          for (const img of additionalImages) {
            if (typeof img === "string" && img.length > 100) {
              let imgUrl = img;
              if (!imgUrl.startsWith("data:")) {
                imgUrl = `data:image/jpeg;base64,${imgUrl}`;
              }
              imageContents.push({ type: "image_url", image_url: { url: imgUrl, detail: "high" } });
            }
          }
        }
      }

      if (imageContents.length > MAX_RX_PDF_PAGES || imageContents.reduce((sum, image) => sum + image.image_url.url.length, 0) > 11.5 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: "This prescription is too large for AI analysis. Split it into smaller files or enter details manually; keep the original as an attachment." });
      }
      if (res.locals.performanceStages) res.locals.performanceStages.rxPreprocess = Date.now() - requestStartedAt;
      const systemPrompt = `You are a dental laboratory prescription reader with expertise in reading BOTH printed and handwritten prescriptions. Analyze the dental prescription image(s) carefully — the prescription may be entirely handwritten, a mix of handwritten and printed fields, or a pre-printed form. Extract all available information. Return ONLY valid JSON with these fields (use null for any field you cannot determine):

{
  "doctorName": "Dr. Full Name",
  "patientName": "Patient Full Name",
  "patientInitials": "PI",
  "caseType": "one of: Crown & Bridge, Removable, Implant, Orthodontic, Other",
  "toothIndices": "comma-separated tooth numbers like 3,5,14",
  "toothAssignments": [{"toothNumber":"single Universal number", "role":"prepared_crown, pontic, or unknown", "material":null, "shade":null, "roleEvidence":null, "requiresReview":true}],
  "shade": "shade value like A2, B1, etc.",
  "gingivialShade": "for Removable cases: the gingival/tissue shade (e.g. 'Light Pink', 'Medium Pink', 'Dark Pink'). Use null for non-Removable cases and when not present.",
  "material": "one of: Zirconia, Porcelain Fused to Zirconia, Lithium Disilicate, PFM, Gold, Composite, Acrylic, Flexible, PMMA, Metal Framework, Titanium, Wax, Other",
  "step": "one of: custom_tray, rims_and_plates, wax_setup, process, or null if no step can be inferred",
  "dueDate": "MM/DD/YYYY format",
  "isRush": false,
  "notes": "any additional notes or special instructions",
  "practiceName": "dental practice or office name",
  "practiceAddress": "practice address",
  "practicePhone": "practice phone number",
  "confidence": 0.0
}

Important rules:
- List per-tooth assignments only for teeth explicitly prescribed. Mark a role prepared_crown or pontic only when the prescription explicitly identifies that tooth's role. In roleEvidence quote the specific tooth/range and its role phrase, not a full sentence combining different roles. A range alone, bridge, missing tooth, tooth position, or connector is not role evidence. Use unknown and requiresReview=true for uncertain roles. Never guess a material or shade from nearby teeth. Copy material and shade only where the prescription explicitly applies them to that tooth.
- HANDWRITING: Many dental prescriptions are fully or partially handwritten. Examine every area of the image carefully, including margins, boxes, check marks, and stamps. Do not skip fields just because they are handwritten or hard to read — make your best effort to decipher handwritten text.
- Read ALL pages if multiple images are provided
- TOOTH CHART: For tooth numbers, use Universal Numbering System (1-32). When a tooth chart or tooth diagram is present, look for circled, marked, checked, or highlighted tooth positions and map them to Universal numbers — give the chart higher weight than any adjacent freehand number if there is a conflict. Also accept handwritten tooth numbers written outside any chart.
- If you see FDI notation, convert to Universal
- Only set isRush to true if explicitly marked as rush/urgent/STAT — including handwritten "rush" notes or red stamps
- For caseType, match to the closest category listed above. Accept handwritten abbreviations (e.g. "PFM", "Zirc", "E.max", "BU", "CB", "FPD", "RPD")
- Extract the shade exactly as written on the prescription, including handwritten shade values
- MATERIAL: output the canonical material name. Mapping rules — "PFM" or "porcelain fused to metal" = PFM; "PFZ" or "porcelain fused to zirconia" = Porcelain Fused to Zirconia (IMPORTANT: this is DISTINCT from plain "Zirconia" — always emit "Porcelain Fused to Zirconia" for PFZ so the lab can charge the layered-porcelain surcharge); "Zirc", "Zr", "Brux", "BruxZ", "Bruxzir", "BZR", or "bruxism" = Zirconia (full-contour strong zirconia for bruxism patients); "GC" or "Gold" = Gold; "Emax", "E.max", "lithium disilicate", or "lithium silicate" = Lithium Disilicate (NEVER output "E.max" or "E max" — always use "Lithium Disilicate")
- SHADE FALLBACK: If the shade field is blank or not clearly marked, scan the handwritten notes/comments area for common shade values (A1–D4, BL1–BL4, OM1–OM4, T, NW, etc.) and record the first recognisable shade found there.
- NAME FORMAT: If a patient name or doctor name contains a comma (e.g. "Kidder, Daniel"), it is Last, First format. Swap to First Last and remove the comma.
- CONFIDENCE: set "confidence" to a number from 0 to 1 reflecting your overall certainty that the extracted fields are correct (1 = fully legible and certain; below 0.5 = blurry, partial, or mostly illegible). Be honest — the app uses this to decide whether a live-camera read is good enough to keep.
- Return ONLY the JSON object, no other text`;

      const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [
        { type: "text", text: `Analyze this dental prescription (${imageContents.length} page${imageContents.length > 1 ? "s" : ""}).` },
        ...imageContents,
      ];

      const baseMessages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userContent },
      ];

      // Forcing a strict json_schema response guarantees parseable JSON with
      // exactly these keys — this eliminates the old "No JSON found in response"
      // failure mode that made the reader unreliable. `confidence` (0-1) lets
      // the mobile live scanner decide when a read is trustworthy enough to
      // auto-fill without a manual capture.
      // OpenAI strict structured outputs require anyOf-based nullable fields;
      // { type: ["string", "null"] } array union syntax is rejected in strict mode.
      const nullableString = { anyOf: [{ type: "string" as const }, { type: "null" as const }] };
      const nullableBoolean = { anyOf: [{ type: "boolean" as const }, { type: "null" as const }] };
      const PRESCRIPTION_SCHEMA = {
        name: "dental_prescription",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            doctorName: nullableString,
            patientName: nullableString,
            patientInitials: nullableString,
            caseType: nullableString,
            toothIndices: nullableString,
            toothAssignments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  toothNumber: { type: "string" },
                  role: { type: "string", enum: ["prepared_crown", "pontic", "unknown"] },
                  material: nullableString,
                  shade: nullableString,
                  roleEvidence: nullableString,
                  requiresReview: { type: "boolean" },
                },
                required: ["toothNumber", "role", "material", "shade", "roleEvidence", "requiresReview"],
              },
            },
            shade: nullableString,
            gingivialShade: nullableString,
            material: nullableString,
            step: { anyOf: [{ type: "string" as const, enum: ["custom_tray", "rims_and_plates", "wax_setup", "process"] }, { type: "null" as const }] },
            dueDate: nullableString,
            isRush: nullableBoolean,
            notes: nullableString,
            practiceName: nullableString,
            practiceAddress: nullableString,
            practicePhone: nullableString,
            confidence: { type: "number" as const },
          },
          required: [
            "doctorName",
            "patientName",
            "patientInitials",
            "caseType",
            "toothIndices",
            "toothAssignments",
            "shade",
            "gingivialShade",
            "material",
            "step",
            "dueDate",
            "isRush",
            "notes",
            "practiceName",
            "practiceAddress",
            "practicePhone",
            "confidence",
          ],
        },
      };

      // Current-generation multimodal models only. The previous chain led with
      // the legacy gpt-4o family, which the Replit AI proxy periodically drops —
      // the recurring cause of this reader "working then breaking again". The
      // gpt-5.x models are multimodal and reject `temperature`/`max_tokens`
      // (use max_completion_tokens). gpt-5-mini is the fast, cheap safety net.
      //
      // `fast` mode (used by the mobile live-camera scanner for its continuous
      // detection ticks) leads with the quick gpt-5-mini so the live preview
      // stays responsive; the final, accurate read of the captured still always
      // runs through the full chain below.
      //
      // Update these constants (not the loop below) when models are renamed or
      // added — keeping them named makes future breakages easy to find and fix.
      const MODEL_CHAIN_ACCURATE = ["gpt-5.4", "gpt-5", "gpt-5-mini"];
      const MODEL_CHAIN_FAST = ["gpt-5-mini", "gpt-5"];
      const MODEL_CHAIN = fast ? MODEL_CHAIN_FAST : MODEL_CHAIN_ACCURATE;
      // The SDK's per-attempt timeout prevents a stalled provider request from
      // holding the reader indefinitely. The shared deadline also bounds the
      // total fallback chain while preserving the accurate desktop model order.
      const MODEL_ATTEMPT_TIMEOUT_MS = 30_000;
      const MODEL_CHAIN_TIMEOUT_MS = 75_000;
      const modelChainDeadline = Math.min(Date.now() + MODEL_CHAIN_TIMEOUT_MS, startedAt + budgetMs);
      let response: any;
      let lastModelErr: any;
      let modelTimedOut = false;
      for (const model of MODEL_CHAIN) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const remainingMs = modelChainDeadline - Date.now();
        if (remainingMs <= 0) {
          modelTimedOut = true;
          break;
        }
        const modelStartedAt = Date.now();
        try {
          const attemptTimeoutMs = Math.min(MODEL_ATTEMPT_TIMEOUT_MS, remainingMs);
          const attemptSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(attemptTimeoutMs)]);
          response = await timeRequestStage(res, `rxModel${MODEL_CHAIN.indexOf(model) + 1}`, () => boundedOperation(openai.chat.completions.create({
            model,
            messages: baseMessages,
            max_completion_tokens: 8192,
            response_format: { type: "json_schema", json_schema: PRESCRIPTION_SCHEMA },
          }, {
            timeout: attemptTimeoutMs,
            // The explicit model chain already provides fallback. SDK retries
            // otherwise multiply each timeout and obscure the actual attempts.
            maxRetries: 0,
            signal: attemptSignal,
          }), attemptSignal));
          req.log.info(
            { model, fast, durationMs: Date.now() - modelStartedAt },
            "AI analyze-prescription: model succeeded"
          );
          break;
        } catch (modelErr: any) {
          if (controller.signal.aborted) throw controller.signal.reason;
          lastModelErr = modelErr;
          modelTimedOut =
            modelTimedOut ||
            modelErr?.name === "APIConnectionTimeoutError" ||
            /timed?\s*out|timeout|aborted/i.test(String(modelErr?.message ?? ""));
          req.log.warn(
            { model, fast, durationMs: Date.now() - modelStartedAt, errorType: modelErr?.name ?? "Error" },
            "AI analyze-prescription: model failed, trying next"
          );
        }
      }
      if (!response) {
        const triedModels = MODEL_CHAIN.join(", ");
        if (
          (modelTimedOut || Date.now() >= modelChainDeadline)
        ) {
          req.log.warn(
            {
              modelsTriedCount: MODEL_CHAIN.length,
              modelsTried: triedModels,
              durationMs: Date.now() - requestStartedAt,
              fast,
            },
            "AI analyze-prescription: model chain timed out"
          );
          return res.status(504).json({
            success: false,
            error:
              "AI analysis timed out before the reader could finish. Try again; if it happens again, upload a clearer image or split a long prescription into fewer pages.",
          });
        }
        req.log.error(
          {
            modelsTriedCount: MODEL_CHAIN.length,
            modelsTried: triedModels,
            durationMs: Date.now() - requestStartedAt,
            fast,
          },
          "AI analyze-prescription: all models failed"
        );
        throw lastModelErr ?? new Error(`All prescription models failed (tried: ${triedModels})`);
      }

      const message = response.choices?.[0]?.message;
      if (message?.refusal) {
        req.log.warn({ refusal: message.refusal }, "AI analyze-prescription: model refused");
        return res.json({ success: false, error: "AI could not read the prescription. Please retake the photo." });
      }
      const text = message?.content || "";
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // Defensive fallback: if a fallback model ever ignores json_schema,
        // salvage the first JSON object embedded in the text.
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          req.log.warn("AI analyze-prescription: No JSON found in model response");
          return res.json({ success: false, error: "AI could not parse the prescription" });
        }
        data = JSON.parse(jsonMatch[0]);
      }

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
          } else if (key === "material" && typeof value === "string") {
            // Canonicalize material naming (zirconia / Emax→Lithium Disilicate /
            // PFM / Wax rules) before the client stores it on the new case, so the
            // material and its resolved price stay consistent.
            cleanedData[key] = normalizeMaterialName(value) ?? value;
          } else if (key === "step") {
            // Only forward step values that belong to the allowed enum; discard
            // anything unrecognized silently so it never reaches the client.
            const cleaned = cleanStepValue(value);
            if (cleaned !== undefined) {
              cleanedData[key] = cleaned;
            }
          } else {
            cleanedData[key] = value;
          }
        }
      }

      // Derive restorationSubtype from the extracted caseType + material using
      // the shared taxonomy aliases so mobile clients can store it directly on
      // case_restorations without needing to re-derive it from free-text fields.
      //
      // Guard: only encode the subtype when confidence is high enough (≥ 0.7)
      // AND both caseType and material are present. Encoding from a partial or
      // low-confidence extraction would silently pre-fill the restoration drawer
      // with a misleading material that the lab tech would have to correct.
      const rxConfidence = typeof cleanedData.confidence === "number" ? cleanedData.confidence : null;
      const rxCaseType = typeof cleanedData.caseType === "string" ? cleanedData.caseType : null;
      const rxMaterial = typeof cleanedData.material === "string" ? cleanedData.material : null;
      const subtypeConfidenceOk = rxConfidence !== null && rxConfidence >= 0.7;
      if (subtypeConfidenceOk && rxCaseType !== null && rxMaterial !== null) {
        const { restorationSubtype: derivedSubtype } = normalizeCaseHierarchy({
          caseType: rxCaseType,
          material: rxMaterial,
        });
        if (derivedSubtype) {
          cleanedData.restorationSubtype = derivedSubtype;
        }
      }

      req.log.info(
        {
          durationMs: Date.now() - requestStartedAt,
          fields: Object.keys(cleanedData),
        },
        "AI analyze-prescription: completed"
      );
      return res.json({ success: true, data: cleanedData });
    } catch (err: any) {
      if (res.destroyed) return;
      if (controller.signal.aborted) {
        return res.status(504).json({ success: false, error: "AI analysis timed out. Try again or enter the details manually. No case was created by this analysis." });
      }
      req.log.error({ errorType: err?.name ?? "Error" }, "AI analyze-prescription error");
      return res.status(500).json({ success: false, error: "AI analysis failed. Please try again." });
    } finally {
      clearTimeout(deadline);
      res.off("close", disconnect);
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
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured on this server. Please contact your administrator." });

      const { imageBase64, mode, whiten, straighten } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      // Resolve enhancement flags from either the new boolean fields or the legacy mode string.
      const doWhiten: boolean = typeof whiten === "boolean" ? whiten : (mode === "whiten" || mode === "both");
      const doStraighten: boolean = typeof straighten === "boolean" ? straighten : (mode === "symmetry" || mode === "both");

      if (!doWhiten && !doStraighten) {
        return res.status(400).json({ error: "At least one enhancement must be selected (whiten or straighten)." });
      }

      let prompt = "";
      if (doWhiten && doStraighten) {
        prompt = "Edit this dental photo to both whiten the person's teeth to a natural, beautiful shade AND correct minor misalignment so the teeth appear straighter and more symmetrical. Make only the requested dental enhancements — keep skin tone, background, and all other features completely unchanged.";
      } else if (doWhiten) {
        prompt = "Edit this dental photo to whiten and brighten the person's teeth to a natural, beautiful shade. Only whiten the teeth — keep skin tone, background, and all other features completely unchanged.";
      } else {
        prompt = "Edit this dental photo to gently straighten and align the person's teeth so they appear more even and symmetrical. Only adjust the tooth alignment — keep skin tone, background, and all other features completely unchanged.";
      }

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
        lastSuccessfulBackupAt,
        staleAfterDays,
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to fetch backup schedule settings.";
      req.log?.error({ err: diagnostic }, "[backup] Could not load legacy schedule settings");
      return res.status(500).json({ error: backupSettingsErrorMessage("load"), diagnostic });
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
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to save backup schedule settings.";
      req.log?.error({ err: diagnostic }, "[backup] Could not save legacy schedule settings");
      return res.status(500).json({ error: backupSettingsErrorMessage("save"), diagnostic });
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
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to reset backup schedule settings.";
      req.log?.error({ err: diagnostic }, "[backup] Could not reset legacy schedule settings");
      return res.status(500).json({ error: backupSettingsErrorMessage("disable"), diagnostic });
    }
  });

  // ── Admin Desktop Installer ───────────────────────────────────────────────
  const SETTING_DESKTOP_INSTALLER_URL = "desktop_installer_url";
  const SETTING_DESKTOP_INSTALLER_VERSION = "desktop_installer_version";
  const SETTING_DESKTOP_INSTALLER_RELEASE_NOTES = "desktop_installer_release_notes";
  const SETTING_DESKTOP_INSTALLER_NOTIFY_LIST = "desktop_installer_notify_list";
  const SETTING_BUILD_COUNTER_WARNING = "build_counter_warning";
  const SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD = "download_interruption_alert_threshold";
  const SETTING_MOBILE_BUILD_LAST_TRIGGER = "mobile_build_last_trigger";
  const SETTING_MOBILE_VERSION_HISTORY = "mobile_app_version_history";
  const SETTING_DESKTOP_BUILD_LAST_TRIGGER = "desktop_build_last_trigger";
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
      process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Setup.exe";
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
    const configuredKind = installerKindFromUrl(rawUrl);
    const isLocalDownload = rawUrl.startsWith("/downloads/");
    // Per-kind availability so the server can resolve the active download to a
    // slot that actually exists. Reuses the same slot-availability logic as the
    // admin settings + health endpoints. Never throws — a storage failure is
    // captured per slot (and collapses to `null` here only on a catastrophic
    // failure).
    const installerSlots = await getDesktopInstallerSlots().catch((err) => {
      req.log.error({ err }, "Failed to compute desktop installer slot availability");
      return null;
    });

    // External https:// URLs are served by a third party — we can't introspect
    // their existence without a round-trip, so report them as available and let
    // the browser handle any 404. They are returned exactly as configured.
    if (!isLocalDownload) {
      const installerObject = configuredKind
        ? await getDesktopInstallerMetadata(configuredKind).catch((err) => {
            req.log.error({ err }, "Failed to read desktop installer metadata from App Storage");
            return null;
          })
        : null;
      return res.json({
        version,
        downloadUrl: rawUrl,
        fileName: rawUrl.split("/").pop() ?? "LabTrax-Setup.exe",
        releaseNotes,
        installerObject,
        available: true,
        fileFound: true,
        installerSlots,
      });
    }

    // Locally-served /downloads/ path: make the server authoritative about
    // which installer the client downloads. Pick the best *available* slot so
    // the link is never dead. Preference: the configured/active kind first,
    // then the portable ZIP, then the macOS DMG.
    const preference: DesktopInstallerKind[] = [];
    for (const k of [configuredKind, "zip", "dmg"] as (DesktopInstallerKind | null)[]) {
      if (k && !preference.includes(k)) preference.push(k);
    }
    const chosenKind =
      installerSlots !== null
        ? preference.find((k) => installerSlots[k]?.available === true) ?? null
        : null;

    if (!chosenKind) {
      // Nothing is uploaded (or storage is unreachable). Return fileFound:false
      // with NO usable URL so the client shows the "not uploaded yet" state
      // instead of sending the browser to a dead /downloads/* link.
      return res.json({
        version,
        downloadUrl: null,
        fileName: null,
        releaseNotes,
        installerObject: null,
        available: false,
        fileFound: false,
        installerSlots,
      });
    }

    const chosen = getDesktopInstallerDownloadInfo(chosenKind);
    const chosenSlot = installerSlots?.[chosenKind] ?? null;
    const installerObject =
      chosenSlot && chosenSlot.available && chosenSlot.uploadedAt
        ? { size: chosenSlot.size ?? 0, uploadedAt: chosenSlot.uploadedAt }
        : null;
    return res.json({
      version,
      downloadUrl: chosen.downloadUrl,
      fileName: chosen.fileName,
      releaseNotes,
      installerObject,
      available: true,
      fileFound: true,
      installerSlots,
    });
  });

  // ── Public version probe (no auth required) ──────────────────────────────
  //
  // Lightweight endpoint the running Electron renderer can call to compare its
  // own version against the latest published build. Returns just the version
  // string so callers can decide whether to surface an "update available" notice
  // without any installer metadata.
  router.get("/desktop/version", async (req, res) => {
    const envVersion = process.env.DESKTOP_INSTALLER_VERSION ?? "1.0.0";
    const dbRows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_VERSION));
    const version = dbRows[0]?.value ?? envVersion;
    return res.json({ version });
  });

  // ── Notify-me signup (no auth required) ──────────────────────────────────
  //
  // Public endpoint: any visitor who sees the "installer coming soon" banner
  // can submit their email to be notified on the next publish. Emails are
  // stored as a JSON array in system_settings under
  // SETTING_DESKTOP_INSTALLER_NOTIFY_LIST and cleared after each publish.
  router.post("/desktop-installer/notify-me", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (email.length > 254) {
      return res.status(400).json({ error: "Email address is too long." });
    }

    try {
      const existing = await db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_NOTIFY_LIST));
      let list: string[] = [];
      if (existing.length > 0 && existing[0].value) {
        try {
          const parsed = JSON.parse(existing[0].value);
          if (Array.isArray(parsed)) list = parsed as string[];
        } catch {
          list = [];
        }
      }
      if (!list.includes(email)) {
        list.push(email);
        await db
          .insert(systemSettings)
          .values({ key: SETTING_DESKTOP_INSTALLER_NOTIFY_LIST, value: JSON.stringify(list) })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: JSON.stringify(list), updatedAt: new Date() },
          });
      }
      return res.json({ success: true });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "notify-me: failed to store email");
      return res.status(500).json({ error: "Failed to save your email. Please try again." });
    }
  });

  router.get("/admin/settings/desktop-installer", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const envVersion = process.env.DESKTOP_INSTALLER_VERSION ?? "1.0.0";
    const envUrl =
      process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Setup.exe";
    const dbRows = await db
      .select()
      .from(systemSettings)
      .where(
        inArray(systemSettings.key, [
          SETTING_DESKTOP_INSTALLER_URL,
          SETTING_DESKTOP_INSTALLER_VERSION,
          SETTING_DESKTOP_INSTALLER_RELEASE_NOTES,
          SETTING_BUILD_COUNTER_WARNING,
          SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD,
        ]),
      );
    const byKey = Object.fromEntries(dbRows.map((r) => [r.key, r.value]));
    const updatedAtByKey = Object.fromEntries(
      dbRows.map((r) => [r.key, r.updatedAt as Date | null] as const),
    );
    const dbUrl = byKey[SETTING_DESKTOP_INSTALLER_URL] ?? null;
    const dbVersion = byKey[SETTING_DESKTOP_INSTALLER_VERSION] ?? null;
    const dbReleaseNotes = byKey[SETTING_DESKTOP_INSTALLER_RELEASE_NOTES] ?? null;
    const dbAlertThresholdRaw = byKey[SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD] ?? null;
    const dbAlertThreshold = dbAlertThresholdRaw !== null ? parseInt(dbAlertThresholdRaw, 10) : null;
    const envAlertThreshold = (() => {
      const v = parseInt(process.env.DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD ?? "", 10);
      return Number.isFinite(v) && v > 0 ? v : 3;
    })();
    const downloadInterruptionAlertThreshold =
      dbAlertThreshold !== null && Number.isFinite(dbAlertThreshold) && dbAlertThreshold > 0
        ? dbAlertThreshold
        : envAlertThreshold;
    const rawUrl = dbUrl ?? envUrl;
    const version = dbVersion ?? envVersion;
    const urlError = validateInstallerUrl(rawUrl);
    const fileName = urlError ? null : (rawUrl.split("/").pop() ?? "LabTrax-Windows-Portable.zip");
    const repoUrl = process.env.GITHUB_REPO_URL ?? null;
    const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\/)?$/;
    const repoUrlWarning =
      repoUrl !== null && !githubRepoPattern.test(repoUrl)
        ? "GITHUB_REPO_URL does not look like a valid https://github.com/<owner>/<repo> URL. The Actions link may not work correctly."
        : undefined;
    const repoMatch = repoUrl ? githubRepoPattern.exec(repoUrl) : null;
    const repoOwner = repoMatch?.[1] ?? null;
    const repoName = repoMatch?.[2] ?? null;
    const tokenConfigured = !!(process.env.GITHUB_ACTIONS_TOKEN);
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
    // Per-slot availability: check all three installer kinds in parallel so
    // the UI can show which ones are present regardless of the active URL.
    // Shared with the public installer endpoint + health check.
    const installerSlots = await getDesktopInstallerSlots();
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
    // ── Build-counter sync check ────────────────────────────────────────────
    // When CI fails to push build-number.json, it calls /publish-failure with
    // stage="build-number-commit" which stores a warning here. We auto-clear
    // it once the file on disk has been updated to >= the attempted number.
    let buildCounterWarning: {
      runUrl: string | null;
      runId: string | null;
      workflowName: string | null;
      ref: string | null;
      attemptedBuildNumber: number | null;
      reportedAt: string;
    } | null = null;
    const rawCounterWarning = byKey[SETTING_BUILD_COUNTER_WARNING] ?? null;
    if (rawCounterWarning) {
      try {
        const parsed = JSON.parse(rawCounterWarning) as {
          runUrl?: string | null;
          runId?: string | null;
          workflowName?: string | null;
          ref?: string | null;
          attemptedBuildNumber?: number | null;
          reportedAt?: string;
        };
        const attempted =
          typeof parsed.attemptedBuildNumber === "number" ? parsed.attemptedBuildNumber : null;
        let cleared = false;
        if (attempted !== null) {
          try {
            const buildNumberPath = path.resolve(
              process.cwd(),
              "artifacts/labtrax-desktop/build-number.json",
            );
            const diskRaw = fs.readFileSync(buildNumberPath, "utf8");
            const diskParsed = JSON.parse(diskRaw) as { buildNumber?: number };
            const diskNum =
              typeof diskParsed.buildNumber === "number" ? diskParsed.buildNumber : null;
            if (diskNum !== null && diskNum >= attempted) {
              cleared = true;
              await db
                .delete(systemSettings)
                .where(eq(systemSettings.key, SETTING_BUILD_COUNTER_WARNING));
            }
          } catch {
            // If we can't read the file, leave the warning in place.
          }
        }
        if (!cleared) {
          buildCounterWarning = {
            runUrl: parsed.runUrl ?? null,
            runId: parsed.runId ?? null,
            workflowName: parsed.workflowName ?? null,
            ref: parsed.ref ?? null,
            attemptedBuildNumber: attempted,
            reportedAt: parsed.reportedAt ?? new Date(0).toISOString(),
          };
        }
      } catch {
        // Malformed warning — ignore.
      }
    }

    // Last desktop build trigger record (for the "Trigger build" button).
    let lastDesktopBuildTrigger: {
      triggeredAt: string;
      triggeredByUsername: string;
      apiBaseUrl: string;
    } | null = null;
    try {
      const triggerRow = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, SETTING_DESKTOP_BUILD_LAST_TRIGGER))
        .limit(1);
      if (triggerRow[0]?.value) {
        lastDesktopBuildTrigger = JSON.parse(triggerRow[0].value) as typeof lastDesktopBuildTrigger;
      }
    } catch {
      // Non-fatal — just omit.
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
      repoOwner,
      repoName,
      tokenConfigured,
      urlError: urlError ?? null,
      repoUrlWarning,
      releaseNotes: dbReleaseNotes,
      dbReleaseNotes,
      installerObject,
      installerSlots,
      activeKind,
      installerStatus,
      installerStatusMessage,
      settingsUpdatedAt: settingsUpdatedAt ? settingsUpdatedAt.toISOString() : null,
      buildCounterWarning,
      downloadInterruptionAlertThreshold,
      downloadInterruptionAlertThresholdSource: dbAlertThreshold !== null && Number.isFinite(dbAlertThreshold) && dbAlertThreshold > 0 ? "db" : "env",
      envDownloadInterruptionAlertThreshold: envAlertThreshold,
      lastDesktopBuildTrigger,
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

  // Shared helper: load active platform-admin email recipients for any
  // installer-pipeline alert path (publish-failure, /publish atomic failure,
  // scheduled health check). Returns [] (not an error) when the query fails
  // so a transient DB blip doesn't itself trigger a 500 on the alert path.
  async function loadAdminAlertRecipients(reqLog?: {
    error?: (obj: unknown, msg?: string) => void;
  }): Promise<string[]> {
    try {
      const admins = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.role, "admin"));
      return admins.map((u) => u.email).filter((e): e is string => Boolean(e));
    } catch (e: any) {
      reqLog?.error?.({ err: e }, "loadAdminAlertRecipients: query failed");
      return [];
    }
  }

  // The database identity alert goes to the admins of the lab the committed
  // fingerprint protects, so it cannot reuse the helper above: that one
  // returns every `role = 'admin'` account — master admins, deactivated
  // accounts, and the admins of every other lab in the database. Production
  // holds more than one lab (the authorized recovery merge put several
  // lineages in it), so an unscoped list would both leave the protected lab
  // uninformed and send its incident to a lab it has nothing to do with.
  // See selectLabAdminRecipients for the rule itself.
  async function loadLabAdminAlertRecipients(
    protectedLabOrganizationId: string | null,
    reqLog?: { error?: (obj: unknown, msg?: string) => void },
  ): Promise<string[]> {
    try {
      if (protectedLabOrganizationId) {
        const scoped = await db
          .select({
            email: users.email,
            role: users.role,
            userType: users.userType,
            isActive: users.isActive,
            membershipLabId: organizationMemberships.labId,
            membershipRole: organizationMemberships.role,
            membershipStatus: organizationMemberships.status,
          })
          .from(organizationMemberships)
          .innerJoin(users, eq(users.id, organizationMemberships.userId))
          .where(
            and(
              eq(organizationMemberships.labId, protectedLabOrganizationId),
              isNull(organizationMemberships.deletedAt),
            ),
          );
        return selectLabAdminRecipients(scoped, {
          protectedLabOrganizationId,
        });
      }

      // No protected lab in the fingerprint means the whole database is what
      // it protects, so every active lab admin in it is an intended recipient.
      const candidates = await db
        .select({
          email: users.email,
          role: users.role,
          userType: users.userType,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.role, "admin"));
      return selectLabAdminRecipients(candidates);
    } catch (e: any) {
      reqLog?.error?.({ err: e }, "loadLabAdminAlertRecipients: query failed");
      return [];
    }
  }

  // CI calls this when the auto-publish step in build-windows.yml / release.yml
  // fails (upload or settings PUT returned non-2xx). We email the platform
  // admin recipient list (same recipients as the cleanup alert) with the
  // workflow run URL, version, stage, and error so the lab can re-run or
  // fall back to a manual upload quickly. Gated by the standard
  // X-Platform-Admin-Secret header — disable by unsetting PLATFORM_ADMIN_SECRET.
  //
  // Identical payloads within a 6 h window are deduplicated by
  // dispatchInstallerAlert() to avoid the email storms that previously
  // followed a flaky release run (see lib/desktop-installer-alerts.ts and
  // docs/desktop-publish-pipeline.md).
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
        stageRaw &&
        ["upload", "settings", "publish", "unknown", "build-number-commit", "health-check"].includes(
          stageRaw.toLowerCase(),
        )
          ? (stageRaw.toLowerCase() as
              | "upload"
              | "settings"
              | "publish"
              | "unknown"
              | "build-number-commit"
              | "health-check")
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
      const attemptedBuildNumberRaw = body.attemptedBuildNumber;
      const attemptedBuildNumber =
        typeof attemptedBuildNumberRaw === "number" && Number.isFinite(attemptedBuildNumberRaw)
          ? Math.trunc(attemptedBuildNumberRaw)
          : null;

      // When CI fails to push the incremented build-number.json, store a warning
      // flag in system_settings so the Settings → Desktop App panel can surface it.
      if (stage === "build-number-commit") {
        try {
          const warningPayload = JSON.stringify({
            runUrl,
            runId,
            workflowName,
            ref,
            attemptedBuildNumber,
            reportedAt: new Date().toISOString(),
          });
          await db
            .insert(systemSettings)
            .values({ key: SETTING_BUILD_COUNTER_WARNING, value: warningPayload })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: warningPayload, updatedAt: new Date() },
            });
        } catch (e: any) {
          req.log?.error?.({ err: e }, "publish-failure: failed to store build counter warning");
        }
      }

      const adminEmails = await loadAdminAlertRecipients(req.log);

      let outcome: Awaited<ReturnType<typeof dispatchInstallerAlert>>;
      try {
        outcome = await dispatchInstallerAlert(
          {
            stage,
            adminEmails,
            workflowName,
            runUrl,
            runId,
            commitSha,
            ref,
            version,
            httpStatus,
            errorMessage,
          },
          req.log ?? undefined,
        );
      } catch (e: any) {
        req.log?.error?.({ err: e }, "publish-failure: dispatchInstallerAlert failed");
        return res.status(500).json({ error: e?.message || "Failed to send alert email." });
      }

      req.log?.warn?.(
        {
          runUrl,
          runId,
          version,
          stage,
          httpStatus,
          recipients: adminEmails.length,
          alertSent: outcome.sent,
          alertSuppressed: outcome.suppressed,
        },
        "Desktop installer publish-failure received from CI.",
      );
      return res.json({
        success: true,
        recipients: adminEmails.length,
        alertSent: outcome.sent,
        alertSuppressed: outcome.suppressed,
      });
    },
  );

  // The scheduled database identity monitor
  // (scripts/src/monitor-production-data-fingerprint.ts) calls this when
  // production stops matching the fingerprint committed in
  // scripts/database-fingerprint.json. The monitor runs the same read-only
  // comparison the publish preflight runs, holds no mail credentials and no
  // recipient list, and never writes to any database — so it reports what it
  // found here and this route turns it into the admin alert email.
  //
  // Gated by the standard X-Platform-Admin-Secret header, like the other
  // script-driven admin endpoints.
  router.post(
    "/admin/database-identity/alert",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }

      const parsed = parseDatabaseIdentityAlertRequest(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }

      const adminEmails = await loadLabAdminAlertRecipients(
        parsed.value.protectedLabOrganizationId,
        req.log,
      );

      let outcome: Awaited<ReturnType<typeof dispatchDatabaseIdentityAlert>>;
      try {
        outcome = await dispatchDatabaseIdentityAlert(
          { adminEmails, request: parsed.value },
          req.log ?? undefined,
        );
      } catch (e: any) {
        req.log?.error?.(
          { err: e },
          "database-identity alert: dispatch failed",
        );
        return res
          .status(500)
          .json({ error: e?.message || "Failed to send alert email." });
      }

      // `recipients` counts admins the mail server actually accepted, not
      // admins we found: the monitor treats a zero here as an undelivered
      // alert, which is the honest outcome when SMTP is unconfigured or
      // refused every address.
      return res.json({
        success: true,
        recipients: outcome.recipients,
        attempted: outcome.attempted,
        alertSent: outcome.sent,
        failureReasons: [...new Set(outcome.failures.map((f) => f.reason))],
      });
    },
  );

  // ── Atomic publish (Task #749, root-cause fix RC1) ─────────────────────────
  //
  // Single multipart endpoint that does upload + settings-PUT + changelog
  // record in one call so a partial success can never leave App Storage with
  // a fresh binary while system_settings still points at the old version.
  //
  // Multipart fields:
  //   file          (required) the .exe / .dmg / .zip installer binary
  //   version       (required) X.Y.Z
  //   downloadUrl   (optional) defaults to /downloads/<inferred filename>
  //   releaseNotes  (optional) markdown
  //   workflowName  (optional, CI) — included in failure alerts
  //   runUrl/runId/commitSha/ref (optional, CI) — included in failure alerts
  //
  // On non-2xx, the response body includes a {stage, errorMessage, httpStatus}
  // shape consistent with the publish-failure alert payload, and the alert is
  // ALSO dispatched server-side (deduped) so CI no longer needs a follow-up
  // notify step.
  router.post(
    "/admin/desktop-installer/publish",
    platformAdminUserOrSecret,
    (req, res, next) => {
      if (!isPlatformAdmin(req)) {
        res.status(403).json({ error: "Admin access required." });
        return;
      }
      installerUpload.single("file")(req, res, (err: any) => {
        if (err) {
          const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
          res.status(status).json({
            error: err?.message || "Upload failed.",
            stage: "upload",
          });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const asStr = (v: unknown): string | null => {
        if (typeof v !== "string") return null;
        const t = v.trim();
        return t.length > 0 ? t : null;
      };
      const ciMeta = {
        workflowName: asStr(body.workflowName),
        runUrl: asStr(body.runUrl),
        runId: asStr(body.runId),
        commitSha: asStr(body.commitSha),
        ref: asStr(body.ref),
      };

      // Helper: dispatch a single consolidated failure alert and return the
      // response shape CI parses. Swallows alert-dispatch errors so a broken
      // mail transport never masks the underlying publish failure.
      const fail = async (
        status: number,
        stage: "upload" | "settings" | "publish",
        message: string,
      ) => {
        try {
          const adminEmails = await loadAdminAlertRecipients(req.log);
          await dispatchInstallerAlert(
            {
              stage,
              adminEmails,
              ...ciMeta,
              version: asStr(body.version),
              httpStatus: status,
              errorMessage: message,
            },
            req.log ?? undefined,
          );
        } catch (e: any) {
          req.log?.warn?.({ err: e }, "publish: dispatchInstallerAlert failed");
        }
        return res
          .status(status)
          .json({ error: message, stage, httpStatus: status });
      };

      const file = (req as any).file as
        | { originalname: string; mimetype: string; buffer: Buffer; size: number }
        | undefined;
      if (!file || !file.buffer || file.size === 0) {
        return fail(400, "upload", "Missing 'file' field — attach a .zip / .exe / .dmg installer.");
      }

      const version = asStr(body.version);
      if (!version) return fail(400, "publish", "Missing 'version' field.");
      if (validateInstallerVersion(version)) {
        return fail(400, "publish", validateInstallerVersion(version)!);
      }

      const name = file.originalname || "";
      const isZipName = /\.zip$/i.test(name);
      const isExeName = /\.exe$/i.test(name);
      const isDmgName = /\.dmg$/i.test(name);
      let kind: DesktopInstallerKind;
      let defaultUrl: string;
      if (isExeName) {
        kind = "exe";
        defaultUrl = "/downloads/LabTrax-Setup.exe";
        const isExeMagic =
          file.buffer.length >= 2 && file.buffer[0] === 0x4d && file.buffer[1] === 0x5a;
        if (!isExeMagic) return fail(400, "upload", "File is not a valid Windows .exe (MZ magic bytes missing).");
      } else if (isDmgName) {
        kind = "dmg";
        defaultUrl = "/downloads/LabTrax.dmg";
        const isDmgMagic =
          file.buffer.length >= 512 &&
          file.buffer[file.buffer.length - 512] === 0x6b &&
          file.buffer[file.buffer.length - 511] === 0x6f &&
          file.buffer[file.buffer.length - 510] === 0x6c &&
          file.buffer[file.buffer.length - 509] === 0x79;
        if (!isDmgMagic) return fail(400, "upload", "File is not a valid macOS .dmg (koly trailer missing).");
      } else if (isZipName) {
        kind = "zip";
        defaultUrl = "/downloads/LabTrax-Windows-Portable.zip";
        const isZipMagic =
          file.buffer.length >= 4 &&
          file.buffer[0] === 0x50 &&
          file.buffer[1] === 0x4b &&
          (file.buffer[2] === 0x03 || file.buffer[2] === 0x05 || file.buffer[2] === 0x07);
        if (!isZipMagic) return fail(400, "upload", "File is not a valid .zip (PK magic bytes missing).");
      } else {
        return fail(400, "upload", "File must be one of LabTrax-Windows-Portable.zip, LabTrax-Setup.exe, or LabTrax.dmg.");
      }

      const downloadUrl = asStr(body.downloadUrl) ?? defaultUrl;
      const urlErr = validateInstallerUrl(downloadUrl);
      if (urlErr) return fail(400, "publish", urlErr);

      const releaseNotes = asStr(body.releaseNotes);
      const checksumSha256 = createHash("sha256").update(file.buffer).digest("hex");

      // ── Stage: upload ──
      let uploadMeta: Awaited<ReturnType<typeof uploadDesktopInstaller>>;
      try {
        uploadMeta = await uploadDesktopInstaller(file.buffer, kind);
      } catch (e: any) {
        if (e instanceof DesktopInstallerNotConfiguredError) {
          return fail(503, "upload", e.message);
        }
        req.log?.error?.({ err: e }, "publish: upload to App Storage failed");
        return fail(500, "upload", e?.message || "Failed to upload installer to App Storage.");
      }

      // Best-effort installer_uploads row (failure here is non-fatal — the
      // bytes are already in storage and downloads will work; we just lose
      // the audit row).
      try {
        const reqUser = (req as any).user as { id?: string; username?: string } | undefined;
        await db.insert(installerUploads).values({
          sizeBytes: uploadMeta.size,
          version,
          checksumSha256,
          uploadedByUserId: reqUser?.id ?? null,
          uploadedByUsername: reqUser?.username ?? "ci:platform-admin-secret",
        });
      } catch (logErr) {
        req.log?.warn?.({ err: logErr }, "publish: failed to record installer_uploads row");
      }

      // ── Stage: settings ──
      try {
        const now = new Date();
        const ops: Promise<unknown>[] = [
          db
            .insert(systemSettings)
            .values({ key: SETTING_DESKTOP_INSTALLER_URL, value: downloadUrl })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: downloadUrl, updatedAt: now },
            }),
          db
            .insert(systemSettings)
            .values({ key: SETTING_DESKTOP_INSTALLER_VERSION, value: version })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: version, updatedAt: now },
            }),
        ];
        if (releaseNotes !== null) {
          ops.push(
            db
              .insert(systemSettings)
              .values({ key: SETTING_DESKTOP_INSTALLER_RELEASE_NOTES, value: releaseNotes })
              .onConflictDoUpdate({
                target: systemSettings.key,
                set: { value: releaseNotes, updatedAt: now },
              }),
          );
        }
        await Promise.all(ops);
      } catch (e: any) {
        req.log?.error?.({ err: e }, "publish: settings write failed after successful upload");
        // Storage has the new bytes but settings still point at the old
        // version → RC1 case. Caller gets one consolidated error so they
        // know the upload succeeded but the metadata didn't.
        return fail(
          500,
          "settings",
          `Installer was uploaded to App Storage (${uploadMeta.size} bytes) but the system settings write failed: ${e?.message || e}. Re-run the publish or apply the URL/version manually in Settings → Desktop App.`,
        );
      }

      // Best-effort changelog row.
      try {
        const reqUser = (req as any).user as { id?: string; username?: string } | undefined;
        await db.insert(installerChangelog).values({
          downloadUrl,
          version,
          releaseNotes,
          savedByUserId: reqUser?.id ?? null,
          savedByUsername: reqUser?.username ?? "ci:platform-admin-secret",
        });
      } catch (logErr) {
        req.log?.warn?.({ err: logErr }, "publish: failed to record installer_changelog row");
      }

      // Best-effort: notify anyone who signed up via POST /desktop-installer/notify-me.
      // Strategy: snapshot the list and delete it FIRST (before sending any email)
      // so the one-time guarantee holds even if individual sends fail. Emails are
      // then attempted per-recipient with Promise.allSettled so one bad address
      // never blocks the others.
      try {
        const notifyRow = await db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_NOTIFY_LIST));
        let notifyEmails: string[] = [];
        if (notifyRow.length > 0 && notifyRow[0].value) {
          try {
            const parsed = JSON.parse(notifyRow[0].value);
            if (Array.isArray(parsed)) notifyEmails = parsed as string[];
          } catch {
            notifyEmails = [];
          }
        }
        if (notifyEmails.length > 0) {
          // Clear the list first — guarantees users are notified at most once per
          // publish regardless of whether the mail transport succeeds.
          await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_DESKTOP_INSTALLER_NOTIFY_LIST));

          // Send per-recipient so one bad address doesn't abort the others.
          const downloadPageUrl = `${getAppBaseUrl()}/desktop/download`;
          const subject = `LabTrax Desktop v${version} is now available for download`;
          const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background:#4A6CF7;color:white;padding:20px;border-radius:8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0;opacity:0.9;">Desktop installer is ready</p></div><div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;"><p style="font-size:15px;">Great news — the LabTrax Desktop installer you signed up to be notified about is now available.</p><p style="font-size:14px;color:#555;"><strong>Version:</strong> ${version}</p><p style="margin:24px 0 8px;"><a href="${downloadPageUrl}" style="display:inline-block;background:#4A6CF7;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">Download LabTrax Desktop</a></p><p style="font-size:13px;color:#888;margin-top:24px;">You received this email because you requested to be notified when the installer became available. You won't receive any further automated emails from this address.</p></div></div>`;
          const text = `LabTrax Desktop v${version} is now available.\n\nDownload it at: ${downloadPageUrl}\n\nYou received this because you signed up for installer availability notifications.`;

          const results = await Promise.allSettled(
            notifyEmails.map((email) => sendMail({ to: email, subject, html, text })),
          );
          const failed = results.filter((r) => r.status === "rejected").length;
          req.log?.info?.(
            { total: notifyEmails.length, failed },
            "notify-me: sent installer-ready emails and cleared list",
          );
        }
      } catch (notifyErr: any) {
        req.log?.warn?.({ err: notifyErr }, "notify-me: failed to process installer-ready notifications (non-fatal)");
      }

      req.log?.info?.(
        {
          kind,
          version,
          downloadUrl,
          size: uploadMeta.size,
          runId: ciMeta.runId,
          runUrl: ciMeta.runUrl,
        },
        "Desktop installer published atomically (upload + settings).",
      );

      return res.json({
        success: true,
        kind,
        version,
        downloadUrl,
        installerObject: uploadMeta,
      });
    },
  );

  // ── Scheduled / on-demand health check (Task #749) ─────────────────────────
  //
  // Reports on the three independent pieces of the pipeline (storage,
  // download URL, GitHub Release manifest) in one JSON document. Safe to
  // poll on demand; the optional `?alert=1` query parameter additionally
  // dispatches the deduped admin alert if the report comes back unhealthy.
  router.get("/admin/desktop-installer/health", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      // Build an absolute base URL for the HEAD probe. Falls back to the
      // INSTALLER_HEALTH_BASE_URL env var inside runDesktopInstallerHealthCheck
      // when the request URL can't yield one.
      const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol;
      const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() || req.get("host");
      const baseUrl = host ? `${proto}://${host}` : null;

      const report = await runDesktopInstallerHealthCheck({ baseUrl });

      const alertRequested =
        (req.query as any)?.alert === "1" || (req.query as any)?.alert === "true";
      if (alertRequested && !report.ok) {
        const adminEmails = await loadAdminAlertRecipients(req.log);
        try {
          await dispatchInstallerAlert(
            {
              stage: "health-check",
              adminEmails,
              workflowName: "scheduled-health-check",
              version: report.settings.version,
              httpStatus: report.download.status,
              errorMessage: report.issues.join("\n") || "Health check reported unhealthy.",
            },
            req.log ?? undefined,
          );
        } catch (e: any) {
          req.log?.warn?.({ err: e }, "health: alert dispatch failed");
        }
      }
      return res.json(report);
    } catch (e: any) {
      req.log?.error?.({ err: e }, "health: unhandled error");
      return res.status(500).json({ error: e?.message || "Health check failed." });
    }
  });

  // Lightweight endpoint that returns only the download interruption stats for
  // the past 24 h. Used by the Desktop App settings panel to surface an inline
  // warning without triggering the full (expensive) health check pipeline.
  router.get("/admin/desktop-installer/interruption-stats", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const stats = await getDownloadInterruptionStats();
      return res.json(stats);
    } catch (e: any) {
      req.log?.error?.({ err: e }, "interruption-stats: unhandled error");
      return res.status(500).json({ error: e?.message || "Failed to fetch interruption stats." });
    }
  });

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
    const alertThresholdRaw = body?.downloadInterruptionAlertThreshold;
    const alertThreshold: number | null = (() => {
      if (alertThresholdRaw === undefined || alertThresholdRaw === null || alertThresholdRaw === "") return null;
      const v = typeof alertThresholdRaw === "number" ? alertThresholdRaw : parseInt(String(alertThresholdRaw), 10);
      if (!Number.isFinite(v) || v <= 0 || v > 1000) return "invalid" as unknown as null;
      return v;
    })();
    if (alertThreshold === ("invalid" as unknown as null)) {
      return res.status(400).json({ error: "downloadInterruptionAlertThreshold must be a positive integer between 1 and 1000." });
    }
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
      if (alertThreshold !== null) {
        ops.push(
          db
            .insert(systemSettings)
            .values({ key: SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD, value: String(alertThreshold) })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: String(alertThreshold), updatedAt: new Date() },
            }),
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

  router.delete(
    "/admin/settings/desktop-installer/build-counter-warning",
    requireAuth,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      try {
        await db
          .delete(systemSettings)
          .where(eq(systemSettings.key, SETTING_BUILD_COUNTER_WARNING));
        return res.json({ success: true });
      } catch (e: any) {
        return res
          .status(500)
          .json({ error: e?.message || "Failed to dismiss build counter warning." });
      }
    },
  );

  // ── Admin: Users list + update ────────────────────────────────────────────
  // List all platform users (non-deleted). Admin-secret gated.
  router.get("/admin/users", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          isActive: users.isActive,
          practiceName: users.practiceName,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          emailVerifiedAt: users.emailVerifiedAt,
          platformAccountNumber: users.platformAccountNumber,
        })
        .from(users)
        .where(isNull(users.deletedAt))
        .orderBy(users.createdAt);
      return res.json({ ok: true, users: rows });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to list users." });
    }
  });

  // Send a password-reset email on behalf of an admin (admin-secret gated).
  router.post("/admin/users/:id/send-password-reset", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const userId = String(req.params.id);
      const [user] = await db
        .select({ id: users.id, username: users.username, email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)));
      if (!user) return res.status(404).json({ error: "User not found." });
      if (!user.email) return res.status(400).json({ error: "User has no email address on file." });

      const token = generateResetToken();
      passwordResetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });

      const resetLink = `${getAppBaseUrl()}/desktop/reset-password?token=${token}`;

      await sendMail({
        to: user.email,
        subject: "LabTrax - Password Reset",
        html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Password Reset</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p><p>Your lab administrator has sent you a password reset link. Click below to reset your password:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a></p>
              <p style="color: #666; font-size: 13px;">Expires in 30 minutes. Username: <strong>${user.username}</strong></p>
            </div></div>`,
      });

      return res.json({ ok: true, message: "Password reset email sent." });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to send password reset." });
    }
  });

  // Resend a verification email to an unverified user (admin-secret gated).
  router.post("/admin/users/:id/send-verification-email", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const userId = String(req.params.id);
      const [user] = await db
        .select({ id: users.id, username: users.username, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)));
      if (!user) return res.status(404).json({ error: "User not found." });
      if (!user.email) return res.status(400).json({ error: "User has no email address on file." });
      if (user.emailVerifiedAt) return res.status(400).json({ error: "Email is already verified." });

      // Imperative throttle check (resolved email, not req.body) so cooldown + per-target + per-IP limits are enforced.
      const throttleResult = checkSendCodeAllowed({
        channel: "email",
        identifier: normalizeEmailTarget(user.email),
        ip: getClientIp(req),
        cooldownMs: 30_000,
        windowMs: SEND_CODE_WINDOW_MS,
        maxPerIdentifier: 5,
        maxPerIp: 10,
      });
      if (throttleResult) {
        res.setHeader("Retry-After", String(throttleResult.retryAfter));
        return res.status(throttleResult.status).json({ error: throttleResult.error });
      }

      const code = generateCode();
      await createVerificationCode({
        channel: "email",
        target: normalizeEmailTarget(user.email),
        code,
        userId: user.id,
      });

      const result = await sendMail({
        to: user.email.trim(),
        subject: "LabTrax - Email Verification Code",
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">LabTrax</h2>
              <p style="margin: 4px 0 0; opacity: 0.85;">Email Verification</p>
            </div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p>
              <p>Your administrator has requested a new email verification code for your account.</p>
              <p style="text-align: center; margin: 24px 0;">
                <span style="display: inline-block; background: #F0F4FF; padding: 16px 40px; border-radius: 8px; font-size: 28px; font-weight: bold; color: #4A6CF7; letter-spacing: 6px;">${code}</span>
              </p>
              <p style="color: #666; font-size: 13px;">This code expires in 10 minutes.</p>
            </div>
          </div>`,
      });

      if (!result.sent) {
        req.log?.error?.({ reason: result.reason }, "[ADMIN EMAIL VERIFICATION] send failed");
        return res.status(500).json({ error: result.reason ? `Email delivery failed: ${result.reason}.` : "Failed to send verification email." });
      }

      // Only record the success after a confirmed 2xx delivery so the cooldown
      // window is not consumed on transient failures (admins can retry immediately).
      recordSendCodeSuccess({ channel: "email", identifier: normalizeEmailTarget(user.email) });

      await writeAuditLog({
        req,
        userId: user.id,
        action: "verification_email_resent",
        entityType: "user",
        entityId: user.id,
      });

      return res.json({ ok: true, message: "Verification email sent." });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to send verification email." });
    }
  });

  // Update a user's role or active status. Admin-secret gated.
  router.patch("/admin/users/:id", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const userId = String(req.params.id);
      const body = req.body as any;
      const patch: Record<string, unknown> = {};
      if (typeof body?.role === "string") {
        const allowed = ["user", "admin", "billing", "owner"];
        if (!allowed.includes(body.role)) {
          return res.status(400).json({ error: `role must be one of: ${allowed.join(", ")}` });
        }
        patch.role = body.role;
      }
      if (typeof body?.isActive === "boolean") {
        patch.isActive = body.isActive;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No updatable fields provided." });
      }
      const [updated] = await db
        .update(users)
        .set(patch)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          isActive: users.isActive,
          practiceName: users.practiceName,
          lastLoginAt: users.lastLoginAt,
        });
      if (!updated) {
        return res.status(404).json({ error: "User not found." });
      }
      return res.json({ ok: true, data: updated });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to update user." });
    }
  });

  // Cross-lab doctor-identity links for a specific user (Task #2457).
  // Powers the "Linked labs" section of the Accounts directory's user
  // detail drawer. Admin-secret gated.
  router.get("/admin/users/:id/linked-labs", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const userId = String(req.params.id);
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)));
      if (!user) return res.status(404).json({ error: "User not found." });
      const linkedLabs = await getLinkedLabsForUser(userId);
      return res.json({ ok: true, linkedLabs });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to load linked labs." });
    }
  });

  // ── Admin: Subscriptions list ─────────────────────────────────────────────
  // Returns a paginated list of all subscription rows with provider, status,
  // currentPeriodEnd, and masked IDs. Platform-admin-secret gated.
  router.get("/admin/subscriptions", requireCreator, async (req: any, res: any) => {

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
          trialEndsAt: r.trialEndAt?.toISOString() ?? null,
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

  // ── Admin Subscriptions: Stripe billing portal ────────────────────────────
  router.post("/admin/subscriptions/:id/portal", requireCreator, async (req: any, res: any) => {
    try {
      const configured = await isStripeConfigured();
      if (!configured) {
        return res.status(503).json({ error: "Stripe is not configured." });
      }
      const id = String(req.params.id);
      const [sub] = await db
        .select({ stripeCustomerId: subscriptions.stripeCustomerId })
        .from(subscriptions)
        .where(eq(subscriptions.id, id));
      if (!sub?.stripeCustomerId) {
        return res.status(404).json({ error: "Subscription not found or not a Stripe subscription." });
      }
      const stripe = await getUncachableStripeClient();
      if (!stripe) return res.status(503).json({ error: "Stripe unavailable." });
      const domains = (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
      const origin = domains[0] ? `https://${domains[0]}` : `${req.protocol}://${req.get("host")}`;
      const returnUrl = `${origin}/desktop/creator`;
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId!,
        return_url: returnUrl,
      });
      return res.json({ ok: true, url: session.url });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to create billing portal session." });
    }
  });

  // ── Admin Platform-Admin Sessions ─────────────────────────────────────────
  // The platform admin credential (secret or PIN) is always verified per-request
  // via headers (see isPlatformAdmin). These three endpoints give mobile clients
  // a way to (a) probe whether the credential is configured on the server,
  // (b) validate and cache a credential for a session, and (c) explicitly end
  // the session. The validated session is stored in system_settings so it
  // survives server restarts; the client stores the session token in SecureStore.

  router.get("/admin/platform-admin/status", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      const sessionId = (req as any).auth?.sessionId as string | undefined;
      const secretConfigured = !!(process.env.PLATFORM_ADMIN_SECRET);
      const pinConfigured = !!(process.env.PLATFORM_ADMIN_PIN) || secretConfigured;
      let sessionActive = false;
      let sessionExpiresAt: string | null = null;
      if (userId && sessionId) {
        const key = `padmin_sess:${userId}:${sessionId}`;
        const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
        if (row) {
          try {
            const data = JSON.parse(row.value ?? "{}");
            const exp = data?.expiresAt ? new Date(data.expiresAt) : null;
            if (exp && exp > new Date()) {
              sessionActive = true;
              sessionExpiresAt = exp.toISOString();
            } else if (exp) {
              await db.delete(systemSettings).where(eq(systemSettings.key, key));
            }
          } catch { /* ignore */ }
        }
      }
      return res.json({ ok: true, secretConfigured, pinConfigured, sessionActive, sessionExpiresAt });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get platform admin status." });
    }
  });

  router.post("/admin/platform-admin/unlock", requireAuth, platformAdminUnlockRateLimit, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      const sessionId = (req as any).auth?.sessionId as string | undefined;
      if (!userId || !sessionId) return res.status(401).json({ error: "Not authenticated." });
      // Only admin-role users may create a platform-admin session.
      const reqUser = (req as any).user;
      if (!reqUser || reqUser.role !== "admin") {
        return res.status(403).json({ error: "Admin role required." });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const credential = typeof body.credential === "string" ? body.credential : null;
      if (!credential) return res.status(400).json({ error: "credential is required." });

      const secret = process.env.PLATFORM_ADMIN_SECRET;
      const effectivePin = getEffectiveAdminPin();
      const valid = (secret && credential === secret) || (credential === effectivePin);
      if (!valid) {
        return res.status(403).json({ error: "Invalid platform admin credential." });
      }

      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const key = `padmin_sess:${userId}:${sessionId}`;
      await db
        .insert(systemSettings)
        .values({ key, value: JSON.stringify({ expiresAt: expiresAt.toISOString(), userId }), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: JSON.stringify({ expiresAt: expiresAt.toISOString(), userId }), updatedAt: new Date() },
        });
      return res.json({ ok: true, sessionActive: true, expiresAt: expiresAt.toISOString(), sessionToken: `${userId}:${sessionId}` });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to unlock platform admin session." });
    }
  });

  router.post("/admin/platform-admin/lock", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string | undefined;
      const sessionId = (req as any).auth?.sessionId as string | undefined;
      if (userId && sessionId) {
        const key = `padmin_sess:${userId}:${sessionId}`;
        await db.delete(systemSettings).where(eq(systemSettings.key, key));
      }
      return res.json({ ok: true, sessionActive: false });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to lock platform admin session." });
    }
  });

  // ── Admin Templates ───────────────────────────────────────────────────────
  // Simple editable fields for invoice, statement, and correspondence templates.
  // Invoice settings overlay is stored per-org in system_settings.
  // Statement and correspondence settings are stored in the organizations table.

  async function getLabOrgForRoles(
    userId: string,
    roles: string[],
  ): Promise<{ id: string } | null> {
    const [membership] = await db
      .select({ labId: organizationMemberships.labId })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          inArray(organizationMemberships.role, roles),
           eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
          eq(organizations.type, "lab"),
          isNull(organizations.deletedAt)
        )
      )
      .limit(1);
    return membership ? { id: membership.labId } : null;
  }

  function getAdminLabOrg(userId: string): Promise<{ id: string } | null> {
    return getLabOrgForRoles(userId, ADMIN_ROLES);
  }

  function getBillingLabOrg(userId: string): Promise<{ id: string } | null> {
    return getLabOrgForRoles(userId, BILLING_ROLES);
  }

  // ── Completed practice authorization documents and lab templates ──────────
  const AUTH_TEMPLATE_DEFAULTS = {
    card_on_file: "Card on File Authorization\nI authorize {{labName}} to securely retain and charge the payment card on file for services and invoices issued to {{practiceName}}.",
    autopay: "Auto-Pay Authorization\nI authorize {{labName}} to automatically charge the payment method on file for invoices issued to {{practiceName}} on the agreed payment schedule.",
  } as const;
  const authorizationPdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  const parseAuthorizationType = (value: unknown): "card_on_file" | "autopay" => {
    if (value !== "card_on_file" && value !== "autopay") throw new HttpError(400, "authorizationType must be card_on_file or autopay.");
    return value;
  };
  const templatePublic = (row: any) => ({
    id: row.id, labOrganizationId: row.labOrganizationId, templateType: row.templateType,
    content: row.content, version: row.version, updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
  const documentPublic = (row: any, status: "current" | "superseded" = "current") => ({
    id: row.id, labOrganizationId: row.labOrganizationId, practiceOrganizationId: row.practiceOrganizationId,
    supersedesDocumentId: row.supersedesDocumentId ?? null,
    authorizationType: row.authorizationType, originalFilename: row.originalFilename,
    byteSize: row.byteSize, checksum: row.checksum, uploaderUserId: row.uploaderUserId, status, createdAt: row.createdAt,
  });
  async function selectedLabForRole(userId: string, roles: string[], requested?: string) {
    const predicates = [
      eq(organizationMemberships.userId, userId),
      inArray(organizationMemberships.role, roles),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt),
      eq(organizations.type, "lab"),
      isNull(organizations.deletedAt),
    ];
    if (requested) predicates.push(eq(organizationMemberships.labId, requested));
    const [lab] = await db.select({ id: organizationMemberships.labId })
      .from(organizationMemberships).innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(and(...predicates)).limit(1);
    if (!lab) throw new HttpError(403, "Lab access is not permitted.");
    return lab.id;
  }
  async function completedDocumentScope(userId: string, practiceId: string, requestedLab?: string) {
    const labId = await selectedLabForRole(userId, BILLING_ROLES, requestedLab);
    const [practice] = await db.select({ id: organizations.id }).from(organizations).where(and(
      eq(organizations.id, practiceId), eq(organizations.parentLabOrganizationId, labId),
      eq(organizations.type, "provider"), isNull(organizations.deletedAt),
    )).limit(1);
    if (!practice) throw new HttpError(403, "Practice is outside this lab.");
    return labId;
  }
  async function storedDocumentScope(userId: string, labId: string, practiceId: string) {
    const selected = await selectedLabForRole(userId, BILLING_ROLES, labId);
    if (selected !== labId || !practiceId) throw new HttpError(403, "Authorization document is outside this lab.");
    return selected;
  }
  const pdfUpload = (req: any, res: any, next: any) => authorizationPdfUpload.single("file")(req, res, (error: any) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "PDF exceeds the 10 MiB limit." });
    return res.status(400).json({ error: "A single PDF file is required." });
  });
  router.get("/admin/authorization-templates", requireAuth, asyncHandler(async (req: any, res: any) => {
    const labId = await selectedLabForRole(req.auth.userId, ADMIN_ROLES, typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : undefined);
    const rows = await db.select().from(labAuthorizationTemplates).where(eq(labAuthorizationTemplates.labOrganizationId, labId));
    const byType = new Map(rows.map((row) => [row.templateType, row]));
    const result = (["card_on_file", "autopay"] as const).map((templateType) => byType.get(templateType) ?? {
      id: null, labOrganizationId: labId, templateType, content: AUTH_TEMPLATE_DEFAULTS[templateType],
      version: 1, updatedByUserId: null, createdAt: null, updatedAt: null,
    });
    return ok(res, result.map(templatePublic));
  }));
  router.put("/admin/authorization-templates/:templateType", requireAuth, asyncHandler(async (req: any, res: any) => {
    const labId = await selectedLabForRole(req.auth.userId, ADMIN_ROLES, typeof req.body?.labOrganizationId === "string" ? req.body.labOrganizationId : undefined);
    const templateType = parseAuthorizationType(req.params.templateType);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content || content.length > 20_000) throw new HttpError(400, "Template content is required and must be at most 20,000 characters.");
    const [row] = await db.insert(labAuthorizationTemplates).values({
      labOrganizationId: labId, templateType, content, updatedByUserId: req.auth.userId,
    }).onConflictDoUpdate({
      target: [labAuthorizationTemplates.labOrganizationId, labAuthorizationTemplates.templateType],
      set: { content, version: sql`${labAuthorizationTemplates.version} + 1`, updatedByUserId: req.auth.userId, updatedAt: new Date() },
    }).returning();
    return ok(res, templatePublic(row));
  }));
  router.get("/admin/authorization-templates/:templateType/pdf", requireAuth, asyncHandler(async (req: any, res: any) => {
    const labId = await selectedLabForRole(req.auth.userId, ADMIN_ROLES, typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : undefined);
    const templateType = parseAuthorizationType(req.params.templateType);
    const [row] = await db.select({ content: labAuthorizationTemplates.content })
      .from(labAuthorizationTemplates)
      .where(and(eq(labAuthorizationTemplates.labOrganizationId, labId), eq(labAuthorizationTemplates.templateType, templateType)))
      .limit(1);
    const [lab] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, labId)).limit(1);
    const content = (row?.content ?? AUTH_TEMPLATE_DEFAULTS[templateType])
      .replace(/\{\{\s*labName\s*\}\}/gi, lab?.name ?? "Laboratory")
      .replace(/\{\{\s*(practiceName|signerName|signer|date)\s*\}\}/gi, "____________________________")
      .replace(/\{\{[^}]+\}\}/g, "____________________________");
    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 54 });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(18).text(templateType === "autopay" ? "Auto-Pay Authorization" : "Card on File Authorization").moveDown();
      doc.fontSize(11).text(content).moveDown(2);
      doc.text("Name: ______________________________________________");
      doc.moveDown().text("Signature: ___________________________________________");
      doc.moveDown().text("Date: ___________________");
      doc.end();
    });
    const filename = `${templateType === "autopay" ? "auto-pay" : "card-on-file"}-authorization-template.pdf`;
    res.type("application/pdf").set("Content-Disposition", `attachment; filename="${filename}"`).end(pdf);
  }));
  router.post("/admin/practices/:practiceId/authorization-documents", requireAuth, pdfUpload, asyncHandler(async (req: any, res: any) => {
    const supersedesDocumentId = typeof req.body?.supersedesDocumentId === "string" && req.body.supersedesDocumentId.trim()
      ? req.body.supersedesDocumentId.trim()
      : null;
    const requestedLab = typeof req.body?.labOrganizationId === "string" ? req.body.labOrganizationId : undefined;
    let labId: string;
    if (supersedesDocumentId) {
      const [prior] = await db.select().from(practiceAuthorizationDocuments)
        .where(eq(practiceAuthorizationDocuments.id, supersedesDocumentId)).limit(1);
      if (!prior) throw new HttpError(404, "Authorization document to supersede was not found.");
      if (prior.practiceOrganizationId !== req.params.practiceId || (requestedLab && requestedLab !== prior.labOrganizationId)) {
        throw new HttpError(403, "Authorization document is outside this practice.");
      }
      labId = await storedDocumentScope(req.auth.userId, prior.labOrganizationId, prior.practiceOrganizationId);
      const [replacement] = await db.select({ id: practiceAuthorizationDocuments.id })
        .from(practiceAuthorizationDocuments)
        .where(eq(practiceAuthorizationDocuments.supersedesDocumentId, prior.id)).limit(1);
      if (replacement) throw new HttpError(409, "This authorization has already been superseded.");
    } else {
      labId = await completedDocumentScope(req.auth.userId, req.params.practiceId, requestedLab);
    }
    const file = req.file as Express.Multer.File | undefined;
    const authorizationType = parseAuthorizationType(req.body?.authorizationType);
    if (!file) throw new HttpError(400, "A completed PDF file is required.");
    if (!/\.pdf$/i.test(file.originalname || "") || file.mimetype.toLowerCase().split(";")[0] !== "application/pdf") {
      throw new HttpError(415, "Only PDF files are accepted.");
    }
    if (file.size < 5 || file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new HttpError(415, "File is not a valid PDF.");
    const id = randomBytes(16).toString("hex");
    const objectKey = `practice-authorizations/${labId}/${req.params.practiceId}/${id}.pdf`;
    const checksum = createHash("sha256").update(file.buffer).digest("hex");
    if (!await writeCaseMediaToObjectStorage(objectKey, file.buffer, "application/pdf")) throw new HttpError(503, "Private authorization storage is not configured.");
    try {
      const [row] = await db.insert(practiceAuthorizationDocuments).values({
        id, labOrganizationId: labId, practiceOrganizationId: req.params.practiceId, authorizationType,
        supersedesDocumentId,
        originalFilename: path.basename(file.originalname).slice(0, 255), byteSize: file.size, checksum,
        uploaderUserId: req.auth.userId, objectKey,
      }).onConflictDoNothing({
        target: practiceAuthorizationDocuments.supersedesDocumentId,
      }).returning();
      if (!row) {
        throw new HttpError(409, "This authorization has already been superseded.");
      }
      return res.status(201).json({ ok: true, data: documentPublic(row) });
    } catch (error) {
      await deleteCaseMediaFromObjectStorage(objectKey);
      throw error;
    }
  }));
  router.get("/admin/practices/:practiceId/authorization-documents", requireAuth, asyncHandler(async (req: any, res: any) => {
    const labId = await selectedLabForRole(req.auth.userId, BILLING_ROLES, typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : undefined);
    const rows = await db.select().from(practiceAuthorizationDocuments).where(and(
      eq(practiceAuthorizationDocuments.labOrganizationId, labId), eq(practiceAuthorizationDocuments.practiceOrganizationId, req.params.practiceId),
    )).orderBy(desc(practiceAuthorizationDocuments.createdAt));
    if (!rows.length) {
      const [practice] = await db.select({ parentLabOrganizationId: organizations.parentLabOrganizationId })
        .from(organizations).where(and(eq(organizations.id, req.params.practiceId), isNull(organizations.deletedAt))).limit(1);
      if (!practice || practice.parentLabOrganizationId !== labId) throw new HttpError(403, "Practice is outside this lab.");
    }
    const supersededIds = new Set(rows.flatMap((row) => row.supersedesDocumentId ? [row.supersedesDocumentId] : []));
    return ok(res, rows.map((row) => documentPublic(row, supersededIds.has(row.id) ? "superseded" : "current")));
  }));
  const serveAuthorizationDocument = (disposition: "inline" | "attachment") => asyncHandler(async (req: any, res: any) => {
    const [row] = await db.select().from(practiceAuthorizationDocuments).where(eq(practiceAuthorizationDocuments.id, req.params.documentId)).limit(1);
    if (!row) throw new HttpError(404, "Authorization document not found.");
    const requestedLab = typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : row.labOrganizationId;
    if (requestedLab !== row.labOrganizationId) throw new HttpError(403, "Authorization document is outside this lab.");
    await storedDocumentScope(req.auth.userId, row.labOrganizationId, row.practiceOrganizationId);
    const object = await openCaseMediaObjectStream(row.objectKey, "application/pdf");
    if (!object) throw new HttpError(404, "Authorization document not found.");
    const chunks: Buffer[] = []; for await (const chunk of object.stream as any) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    if (createHash("sha256").update(data).digest("hex") !== row.checksum) throw new HttpError(422, "Authorization document integrity check failed.");
    res.type("application/pdf").set("Content-Disposition", `${disposition}; filename="${row.originalFilename.replace(/["\r\n]/g, "_")}"`).end(data);
  });
  router.get("/admin/authorization-documents/:documentId/preview", requireAuth, serveAuthorizationDocument("inline"));
  router.get("/admin/authorization-documents/:documentId/download", requireAuth, serveAuthorizationDocument("attachment"));

  const DEFAULT_INVOICE_TEMPLATE = {
    showLogo: true,
    showHeader: true,
    showDueDate: true,
    showCaseNumbers: true,
    showRestorationDetails: true,
    headerText: null as string | null,
    footerText: null as string | null,
    termsText: null as string | null,
    notesText: null as string | null,
  };

  const DEFAULT_STATEMENT_TEMPLATE = {
    showLogo: true,
    showAccountNumber: true,
    showAgingSummary: true,
    showPaymentInstructions: true,
    headerText: null as string | null,
    footerText: null as string | null,
    paymentInstructionsText: null as string | null,
    messageText: null as string | null,
  };

  const DEFAULT_CORRESPONDENCE_TEMPLATE = {
    showLogo: true,
    showAddress: true,
    showContactInfo: true,
    salutation: null as string | null,
    closingText: null as string | null,
    signatureText: null as string | null,
    headerText: null as string | null,
    footerText: null as string | null,
  };

  router.get("/admin/templates/invoice", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const key = `tmpl_invoice_simple:${org.id}`;
      const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      const stored = row ? (() => { try { return JSON.parse(row.value ?? "{}"); } catch { return {}; } })() : {};
      const template = { ...DEFAULT_INVOICE_TEMPLATE, ...stored };
      return res.json({ ok: true, template, orgId: org.id });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get invoice template." });
    }
  });

  router.patch("/admin/templates/invoice", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const body = req.body ?? {};
      const key = `tmpl_invoice_simple:${org.id}`;
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      const current = existing ? (() => { try { return JSON.parse(existing.value ?? "{}"); } catch { return {}; } })() : {};
      const updated = { ...DEFAULT_INVOICE_TEMPLATE, ...current, ...body };
      await db
        .insert(systemSettings)
        .values({ key, value: JSON.stringify(updated), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: JSON.stringify(updated), updatedAt: new Date() },
        });
      return res.json({ ok: true, template: updated });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to update invoice template." });
    }
  });

  router.get("/admin/templates/statement", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const [orgRow] = await db.select({ statementTemplate: organizations.statementTemplate }).from(organizations).where(eq(organizations.id, org.id));
      const stored = (orgRow?.statementTemplate as Record<string, unknown> | null) ?? {};
      const template = { ...DEFAULT_STATEMENT_TEMPLATE, ...stored };
      return res.json({ ok: true, template, orgId: org.id });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get statement template." });
    }
  });

  router.patch("/admin/templates/statement", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const [orgRow] = await db.select({ statementTemplate: organizations.statementTemplate }).from(organizations).where(eq(organizations.id, org.id));
      const current = (orgRow?.statementTemplate as Record<string, unknown> | null) ?? {};
      const updated = { ...DEFAULT_STATEMENT_TEMPLATE, ...current, ...(req.body ?? {}) };
      await db.update(organizations).set({ statementTemplate: updated, updatedAt: new Date() }).where(eq(organizations.id, org.id))
        .catch((err: unknown): never => wrapDbError(err, { fallback: "Failed to update statement template." }));
      return res.json({ ok: true, template: updated });
    } catch (e: any) {
      const msg = e instanceof HttpError ? e.message : "Failed to update statement template.";
      return res.status(e instanceof HttpError ? e.statusCode : 500).json({ error: msg });
    }
  });

  router.get("/admin/templates/correspondence", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const [orgRow] = await db.select({ correspondenceTemplate: organizations.correspondenceTemplate }).from(organizations).where(eq(organizations.id, org.id));
      const stored = (orgRow?.correspondenceTemplate as Record<string, unknown> | null) ?? {};
      const template = { ...DEFAULT_CORRESPONDENCE_TEMPLATE, ...stored };
      return res.json({ ok: true, template, orgId: org.id });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get correspondence template." });
    }
  });

  router.patch("/admin/templates/correspondence", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const [orgRow] = await db.select({ correspondenceTemplate: organizations.correspondenceTemplate }).from(organizations).where(eq(organizations.id, org.id));
      const current = (orgRow?.correspondenceTemplate as Record<string, unknown> | null) ?? {};
      const updated = { ...DEFAULT_CORRESPONDENCE_TEMPLATE, ...current, ...(req.body ?? {}) };
      await db.update(organizations).set({ correspondenceTemplate: updated, updatedAt: new Date() }).where(eq(organizations.id, org.id))
        .catch((err: unknown): never => wrapDbError(err, { fallback: "Failed to update correspondence template." }));
      return res.json({ ok: true, template: updated });
    } catch (e: any) {
      const msg = e instanceof HttpError ? e.message : "Failed to update correspondence template.";
      return res.status(e instanceof HttpError ? e.statusCode : 500).json({ error: msg });
    }
  });

  // ── Statement email template ──────────────────────────────────────────────
  const DEFAULT_STATEMENT_EMAIL_TEMPLATE = {
    emailSubject: null as string | null,
    emailBody: null as string | null,
    emailHeader: null as string | null,
    emailReplyTo: null as string | null,
  };

  router.get("/admin/templates/statement-email", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const key = `tmpl_statement_email:${org.id}`;
      const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      const stored = row ? (() => { try { return JSON.parse(row.value ?? "{}"); } catch { return {}; } })() : {};
      const template = { ...DEFAULT_STATEMENT_EMAIL_TEMPLATE, ...stored };
      return res.json({
        ok: true,
        emailSubject: template.emailSubject,
        emailBody: template.emailBody,
        emailHeader: template.emailHeader,
        emailReplyTo: template.emailReplyTo,
        orgId: org.id,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to get statement email template." });
    }
  });

  router.patch("/admin/templates/statement-email", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getAdminLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Admin access required." });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = `tmpl_statement_email:${org.id}`;
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      const current = existing ? (() => { try { return JSON.parse(existing.value ?? "{}"); } catch { return {}; } })() : {};
      const updated = {
        ...DEFAULT_STATEMENT_EMAIL_TEMPLATE,
        ...current,
        ...(typeof body.emailSubject !== "undefined" ? { emailSubject: body.emailSubject || null } : {}),
        ...(typeof body.emailBody !== "undefined" ? { emailBody: body.emailBody || null } : {}),
        ...(typeof body.emailHeader !== "undefined" ? { emailHeader: body.emailHeader || null } : {}),
        ...(typeof body.emailReplyTo !== "undefined" ? { emailReplyTo: body.emailReplyTo || null } : {}),
      };
      await db
        .insert(systemSettings)
        .values({ key, value: JSON.stringify(updated), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: JSON.stringify(updated), updatedAt: new Date() },
        });
      return res.json({
        ok: true,
        emailSubject: updated.emailSubject,
        emailBody: updated.emailBody,
        emailHeader: updated.emailHeader,
        emailReplyTo: updated.emailReplyTo,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to update statement email template." });
    }
  });

  // ── Billing: send authorization form by email ─────────────────────────────
  router.post("/admin/auth-form-email", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).auth?.userId as string;
      const org = await getBillingLabOrg(userId);
      if (!org) return res.status(403).json({ error: "Billing access required." });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const to = typeof body.to === "string" ? body.to.trim() : "";
      const subject = typeof body.subject === "string" ? body.subject.trim() : "";
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!to) return res.status(400).json({ error: "Recipient email is required." });
      if (!subject) return res.status(400).json({ error: "Subject is required." });
      if (!text) return res.status(400).json({ error: "Form body is required." });
      const html = `<pre style="font-family:monospace;white-space:pre-wrap;font-size:13px">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
      await sendMail({ to, subject, html, text });
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to send email." });
    }
  });

  // ── Admin: pre-cutoff data cleanup (one-shot, platform-admin gated) ───────
  // Soft-deletes every canonical case, invoice, and legacy mobile case dated
  // before June 1 2026 (America/New_York → 2026-06-01T04:00:00Z). Built for a
  // one-time production cleanup requested by the platform owner. Everything
  // goes through the standard soft-delete machinery (softDeleteById /
  // softDeleteLegacyCases) so it is fully reversible and audit-logged.
  //
  // Safety model:
  //   - Gated by platformAdminUserOrSecret + isPlatformAdmin (secret header).
  //   - Defaults to dryRun:true — reports counts, changes nothing.
  //   - A live run additionally requires confirm:"DELETE_PRE_JUNE_2026".
  //   - Date fields are authoritative business dates: cases.received_at,
  //     COALESCE(invoices.issued_at, invoices.created_at), and the legacy
  //     blob's createdAt (epoch-ms or ISO). Rows exactly AT the cutoff are
  //     kept (strict <). A legacy blob whose createdAt cannot be parsed is
  //     NEVER deleted (fail-closed).
  router.post("/admin/cleanup/pre-cutoff-cases", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
      const CUTOFF = new Date("2026-06-01T04:00:00.000Z"); // 2026-06-01 00:00 America/New_York (EDT)
      const CASE_CUTOFF = "2026-06-01";
    const CONFIRM_PHRASE = "DELETE_PRE_JUNE_2026";

    const parseLegacyCreatedAtMs = (raw: unknown): number | null => {
      if (raw == null) return null;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        // Blob createdAt is epoch-milliseconds; reject implausibly small
        // numbers (e.g. epoch-seconds or garbage) instead of guessing.
        return raw > 10_000_000_000 ? raw : null;
      }
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (/^\d{12,}$/.test(trimmed)) return Number(trimmed);
        const t = Date.parse(trimmed);
        return Number.isNaN(t) ? null : t;
      }
      return null;
    };

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = body.dryRun !== false; // default: dry run
      if (!dryRun && body.confirm !== CONFIRM_PHRASE) {
        return res.status(400).json({
          error: `Live run requires body { dryRun: false, confirm: "${CONFIRM_PHRASE}" }.`,
        });
      }
      // Optional tenant scope: when set, only rows belonging to this lab org
      // are considered. Keeps the blast radius contained (tests scope to their
      // own seeded org; the production run passes the real lab's org id).
      const scopeOrgId =
        typeof body.organizationId === "string" && body.organizationId.trim()
          ? body.organizationId.trim()
          : null;

      const actorUserId = ((req as any).user?.id as string | null) ?? null;
      const actorName = ((req as any).user?.username as string) || "platform-admin";

      // 1) Canonical cases received before the cutoff.
      const preCases = await db
        .select({
          id: casesTable.id,
          caseNumber: casesTable.caseNumber,
          labOrganizationId: casesTable.labOrganizationId,
          patientFirstName: casesTable.patientFirstName,
          patientLastName: casesTable.patientLastName,
          receivedAt: casesTable.receivedAt,
        })
        .from(casesTable)
        .where(
          and(
            notDeleted(casesTable),
            sql`${casesTable.receivedAt} < ${CASE_CUTOFF}`,
            ...(scopeOrgId ? [eq(casesTable.labOrganizationId, scopeOrgId)] : []),
          ),
        );

      // 2) Invoices dated before the cutoff (issued_at, falling back to
      //    created_at for never-issued drafts).
      const preInvoices = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          labOrganizationId: invoices.labOrganizationId,
          issuedAt: invoices.issuedAt,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(
          and(
            notDeleted(invoices),
            sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < ${CUTOFF}`,
            ...(scopeOrgId ? [eq(invoices.labOrganizationId, scopeOrgId)] : []),
          ),
        );

      // 3) Legacy mobile cases whose blob createdAt predates the cutoff.
      const allLegacy = await db
        .select({ id: labCases.id, organizationId: labCases.organizationId, caseData: labCases.caseData })
        .from(labCases)
        .where(
          and(
            isNull(labCases.deletedAt),
            ...(scopeOrgId ? [eq(labCases.organizationId, scopeOrgId)] : []),
          ),
        );
      const preLegacy: { id: string; createdAtMs: number }[] = [];
      let unparseableLegacy = 0;
      for (const row of allLegacy) {
        try {
          const data = typeof row.caseData === "string" ? JSON.parse(row.caseData) : (row.caseData ?? {});
          const t = parseLegacyCreatedAtMs(data?.createdAt);
          if (t == null) {
            unparseableLegacy++;
          } else if (t < CUTOFF.getTime()) {
            preLegacy.push({ id: row.id, createdAtMs: t });
          }
        } catch {
          unparseableLegacy++; // malformed blob → keep (never delete on uncertainty)
        }
      }

      const summary = {
        cutoff: CUTOFF.toISOString(),
        scopeOrganizationId: scopeOrgId,
        canonicalCases: preCases.length,
        invoices: preInvoices.length,
        legacyCases: preLegacy.length,
        unparseableLegacySkipped: unparseableLegacy,
        caseReceivedRange: preCases.length
          ? {
              oldest: preCases.map((c) => c.receivedAt).sort()[0],
              newest: preCases.map((c) => c.receivedAt).sort().at(-1),
            }
          : null,
        legacyCreatedRange: preLegacy.length
          ? {
              oldest: new Date(Math.min(...preLegacy.map((c) => c.createdAtMs))).toISOString(),
              newest: new Date(Math.max(...preLegacy.map((c) => c.createdAtMs))).toISOString(),
            }
          : null,
      };

      req.log?.info?.(
        { ...summary, dryRun, actor: actorName },
        "pre-cutoff cleanup: scan complete",
      );

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, ...summary });
      }

      // ── Live run ──────────────────────────────────────────────────────────
      // Group canonical cases per lab because invoice freezing is tenant-scoped.
      const caseIdsByLab = new Map<string, { ids: string[]; numbers: Map<string, string | null | undefined> }>();
      for (const c of preCases) {
        const bucket =
          caseIdsByLab.get(c.labOrganizationId) ??
          { ids: [] as string[], numbers: new Map<string, string | null | undefined>() };
        bucket.ids.push(c.id);
        bucket.numbers.set(c.id, c.caseNumber);
        caseIdsByLab.set(c.labOrganizationId, bucket);
      }
      let invoicesFrozen = 0;
      await db.transaction(async (tx) => {
        // A canonical case and every active invoice linked to it must change
        // together, including their audit records.
        for (const c of preCases) {
          await softDeleteById({
            table: casesTable,
            id: c.id,
            actorUserId,
            req,
            organizationId: c.labOrganizationId,
            entityType: "case",
            beforeJson: c,
            metadataJson: {
              caseNumber: c.caseNumber,
              patientName: [c.patientFirstName, c.patientLastName].filter(Boolean).join(" "),
              cleanup: "pre_cutoff_2026_06_01",
            },
            tx,
          });
        }

        for (const [labOrganizationId, bucket] of caseIdsByLab) {
          invoicesFrozen += await freezeInvoicesForDeletedCases({
            req,
            caseIds: bucket.ids,
            labOrganizationId,
            deletingUserId: actorUserId,
            caseNumberById: bucket.numbers,
            tx,
          });
        }
      });

      // Soft-delete pre-cutoff invoices (one audit entry per invoice).
      for (const inv of preInvoices) {
        await softDeleteById({
          table: invoices,
          id: inv.id,
          actorUserId,
          req,
          organizationId: inv.labOrganizationId,
          entityType: "invoice",
          beforeJson: inv,
          metadataJson: {
            invoiceNumber: inv.invoiceNumber,
            cleanup: "pre_cutoff_2026_06_01",
          },
        });
      }

      // Soft-delete legacy mobile cases via the shared helper (per-case audit;
      // embedded mobile invoices live inside the blob and disappear with it).
      let legacyDeleted = 0;
      if (preLegacy.length > 0) {
        const { deletedIds } = await softDeleteLegacyCases({
          ids: preLegacy.map((c) => c.id),
          deletedBy: `cleanup:${actorName}`,
          actorUserId,
          organizationId: null, // audit falls back to each row's own org
          req,
        });
        legacyDeleted = deletedIds.length;
      }

      const result = {
        ...summary,
        legacyCases: legacyDeleted,
        invoicesFrozen,
      };

      await writeAuditLog({
        req,
        userId: actorUserId,
        organizationId: null,
        action: "pre_cutoff_cleanup_completed",
        entityType: "system",
        entityId: "pre-cutoff-cleanup",
        metadataJson: { ...result, actor: actorName },
      });

      req.log?.info?.({ ...result, actor: actorName }, "pre-cutoff cleanup: live run complete");

      return res.json({ ok: true, dryRun: false, ...result });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "pre-cutoff cleanup failed");
      return res.status(500).json({ error: e?.message || "Cleanup failed." });
    }
  });

  // ── Admin: externalize base64 photos embedded in legacy case blobs ───────
  // Legacy mobile cases store one JSON blob per case in `lab_cases.case_data`,
  // and early mobile builds embedded each photo in it as base64. A single
  // photo can make a row 10 MB, and that row is read and copied whole by case
  // detail, mobile sync, the nightly backup ZIP, and every restore.
  //
  // This sweep moves each payload to a normal case-media file (disk + App
  // Storage) with its `legacy_case_media` ledger row, and leaves a reference
  // in the blob. See ../lib/legacy-case-media-externalize.ts for the per-case
  // ordering and the parity check.
  //
  // Safety model:
  //   - Gated by platformAdminUserOrSecret + isPlatformAdmin.
  //   - Defaults to dryRun:true — files are written and verified and the
  //     rewrite is parity-checked, but no blob is changed.
  //   - A live run additionally requires
  //     confirm:"EXTERNALIZE_LEGACY_CASE_MEDIA".
  //   - Batched and resumable: candidates are "blobs that still contain
  //     base64", so a migrated case drops out and an interrupted run is
  //     continued simply by calling again. `limit` bounds one invocation.
  //   - Every original blob is backed up to App Storage and read back before
  //     its row is rewritten; a backup that could only reach ephemeral local
  //     disk aborts that case unless allowLocalBackup:true.
  router.get(
    "/admin/maintenance/legacy-case-media",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      try {
        return res.json({ ok: true, ...(await getLegacyCaseMediaMigrationStatus()) });
      } catch (e: any) {
        req.log?.error?.({ err: e }, "legacy case media status failed");
        return res.status(500).json({ error: e?.message || "Status failed." });
      }
    },
  );

  router.post(
    "/admin/maintenance/legacy-case-media",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = body.dryRun !== false; // default: dry run
      if (!dryRun && body.confirm !== LEGACY_CASE_MEDIA_CONFIRM) {
        return res.status(400).json({
          error: `Live run requires body { dryRun: false, confirm: "${LEGACY_CASE_MEDIA_CONFIRM}" }.`,
        });
      }
      try {
        const actorName =
          ((req as any).user?.username as string) || "platform-admin";
        // `caseIds` narrows the sweep to specific cases — how an operator
        // retries one case that failed or was skipped, without touching the
        // rest. Omitted, the run sweeps every case still holding base64.
        const caseIds = Array.isArray(body.caseIds)
          ? body.caseIds.filter((id): id is string => typeof id === "string" && !!id)
          : undefined;
        const report = await runLegacyCaseMediaMigration({
          dryRun,
          caseIds,
          limit: typeof body.limit === "number" ? body.limit : undefined,
          batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
          runId: typeof body.runId === "string" && body.runId ? body.runId : undefined,
          requireDurableBackup: body.allowLocalBackup !== true,
        });
        if (!dryRun) {
          await writeAuditLog({
            req,
            userId: ((req as any).user?.id as string | null) ?? null,
            organizationId: null,
            action: "legacy_case_media_externalized",
            entityType: "system",
            entityId: report.runId,
            metadataJson: {
              actor: actorName,
              runId: report.runId,
              scannedCases: report.scannedCases,
              migratedCases: report.migratedCases,
              skippedCases: report.skippedCases,
              failedCases: report.failedCases,
              filesWritten: report.filesWritten,
              bytesRemovedFromBlobs: report.bytesRemovedFromBlobs,
              remainingCases: report.remainingCases,
            },
          });
        }
        return res.json({ ok: report.failedCases === 0, ...report });
      } catch (e: any) {
        req.log?.error?.({ err: e }, "legacy case media externalization failed");
        return res.status(500).json({ error: e?.message || "Migration failed." });
      }
    },
  );

  // Undo for the sweep above: put a case's original pre-migration blob back
  // from the backup that run took. The stored object is an envelope, so this
  // has to be code rather than a "write the JSON back" instruction — the
  // original is the `caseData` string inside it.
  router.post(
    "/admin/maintenance/legacy-case-media/restore",
    platformAdminUserOrSecret,
    async (req, res) => {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const runId = typeof body.runId === "string" ? body.runId.trim() : "";
      const caseIds = Array.isArray(body.caseIds)
        ? body.caseIds.filter((id): id is string => typeof id === "string" && !!id)
        : [];
      if (!runId || caseIds.length === 0) {
        return res
          .status(400)
          .json({ error: "Body must include { runId, caseIds: [...] }." });
      }
      const dryRun = body.dryRun !== false; // default: dry run
      if (!dryRun && body.confirm !== LEGACY_CASE_DATA_RESTORE_CONFIRM) {
        return res.status(400).json({
          error: `Live restore requires body { dryRun: false, confirm: "${LEGACY_CASE_DATA_RESTORE_CONFIRM}" }.`,
        });
      }
      try {
        const report = await restoreLegacyCaseDataFromBackup({
          runId,
          caseIds,
          dryRun,
        });
        if (!dryRun) {
          await writeAuditLog({
            req,
            userId: ((req as any).user?.id as string | null) ?? null,
            organizationId: null,
            action: "legacy_case_data_restored",
            entityType: "system",
            entityId: runId,
            metadataJson: {
              actor: ((req as any).user?.username as string) || "platform-admin",
              runId,
              requestedCases: caseIds.length,
              restoredCases: report.restoredCases,
              cases: report.cases,
            },
          });
        }
        return res.json({
          ok: report.cases.every((c) => c.status !== "failed"),
          ...report,
        });
      } catch (e: any) {
        req.log?.error?.({ err: e }, "legacy case data restore failed");
        return res.status(500).json({ error: e?.message || "Restore failed." });
      }
    },
  );

  // ── Admin: targeted legacy invoice cleanup (one-shot, platform-admin gated) ──
  // The target identity list and date window are validated private configuration.
  // Matching is by patient identity and date window, never by reused case number.
  //
  // Safety model:
  //   - Gated by platformAdminUserOrSecret + isPlatformAdmin (secret header).
  //   - organizationId is REQUIRED and must be the SDR1 org id; any other org
  //     needs allowNonSdr1OrgForTesting:true, which is rejected in production.
  //   - Defaults to dryRun:true — full matched/ambiguous/nonTarget report,
  //     changes nothing.
  //   - A live run additionally requires the configured exact confirmation phrase.
  //   - Linked canonical cases/invoices are only soft-deleted when BOTH the
  //     number AND the patient name match a matched legacy row; a number match
  //     with a different patient is reported and skipped (fail-closed).
  //   - Everything goes through softDeleteById / softDeleteLegacyCases, so it
  //     is reversible and audit-logged.
  router.post("/admin/cleanup/sdr1-legacy-open-invoices", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    if (!recoveryDataAvailable) {
      return res.status(503).json({ error: RECOVERY_DATA_UNAVAILABLE_MESSAGE });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = body.dryRun !== false; // default: dry run
      if (!dryRun && body.confirm !== SDR1_CLEANUP_CONFIRM) {
        return res.status(400).json({
          error: `Live run requires body { dryRun: false, confirm: "${SDR1_CLEANUP_CONFIRM}" }.`,
        });
      }
      const orgId =
        typeof body.organizationId === "string" && body.organizationId.trim()
          ? body.organizationId.trim()
          : null;
      if (!orgId) {
        return res.status(400).json({ error: "organizationId is required." });
      }
      if (orgId !== SDR1_ORG_ID) {
        const overrideAllowed =
          body.allowNonSdr1OrgForTesting === true && process.env.NODE_ENV !== "production";
        if (!overrideAllowed) {
          return res.status(400).json({
            error:
              "This cleanup is scoped to the SDR1 lab organization. organizationId does not match.",
          });
        }
      }

      const actorUserId = ((req as any).user?.id as string | null) ?? null;
      const actorName = ((req as any).user?.username as string) || "platform-admin";

      // 1) Active legacy rows in the target org, classified by the pure
      //    matching logic (patient name + legacy era window).
      const activeLegacy = await db
        .select({
          id: labCases.id,
          organizationId: labCases.organizationId,
          caseData: labCases.caseData,
        })
        .from(labCases)
        .where(and(isNull(labCases.deletedAt), eq(labCases.organizationId, orgId)));
      const classification = classifySdr1LegacyRows(activeLegacy);
      const { matched, ambiguous, nonTarget, unmatchedTargets } = classification;

      // 2) Linked still-active canonical records. Candidate by number, but
      //    ONLY deleted when the canonical patient name matches the same
      //    target the legacy row matched — the legacy numbers were re-used by
      //    unrelated legitimate cases which must never be touched.
      const targetByCaseNumber = new Map<string, Set<string>>();
      for (const m of matched) {
        if (!m.caseNumber || !m.matchedTarget) continue;
        const set = targetByCaseNumber.get(m.caseNumber) ?? new Set<string>();
        set.add(m.matchedTarget);
        targetByCaseNumber.set(m.caseNumber, set);
      }
      const matchedCaseNumbers = [...targetByCaseNumber.keys()];
      const matchedLegacyIds = matched.map((m) => m.id);

      const linkedCanonicalCases: {
        id: string;
        caseNumber: string | null;
        patientName: string;
        matchedTarget: string;
      }[] = [];
      const skippedCanonicalCaseCollisions: {
        id: string;
        caseNumber: string | null;
        patientName: string;
      }[] = [];
      if (matchedCaseNumbers.length > 0) {
        const candidateCases = await db
          .select({
            id: casesTable.id,
            caseNumber: casesTable.caseNumber,
            labOrganizationId: casesTable.labOrganizationId,
            patientFirstName: casesTable.patientFirstName,
            patientLastName: casesTable.patientLastName,
          })
          .from(casesTable)
          .where(
            and(
              notDeleted(casesTable),
              eq(casesTable.labOrganizationId, orgId),
              inArray(casesTable.caseNumber, matchedCaseNumbers),
            ),
          );
        for (const c of candidateCases) {
          const patientName = [c.patientFirstName, c.patientLastName]
            .filter(Boolean)
            .join(" ");
          const targets = c.caseNumber ? targetByCaseNumber.get(c.caseNumber) : undefined;
          const hit = targets
            ? [...targets].find((t) => patientName && namesMatch(patientName, t))
            : undefined;
          if (hit) {
            linkedCanonicalCases.push({
              id: c.id,
              caseNumber: c.caseNumber,
              patientName,
              matchedTarget: hit,
            });
          } else {
            skippedCanonicalCaseCollisions.push({
              id: c.id,
              caseNumber: c.caseNumber,
              patientName,
            });
          }
        }
      }

      const linkedCanonicalInvoices: {
        id: string;
        invoiceNumber: string;
        patientName: string | null;
        matchedTarget: string | null;
        linkVia: "case_id" | "number_and_name";
      }[] = [];
      const skippedCanonicalInvoiceCollisions: {
        id: string;
        invoiceNumber: string;
        patientName: string | null;
      }[] = [];
      const invoiceNumberByCaseNumber = new Map<string, Set<string>>();
      for (const [caseNumber, targets] of targetByCaseNumber) {
        invoiceNumberByCaseNumber.set(`INV-${caseNumber}`, targets);
      }
      const candidateInvoiceNumbers = [...invoiceNumberByCaseNumber.keys()];
      if (candidateInvoiceNumbers.length > 0 || matchedLegacyIds.length > 0) {
        const candidateInvoices = await db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            caseId: invoices.caseId,
            labOrganizationId: invoices.labOrganizationId,
            displayMetadataJson: invoices.displayMetadataJson,
          })
          .from(invoices)
          .where(
            and(
              notDeleted(invoices),
              eq(invoices.labOrganizationId, orgId),
              or(
                ...(candidateInvoiceNumbers.length > 0
                  ? [inArray(invoices.invoiceNumber, candidateInvoiceNumbers)]
                  : []),
                ...(matchedLegacyIds.length > 0
                  ? [inArray(invoices.caseId, matchedLegacyIds)]
                  : []),
              ),
            ),
          );
        for (const inv of candidateInvoices) {
          const meta = (inv.displayMetadataJson ?? {}) as Record<string, unknown>;
          const patientName =
            typeof meta.patientName === "string" && meta.patientName.trim()
              ? meta.patientName.trim()
              : null;
          if (inv.caseId && matchedLegacyIds.includes(inv.caseId)) {
            // Direct link: the invoice points at a matched legacy row id.
            linkedCanonicalInvoices.push({
              id: inv.id,
              invoiceNumber: inv.invoiceNumber,
              patientName,
              matchedTarget: null,
              linkVia: "case_id",
            });
            continue;
          }
          const targets = invoiceNumberByCaseNumber.get(inv.invoiceNumber);
          const hit =
            targets && patientName
              ? [...targets].find((t) => namesMatch(patientName, t))
              : undefined;
          if (hit) {
            linkedCanonicalInvoices.push({
              id: inv.id,
              invoiceNumber: inv.invoiceNumber,
              patientName,
              matchedTarget: hit,
              linkVia: "number_and_name",
            });
          } else {
            skippedCanonicalInvoiceCollisions.push({
              id: inv.id,
              invoiceNumber: inv.invoiceNumber,
              patientName,
            });
          }
        }
      }

      const summary = {
        scopeOrganizationId: orgId,
        activeLegacyRows: activeLegacy.length,
        matched: matched.length,
        ambiguousSkipped: ambiguous.length,
        nonTargetSkipped: nonTarget.length,
        unmatchedTargets: unmatchedTargets.length,
        linkedCanonicalCases: linkedCanonicalCases.length,
        linkedCanonicalInvoices: linkedCanonicalInvoices.length,
        skippedCanonicalCaseCollisions: skippedCanonicalCaseCollisions.length,
        skippedCanonicalInvoiceCollisions: skippedCanonicalInvoiceCollisions.length,
      };
      const report = {
        ...summary,
        matchedRows: matched,
        ambiguousRows: ambiguous,
        nonTargetRows: nonTarget,
        unmatchedTargetNames: unmatchedTargets,
        linkedCanonicalCaseRows: linkedCanonicalCases,
        linkedCanonicalInvoiceRows: linkedCanonicalInvoices,
        skippedCanonicalCaseCollisionRows: skippedCanonicalCaseCollisions,
        skippedCanonicalInvoiceCollisionRows: skippedCanonicalInvoiceCollisions,
      };

      req.log?.info?.(
        { ...summary, dryRun, actor: actorName },
        "sdr1 legacy cleanup: scan complete",
      );

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, ...report });
      }

      // ── Live run ──────────────────────────────────────────────────────────
      let legacyDeleted = 0;
      let invoicesFrozen = 0;
      await db.transaction(async (tx) => {
        // Legacy rows determine the canonical match set, so all cleanup writes
        // must roll back together to keep a failed run safely retryable.
        if (matchedLegacyIds.length > 0) {
          const { deletedIds } = await softDeleteLegacyCases({
            ids: matchedLegacyIds,
            deletedBy: `cleanup:sdr1-legacy:${actorName}`,
            actorUserId,
            organizationId: orgId,
            req,
            tx,
          });
          legacyDeleted = deletedIds.length;
        }

        for (const c of linkedCanonicalCases) {
          await softDeleteById({
            table: casesTable,
            id: c.id,
            actorUserId,
            req,
            organizationId: orgId,
            entityType: "case",
            beforeJson: c,
            metadataJson: {
              caseNumber: c.caseNumber,
              patientName: c.patientName,
              cleanup: "sdr1_legacy_open_invoices",
            },
            tx,
          });
        }
        if (linkedCanonicalCases.length > 0) {
          invoicesFrozen = await freezeInvoicesForDeletedCases({
            req,
            caseIds: linkedCanonicalCases.map((c) => c.id),
            labOrganizationId: orgId,
            deletingUserId: actorUserId,
            caseNumberById: new Map(linkedCanonicalCases.map((c) => [c.id, c.caseNumber])),
            tx,
          });
        }

        // Soft-delete linked canonical invoices (part of the target set).
        for (const inv of linkedCanonicalInvoices) {
          await softDeleteById({
            table: invoices,
            id: inv.id,
            actorUserId,
            req,
            organizationId: orgId,
            entityType: "invoice",
            beforeJson: inv,
            metadataJson: {
              invoiceNumber: inv.invoiceNumber,
              patientName: inv.patientName,
              linkVia: inv.linkVia,
              cleanup: "sdr1_legacy_open_invoices",
            },
            tx,
          });
        }
      });

      const result = {
        ...summary,
        legacyDeleted,
        canonicalCasesDeleted: linkedCanonicalCases.length,
        canonicalInvoicesDeleted: linkedCanonicalInvoices.length,
        invoicesFrozen,
      };

      await writeAuditLog({
        req,
        userId: actorUserId,
        organizationId: orgId,
        action: "sdr1_legacy_cleanup_completed",
        entityType: "system",
        entityId: "sdr1-legacy-cleanup",
        metadataJson: { ...result, actor: actorName },
      });

      req.log?.info?.({ ...result, actor: actorName }, "sdr1 legacy cleanup: live run complete");

      return res.json({ ok: true, dryRun: false, ...result, ...report });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sdr1 legacy cleanup failed");
      return res.status(500).json({ error: e?.message || "Cleanup failed." });
    }
  });

  // ── Lab-scoped backup download ────────────────────────────────────────────
  // This route intentionally has no platform-admin middleware. The requested
  // organization is only a selector: every request is resolved against the
  // caller's current, active owner/admin membership before any data is read.
  router.get("/lab/backup/generate", requireAuth, async (req, res) => {
    const userId = (req as any).auth?.userId ?? (req as any).user?.id;
    if (typeof userId !== "string" || !userId) {
      return res.status(401).json({ error: "Sign in again to download a lab backup." });
    }

    const requestedLabId = typeof req.query.labOrganizationId === "string"
      ? req.query.labOrganizationId.trim()
      : "";

    try {
      const memberships = await db
        .select({
          organizationId: organizations.id,
          organizationName: organizations.name,
        })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
        .where(and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
          inArray(organizationMemberships.role, ADMIN_ROLES),
          eq(organizations.type, "lab"),
          eq(organizations.isActive, true),
          isNull(organizations.deletedAt),
        ));

      if (memberships.length === 0) {
        return res.status(403).json({
          error: "An active lab owner or admin membership is required to download a lab backup.",
        });
      }

      let selected = undefined as typeof memberships[number] | undefined;
      if (requestedLabId) {
        selected = memberships.find((membership) => membership.organizationId === requestedLabId);
        if (!selected) {
          return res.status(403).json({
            error: "You do not have active owner or admin access to the selected lab.",
          });
        }
      } else if (memberships.length === 1) {
        selected = memberships[0];
      } else {
        return res.status(400).json({
          error: "Choose one of your actively administered labs before downloading its backup.",
        });
      }

      await streamLabScopedBackupDownload({
        labId: selected.organizationId,
        labName: selected.organizationName,
        userId,
        response: res,
      });
      return;
    } catch (error: unknown) {
      const diagnostic = error instanceof Error ? error.message : "Lab backup generation failed.";
      if (!res.headersSent) {
        return res.status(500).json({
          error: backupErrorMessage(diagnostic),
          diagnostic,
        });
      }
      req.log?.error?.({ err: error }, "Lab-scoped backup stream failed");
      if (!res.writableEnded) res.destroy();
      return;
    }
  });

  // ── Admin Backup: run now ─────────────────────────────────────────────────
  router.post("/admin/backup/run", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const reqUser = (req as any).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedRunId = typeof body.runId === "string" ? body.runId : undefined;
    if (body.runId !== undefined &&
      (!requestedRunId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedRunId))) {
      return res.status(400).json({ error: "runId must be a valid backup run UUID." });
    }
    if (requestedRunId && await getBackupLiveStatus(requestedRunId)) {
      return res.status(409).json({ error: "This backup run ID has already been used." });
    }
    const destination = body.destination as BackupDestination | undefined;
    if (
      destination !== "local" &&
      destination !== "network" &&
      destination !== "onedrive" &&
      destination !== "google-drive"
    ) {
      return res.status(400).json({
        error: "destination must be one of: local, network, onedrive, google-drive.",
      });
    }
    const destPath = typeof body.path === "string" ? body.path.trim() : undefined;
    if ((destination === "local" || destination === "network") && !destPath) {
      return res.status(400).json({ error: "path is required for local and network destinations." });
    }
    try {
      const triggeredBy = `manual:${(reqUser as any)?.username || "admin"}`;
      const result = await withBackupRun(() => runBackup(triggeredBy, destination, destPath), requestedRunId);
      // A run that dropped content is not a clean success. The history list
      // already shows it amber; saying "Backup complete" here (and nowhere
      // else) is how a partial archive gets mistaken for a recovery point.
      return res.json({
        ok: true,
        size: result.size,
        completedAt: result.completedAt,
        fileName: result.fileName,
        archiveKind: result.archiveKind ?? null,
        mediaFileCount: result.mediaFileCount ?? null,
        attachmentRowCount: result.attachmentRowCount ?? null,
        partialFailure: result.partialFailure ?? false,
        warnings: result.warnings ?? null,
        warningMessage: result.partialFailure ? partialBackupMessage() : null,
        ...(requestedRunId ? { runId: requestedRunId } : {}),
      });
    } catch (e: any) {
      const diagnostic = e?.message || "Backup failed.";
      return res.status(500).json({
        error: backupErrorMessage(diagnostic),
        diagnostic,
      });
    }
  });

  // ── Admin Backup: generate (stream to client) ─────────────────────────────
    // Streams the encrypted archive back so the client
  // (Electron or browser) can save the file locally. This is the correct path
  // for "Back up now → Local folder / USB" because the user's drive is on
  // their machine, not on the Linux server.
  router.post("/admin/backup/generate", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      res.status(403).json({ error: "Admin access required." });
      return;
    }
    const reqUser = (req as any).user;
    // deferRecord=1 is the desktop-scheduler path: the download alone doesn't
    // prove the file reached the local folder, so history/staleness recording
    // is deferred to POST /admin/backup/desktop-run-report (the scheduler
    // reports success or failure after the folder write). Without the flag
    // (manual "Back up now") a successful stream is recorded immediately.
    const deferRecord = req.query.deferRecord === "1" || req.query.deferRecord === "true";
    const triggeredBy = deferRecord && req.query.source !== "manual"
      ? `scheduler:desktop:${(reqUser as any)?.username || "admin"}`
      : `manual:${(reqUser as any)?.username || "admin"}`;
    try {
      // Streams the encrypted ZIP straight to the client (chunked transfer) so
      // large labs don't hit the proxy's single-shot transfer cap that caused
      // "Failed to fetch". Pre-flight failures throw before any byte is written
      // and are reported as a JSON 500 below; once streaming begins the headers
      // are already sent, so we just log and let the aborted connection surface.
      const requestedRunId = typeof req.query.runId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.runId)
        ? req.query.runId
        : undefined;
      await streamBackupDownload(triggeredBy, res, { recordHistory: !deferRecord, runId: requestedRunId });
    } catch (e: any) {
      if (!res.headersSent) {
        const diagnostic = e?.message || "Backup failed.";
        res.status(500).json({ error: backupErrorMessage(diagnostic), diagnostic });
        return;
      }
      req.log.error({ err: e }, "Backup stream aborted after headers were sent");
      if (!res.writableEnded) res.destroy();
    }
  });

  // ── Admin Backup: overdue-status (requireAuth only, no platform-admin session) ──
  // Used by the Account tab to compute the "backup overdue" badge without
  // requiring the user to have unlocked a platform-admin session.
  router.get("/admin/backup/overdue-status", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin" || reqUser.userType !== "lab") {
      return res.status(403).json({ error: "Lab admin access required." });
    }
    try {
      // Freshness comes from the archive confirmed present off-site, not from
      // the database watermark: the watermark is advanced by runs that
      // believed they worked, and it is what read "healthy" for eighteen days
      // with nothing in OneDrive. The watermark is still reported, as the
      // second-hand figure it is.
      const [lastSuccessfulBackupAt, staleDaysRow, freshness, undeliveredAlert] =
        await Promise.all([
          getLastSuccessfulBackupAt(),
          db.select().from(systemSettings).where(eq(systemSettings.key, SETTING_BACKUP_STALE_DAYS)).limit(1),
          getOffsiteFreshness(),
          getUndeliveredBackupAlert(),
        ]);
      const staleDaysRaw = staleDaysRow[0]?.value ?? null;
      const staleAfterDays =
        staleDaysRaw !== null ? parseInt(staleDaysRaw, 10) : DEFAULT_BACKUP_STALE_DAYS;
      return res.json({
        ok: true,
        lastSuccessfulBackupAt,
        staleAfterDays: Number.isFinite(staleAfterDays) ? staleAfterDays : DEFAULT_BACKUP_STALE_DAYS,
        offsite: {
          enabled: freshness.enabled,
          stale: freshness.enabled && freshness.stale,
          ageMinutes: freshness.ageMinutes,
          windowMinutes: freshness.windowMinutes,
          intervalMinutes: freshness.intervalMinutes,
          source: freshness.source,
          reason: freshness.reason,
          destinationUnreadable: freshness.destinationUnreadable,
          newestArchive: freshness.newestArchive,
        },
        undeliveredAlert,
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to fetch backup overdue status.";
      return res.status(500).json({
        error: backupErrorMessage(diagnostic, "status"),
        diagnostic,
      });
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
      const [config, lastSuccessfulBackupAt, staleAlertSettings, staleDaysRow, scheduleState, fullArchiveIntervalMinutes, offsite, freshness, alertLog] =
        await Promise.all([
          getBackupScheduleConfig(),
          getLastSuccessfulBackupAt(),
          getBackupStaleAlertSettings(),
          db.select().from(systemSettings).where(eq(systemSettings.key, SETTING_BACKUP_STALE_DAYS)).limit(1),
          getBackupScheduleState(),
          Promise.resolve(15),
          getOffsiteProtectionStatus(),
          getOffsiteFreshness(),
          getBackupAlertDeliveryLog(),
        ]);
      const { interval, unit } = fromIntervalMinutes(config.intervalMinutes);
      const staleDaysRaw = staleDaysRow[0]?.value ?? null;
      const staleAfterDays = staleDaysRaw !== null ? parseInt(staleDaysRaw, 10) : DEFAULT_BACKUP_STALE_DAYS;

      // Report the newest archive that is actually present at the destination,
      // not just the newest run we believe succeeded. A run row says we tried;
      // only the destination listing says a recovery point exists.
      // Off-site protection runs its own timer on the deployed server, at its
      // own cadence, whatever the editable schedule row says. Reporting that
      // row as "the server's cadence" would claim hourly (or paused) while
      // archives are really appearing every fifteen minutes, so the cadence
      // reported here is the one belonging to the job that is running.
      const offsiteActive = offsite.enabled && offsite.running;
      const effectiveIntervalMinutes = offsiteActive
        ? offsite.intervalMinutes
        : config.enabled
          ? config.intervalMinutes
          : null;
      const effectiveDestination = offsiteActive
        ? "onedrive"
        : config.enabled
          ? config.destination
          : null;

      // Read back from the destination's own listing (the same evidence the
      // out-of-process freshness check uses), so this card and the watchdog
      // can never disagree about whether a recovery point exists.
      const newestArchive = freshness.newestArchive;
      const newestArchiveError = freshness.listingError;
      const archiveCount = freshness.archiveCount;

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
        // What the server is actually running, read back from its own state.
        effectiveIntervalMinutes,
        effectiveDestination,
        scheduleIntervalMinutes: config.intervalMinutes,
        offsite: {
          enabled: offsite.enabled,
          running: offsite.running,
          intervalMinutes: offsite.intervalMinutes,
          lastVerifiedAt: offsite.lastVerifiedAt,
          // Judged from the confirmed archive, not the database watermark.
          stale: offsite.enabled && freshness.stale,
          ageMinutes: freshness.ageMinutes,
          windowMinutes: freshness.windowMinutes,
          source: freshness.source,
          reason: freshness.reason,
          destinationUnreadable: freshness.destinationUnreadable,
        },
        // Every alert attempt and its outcome, so an alert nobody could
        // receive is visible here instead of only in the server log.
        alertDelivery: {
          undelivered: findUndeliveredBackupAlert(alertLog),
          recent: alertLog.slice(0, 5),
        },
        fullArchiveIntervalMinutes,
        nextDueAt: scheduleState.nextDueAt?.toISOString() ?? null,
        lastAttemptAt: scheduleState.lastAttemptAt?.toISOString() ?? null,
        newestArchive,
        newestArchiveError,
        newestArchiveErrorMessage: newestArchiveError ? backupStatusErrorMessage() : null,
        newestArchiveErrorDiagnostic: newestArchiveError,
        archiveCount,
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to fetch backup schedule.";
      return res.status(500).json({
        error: backupErrorMessage(diagnostic, "status"),
        diagnostic,
      });
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
    // The current desktop/browser menu offers 5, 10, 15 minutes and 1 hour.
    // Keep older saved intervals writable so an unrelated edit can preserve a
    // legacy schedule until the admin explicitly selects a new cadence.
    const VALID_INTERVALS = [5, 10, 15, 30, 60, 120, 240, 480, 1440];
    if (!VALID_INTERVALS.includes(intervalMinutes)) {
      return res.status(400).json({
        error: `Computed intervalMinutes (${intervalMinutes}) is not a supported value. Valid combinations: 5, 10, 15, 30 min, 1 h, 2 h, 4 h, 8 h, 24 h.`,
      });
    }
    if (
      destination !== "local" &&
      destination !== "network" &&
      destination !== "onedrive" &&
      destination !== "google-drive"
    ) {
      return res.status(400).json({
        error: "destination must be one of: local, network, onedrive, google-drive.",
      });
    }
    if ((destination === "local" || destination === "network") && !destPath) {
      return res.status(400).json({ error: "path is required for local and network destinations." });
    }
    // Local-folder schedules are allowed: they are executed by the LabTrax
    // Desktop app while it is open (the server silently skips them). OneDrive
    // and Google Drive schedules run fully server-side. UNC/SMB network paths remain blocked —
    // they exist on the admin's Windows machine, not the server, so a scheduled
    // (server-side) write would silently produce a file that never reaches the
    // user. Only SFTP network destinations are server-reachable.
    if (destination === "network" && destPath && !destPath.startsWith("sftp://")) {
      return res.status(400).json({
        error:
          "Scheduled network backups can only use SFTP destinations. " +
          "UNC/SMB network paths exist on your Windows machine, not on the server " +
          "where scheduled backups run (Linux). The file would never reach you. " +
          "Use an SFTP URL (sftp://user@host/path), OneDrive, Google Drive, or a local folder " +
          "(written by the LabTrax Desktop app while it is open).",
      });
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
      // Drop the persisted due time: it was computed from the previous
      // cadence, and honouring it would delay the new interval by up to a
      // full old interval. restartScheduledBackupJob re-anchors from now.
      await upsert(SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT, null);
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
      const diagnostic = e instanceof Error ? e.message : "Failed to save backup schedule.";
      req.log?.error({ err: diagnostic }, "[backup] Could not save backup schedule");
      return res.status(500).json({
        error: backupSettingsErrorMessage("save"),
        diagnostic,
      });
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
      const diagnostic = e instanceof Error ? e.message : "Failed to disable backup schedule.";
      req.log?.error({ err: diagnostic }, "[backup] Could not disable backup schedule");
      return res.status(500).json({
        error: backupSettingsErrorMessage("disable"),
        diagnostic,
      });
    }
  });

  // ── Admin Backup: schedule run-now ───────────────────────────────────────
  // Immediately fires one backup using the saved scheduled destination so
  // admins can verify their SFTP or OneDrive config without waiting for the
  // interval. Local-folder schedules run from the desktop app and return a
  // clear error here.
  router.post("/admin/backup/schedule/run-now", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const result = await runScheduledBackupNow();
      return res.json({
        ok: true,
        size: result.size,
        completedAt: result.completedAt,
        fileName: result.fileName,
        destination: result.destination,
        path: result.path,
        // Carried through so a run that dropped content reads as partial here
        // too, not only in the history list.
        partialFailure: result.partialFailure ?? false,
        warnings: result.warnings ?? null,
        warningMessage: result.partialFailure ? partialBackupMessage() : null,
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Backup failed.";
      return res.status(500).json({
        error: backupErrorMessage(diagnostic),
        diagnostic,
      });
    }
  });

  // ── Admin Backup: OneDrive connection status ─────────────────────────────
  router.get("/admin/backup/onedrive-status", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const status = await getOneDriveStatus();
      return res.json({
        ok: true,
        ...status,
        userMessage: status.connected
          ? null
          : "OneDrive is not connected. Connect the Microsoft integration or reconnect the account, then check again.",
        diagnostic: status.connected ? null : status.error,
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to check OneDrive status.";
      req.log?.error({ err: diagnostic }, "[backup] Could not check OneDrive connection");
      return res.status(500).json({
        error: backupErrorMessage(diagnostic, "status"),
        diagnostic,
      });
    }
  });

  // ── Admin Backup: Google Drive connection status ──────────────────────────
  router.get("/admin/backup/google-drive-status", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const status = await getGoogleDriveStatus();
      return res.json({ ok: true, ...status });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to check Google Drive status.";
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin Backup: desktop-executed run report ─────────────────────────────
  // The LabTrax Desktop app executes local-folder schedules (it downloads the
  // backup and writes it to the chosen folder while the app is open), then
  // reports the outcome here so the run lands in backup_runs and a success
  // feeds the staleness watermark/alerts.
  router.post("/admin/backup/desktop-run-report", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const reqUser = (req as any).user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (status !== "success" && status !== "error") {
      return res.status(400).json({ error: "status must be 'success' or 'error'." });
    }
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() || null : null;
    const destPath = typeof body.path === "string" ? body.path.trim() || null : null;
    const sizeBytesRaw = body.sizeBytes;
    const sizeBytes =
      typeof sizeBytesRaw === "number" && Number.isFinite(sizeBytesRaw) && sizeBytesRaw >= 0
        ? Math.floor(sizeBytesRaw)
        : null;
    const errorText = typeof body.error === "string" ? body.error.trim().slice(0, 2000) || null : null;
    const downloadRunId = typeof body.downloadRunId === "string" ? body.downloadRunId : undefined;
    if (body.downloadRunId !== undefined && (!downloadRunId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(downloadRunId))) {
      return res.status(400).json({ error: "downloadRunId must be the UUID returned by backup generation." });
    }
    if (status === "success" && !fileName) {
      return res.status(400).json({ error: "fileName is required for a successful run report." });
    }
    try {
      const triggeredBy = body.source === "manual"
        ? `manual:desktop:${(reqUser as any)?.username || "admin"}`
        : `scheduler:desktop:${(reqUser as any)?.username || "admin"}`;
      const result = await recordDesktopReportedBackupRun({
        triggeredBy,
        status,
        fileName,
        path: destPath,
        sizeBytes,
        error: errorText,
        downloadRunId,
        archiveEvidence: downloadRunId
          ? (await getBackupLiveStatus(downloadRunId))?.archiveEvidence
          : undefined,
      });
      await finishBackupLiveRun(downloadRunId, status === "success" && !result.rejected ? "completed" : "failed");

      // When the desktop scheduler reports a failure — or claims a success the
      // server can tell is not a real backup (a placeholder-sized file) —
      // create an in-app notification for the requesting admin so they are
      // alerted without having to open Settings → Backup.
      if ((status === "error" || result.rejected) && reqUser?.id) {
        const pathNote = destPath ? ` (${destPath})` : "";
      const failureDetail = result.rejectionReason ?? result.errorReason ?? errorText;
      const bodyText = `${backupErrorMessage(failureDetail)}${pathNote}`;
        try {
          await db.insert(notifications).values({
            userId: reqUser.id as string,
            type: "backup_local_error",
            title: result.rejected
              ? "Local folder backup produced an unusable file"
              : "Local folder backup failed",
            body: bodyText,
            dataJson: {
              path: destPath,
              error: failureDetail,
              sizeBytes,
            },
          });
        } catch {
          // Best-effort — do not fail the response if notification insert fails.
        }
      }

      return res.json({
        ok: true,
        completedAt: result.completedAt,
        ...(result.rejected ? {
          rejected: true,
          warning: backupErrorMessage(result.rejectionReason),
          diagnostic: result.rejectionReason,
        } : {}),
        ...(result.errorReason ? {
          errorReason: backupErrorMessage(result.errorReason),
          diagnostic: result.errorReason,
        } : {}),
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to record backup run.";
      return res.status(500).json({
        error: backupSettingsErrorMessage("save"),
        diagnostic,
      });
    }
  });

  // Live phase/progress is deliberately transient and keyed by the opaque run
  // UUID returned in X-Backup-Run-Id. It contains no archive names or paths.
  router.get("/admin/backup/status/:runId", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const runId = String(req.params.runId ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      return res.status(400).json({ error: "A valid backup run ID is required." });
    }
    const status = await getBackupLiveStatus(runId);
    if (!status) return res.status(404).json({ error: "Backup progress is no longer available." });
    return res.json(status);
  });

  // ── Admin Backup: history ─────────────────────────────────────────────────
  router.get("/admin/backup/history", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    try {
      const rows = await db
        .select()
        .from(backupRuns)
        .orderBy(sql`${backupRuns.completedAt} DESC`)
        .limit(20);
      return res.json({
        ok: true,
        runs: rows.map((run) => ({
          ...run,
          userMessage: run.status === "error" && run.error
            ? backupErrorMessage(run.error)
            : null,
        })),
      });
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to fetch backup history.";
      req.log?.error({ err: diagnostic }, "[backup] Could not load backup history");
      return res.status(500).json({
        error: backupSettingsErrorMessage("history"),
        diagnostic,
      });
    }
  });

  // ── Admin Backup: download a history run from OneDrive ───────────────────
  // GET /admin/backup/history/:id/download
  // Protected by the same lab-admin gate as the history list.  Looks up the
  // run by id, then proxies the OneDrive file back as application/octet-stream
  // so the desktop client can feed it directly into the restore pipeline.
  // Returns 400 for non-OneDrive (or SFTP) runs; 404 if the id is unknown.
  router.get("/admin/backup/history/:id/download", platformAdminUserOrSecret, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const id = parseInt((req.params as any).id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid backup run ID." });
    }
    try {
      const rows = await db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.id, id))
        .limit(1);
      if (rows.length === 0) {
        return res.status(404).json({ error: "Backup run not found." });
      }
      const run = rows[0];
      if (run.destination === "sftp") {
        return res.status(400).json({
          error: "SFTP backups must be downloaded manually and restored via the file picker.",
        });
      }
      if (run.destination !== "onedrive") {
        return res.status(400).json({
          error: "Only OneDrive backup runs can be downloaded via this endpoint.",
        });
      }
      if (!run.fileName && !run.remoteItemId) {
        return res.status(400).json({
          error: "This backup run has no file name recorded — it cannot be downloaded.",
        });
      }
      // Prefer the Graph item id confirmed for the run: OneDrive renames on
      // conflict, so the name is not guaranteed to address the file this run
      // actually produced. Rows written before the id was recorded fall back
      // to the recorded name.
      // The guard above refuses a row with neither, so an empty name here is
      // only ever paired with an id and never reaches a name-based lookup.
      const buffer = await downloadFileFromOneDrive(
        run.fileName ?? "",
        undefined,
        run.remoteItemId ?? oneDriveItemIdFromPath(run.path),
      );
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${(run.fileName ?? "labtrax-backup.zip.enc").replace(/"/g, "")}"`,
      );
      res.setHeader("Content-Length", String(buffer.length));
      return res.send(buffer);
    } catch (e: unknown) {
      const diagnostic = e instanceof Error ? e.message : "Failed to download backup from OneDrive.";
      return res.status(500).json({
        error: backupDownloadErrorMessage(),
        diagnostic,
      });
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
      const diagnostic = e instanceof Error ? e.message : "Failed to fetch backup history retention settings.";
      req.log?.error({ err: diagnostic }, "[backup] Could not load history retention settings");
      return res.status(500).json({
        error: backupSettingsErrorMessage("load"),
        diagnostic,
      });
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

    const normalizedRxName = normalizeRxPracticeName(rxName);
    let row: Array<{ providerOrganizationId: string }>;
    try {
      row = await db
        .select({ providerOrganizationId: rxPracticeNameAliases.providerOrganizationId })
        .from(rxPracticeNameAliases)
        .where(
          and(
            eq(rxPracticeNameAliases.labOrganizationId, labOrganizationId.trim()),
            eq(rxPracticeNameAliases.rxName, normalizedRxName)
          )
        )
        .limit(1);
    } catch (err) {
      // A missing table must be a LOUD failure, not a silent "no alias found" —
      // otherwise the intake quietly re-prompts forever on a deployment where
      // the migration never landed.
      req.log.error({ err }, "rx-practice-aliases: lookup failed");
      return res.status(500).json({
        error:
          "Failed to look up alias. Ensure the rx_practice_name_aliases table exists (run: pnpm --filter @workspace/db run push).",
      });
    }

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

    const normalizedRxName = normalizeRxPracticeName(rxName);
    try {
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
    } catch (err) {
      req.log.error({ err }, "rx-practice-aliases: failed to upsert alias");
      return res.status(500).json({
        error: "Failed to save alias. Ensure the rx_practice_name_aliases table exists (run: pnpm --filter @workspace/db run push).",
      });
    }

    return res.json({ ok: true, data: { found: true, providerOrganizationId: providerOrganizationId.trim() } });
  });

  // ── Rx Doctor → Practice Memory ──────────────────────────────────────────
  // The DOCTOR-keyed counterpart to the Rx-practice-name aliases above. A
  // doctor's practice is stable, while the practice text on a prescription is
  // not (missing, abbreviated, OCR'd differently), so once a user confirms
  // "this doctor works at this practice" the intake can auto-select the
  // practice with no further prompting — even for an Rx with no readable
  // practice name at all. This memory takes priority over the Rx-name alias.
  //
  // Route conventions deliberately mirror /rx-practice-aliases: active
  // lab-membership check, shared normalization, idempotent upsert, and a loud
  // 500 (never a silent no-op) when the backing table is missing.

  /** Shared active-lab-membership check for the Rx-memory routes. */
  async function callerIsActiveLabMember(userId: string, labId: string) {
    const membership = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.labId, labId),
          eq(organizationMemberships.status, "active"),
          eq(organizations.type, "lab")
        )
      )
      .limit(1);
    return membership.length > 0;
  }

  async function callerIsActiveLabAdmin(userId: string, labId: string) {
    const membership = await db
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.labId, labId),
          eq(organizationMemberships.status, "active"),
          eq(organizations.type, "lab")
        )
      )
      .limit(1);
    return (
      membership.length > 0 &&
      ADMIN_ROLES.includes(membership[0].role as (typeof ADMIN_ROLES)[number])
    );
  }

  const DOCTOR_MEMORY_TABLE_HINT =
    "Ensure the rx_doctor_practice_memory table exists (run: pnpm --filter @workspace/db run push).";

  /**
   * Is `providerOrganizationId` a practice this lab actually owns?
   *
   * Lab membership alone is NOT enough to authorize the write: the id lands in
   * a row the lab reads back and auto-selects later, so accepting an arbitrary
   * organization id would let a member point their own lab's memory at another
   * tenant's provider organization. Mirrors how practices are scoped
   * everywhere else — type "provider", owned by this lab, active, not deleted.
   */
  async function providerOrgBelongsToLab(
    providerOrganizationId: string,
    labOrganizationId: string
  ): Promise<boolean> {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, providerOrganizationId),
          eq(organizations.type, "provider"),
          eq(organizations.parentLabOrganizationId, labOrganizationId),
          eq(organizations.isActive, true),
          notDeleted(organizations)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  // GET /rx-doctor-practice-memory?labOrganizationId=&doctorName=
  // Without doctorName this returns the admin-only list used to manage the
  // remembered mappings. Keeping the lookup and list on one resource preserves
  // the existing intake contract while giving the settings screen a
  // lab-scoped management view.
  router.get("/rx-doctor-practice-memory", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { labOrganizationId, doctorName } = req.query as Record<string, unknown>;
    if (typeof labOrganizationId !== "string" || !labOrganizationId.trim()) {
      return res.status(400).json({ error: "labOrganizationId is required" });
    }
    if (doctorName === undefined) {
      if (!(await callerIsActiveLabAdmin(reqUser.id, labOrganizationId.trim()))) {
        res.status(403).json({ error: "Lab admin access required" });
        return;
      }

      try {
        const mappings = await db
          .select({
            id: rxDoctorPracticeMemory.id,
            doctorName: rxDoctorPracticeMemory.doctorName,
            providerOrganizationId:
              rxDoctorPracticeMemory.providerOrganizationId,
            practiceName: sql<string>`
              case
                when ${organizations.type} = 'provider'
                  and ${organizations.parentLabOrganizationId} = ${labOrganizationId.trim()}
                  and ${organizations.isActive} = true
                  and ${organizations.deletedAt} is null
                then coalesce(${organizations.displayName}, ${organizations.name})
                else 'Unavailable practice'
              end
            `,
            practiceAvailable: sql<boolean>`
              ${organizations.type} = 'provider'
              and ${organizations.parentLabOrganizationId} = ${labOrganizationId.trim()}
              and ${organizations.isActive} = true
              and ${organizations.deletedAt} is null
            `,
            updatedAt: rxDoctorPracticeMemory.updatedAt,
          })
          .from(rxDoctorPracticeMemory)
          .leftJoin(
            organizations,
            eq(organizations.id, rxDoctorPracticeMemory.providerOrganizationId)
          )
          .where(eq(rxDoctorPracticeMemory.labOrganizationId, labOrganizationId.trim()))
          .orderBy(
            desc(rxDoctorPracticeMemory.updatedAt),
            rxDoctorPracticeMemory.doctorName
          );
        res.json({ ok: true, data: { mappings } });
        return;
      } catch (err) {
        req.log.error({ err }, "rx-doctor-practice-memory: list failed");
        res.status(500).json({
          error: `Failed to list remembered doctor practices. ${DOCTOR_MEMORY_TABLE_HINT}`,
        });
        return;
      }
    }

    if (typeof doctorName !== "string" || !doctorName.trim()) {
      return res.status(400).json({ error: "doctorName is required" });
    }

    if (!(await callerIsActiveLabMember(reqUser.id, labOrganizationId.trim()))) {
      return res.status(403).json({ error: "Not a member of this lab" });
    }

    const normalizedDoctorName = normalizeRxDoctorName(doctorName);
    if (!normalizedDoctorName) {
      // Nothing meaningful left after stripping the title/punctuation.
      return res.json({ ok: true, data: { found: false, providerOrganizationId: null } });
    }

    let row: Array<{ providerOrganizationId: string }>;
    try {
      row = await db
        .select({
          providerOrganizationId: rxDoctorPracticeMemory.providerOrganizationId,
        })
        .from(rxDoctorPracticeMemory)
        .innerJoin(
          organizations,
          and(
            eq(
              organizations.id,
              rxDoctorPracticeMemory.providerOrganizationId
            ),
            eq(organizations.type, "provider"),
            eq(
              organizations.parentLabOrganizationId,
              labOrganizationId.trim()
            ),
            eq(organizations.isActive, true),
            notDeleted(organizations)
          )
        )
        .where(
          and(
            eq(rxDoctorPracticeMemory.labOrganizationId, labOrganizationId.trim()),
            eq(rxDoctorPracticeMemory.doctorName, normalizedDoctorName)
          )
        )
        .limit(1);
    } catch (err) {
      req.log.error({ err }, "rx-doctor-practice-memory: lookup failed");
      return res.status(500).json({
        error: `Failed to look up the remembered practice for this doctor. ${DOCTOR_MEMORY_TABLE_HINT}`,
      });
    }

    if (row.length === 0) {
      return res.json({ ok: true, data: { found: false, providerOrganizationId: null } });
    }
    return res.json({
      ok: true,
      data: { found: true, providerOrganizationId: row[0].providerOrganizationId },
    });
  });

  // DELETE /rx-doctor-practice-memory/:id — remove one remembered mapping.
  // The row's own lab is used for authorization, so a caller cannot delete a
  // mapping from another lab by supplying a lab id of their choosing.
  router.delete("/rx-doctor-practice-memory/:id", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const mappingId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    if (!mappingId?.trim()) {
      res.status(400).json({ error: "Mapping id is required" });
      return;
    }

    let mapping: { labOrganizationId: string } | undefined;
    try {
      const rows = await db
        .select({ labOrganizationId: rxDoctorPracticeMemory.labOrganizationId })
        .from(rxDoctorPracticeMemory)
        .where(eq(rxDoctorPracticeMemory.id, mappingId.trim()))
        .limit(1);
      mapping = rows[0];
    } catch (err) {
      req.log.error({ err }, "rx-doctor-practice-memory: delete lookup failed");
      res.status(500).json({
        error: `Failed to remove remembered doctor practice. ${DOCTOR_MEMORY_TABLE_HINT}`,
      });
      return;
    }

    if (!mapping) {
      res.status(404).json({ error: "Remembered doctor practice not found" });
      return;
    }
    if (
      !(await callerIsActiveLabAdmin(
        reqUser.id,
        mapping.labOrganizationId
      ))
    ) {
      res.status(403).json({ error: "Lab admin access required" });
      return;
    }

    try {
      await db
        .delete(rxDoctorPracticeMemory)
        .where(
          and(
            eq(rxDoctorPracticeMemory.id, mappingId.trim()),
            eq(
              rxDoctorPracticeMemory.labOrganizationId,
              mapping.labOrganizationId
            )
          )
        );
      res.json({ ok: true, data: { deleted: true } });
    } catch (err) {
      req.log.error({ err }, "rx-doctor-practice-memory: delete failed");
      res.status(500).json({
        error: `Failed to remove remembered doctor practice. ${DOCTOR_MEMORY_TABLE_HINT}`,
      });
    }
  });

  // POST /rx-doctor-practice-memory — upsert a doctor → practice mapping
  router.post("/rx-doctor-practice-memory", requireAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { labOrganizationId, doctorName, providerOrganizationId } = body;
    if (typeof labOrganizationId !== "string" || !labOrganizationId.trim()) {
      return res.status(400).json({ error: "labOrganizationId is required" });
    }
    if (typeof doctorName !== "string" || !doctorName.trim()) {
      return res.status(400).json({ error: "doctorName is required" });
    }
    if (typeof providerOrganizationId !== "string" || !providerOrganizationId.trim()) {
      return res.status(400).json({ error: "providerOrganizationId is required" });
    }

    if (!(await callerIsActiveLabMember(reqUser.id, labOrganizationId.trim()))) {
      return res.status(403).json({ error: "Not a member of this lab" });
    }

    const normalizedDoctorName = normalizeRxDoctorName(doctorName);
    if (!normalizedDoctorName) {
      return res
        .status(400)
        .json({ error: "doctorName must contain a usable name" });
    }

    if (
      !(await providerOrgBelongsToLab(
        providerOrganizationId.trim(),
        labOrganizationId.trim()
      ))
    ) {
      return res
        .status(403)
        .json({ error: "That practice does not belong to this lab" });
    }

    try {
      await db
        .insert(rxDoctorPracticeMemory)
        .values({
          labOrganizationId: labOrganizationId.trim(),
          doctorName: normalizedDoctorName,
          providerOrganizationId: providerOrganizationId.trim(),
          createdByUserId: reqUser.id,
        })
        .onConflictDoUpdate({
          target: [
            rxDoctorPracticeMemory.labOrganizationId,
            rxDoctorPracticeMemory.doctorName,
          ],
          set: {
            providerOrganizationId: providerOrganizationId.trim(),
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      req.log.error({ err }, "rx-doctor-practice-memory: failed to upsert mapping");
      return res.status(500).json({
        error: `Failed to remember this doctor's practice. ${DOCTOR_MEMORY_TABLE_HINT}`,
      });
    }

    return res.json({
      ok: true,
      data: {
        found: true,
        providerOrganizationId: providerOrganizationId.trim(),
      },
    });
  });

  // ── Admin Backup: restore — status poll ──────────────────────────────────
  router.get("/admin/backup/restore/status", platformAdminUserOrSecret, (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const state = getRestoreState();
    return res.json({
      ok: true,
      ...state,
      ...(state.phase === "error" && state.message ? {
        message: backupErrorMessage(state.message, "restore"),
        diagnosticMessage: state.message,
      } : {}),
    });
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
      // Synchronous pre-flight: decrypt + manifest parse before 202.
      // Returns 409 immediately if the backup is incompatible (schema version
      // mismatch, wrong app name, or missing required archive entries).
      let encryptedBuffer: Buffer;
      try {
        encryptedBuffer = fs.readFileSync(uploadedFile.path);
        try { fs.unlinkSync(uploadedFile.path); } catch { /* ignore */ }
      } catch (readErr: unknown) {
        const diagnostic = readErr instanceof Error ? readErr.message : "Failed to read uploaded file.";
        return res.status(500).json({
          error: backupErrorMessage(diagnostic, "restore"),
          diagnostic,
        });
      }
      try {
        parseAndValidateBackupManifest(encryptedBuffer);
      } catch (manifestErr: unknown) {
        const diagnostic = manifestErr instanceof Error ? manifestErr.message : String(manifestErr);
        return res.status(409).json({
          error: backupErrorMessage(diagnostic, "restore"),
          diagnostic,
        });
      }
      // Respond with 202, restore runs async.
      res.status(202).json({ ok: true, phase: "decrypting", message: "Restore started." });
      // Run the restore pipeline in background.
      (async () => {
        try {
          await executeRestore(encryptedBuffer, triggeredBy);
        } catch (err: unknown) {
          req.log?.error(
            { err: err instanceof Error ? err.message : String(err) },
            "[restore] Restore pipeline failed",
          );
        }
      })().catch(() => { /* handled above */ });
    },
  );

  // ── Admin Backup: restore — resumable upload session ─────────────────────
  // Mirrors the /media/upload-session pattern but uses platform-admin auth
  // and on finalize triggers executeRestore() in background (same as the
  // single-shot route above). Solves the proxy ~20 MB hard limit for large
  // backups: each chunk stays at/under MAX_RESUMABLE_CHUNK_BYTES.

  const restoreSessionsDir = path.join(os.tmpdir(), "labtrax-restore-sessions");

  interface RestoreSessionMeta {
    sessionId: string;
    fileSize: number;
    fileName: string;
    createdAt: number;
  }

  function restoreSessionPaths(id: string) {
    return {
      metaPath: path.resolve(restoreSessionsDir, `${id}.json`),
      partPath: path.resolve(restoreSessionsDir, `${id}.part`),
    };
  }

  function readRestoreSessionMeta(id: string): RestoreSessionMeta | null {
    if (!isSafeSessionId(id)) return null;
    try {
      const { metaPath } = restoreSessionPaths(id);
      const raw = fs.readFileSync(metaPath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.fileSize === "number" &&
        typeof parsed.fileName === "string"
      ) {
        return parsed as RestoreSessionMeta;
      }
      return null;
    } catch {
      return null;
    }
  }

  function getRestoreSessionOffset(id: string): number {
    try {
      const { partPath } = restoreSessionPaths(id);
      return fs.statSync(partPath).size;
    } catch {
      return 0;
    }
  }

  function destroyRestoreSession(id: string): void {
    const { metaPath, partPath } = restoreSessionPaths(id);
    try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
    try { fs.unlinkSync(partPath); } catch { /* ignore */ }
  }

  router.post("/admin/backup/restore-session", platformAdminUserOrSecret, (req: any, res: any) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    // Reject concurrent restores before accepting any bytes.
    const currentState = getRestoreState();
    if (currentState.phase !== "idle" && currentState.phase !== "done" && currentState.phase !== "error") {
      return res.status(409).json({ error: "A restore is already in progress.", phase: currentState.phase });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : NaN;
    if (!fileName) {
      return res.status(400).json({ error: "fileName is required" });
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: "fileSize must be a positive number" });
    }
    if (fileSize > 2 * 1024 * 1024 * 1024) {
      return res.status(413).json({ error: "File exceeds maximum restore size (2 GB)" });
    }
    const sessionId = randomBytes(16).toString("hex");
    const meta: RestoreSessionMeta = { sessionId, fileSize, fileName, createdAt: Date.now() };
    try {
      fs.mkdirSync(restoreSessionsDir, { recursive: true });
      const { metaPath, partPath } = restoreSessionPaths(sessionId);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      fs.writeFileSync(partPath, "");
    } catch (error: any) {
      req.log?.error({ err: error?.message }, "[restore-session] Failed to create session");
      return res.status(500).json({ error: "Could not create restore session" });
    }
    return res.status(201).json({ sessionId, uploadedBytes: 0, fileSize });
  });

  router.get("/admin/backup/restore-session/:id", platformAdminUserOrSecret, (req: any, res: any) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const sessionId = req.params.id as string;
    const meta = readRestoreSessionMeta(sessionId);
    if (!meta) {
      return res.status(404).json({ error: "Restore session not found" });
    }
    return res.json({
      sessionId: meta.sessionId,
      uploadedBytes: getRestoreSessionOffset(sessionId),
      fileSize: meta.fileSize,
      fileName: meta.fileName,
    });
  });

  router.patch("/admin/backup/restore-session/:id", platformAdminUserOrSecret, (req: any, res: any) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const sessionId = req.params.id as string;
    const meta = readRestoreSessionMeta(sessionId);
    if (!meta) {
      return res.status(404).json({ error: "Restore session not found" });
    }
    const offsetHeader = req.header("upload-offset");
    const offset = Number(offsetHeader);
    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: "Upload-Offset header is required" });
    }
    const currentOffset = getRestoreSessionOffset(sessionId);
    if (offset !== currentOffset) {
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

    const { partPath } = restoreSessionPaths(sessionId);
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
      req.log?.error({ err: err?.message }, "[restore-session] Chunk write error");
      res.status(500).json({
        error: "LabTrax could not save part of the uploaded backup. Check your connection and choose the file again.",
        diagnostic: err?.message ?? "Failed to persist restore upload chunk.",
        uploadedBytes: getRestoreSessionOffset(sessionId),
      });
    };

    writeStream.on("error", handleError);
    req.on("error", handleError);

    writeStream.on("finish", () => {
      void (async () => {
        if (aborted) {
          if (!res.headersSent) {
            res.status(400).json({
              error: "The uploaded file did not match its expected size. Choose the backup file again and restart the restore.",
              diagnostic: "Received data exceeded the declared restore file size.",
              uploadedBytes: getRestoreSessionOffset(sessionId),
            });
          }
          return;
        }
        const newOffset = getRestoreSessionOffset(sessionId);
        if (newOffset >= meta.fileSize) {
          // All bytes received — re-check concurrent restore guard.
          const state = getRestoreState();
          if (state.phase !== "idle" && state.phase !== "done" && state.phase !== "error") {
            destroyRestoreSession(sessionId);
            if (!res.headersSent) {
              res.status(409).json({ error: "A restore is already in progress.", phase: state.phase });
            }
            return;
          }
          let encryptedBuffer: Buffer;
          try {
            encryptedBuffer = fs.readFileSync(partPath);
          } catch (err: unknown) {
            const diagnostic = err instanceof Error ? err.message : "Failed to read assembled backup file.";
            req.log?.error({ err: diagnostic }, "[restore-session] Failed to read assembled file");
            destroyRestoreSession(sessionId);
            if (!res.headersSent) {
              res.status(500).json({
                error: backupErrorMessage(diagnostic, "restore"),
                diagnostic,
              });
            }
            return;
          }
          destroyRestoreSession(sessionId);
          const reqUser = req.user;
          const triggeredBy = `restore:${reqUser?.username || "admin"}`;
          // Synchronous pre-flight: returns 409 if the backup is incompatible
          // (schema version mismatch, wrong app name, missing archive entries).
          try {
            parseAndValidateBackupManifest(encryptedBuffer);
          } catch (manifestErr: unknown) {
            const diagnostic = manifestErr instanceof Error ? manifestErr.message : String(manifestErr);
            if (!res.headersSent) {
              res.status(409).json({
                error: backupErrorMessage(diagnostic, "restore"),
                diagnostic,
              });
            }
            return;
          }
          if (!res.headersSent) {
            res.status(202).json({ ok: true, phase: "decrypting", message: "Restore started.", complete: true });
          }
          (async () => {
            try {
              await executeRestore(encryptedBuffer, triggeredBy);
            } catch (err: unknown) {
              req.log?.error(
                { err: err instanceof Error ? err.message : String(err) },
                "[restore-session] Restore pipeline failed",
              );
            }
          })().catch(() => { /* handled above */ });
        } else {
          if (!res.headersSent) {
            res.json({
              ok: true,
              uploadedBytes: newOffset,
              fileSize: meta.fileSize,
              complete: false,
            });
          }
        }
      })();
    });

    req.pipe(writeStream);
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
      const diagnostic = e instanceof Error ? e.message : "Failed to save backup history retention settings.";
      req.log?.error({ err: diagnostic }, "[backup] Could not save history retention settings");
      return res.status(500).json({
        error: backupSettingsErrorMessage("save"),
        diagnostic,
      });
    }
  });

  // ── Admin: Desktop Windows Build Trigger ──────────────────────────────────
  // Dispatches the "Build Windows Installer (Test)" GitHub Actions workflow
  // with the server's public URL pre-filled as api_base_url. Uses the same
  // GITHUB_ACTIONS_TOKEN + GITHUB_REPO_URL env vars as the mobile build trigger.

  router.post("/admin/desktop-build/trigger", requireAuth, async (req, res) => {
    if (!isPlatformAdmin(req)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const token = process.env.GITHUB_ACTIONS_TOKEN;
    if (!token) {
      return res.status(503).json({
        error: "GITHUB_ACTIONS_TOKEN is not configured. Set it as an environment secret to enable build triggering.",
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

    // Auto-detect the public API base URL: prefer PUBLISH_API_BASE_URL (already
    // configured for the publish CI step), then REPLIT_DOMAINS (first entry),
    // then fall back to empty string — the caller may also pass it in the body.
    const replitDomains = process.env.REPLIT_DOMAINS ?? "";
    const firstDomain = replitDomains.split(",")[0]?.trim() ?? "";
    const autoApiBaseUrl =
      process.env.PUBLISH_API_BASE_URL ??
      (firstDomain ? `https://${firstDomain}` : "");
    const { apiBaseUrl: bodyApiBaseUrl } = req.body as { apiBaseUrl?: unknown };
    const apiBaseUrl =
      (typeof bodyApiBaseUrl === "string" && bodyApiBaseUrl.trim())
        ? bodyApiBaseUrl.trim()
        : autoApiBaseUrl;

    if (!apiBaseUrl) {
      return res.status(400).json({
        error: "Could not determine the API base URL to pass to the workflow. Set PUBLISH_API_BASE_URL or pass apiBaseUrl in the request body.",
      });
    }

    const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/build-windows.yml/dispatches`;
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
          inputs: { api_base_url: apiBaseUrl },
        }),
      });
    } catch (err) {
      req.log.error({ err }, "GitHub API request failed for desktop build trigger");
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
        "GitHub workflow_dispatch returned a non-2xx response for desktop build",
      );
      return res.status(502).json({
        error: `GitHub rejected the workflow dispatch (HTTP ${ghRes.status})${detail}. Verify that GITHUB_ACTIONS_TOKEN has workflow write access and that build-windows.yml exists on the main branch.`,
      });
    }

    const reqUser = (req as any).user as { username?: string } | undefined;
    const triggerRecord = {
      triggeredAt: new Date().toISOString(),
      triggeredByUsername: reqUser?.username ?? "unknown",
      apiBaseUrl,
    };

    try {
      await db
        .insert(systemSettings)
        .values({ key: SETTING_DESKTOP_BUILD_LAST_TRIGGER, value: JSON.stringify(triggerRecord) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: JSON.stringify(triggerRecord), updatedAt: new Date() },
        });
    } catch (err) {
      req.log.warn({ err }, "Failed to persist desktop build last-trigger record");
    }

    return res.json({ ok: true, trigger: triggerRecord, apiBaseUrl });
  });

  // Returns the status of the most recent build-windows.yml GitHub Actions run.
  router.get("/admin/desktop-build/status", requireAuth, async (req, res) => {
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

    const runsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/build-windows.yml/runs?per_page=1`;
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
      req.log.error({ err }, "GitHub API request failed for desktop build status");
      return res.status(502).json({ error: "Could not reach the GitHub API." });
    }

    if (!ghRes.ok) {
      req.log.error({ status: ghRes.status, url: runsUrl }, "GitHub workflow runs returned a non-2xx response for desktop build");
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

  // ── Admin: Mobile Build ────────────────────────────────────────────────────
  // Returns current build numbers from app.json and last-triggered build info.
  // The platform-admin secret is not required for GET so that mobile clients
  // (which cannot hold the server-side secret) can fetch version history when
  // the authenticated user has the admin role.
  router.get("/admin/mobile-build/info", requireAuth, async (req, res) => {
    const reqUser = (req as any).user as { role?: string } | undefined;
    if (!reqUser || reqUser.role !== "admin") {
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
        lastTrigger = JSON.parse(lastTriggerRaw) as {
          platform: string;
          profile: string;
          triggeredAt: string;
          triggeredByUsername: string;
        };
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
  // Accepts either a platform-admin secret header (CI path) or a JWT-authenticated
  // master_admin user (mobile / desktop path without a stored secret).
  router.post("/admin/mobile-build/trigger", requireAuth, async (req, res) => {
    const reqUser = (req as any).user as { role?: string; username?: string; userType?: string } | undefined;
    const isMasterAdmin = !!reqUser && reqUser.role === "admin" && reqUser.userType === "master_admin";
    if (!isPlatformAdmin(req) && !isMasterAdmin) {
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
