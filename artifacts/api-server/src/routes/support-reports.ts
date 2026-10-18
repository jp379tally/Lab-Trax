import { Router, type RequestHandler } from "express";
import multer from "multer";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { and, eq, isNull, asc, or } from "drizzle-orm";
import { db, users, organizations, organizationMemberships, supportReports, supportReportAttachments } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { requireSelectedProviderOrganization } from "../lib/provider-selection";
import { isReservedEmailDomain, resolveDomainDeliverability } from "../lib/mail";
import { writeSupportReportAttachment } from "../lib/support-report-storage";
import { SUPPORT_REPORT_RETENTION_MS } from "../lib/support-report-outbox";
import { persistSupportReportIntake } from "../lib/support-report-intake";
import { creatorRecipientId, requireCreator } from "../lib/creator-auth";
import { randomUUID } from "node:crypto";
import { createUserRateLimit } from "../lib/rate-limit";

const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_PDF_PAGES = 50;
const MAX_CONCURRENT_PDF_VALIDATIONS = 2;
const PDF_VALIDATION_TIMEOUT_MS = 3_000;
const TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain"]);
let activePdfValidations = 0;

// Run the legacy parser outside the API process so hostile PDFs cannot consume
// the server heap. The child has a small heap, a hard timeout, and a page cap.
// pdf-parse's package index is intentionally bypassed (it reads a test file).
const PDF_VALIDATOR_SCRIPT = `
const parse = require(process.argv[1]);
const maxPages = Number(process.argv[2]);
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", async () => {
  try {
    const result = await parse(Buffer.concat(chunks));
    process.exit(Number(result && result.numpages) <= maxPages ? 0 : 2);
  } catch {
    process.exit(2);
  }
});
`;

function validatePdfInChild(buffer: Buffer): Promise<boolean> {
  if (activePdfValidations >= MAX_CONCURRENT_PDF_VALIDATIONS) return Promise.resolve(false);
  activePdfValidations += 1;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      activePdfValidations -= 1;
      clearTimeout(timer);
      resolve(valid);
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parserPath = require.resolve("pdf-parse/lib/pdf-parse.js");
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=96", "-e", PDF_VALIDATOR_SCRIPT, parserPath, String(MAX_PDF_PAGES)],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, PDF_VALIDATION_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

class BoundedMemoryStorage {
  _handleFile(req: any, file: any, cb: (error?: any, info?: any) => void) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    (req as any).__supportFilesBytes ??= 0;
    const finish = (error?: any, info?: any) => {
      if (finished) return;
      finished = true;
      cb(error, info);
    };
    file.stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      (req as any).__supportFilesBytes += chunk.length;
      if (bytes > MAX_FILE || (req as any).__supportFilesBytes > MAX_TOTAL) {
        file.stream.destroy(Object.assign(new Error("SUPPORT_TOTAL_LIMIT"), { code: "LIMIT_TOTAL" }));
        return;
      }
      chunks.push(chunk);
    });
    file.stream.on("error", (err: any) => finish(err));
    file.stream.on("end", () => {
      finish(null, { buffer: Buffer.concat(chunks, bytes), size: bytes });
    });
  }
  _removeFile(_req: any, _file: any, cb: (error: Error | null) => void) { cb(null); }
}

const upload = multer({
  storage: new BoundedMemoryStorage(),
  limits: { files: 5, fileSize: MAX_FILE, fields: 10, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => TYPES.has(file.mimetype.toLowerCase())
    ? cb(null, true)
    : cb(new Error("UNSUPPORTED_ATTACHMENT_TYPE")),
});

function safeName(name: string): string {
  const base = path.basename(name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "attachment";
}

async function validBinary(type: string, b: Buffer): Promise<boolean> {
  if (type === "application/pdf") {
    return validatePdfInChild(b);
  }
  if (type === "text/plain") return isTextContent(b);
  const expected = { "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[type] ?? "jpeg";
  try {
    const input = sharp(b, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true });
    const metadata = await input.metadata();
    if (metadata.format !== expected) return false;
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) return false;
    // Metadata alone can succeed for a truncated image. Force a bounded full
    // decode before the bytes are accepted as an email attachment.
    await sharp(b, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true }).toBuffer();
    return true;
  } catch {
    return false;
  }
}

function isTextContent(b: Buffer): boolean {
  if (b.includes(0)) return false;
  // Reject other ASCII control bytes; tabs, line endings, and printable UTF-8
  // are valid text/plain content.
  for (const byte of b) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return false;
  }
  return !b.toString("utf8").includes("\ufffd");
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && !isReservedEmailDomain(value.trim());
}

async function usableEmail(email: string): Promise<boolean> {
  return (await resolveDomainDeliverability(email)) !== "undeliverable";
}

type SupportContext = { portal: "lab" | "provider"; organizationId: string };

const authorizeSupport: RequestHandler = async (req: any, res, next) => {
  const feedback = req.query.kind === "feedback";
  const portal = typeof req.query.portal === "string" ? req.query.portal : "";
  if (portal !== "lab" && portal !== "provider") return res.status(400).json({ error: "portal query parameter must be lab or provider." });
  try {
    let organizationId: string;
    if (portal === "provider") {
      const selectedId = typeof req.headers["x-provider-organization-id"] === "string" ? req.headers["x-provider-organization-id"] : undefined;
      const selected = await requireSelectedProviderOrganization(req.auth.userId, selectedId);
      const membership = await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.userId, req.auth.userId), eq(organizationMemberships.labId, selected.id), eq(organizationMemberships.status, "active"), isNull(organizationMemberships.deletedAt)) });
      if (!membership || (!feedback && !["owner", "admin"].includes(membership.role))) return res.status(403).json({ error: "Support reports require organization administrator access." });
      organizationId = selected.id;
    } else {
      const memberships = await db.select({ id: organizationMemberships.labId, role: organizationMemberships.role }).from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
        .where(and(eq(organizationMemberships.userId, req.auth.userId), eq(organizationMemberships.status, "active"), isNull(organizationMemberships.deletedAt), eq(organizations.type, "lab"), eq(organizations.isActive, true), isNull(organizations.deletedAt)))
        .orderBy(asc(organizationMemberships.createdAt));
      const selectedId = req.headers["x-lab-organization-id"];
      const membership = memberships.find((m) => (!selectedId || m.id === selectedId) && (feedback || m.role === "owner" || m.role === "admin"));
      if (!membership) return res.status(403).json({ error: "Support reports require lab administrator access." });
      organizationId = membership.id;
    }
    req.supportContext = { portal, organizationId } satisfies SupportContext;
    return next();
  } catch (err) { next(err); }
};

const multipart: RequestHandler = (req, res, next) => {
  upload.array("attachments", 5)(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_TOTAL") return res.status(413).json({ error: err.code === "LIMIT_TOTAL" ? "Attachments exceed the 10 MiB total limit." : "Attachment exceeds the 5 MiB limit." });
    if (err.code === "LIMIT_FILE_COUNT") return res.status(413).json({ error: "A maximum of 5 attachments is allowed." });
    if (err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: "Unexpected attachment field." });
    if (err.code === "LIMIT_FIELD_SIZE") return res.status(413).json({ error: "Form field is too large." });
    if (err.message === "UNSUPPORTED_ATTACHMENT_TYPE") return res.status(415).json({ error: "Unsupported attachment type." });
    return res.status(415).json({ error: "Unsupported multipart attachment." });
  });
};

export default function supportReportsRouter(
  rateLimit?: RequestHandler,
): Router {
  const router = Router();
  router.get("/status", requireCreator, asyncHandler(async (_req: any, res) => {
    // Deliberately expose only operational metadata to platform owners. Never
    // return description, addresses, organization ids, or attachment names.
    const rows = await db.select({
      id: supportReports.id, ownerStatus: supportReports.ownerStatus, copyStatus: supportReports.copyStatus,
      ownerAttempts: supportReports.ownerAttempts, copyAttempts: supportReports.copyAttempts,
      ownerFailureReason: supportReports.ownerFailureReason, copyFailureReason: supportReports.copyFailureReason,
      createdAt: supportReports.createdAt,
    }).from(supportReports).where(or(eq(supportReports.ownerStatus, "permanent_failed"), eq(supportReports.copyStatus, "permanent_failed"))).limit(100);
    return res.json({ reports: rows.map((r) => ({
      id: r.id, ownerStatus: r.ownerStatus, copyStatus: r.copyStatus,
      ownerAttempts: r.ownerAttempts, copyAttempts: r.copyAttempts,
      ownerFailureReason: ["send_failed", "recipient_rejected", "attachment_unavailable", "expired", "intake_incomplete"].includes(r.ownerFailureReason ?? "") ? r.ownerFailureReason : r.ownerFailureReason ? "permanent_failure" : null,
      copyFailureReason: ["send_failed", "recipient_rejected", "attachment_unavailable", "expired", "intake_incomplete"].includes(r.copyFailureReason ?? "") ? r.copyFailureReason : r.copyFailureReason ? "permanent_failure" : null,
      createdAt: r.createdAt,
    })) });
  }));
  const supportReportRateLimit = rateLimit ?? createUserRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: "Too many support reports. Please wait and try again later.",
  });
  router.post("/", requireAuth, supportReportRateLimit, authorizeSupport, multipart, asyncHandler(async (req: any, res) => {
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const portal = req.supportContext.portal;
    if (!description) return res.status(400).json({ error: "Description is required." });

    const files = (req.files ?? []) as Express.Multer.File[];
    for (const file of files) {
      const type = file.mimetype.toLowerCase().split(";")[0]!;
      if (!TYPES.has(type)) return res.status(415).json({ error: "Unsupported attachment type." });
      if (!(await validBinary(type, file.buffer))) {
        return res.status(415).json({ error: "Attachment content does not match its declared type." });
      }
    }

    const userId = req.auth.userId as string;
    const organizationId = req.supportContext.organizationId;
    const idempotencyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyHeader === "string"
      && /^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyHeader)
        ? idempotencyHeader
        : null;

    const [reporter] = await db.select({ username: users.username, email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
    const [organization] = await db.select({ id: organizations.id, name: organizations.name })
      .from(organizations).where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt))).limit(1);
    if (!reporter || !organization) return res.status(403).json({ error: "Organization context is unavailable." });

    const destination = await creatorRecipientId();
    if (!destination) return res.status(503).json({ error: "Support email is temporarily unavailable." });
    const recipients = await db.select({ email: users.email }).from(users)
      .where(and(eq(users.id, destination), eq(users.isActive, true), isNull(users.deletedAt)));
    if (recipients.length !== 1 || !validEmail(recipients[0]?.email) || !(await usableEmail(recipients[0]!.email))) {
      return res.status(503).json({ error: "Support email is temporarily unavailable." });
    }
    const reportId = randomUUID();
    const stored = files.map((f) => ({
      id: randomUUID(),
      filename: safeName(f.originalname),
      contentType: f.mimetype.split(";")[0]!,
      storageKey: randomUUID(),
      size: f.buffer.length,
      content: f.buffer,
    }));
    const reporterEmail = validEmail(reporter.email) ? reporter.email.trim().toLowerCase() : undefined;
    const ownerEmail = recipients[0]!.email!.trim().toLowerCase();
    const copyRequired = Boolean(reporterEmail && reporterEmail !== ownerEmail && await usableEmail(reporterEmail));
    const now = new Date();
    try {
      const inserted = await persistSupportReportIntake({
          id: reportId,
          reporterUserId: userId,
          organizationId,
          idempotencyKey,
          portal,
          kind: req.query.kind === "feedback" ? "feedback" : "issue",
          description: "",
          reporterEmail: reporterEmail ?? null,
          ownerEmail,
          ownerStatus: "persisting",
          copyStatus: copyRequired ? "persisting" : "not_applicable",
          copyNextAttemptAt: copyRequired ? now : null,
          expiresAt: new Date(now.getTime() + SUPPORT_REPORT_RETENTION_MS),
        }, stored.map(({ content: _content, ...attachment }) => attachment));
      if (!inserted) {
        if (!idempotencyKey) throw new Error("Unexpected support report conflict");
        const existing = await db.query.supportReports.findFirst({
          columns: { ownerFailureReason: true },
          where: and(
            eq(supportReports.reporterUserId, userId),
            eq(supportReports.idempotencyKey, idempotencyKey),
          ),
        });
        if (existing?.ownerFailureReason === "intake_incomplete") {
          return res.status(503).json({ error: "Support attachments are temporarily unavailable." });
        }
        return res.status(202).json({ ok: true, queued: true, copySent: false, duplicate: true });
      }
    } catch {
      return res.status(503).json({ error: "Support report could not be saved. Please try again later." });
    }
    const timestamp = now.toISOString();
    const reporterName = [reporter.firstName, reporter.lastName].filter(Boolean).join(" ") || reporter.username;
    const text = `${req.query.kind === "feedback" ? "Feedback" : "Support report"}\nPortal: ${portal}\nUTC timestamp: ${timestamp}\nReporter: ${reporterName} (${reporter.username}, ${reporter.email ?? "no email"})\nOrganization: ${organization.name} (${organization.id})\n\n${description}`;
    try {
      for (const attachment of stored) {
        if (!(await writeSupportReportAttachment(attachment.storageKey, attachment.content, attachment.contentType))) {
          throw new Error("SUPPORT_STORAGE_UNAVAILABLE");
        }
      }
      const [accepted] = await db.update(supportReports).set({
        description: text,
        ownerStatus: "pending",
        copyStatus: copyRequired ? "pending" : "not_applicable",
      }).where(and(eq(supportReports.id, reportId), eq(supportReports.ownerStatus, "persisting"))).returning();
      if (!accepted) throw new Error("outbox activation failed");
    } catch {
      await db.update(supportReports).set({
        ownerStatus: "permanent_failed",
        copyStatus: copyRequired ? "permanent_failed" : "not_applicable",
        ownerFailureReason: "intake_incomplete",
        copyFailureReason: copyRequired ? "intake_incomplete" : null,
        expiresAt: new Date(),
      }).where(eq(supportReports.id, reportId)).catch(() => undefined);
      return res.status(503).json({ error: "Support attachments are temporarily unavailable." });
    }
    return res.status(202).json({ ok: true, queued: true, copySent: false });
  }));
  return router;
}