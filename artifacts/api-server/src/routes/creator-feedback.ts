import { Router } from "express";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, supportReports, supportReportAttachments, users, organizations } from "@workspace/db";
import { asyncHandler } from "../middlewares/async-handler";
import { readSupportReportAttachment } from "../lib/support-report-storage";
import { HttpError } from "../lib/http";
import { writeAuditLog } from "../lib/audit";

export const creatorFeedbackRouter = Router();
const visible = () => and(isNull(supportReports.deletedAt), gt(supportReports.expiresAt, new Date()), sql`${supportReports.ownerStatus} <> 'persisting' AND COALESCE(${supportReports.ownerFailureReason}, '') <> 'intake_incomplete'`);
creatorFeedbackRouter.get("/", asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = req.query.status;
  const conditions = and(visible(), status === "new" ? isNull(supportReports.reviewedAt) : status === "reviewed" ? sql`${supportReports.reviewedAt} IS NOT NULL` : undefined);
  const [rows, totals, newTotals] = await Promise.all([
    db.select({ report: supportReports, reporter: { username: users.username, email: users.email, firstName: users.firstName, lastName: users.lastName }, organization: { name: organizations.name } })
      .from(supportReports).leftJoin(users, eq(users.id, supportReports.reporterUserId)).leftJoin(organizations, eq(organizations.id, supportReports.organizationId))
      .where(conditions).orderBy(desc(supportReports.createdAt), desc(supportReports.id)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(supportReports).where(conditions),
    db.select({ n: sql<number>`count(*)::int` }).from(supportReports).where(and(visible(), isNull(supportReports.reviewedAt))),
  ]);
  const attachments = rows.length ? await db.select({
    id: supportReportAttachments.id, reportId: supportReportAttachments.reportId, filename: supportReportAttachments.filename,
    contentType: supportReportAttachments.contentType, size: supportReportAttachments.size,
  }).from(supportReportAttachments).where(and(inArray(supportReportAttachments.reportId, rows.map(r => r.report.id)), isNull(supportReportAttachments.deletedAt))) : [];
  res.json({ items: rows.map(({ report: r, reporter, organization }) => ({
    id: r.id, reporterUserId: r.reporterUserId, organizationId: r.organizationId, portal: r.portal, kind: r.kind,
    description: r.description, createdAt: r.createdAt, reviewedAt: r.reviewedAt, reporter, organization,
    attachments: attachments.filter(a => a.reportId === r.id),
  })), total: totals[0]?.n ?? 0, newCount: newTotals[0]?.n ?? 0 });
}));
creatorFeedbackRouter.patch("/:id", asyncHandler(async (req: any, res) => {
  if (typeof req.body?.reviewed !== "boolean") throw new HttpError(400, "reviewed must be a boolean.");
  const [report] = await db.update(supportReports).set({ reviewedAt: req.body.reviewed ? new Date() : null })
    .where(and(eq(supportReports.id, req.params.id), visible())).returning({ id: supportReports.id, reviewedAt: supportReports.reviewedAt });
  if (!report) throw new HttpError(404, "Feedback not found or expired.");
  await writeAuditLog({ req, userId: req.auth.userId, action: "creator_feedback_reviewed", entityType: "support_report", entityId: report.id, metadataJson: { reviewed: req.body.reviewed } });
  res.json({ ok: true, ...report });
}));
creatorFeedbackRouter.get("/:reportId/attachments/:attachmentId", asyncHandler(async (req, res) => {
  const [item] = await db.select({ attachment: supportReportAttachments }).from(supportReportAttachments)
    .innerJoin(supportReports, eq(supportReports.id, supportReportAttachments.reportId))
    .where(and(eq(supportReports.id, String(req.params.reportId)), eq(supportReportAttachments.id, String(req.params.attachmentId)), isNull(supportReportAttachments.deletedAt), visible()));
  if (!item) throw new HttpError(404, "Attachment not found or expired.");
  const bytes = await readSupportReportAttachment(item.attachment.storageKey);
  if (!bytes) throw new HttpError(404, "Attachment is no longer available.");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("application/octet-stream").attachment(item.attachment.filename).send(bytes);
}));
