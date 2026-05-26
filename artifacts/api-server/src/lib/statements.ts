import PDFDocument from "pdfkit";
import { normalizePhoneE164 } from "./account-link-sms";
import archiver from "archiver";
import nodemailer from "nodemailer";
import { and, asc, eq, gte, inArray, lt, or, isNull, ne, lte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  invoiceLineItems,
  invoices,
  organizations,
  statementSchedules,
  statementSendRuns,
} from "@workspace/db";
import { logger } from "./logger";
import { openLabLogoStream } from "./lab-logo-storage";
import { getAppBaseUrl } from "./mail";
import { checkEmailPref } from "./email-prefs";

// Automatic retry configuration for failed statement sends.
// MAX_ATTEMPTS includes the initial attempt, so a value of 3 means
// up to two automatic retries after the first failure.
export const STATEMENT_MAX_ATTEMPTS = 3;
// Backoff schedule (ms) per attempt number that just completed:
// after attempt 1 → wait 30 min before attempt 2
// after attempt 2 → wait 2 hours before attempt 3
const STATEMENT_RETRY_BACKOFF_MS: number[] = [
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
];

function nextAttemptDelayMs(justCompletedAttempt: number): number | null {
  const idx = justCompletedAttempt - 1;
  if (idx < 0 || idx >= STATEMENT_RETRY_BACKOFF_MS.length) return null;
  return STATEMENT_RETRY_BACKOFF_MS[idx]!;
}

export type SendTrigger = "schedule" | "manual";

export interface LineItemEntry {
  id: string;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  parentLineItemId: string | null;
  toothLabel: string | null;
  toothNumber: number | null;
  sortOrder: number;
}

export interface PracticeStatementData {
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
  /** True when the practice has opted out of receiving statement emails. */
  statementEmailOptOut: boolean;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  invoices: Array<{
    invoiceNumber: string;
    issuedAt: Date | null;
    dueAt: Date | null;
    status: string;
    total: string;
    balanceDue: string;
    patientName: string | null;
    billTo: string | null;
    /** Line items for this invoice, used to render group subtotals in the PDF. */
    lineItems?: LineItemEntry[];
  }>;
}

/**
 * Stream the logo for an org directly from App Storage into a Buffer.
 * Returns null if no logo exists, storage is not configured, or the
 * format is SVG (pdfkit cannot embed SVG natively).
 */
async function readLogoBuffer(orgId: string): Promise<Buffer | null> {
  try {
    const result = await openLabLogoStream(orgId);
    if (!result) return null;
    if (result.contentType.includes("svg")) return null;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      result.stream.on("end", resolve);
      result.stream.on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Resolve effective logo placements from a saved preference array.
 * Accepts null/undefined (org not found or column not set) and returns an
 * empty Set so no logo appears until an admin opts in.
 */
function resolveLocalLogoplacements(
  org:
    | {
        logoUrl: string | null | undefined;
        logoplacements: string[] | null | undefined;
      }
    | null
    | undefined
): Set<string> {
  if (!org) return new Set();
  if (org.logoplacements != null) return new Set(org.logoplacements);
  return new Set();
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  try {
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export function periodMonthFor(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function priorMonthRange(asOf: Date): {
  start: Date;
  end: Date;
  periodMonth: string;
} {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth(); // current month
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { start, end, periodMonth: periodMonthFor(start) };
}

/**
 * Batch-fetches invoice line items for every invoice in the given statements
 * and attaches them to the matching invoice entries in-place. The caller
 * passes a Map from invoiceId → {practiceId, invoiceIndex} so this helper
 * can look up the right slot without re-scanning the statements array.
 */
async function attachLineItems(
  statements: Map<string, PracticeStatementData>,
  invoiceIdMap: Map<string, { practiceId: string; index: number }>
): Promise<void> {
  const allIds = Array.from(invoiceIdMap.keys());
  if (!allIds.length) return;

  const liRows = await db.query.invoiceLineItems.findMany({
    where: inArray(invoiceLineItems.invoiceId, allIds),
    orderBy: [asc(invoiceLineItems.sortOrder)],
  });

  const liByInvoice = new Map<string, typeof liRows>();
  for (const li of liRows) {
    if (!liByInvoice.has(li.invoiceId)) liByInvoice.set(li.invoiceId, []);
    liByInvoice.get(li.invoiceId)!.push(li);
  }

  for (const [invoiceId, { practiceId, index }] of invoiceIdMap) {
    const pData = statements.get(practiceId);
    if (!pData) continue;
    const entry = pData.invoices[index];
    if (!entry) continue;
    entry.lineItems = (liByInvoice.get(invoiceId) ?? []).map((li) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitPrice: String(li.unitPrice),
      lineTotal: String(li.lineTotal),
      parentLineItemId: li.parentLineItemId ?? null,
      toothLabel: li.toothLabel ?? null,
      toothNumber: li.toothNumber ?? null,
      sortOrder: li.sortOrder,
    }));
  }
}

export async function buildPracticeStatements(
  labOrganizationId: string,
  periodStart: Date,
  periodEnd: Date,
  /**
   * When provided (non-null, non-empty), only practices whose id appears in
   * this list will be included in the returned statements. null / undefined
   * means "all practices with activity" — the default behaviour.
   */
  includedOrgIds?: string[] | null
): Promise<PracticeStatementData[]> {
  const rows = await db.query.invoices.findMany({
    where: and(
      eq(invoices.labOrganizationId, labOrganizationId),
      gte(invoices.createdAt, periodStart),
      lt(invoices.createdAt, periodEnd)
    ),
    orderBy: [asc(invoices.createdAt)],
  });
  if (!rows.length) return [];

  // Apply per-practice filter when an explicit inclusion list is present.
  const filterIds =
    includedOrgIds && includedOrgIds.length > 0 ? new Set(includedOrgIds) : null;

  const practiceIds = Array.from(
    new Set(
      rows
        .map((r) => r.providerOrganizationId)
        .filter((id) => !filterIds || filterIds.has(id))
    )
  );
  if (!practiceIds.length) return [];

  const practiceRows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, practiceIds));
  type OrgRow = (typeof practiceRows)[number];
  const byId = new Map<string, OrgRow>(
    practiceRows.map((o) => [o.id, o] as const)
  );

  const grouped = new Map<string, PracticeStatementData>();
  const invoiceIdMap = new Map<string, { practiceId: string; index: number }>();

  for (const inv of rows) {
    const id = inv.providerOrganizationId;
    // Skip invoices for practices that aren't in the inclusion filter.
    if (filterIds && !filterIds.has(id)) continue;
    const org = byId.get(id);
    const cur =
      grouped.get(id) ||
      ({
        practiceId: id,
        practiceName: org?.displayName || org?.name || "Unknown practice",
        practiceEmail: org?.billingEmail || null,
        statementEmailOptOut: org?.statementEmailOptOut ?? false,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        invoices: [],
      } as PracticeStatementData);

    const total = Number(inv.total ?? 0);
    const balance = Number(inv.balanceDue ?? 0);
    cur.invoiceCount += 1;
    cur.totalBilled += total;
    cur.totalPaid += Math.max(0, total - balance);
    if (inv.status !== "void") cur.openBalance += balance;
    const meta = (inv.displayMetadataJson ?? null) as
      | { patientName?: string | null; billTo?: string | null }
      | null;
    invoiceIdMap.set(inv.id, { practiceId: id, index: cur.invoices.length });
    cur.invoices.push({
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
      dueAt: inv.dueAt ?? null,
      status: inv.status,
      total: String(inv.total ?? "0"),
      balanceDue: String(inv.balanceDue ?? "0"),
      patientName: meta?.patientName ?? null,
      billTo: meta?.billTo ?? null,
    });
    grouped.set(id, cur);
  }

  await attachLineItems(grouped, invoiceIdMap);
  return Array.from(grouped.values());
}

const PDF_LOGO_FIT: Record<string, [number, number]> = {
  small: [90, 36],
  medium: [120, 48],
  large: [160, 64],
};

export async function generateStatementPdfBuffer(
  labName: string,
  data: PracticeStatementData,
  periodLabel: string,
  logoBuffer?: Buffer | null,
  logoPdfSize?: string | null
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (logoBuffer) {
      try {
        const fit = PDF_LOGO_FIT[logoPdfSize ?? "medium"] ?? PDF_LOGO_FIT["medium"]!;
        doc.image(logoBuffer, 48, 30, { fit });
        // Move the cursor below the logo before writing the heading so
        // text does not overlap the image.
        doc.y = 30 + fit[1] + 12;
      } catch {
        // logo embed failed — fall through to text-only header
      }
    }

    doc.fontSize(20).font("Helvetica-Bold").text("Statement", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(11).font("Helvetica").fillColor("#444").text(labName);
    doc.fillColor("#000");
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(`For: ${data.practiceName}`)
      .text(`Period: ${periodLabel}`)
      .text(`Generated: ${new Date().toLocaleString("en-US")}`);
    doc.fillColor("#000");

    doc.moveDown(1);
    doc.fontSize(11).font("Helvetica-Bold").text("Summary");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10);
    const sumLines: Array<[string, string]> = [
      ["Invoices", String(data.invoiceCount)],
      ["Billed", fmtMoney(data.totalBilled)],
      ["Paid", fmtMoney(data.totalPaid)],
      ["Open balance", fmtMoney(data.openBalance)],
    ];
    for (const [k, v] of sumLines) {
      doc.text(`${k}: ${v}`);
    }

    doc.moveDown(1);
    doc.fontSize(11).font("Helvetica-Bold").text("Invoices");
    doc.moveDown(0.3);

    const startX = doc.x;
    const colWidths = [110, 100, 75, 75, 60, 70, 70];
    const headers = [
      "Invoice",
      "Patient",
      "Issued",
      "Due",
      "Status",
      "Total",
      "Balance",
    ];
    const rightAlignFrom = 5;
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
    let x = startX;
    headers.forEach((h, i) => {
      doc.text(h, x, y, {
        width: colWidths[i],
        align: i >= rightAlignFrom ? "right" : "left",
      });
      x += colWidths[i]!;
    });
    doc.fillColor("#000");
    y += 14;
    doc
      .moveTo(startX, y - 2)
      .lineTo(startX + colWidths.reduce((a, b) => a + b!, 0), y - 2)
      .strokeColor("#ccc")
      .stroke();

    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    doc.font("Helvetica").fontSize(9);
    for (const inv of data.invoices) {
      const billTo = inv.billTo && inv.billTo.trim() ? inv.billTo.trim() : "";
      const showBillTo = billTo && billTo !== data.practiceName;
      const rowHeight = showBillTo ? 26 : 16;
      if (y + rowHeight > doc.page.height - 60) {
        doc.addPage();
        y = doc.y;
      }
      const patient =
        inv.patientName && inv.patientName.trim() ? inv.patientName.trim() : "—";
      const cells = [
        inv.invoiceNumber,
        patient,
        fmtDate(inv.issuedAt),
        fmtDate(inv.dueAt),
        inv.status,
        fmtMoney(Number(inv.total)),
        fmtMoney(Number(inv.balanceDue)),
      ];
      x = startX;
      cells.forEach((c, i) => {
        doc.text(c, x, y, {
          width: colWidths[i],
          align: i >= rightAlignFrom ? "right" : "left",
        });
        x += colWidths[i]!;
      });
      if (showBillTo) {
        doc
          .fontSize(8)
          .fillColor("#666")
          .text(`Bill to: ${billTo}`, startX, y + 12, {
            width: colWidths[0]!,
          });
        doc.fontSize(9).fillColor("#000");
      }
      y += rowHeight;

      // ── Grouped line items ──────────────────────────────────────────────
      const lineItems = inv.lineItems;
      if (lineItems && lineItems.length > 0) {
        const LI_INDENT = 16;
        const LI_AMT_W = 70;
        const LI_DESC_W = tableWidth - LI_INDENT - LI_AMT_W;
        const liX = startX + LI_INDENT;
        const liAmtX = liX + LI_DESC_W;

        // Separate top-level items from children.
        const parents = lineItems.filter((li) => !li.parentLineItemId);
        const childrenByParent = new Map<string, LineItemEntry[]>();
        for (const li of lineItems) {
          if (li.parentLineItemId) {
            if (!childrenByParent.has(li.parentLineItemId)) {
              childrenByParent.set(li.parentLineItemId, []);
            }
            childrenByParent.get(li.parentLineItemId)!.push(li);
          }
        }

        for (const parent of parents) {
          const children = childrenByParent.get(parent.id) ?? [];
          const hasChildren = children.length > 0;
          const LI_ROW_H = 13;

          // Parent / group-header row
          if (y + LI_ROW_H > doc.page.height - 60) {
            doc.addPage();
            y = doc.y;
          }
          doc
            .font(hasChildren ? "Helvetica-Bold" : "Helvetica")
            .fontSize(8)
            .fillColor("#333");
          doc.text(parent.description, liX, y, { width: LI_DESC_W, lineBreak: false });
          doc.text(fmtMoney(Number(parent.lineTotal)), liAmtX, y, {
            width: LI_AMT_W,
            align: "right",
            lineBreak: false,
          });
          doc.fillColor("#000");
          y += LI_ROW_H;

          // Child rows (sub-items)
          const SUB_EXTRA = 10;
          const subX = liX + SUB_EXTRA;
          const subDescW = LI_DESC_W - SUB_EXTRA;
          for (const child of children) {
            if (y + LI_ROW_H > doc.page.height - 60) {
              doc.addPage();
              y = doc.y;
            }
            doc.font("Helvetica").fontSize(8).fillColor("#666");
            doc.text(`↳ ${child.description}`, subX, y, {
              width: subDescW,
              lineBreak: false,
            });
            doc.text(fmtMoney(Number(child.lineTotal)), liAmtX, y, {
              width: LI_AMT_W,
              align: "right",
              lineBreak: false,
            });
            doc.fillColor("#000");
            y += LI_ROW_H;
          }

          // Subtotal row when parent has children
          if (hasChildren) {
            const groupTotal =
              Number(parent.lineTotal) +
              children.reduce((s, c) => s + Number(c.lineTotal), 0);
            const ST_ROW_H = 14;
            if (y + ST_ROW_H > doc.page.height - 60) {
              doc.addPage();
              y = doc.y;
            }
            // Light-gray background strip
            doc.save();
            doc
              .rect(startX + LI_INDENT - 4, y - 2, tableWidth - LI_INDENT + 4, ST_ROW_H + 1)
              .fillColor("#e6e8eb")
              .fill();
            doc.restore();
            // "— Subtotal" label (italic) + bold amount
            doc.font("Helvetica-Oblique").fontSize(8).fillColor("#505050");
            doc.text("— Subtotal", liX, y, { width: LI_DESC_W, lineBreak: false });
            doc.font("Helvetica-Bold").fillColor("#505050");
            doc.text(fmtMoney(groupTotal), liAmtX, y, {
              width: LI_AMT_W,
              align: "right",
              lineBreak: false,
            });
            doc.fillColor("#000");
            y += ST_ROW_H;
          }
        }
        // Small visual gap after the line-items block
        y += 4;
      }
      // ── End grouped line items ──────────────────────────────────────────
    }

    doc.end();
  });
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = process.env.SMTP_PORT || "587";
  const from = process.env.SMTP_FROM || user || "noreply@labtrax.com";
  if (!host || !user || !pass) return null;
  return { host, user, pass, port, from };
}

export const DEFAULT_STATEMENT_SUBJECT =
  "Statement for {{practiceName}} — {{periodLabel}}";
export const DEFAULT_STATEMENT_BODY =
  "Hello,\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nTotal billed: {{totalBilled}}\nOpen balance: {{openBalance}}\n\nThank you,\n{{labName}}";

export interface StatementEmailVars {
  practiceName: string;
  labName: string;
  periodLabel: string;
  totalBilled: string;
  openBalance: string;
}

export function renderStatementTemplate(
  template: string,
  vars: StatementEmailVars
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = (vars as unknown as Record<string, string>)[key];
    return v ?? `{{${key}}}`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyToHtml(body: string): string {
  const escaped = escapeHtml(body).replace(/\n/g, "<br/>");
  return `<div style="font-family: Arial, sans-serif; max-width: 600px; white-space: normal;">${escaped}</div>`;
}

export async function sendStatementEmail(opts: {
  to: string;
  fromName: string;
  practiceName: string;
  periodLabel: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  totals: { billed: number; open: number };
  template?: {
    subject?: string | null;
    body?: string | null;
    replyTo?: string | null;
  } | null;
  /**
   * When set, an <img> tag with the lab logo is prepended to the email HTML.
   * Must be an absolute URL. Only populated when the `emails` placement is
   * enabled for the lab.
   */
  labLogoUrl?: string | null;
}): Promise<{ delivered: boolean; reason?: string }> {
  const smtp = getSmtpConfig();
  if (!smtp) {
    return { delivered: false, reason: "SMTP not configured" };
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: parseInt(smtp.port, 10),
    secure: smtp.port === "465",
    auth: { user: smtp.user, pass: smtp.pass },
  });
  const vars: StatementEmailVars = {
    practiceName: opts.practiceName,
    labName: opts.fromName,
    periodLabel: opts.periodLabel,
    totalBilled: fmtMoney(opts.totals.billed),
    openBalance: fmtMoney(opts.totals.open),
  };
  const subjectTemplate =
    (opts.template?.subject?.trim() || "") || DEFAULT_STATEMENT_SUBJECT;
  const bodyTemplate =
    (opts.template?.body?.trim() || "") || DEFAULT_STATEMENT_BODY;
  const subject = renderStatementTemplate(subjectTemplate, vars);
  const bodyText = renderStatementTemplate(bodyTemplate, vars);
  const replyTo = opts.template?.replyTo?.trim() || undefined;

  const logoHeaderHtml = opts.labLogoUrl
    ? `<div style="margin-bottom:12px;"><img src="${escapeHtml(opts.labLogoUrl)}" alt="Lab logo" style="max-height:48px;max-width:150px;object-fit:contain;display:block;" /></div>`
    : "";
  const emailHtml = logoHeaderHtml
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;">${logoHeaderHtml}${bodyToHtml(bodyText).replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "")}</div>`
    : bodyToHtml(bodyText);

  await transporter.sendMail({
    from: `${opts.fromName} <${smtp.from}>`,
    to: opts.to,
    ...(replyTo ? { replyTo } : {}),
    subject,
    text: bodyText,
    html: emailHtml,
    attachments: [
      { filename: opts.pdfFilename, content: opts.pdfBuffer, contentType: "application/pdf" },
    ],
  });
  return { delivered: true };
}

function periodLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map((s) => parseInt(s, 10));
  if (!y || !m) return periodMonth;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export interface RunResultRow {
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
  status: "sent" | "failed" | "skipped_no_email" | "skipped_opted_out";
  errorMessage?: string;
}

export async function runMonthlyStatementsForLab(opts: {
  labOrganizationId: string;
  triggeredBy: SendTrigger;
  triggeredByUserId?: string | null;
  asOf?: Date;
}): Promise<{ periodMonth: string; results: RunResultRow[] }> {
  const asOf = opts.asOf ?? new Date();
  const { start, end, periodMonth } = priorMonthRange(asOf);
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";

  // Determine which logo contexts are active for this lab.
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;
  const emailLogoUrl =
    effectivePlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  const sched = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
  });
  const template = sched
    ? {
        subject: sched.emailSubject,
        body: sched.emailBody,
        replyTo: sched.emailReplyTo,
      }
    : null;

  // Respect the per-practice inclusion filter saved on the schedule.
  // null / empty → send to all practices with activity (default behaviour).
  const includedOrgIds =
    sched?.includedOrgIds && sched.includedOrgIds.length > 0
      ? sched.includedOrgIds
      : null;

  const statements = await buildPracticeStatements(
    opts.labOrganizationId,
    start,
    end,
    includedOrgIds
  );

  const results: RunResultRow[] = [];
  for (const s of statements) {
    const safeName = s.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    const filename = `statement-${safeName}-${periodMonth}.pdf`;
    let status: RunResultRow["status"] = "sent";
    let errorMessage: string | undefined;

    try {
      if (s.statementEmailOptOut) {
        status = "skipped_opted_out";
        errorMessage = "Practice has opted out of statement emails";
      } else if (!s.practiceEmail) {
        status = "skipped_no_email";
        errorMessage = "Practice has no billing email on file";
      } else if (!(await checkEmailPref(s.practiceEmail, "statementEmails"))) {
        status = "skipped_opted_out";
        errorMessage = "Recipient has opted out of statement emails via notification preferences";
      } else {
        const pdfBuffer = await generateStatementPdfBuffer(
          labName,
          s,
          periodLabel(periodMonth),
          logoBuffer,
          (labOrg as any)?.logoPdfSize
        );
        const result = await sendStatementEmail({
          to: s.practiceEmail,
          fromName: labName,
          practiceName: s.practiceName,
          periodLabel: periodLabel(periodMonth),
          pdfBuffer,
          pdfFilename: filename,
          totals: { billed: s.totalBilled, open: s.openBalance },
          template,
          labLogoUrl: emailLogoUrl,
        });
        if (!result.delivered) {
          status = "failed";
          errorMessage = result.reason || "Email send failed";
        }
      }
    } catch (err: unknown) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, practiceId: s.practiceId },
        "Statement send failed"
      );
    }

    const now = new Date();
    const delay = status === "failed" ? nextAttemptDelayMs(1) : null;
    await db.insert(statementSendRuns).values({
      labOrganizationId: opts.labOrganizationId,
      practiceOrganizationId: s.practiceId,
      practiceName: s.practiceName,
      practiceEmail: s.practiceEmail,
      periodMonth,
      status,
      errorMessage: errorMessage ?? null,
      invoiceCount: s.invoiceCount,
      totalBilled: s.totalBilled.toFixed(2),
      openBalance: s.openBalance.toFixed(2),
      triggeredBy: opts.triggeredBy,
      triggeredByUserId: opts.triggeredByUserId ?? null,
      attemptCount: 1,
      lastAttemptAt: now,
      nextAttemptAt: delay !== null ? new Date(now.getTime() + delay) : null,
    });

    results.push({
      practiceId: s.practiceId,
      practiceName: s.practiceName,
      practiceEmail: s.practiceEmail,
      status,
      errorMessage,
    });
  }

  return { periodMonth, results };
}

// ── Retry of individual failed sends ────────────────────────────────────────
// statementSendRuns rows that ended in `failed` keep their `nextAttemptAt`
// stamp until the configured maximum attempts is reached. The retry tick
// (and the manual /retry route) re-builds the PDF from current invoice data
// for the same period and re-sends to the same address.

export interface RetryResult {
  runId: string;
  status: "sent" | "failed" | "skipped_no_email" | "skipped_opted_out";
  attemptCount: number;
  errorMessage?: string;
}

async function attemptStatementSendForRun(runId: string): Promise<RetryResult> {
  const run = await db.query.statementSendRuns.findFirst({
    where: eq(statementSendRuns.id, runId),
  });
  if (!run) {
    throw new Error(`statementSendRun ${runId} not found`);
  }
  if (run.status === "sent") {
    return {
      runId,
      status: "sent",
      attemptCount: run.attemptCount,
    };
  }

  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, run.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const retryPlacements = resolveLocalLogoplacements(labOrg);
  const retryLogoBuffer = retryPlacements.has("statements")
    ? await readLogoBuffer(run.labOrganizationId)
    : null;
  const retryEmailLogoUrl =
    retryPlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  // Re-resolve the practice's billing email and opt-out flag — they may have
  // been corrected between the original failed attempt and the retry.
  let practiceEmail = run.practiceEmail;
  let practiceName = run.practiceName;
  let practiceOptedOut = false;
  if (run.practiceOrganizationId) {
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, run.practiceOrganizationId),
    });
    if (practice) {
      practiceEmail = practice.billingEmail || null;
      practiceName = practice.displayName || practice.name || practiceName;
      practiceOptedOut = practice.statementEmailOptOut ?? false;
    }
  }

  const [y, m] = run.periodMonth.split("-").map((s) => parseInt(s, 10));
  const periodStart = new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(y!, m!, 1, 0, 0, 0));
  const allForLab = await buildPracticeStatements(
    run.labOrganizationId,
    periodStart,
    periodEnd
  );
  const data =
    allForLab.find((p) => p.practiceId === run.practiceOrganizationId) || null;

  let status: RetryResult["status"] = "sent";
  let errorMessage: string | undefined;

  try {
    if (practiceOptedOut) {
      status = "skipped_opted_out";
      errorMessage = "Practice has opted out of statement emails";
    } else if (!practiceEmail) {
      status = "skipped_no_email";
      errorMessage = "Practice has no billing email on file";
    } else if (!data) {
      // No invoices remain for the period (perhaps all voided/deleted).
      // Treat this as resolved so it stops being retried.
      status = "sent";
    } else {
      const safeName = practiceName.replace(/[^a-z0-9-_]+/gi, "_");
      const filename = `statement-${safeName}-${run.periodMonth}.pdf`;
      const pdfBuffer = await generateStatementPdfBuffer(
        labName,
        data,
        periodLabel(run.periodMonth),
        retryLogoBuffer,
        (labOrg as any)?.logoPdfSize
      );
      const result = await sendStatementEmail({
        to: practiceEmail,
        fromName: labName,
        practiceName,
        periodLabel: periodLabel(run.periodMonth),
        pdfBuffer,
        pdfFilename: filename,
        totals: { billed: data.totalBilled, open: data.openBalance },
        labLogoUrl: retryEmailLogoUrl,
      });
      if (!result.delivered) {
        status = "failed";
        errorMessage = result.reason || "Email send failed";
      }
    }
  } catch (err: unknown) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, runId, practiceId: run.practiceOrganizationId },
      "Statement retry send failed"
    );
  }

  const now = new Date();
  const newAttempt = run.attemptCount + 1;
  const delay =
    status === "failed" && newAttempt < STATEMENT_MAX_ATTEMPTS
      ? nextAttemptDelayMs(newAttempt)
      : null;

  // Refresh the snapshot fields from the freshly recomputed data so the
  // history row reflects current numbers after the retry.
  const refreshedTotals = data
    ? {
        invoiceCount: data.invoiceCount,
        totalBilled: data.totalBilled.toFixed(2),
        openBalance: data.openBalance.toFixed(2),
      }
    : {
        invoiceCount: run.invoiceCount,
        totalBilled: run.totalBilled,
        openBalance: run.openBalance,
      };

  await db
    .update(statementSendRuns)
    .set({
      status,
      errorMessage: errorMessage ?? null,
      practiceEmail,
      practiceName,
      attemptCount: newAttempt,
      lastAttemptAt: now,
      nextAttemptAt: delay !== null ? new Date(now.getTime() + delay) : null,
      invoiceCount: refreshedTotals.invoiceCount,
      totalBilled: refreshedTotals.totalBilled,
      openBalance: refreshedTotals.openBalance,
    })
    .where(eq(statementSendRuns.id, runId));

  // On success, bump the parent schedule's lastRunAt. Only advance
  // lastSentForMonth if this run's period is NOT older than what the
  // schedule already has — otherwise retrying a stale failed row could
  // rewind the marker and cause processDueSchedules to re-send a newer
  // month that's already complete.
  if (status === "sent") {
    await db
      .update(statementSchedules)
      .set({
        lastRunAt: now,
        lastSentForMonth: run.periodMonth,
      })
      .where(
        and(
          eq(statementSchedules.labOrganizationId, run.labOrganizationId),
          or(
            isNull(statementSchedules.lastSentForMonth),
            lte(statementSchedules.lastSentForMonth, run.periodMonth)
          )
        )
      )
      .catch(() => {
        /* schedule may not exist for manually-triggered labs */
      });
    // If the conditional update above didn't match (because the schedule
    // is already at a newer period), still bump lastRunAt without
    // touching lastSentForMonth.
    await db
      .update(statementSchedules)
      .set({ lastRunAt: now })
      .where(eq(statementSchedules.labOrganizationId, run.labOrganizationId))
      .catch(() => {
        /* best effort */
      });
  }

  return {
    runId,
    status,
    attemptCount: newAttempt,
    errorMessage,
  };
}

export async function retryStatementSendRun(
  runId: string
): Promise<RetryResult> {
  return attemptStatementSendForRun(runId);
}

// ── On-demand batch-send helpers ─────────────────────────────────────────────

export type InvoiceScope = "open" | "open_overdue_90" | "all";

/**
 * Builds practice statement data scoped by invoice status (not calendar period).
 * Used by the on-demand batch-send modal.
 *
 * - "open" / "open_overdue_90": non-paid, non-voided invoices; practices with
 *   zero open balance are excluded.
 * - "all": every invoice regardless of status.
 *
 * When practiceIds is non-empty, only those practices are returned.
 */
export async function buildPracticeStatementsForScope(
  labOrganizationId: string,
  scope: InvoiceScope,
  practiceIds?: string[] | null
): Promise<PracticeStatementData[]> {
  const rows = await db.query.invoices.findMany({
    where:
      scope === "all"
        ? eq(invoices.labOrganizationId, labOrganizationId)
        : and(
            eq(invoices.labOrganizationId, labOrganizationId),
            ne(invoices.status, "paid"),
            ne(invoices.status, "void")
          ),
    orderBy: [asc(invoices.createdAt)],
  });
  if (!rows.length) return [];

  const filterIds =
    practiceIds && practiceIds.length > 0 ? new Set(practiceIds) : null;

  const uniquePracticeIds = Array.from(
    new Set(
      rows
        .map((r) => r.providerOrganizationId)
        .filter((id) => !filterIds || filterIds.has(id))
    )
  );
  if (!uniquePracticeIds.length) return [];

  const practiceRows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, uniquePracticeIds));
  const byId = new Map(practiceRows.map((o) => [o.id, o]));

  const grouped = new Map<string, PracticeStatementData>();
  const invoiceIdMap = new Map<string, { practiceId: string; index: number }>();

  for (const inv of rows) {
    const id = inv.providerOrganizationId;
    if (filterIds && !filterIds.has(id)) continue;
    const org = byId.get(id);
    const cur =
      grouped.get(id) ??
      ({
        practiceId: id,
        practiceName: org?.displayName || org?.name || "Unknown practice",
        practiceEmail: org?.billingEmail || null,
        statementEmailOptOut: org?.statementEmailOptOut ?? false,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        invoices: [],
      } as PracticeStatementData);

    const total = Number(inv.total ?? 0);
    const balance = Number(inv.balanceDue ?? 0);
    cur.invoiceCount += 1;
    cur.totalBilled += total;
    cur.totalPaid += Math.max(0, total - balance);
    if (inv.status !== "void") cur.openBalance += balance;
    const meta = (inv.displayMetadataJson ?? null) as
      | { patientName?: string | null; billTo?: string | null }
      | null;
    invoiceIdMap.set(inv.id, { practiceId: id, index: cur.invoices.length });
    cur.invoices.push({
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
      dueAt: inv.dueAt ?? null,
      status: inv.status,
      total: String(inv.total ?? "0"),
      balanceDue: String(inv.balanceDue ?? "0"),
      patientName: meta?.patientName ?? null,
      billTo: meta?.billTo ?? null,
    });
    grouped.set(id, cur);
  }

  await attachLineItems(grouped, invoiceIdMap);
  const all = Array.from(grouped.values());
  return scope === "all" ? all : all.filter((s) => s.openBalance > 0);
}

/**
 * Sends an SMS notification to a practice phone number via Twilio.
 * Never throws — returns a result object instead.
 */
export async function sendStatementSms(opts: {
  to: string;
  labName: string;
  practiceName: string;
  periodLabel: string;
  openBalance: number;
}): Promise<{ delivered: boolean; reason?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    return { delivered: false, reason: "SMS not configured on server" };
  }
  const body =
    `${opts.labName}: Statement for ${opts.practiceName} — ${opts.periodLabel}. ` +
    `Open balance: ${fmtMoney(opts.openBalance)}. Please contact us with any questions.`;
  const toE164 = normalizePhoneE164(opts.to);
  if (!toE164) {
    return { delivered: false, reason: `Invalid phone number: ${opts.to}` };
  }
  const params = new URLSearchParams();
  params.set("From", from);
  params.set("To", toE164);
  params.set("Body", body);
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );
    if (!r.ok) {
      return { delivered: false, reason: `Twilio HTTP ${r.status}` };
    }
    return { delivered: true };
  } catch (err: any) {
    return { delivered: false, reason: err?.message ?? "SMS send failed" };
  }
}

/**
 * Generates a ZIP archive containing one statement PDF per practice.
 * All PDFs are generated sequentially before the ZIP is assembled.
 */
export async function generateStatementsZipBuffer(
  labName: string,
  statements: PracticeStatementData[],
  label: string,
  logoBuffer: Buffer | null,
  logoPdfSize?: string | null
): Promise<Buffer> {
  const pdfs: Array<{ name: string; buf: Buffer }> = [];
  for (const s of statements) {
    const safeName = s.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    const buf = await generateStatementPdfBuffer(labName, s, label, logoBuffer, logoPdfSize);
    pdfs.push({ name: `statement-${safeName}.pdf`, buf });
  }

  return new Promise<Buffer>((resolve, reject) => {
    const arc = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    arc.on("data", (c: Buffer) => chunks.push(c));
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);
    for (const { name, buf } of pdfs) {
      arc.append(buf, { name });
    }
    arc.finalize();
  });
}

export interface BatchSendResult {
  practiceId: string;
  practiceName: string;
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailError: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  smsError: string | null;
}

/**
 * On-demand batch send: emails and/or SMS for the selected practices and scope.
 * Records each attempt in statementSendRuns for history tracking.
 */
export async function runBatchSendStatements(opts: {
  labOrganizationId: string;
  triggeredByUserId: string;
  practiceIds?: string[] | null;
  invoiceScope: InvoiceScope;
  channels: Array<"email" | "sms">;
  emailSubject?: string | null;
  emailBody?: string | null;
  periodLabel?: string | null;
}): Promise<{ periodLabel: string; results: BatchSendResult[] }> {
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;
  const emailLogoUrl =
    effectivePlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  const sched = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
  });
  const template = {
    subject: opts.emailSubject?.trim() || sched?.emailSubject || null,
    body: opts.emailBody?.trim() || sched?.emailBody || null,
    replyTo: sched?.emailReplyTo || null,
  };

  const label =
    opts.periodLabel?.trim() ||
    `Statement as of ${new Date().toLocaleString("en-US", {
      month: "long",
      year: "numeric",
    })}`;

  const statements = await buildPracticeStatementsForScope(
    opts.labOrganizationId,
    opts.invoiceScope,
    opts.practiceIds ?? null
  );

  const sendEmail = opts.channels.includes("email");
  const sendSms = opts.channels.includes("sms");

  // Fetch phone numbers for SMS channel.
  const practiceOrgIds = statements.map((s) => s.practiceId);
  const phoneById = new Map<string, string | null>();
  if (sendSms && practiceOrgIds.length) {
    const phoneRows = await db
      .select({ id: organizations.id, phone: organizations.phone })
      .from(organizations)
      .where(inArray(organizations.id, practiceOrgIds));
    for (const r of phoneRows) phoneById.set(r.id, r.phone);
  }

  const periodMonthStr = new Date().toISOString().slice(0, 7);
  const results: BatchSendResult[] = [];

  for (const s of statements) {
    const safeName = s.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    const filename = `statement-${safeName}-${periodMonthStr}.pdf`;

    let emailStatus: BatchSendResult["emailStatus"] = null;
    let emailError: string | null = null;
    let smsStatus: BatchSendResult["smsStatus"] = null;
    let smsError: string | null = null;

    if (sendEmail) {
      if (s.statementEmailOptOut) {
        emailStatus = "skipped";
        emailError = "Practice opted out of statement emails";
      } else if (!s.practiceEmail) {
        emailStatus = "skipped";
        emailError = "No billing email on file";
      } else {
        try {
          const pdfBuffer = await generateStatementPdfBuffer(
            labName,
            s,
            label,
            logoBuffer,
            (labOrg as any)?.logoPdfSize
          );
          const er = await sendStatementEmail({
            to: s.practiceEmail,
            fromName: labName,
            practiceName: s.practiceName,
            periodLabel: label,
            pdfBuffer,
            pdfFilename: filename,
            totals: { billed: s.totalBilled, open: s.openBalance },
            template,
            labLogoUrl: emailLogoUrl,
          });
          emailStatus = er.delivered ? "sent" : "failed";
          if (!er.delivered) emailError = er.reason ?? "Email send failed";
        } catch (err: any) {
          emailStatus = "failed";
          emailError = err?.message ?? "Email send failed";
          logger.error(
            { err, practiceId: s.practiceId },
            "Batch statement email failed"
          );
        }
      }
    }

    if (sendSms) {
      const phone = phoneById.get(s.practiceId) ?? null;
      if (!phone) {
        smsStatus = "skipped";
        smsError = "No phone number on file";
      } else {
        const sr = await sendStatementSms({
          to: phone,
          labName,
          practiceName: s.practiceName,
          periodLabel: label,
          openBalance: s.openBalance,
        });
        smsStatus = sr.delivered ? "sent" : "failed";
        if (!sr.delivered) smsError = sr.reason ?? "SMS send failed";
      }
    }

    const runStatus: string =
      emailStatus === "failed" || smsStatus === "failed"
        ? "failed"
        : (!sendEmail || emailStatus === "skipped") &&
            (!sendSms || smsStatus === "skipped")
          ? "skipped_no_email"
          : "sent";

    await db.insert(statementSendRuns).values({
      labOrganizationId: opts.labOrganizationId,
      practiceOrganizationId: s.practiceId,
      practiceName: s.practiceName,
      practiceEmail: s.practiceEmail,
      periodMonth: periodMonthStr,
      status: runStatus,
      errorMessage: [emailError, smsError].filter(Boolean).join("; ") || null,
      invoiceCount: s.invoiceCount,
      totalBilled: s.totalBilled.toFixed(2),
      openBalance: s.openBalance.toFixed(2),
      triggeredBy: "manual",
      triggeredByUserId: opts.triggeredByUserId,
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
    });

    results.push({
      practiceId: s.practiceId,
      practiceName: s.practiceName,
      emailStatus,
      emailError,
      smsStatus,
      smsError,
    });
  }

  return { periodLabel: label, results };
}

/**
 * Generates a ZIP buffer for all matching practices — with logo — ready to
 * stream back as a download response. This keeps logo resolution out of the
 * route layer.
 */
export async function generateStatementsZipBufferForLab(opts: {
  labOrganizationId: string;
  practiceIds?: string[] | null;
  invoiceScope: InvoiceScope;
  periodLabel?: string | null;
}): Promise<{ zipBuffer: Buffer; filename: string; periodLabel: string }> {
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;

  const label =
    opts.periodLabel?.trim() ||
    `Statement as of ${new Date().toLocaleString("en-US", {
      month: "long",
      year: "numeric",
    })}`;

  const statements = await buildPracticeStatementsForScope(
    opts.labOrganizationId,
    opts.invoiceScope,
    opts.practiceIds ?? null
  );

  if (!statements.length) {
    throw new Error("No invoices found for the selected practices and scope.");
  }

  const zipBuffer = await generateStatementsZipBuffer(
    labName,
    statements,
    label,
    logoBuffer,
    (labOrg as any)?.logoPdfSize
  );
  const dateStr = new Date().toISOString().slice(0, 10);
  return { zipBuffer, filename: `statements-${dateStr}.zip`, periodLabel: label };
}

export async function processDueRetries(asOf: Date = new Date()): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  const due = await db
    .select({ id: statementSendRuns.id })
    .from(statementSendRuns)
    .where(
      and(
        eq(statementSendRuns.status, "failed"),
        lt(statementSendRuns.attemptCount, STATEMENT_MAX_ATTEMPTS),
        // nextAttemptAt is set when more retries remain
        lte(statementSendRuns.nextAttemptAt, asOf)
      )
    )
    .limit(100);

  let succeeded = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const r = await attemptStatementSendForRun(row.id);
      if (r.status === "sent") succeeded += 1;
      else if (r.status === "failed") failed += 1;
    } catch (err: unknown) {
      failed += 1;
      logger.error(
        { err, runId: row.id },
        "Unexpected error while retrying statement send"
      );
    }
  }
  if (due.length) {
    logger.info(
      { attempted: due.length, succeeded, failed },
      "Statement retry tick complete"
    );
  }
  return { attempted: due.length, succeeded, failed };
}

// ── Daily scheduler ─────────────────────────────────────────────────────────
// Wakes once per day and processes any enabled lab schedules whose
// `dayOfMonth` matches today (clamped to last day of month) and that have
// not yet been sent for the prior month.

let scheduled = false;

function msUntilNextHour(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      5,
      0,
      0
    )
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export async function processDueSchedules(asOf: Date = new Date()): Promise<void> {
  const todayDay = asOf.getUTCDate();
  const lastDay = lastDayOfMonth(asOf.getUTCFullYear(), asOf.getUTCMonth());
  const { periodMonth } = priorMonthRange(asOf);

  const due = await db.query.statementSchedules.findMany({
    where: eq(statementSchedules.enabled, true),
  });

  for (const sched of due) {
    // dayOfMonth = 0 means "last day of month" — fire on the true last calendar
    // day of the current month. Values 1–31 are clamped to the month's actual
    // length so admins picking 31 still get sent on Feb 28/29, Apr 30, etc.
    const target =
      sched.dayOfMonth === 0
        ? lastDay
        : Math.min(Math.max(1, sched.dayOfMonth), lastDay);
    // Catch-up semantics: run any time on or after the target day this month
    // if we have not yet sent for the prior month. This covers brief outages
    // and process restarts on the target day without resending.
    if (todayDay < target) continue;
    if (sched.lastSentForMonth === periodMonth) continue;

    // DB-level in-progress lease: atomically claim the (lab, periodMonth)
    // run so a concurrent tick / second app instance cannot double-send.
    // The lease is short-lived (LEASE_MS) so a crash mid-run leaves it
    // recoverable on the next tick instead of permanently blocking the
    // month. lastSentForMonth is only stamped after the run completes.
    const LEASE_MS = 30 * 60 * 1000; // 30 minutes
    const leaseCutoff = new Date(asOf.getTime() - LEASE_MS);
    const claimed = await db
      .update(statementSchedules)
      .set({ inProgressForMonth: periodMonth, inProgressLeasedAt: asOf })
      .where(
        and(
          eq(statementSchedules.id, sched.id),
          // Don't reclaim a period we've already finished sending.
          or(
            isNull(statementSchedules.lastSentForMonth),
            ne(statementSchedules.lastSentForMonth, periodMonth)
          ),
          // Acquire only when no live lease exists for this period.
          or(
            isNull(statementSchedules.inProgressForMonth),
            ne(statementSchedules.inProgressForMonth, periodMonth),
            isNull(statementSchedules.inProgressLeasedAt),
            lt(statementSchedules.inProgressLeasedAt, leaseCutoff)
          )
        )
      )
      .returning({ id: statementSchedules.id });
    if (!claimed.length) continue;

    try {
      logger.info(
        { labOrganizationId: sched.labOrganizationId, periodMonth },
        "Running scheduled monthly statements"
      );
      const result = await runMonthlyStatementsForLab({
        labOrganizationId: sched.labOrganizationId,
        triggeredBy: "schedule",
        asOf,
      });
      const sent = result.results.filter((r) => r.status === "sent").length;
      const failed = result.results.filter((r) => r.status === "failed").length;
      const skipped = result.results.filter(
        (r) => r.status === "skipped_no_email"
      ).length;
      const optedOut = result.results.filter(
        (r) => r.status === "skipped_opted_out"
      ).length;
      logger.info(
        {
          labOrganizationId: sched.labOrganizationId,
          periodMonth,
          sent,
          failed,
          skipped,
          optedOut,
        },
        "Scheduled monthly statements complete"
      );
      // Mark the period fully sent only on completion. We treat any
      // delivery attempt (sent / failed / skipped_no_email) as a recorded
      // outcome for this lab+period; the per-practice statementSendRuns
      // table is the source of truth, so we don't auto-retry the whole lab
      // on the next day. Individual failed practices can be retried by an
      // admin via "Send last month now" or a future per-row retry.
      await db
        .update(statementSchedules)
        .set({
          lastSentForMonth: periodMonth,
          lastRunAt: new Date(),
          inProgressForMonth: null,
          inProgressLeasedAt: null,
        })
        .where(eq(statementSchedules.id, sched.id));
    } catch (err: unknown) {
      // Release the lease so the next tick (today or tomorrow) retries.
      // lastSentForMonth is intentionally NOT set, so the period stays
      // claim-eligible.
      await db
        .update(statementSchedules)
        .set({ inProgressForMonth: null, inProgressLeasedAt: null })
        .where(eq(statementSchedules.id, sched.id))
        .catch(() => {
          /* swallow: best-effort lease release */
        });
      logger.error(
        { err, labOrganizationId: sched.labOrganizationId, periodMonth },
        "Scheduled statement run failed; lease released for retry"
      );
    }
  }
}

export function startStatementScheduler() {
  if (scheduled) return;
  scheduled = true;
  const hourUtc = Math.max(
    0,
    Math.min(
      23,
      parseInt(process.env.STATEMENTS_HOUR_UTC || "8", 10) || 8
    )
  );
  const tick = async () => {
    try {
      await processDueSchedules(new Date());
    } catch (err: unknown) {
      logger.error({ err }, "Statement scheduler tick failed");
    } finally {
      setTimeout(tick, msUntilNextHour(hourUtc));
    }
  };
  const initial = msUntilNextHour(hourUtc);
  logger.info(
    { hourUtc, firstRunInMin: Math.round(initial / 60000) },
    "Monthly statement scheduler armed"
  );
  setTimeout(tick, initial);

  // Independent retry tick: runs every RETRY_INTERVAL_MS to pick up any
  // failed sends whose backoff has elapsed. Decoupled from the once-a-day
  // schedule tick so retries don't have to wait for tomorrow.
  const RETRY_INTERVAL_MS = Math.max(
    60 * 1000,
    parseInt(process.env.STATEMENTS_RETRY_INTERVAL_MS || "", 10) ||
      15 * 60 * 1000
  );
  const retryTick = async () => {
    try {
      await processDueRetries(new Date());
    } catch (err: unknown) {
      logger.error({ err }, "Statement retry tick failed");
    } finally {
      setTimeout(retryTick, RETRY_INTERVAL_MS);
    }
  };
  // Stagger initial retry tick a bit after boot so we don't hammer SMTP
  // at the same moment as the daily scheduler tick.
  setTimeout(retryTick, Math.min(RETRY_INTERVAL_MS, 2 * 60 * 1000));
  logger.info(
    { intervalMs: RETRY_INTERVAL_MS },
    "Statement retry scheduler armed"
  );
}
