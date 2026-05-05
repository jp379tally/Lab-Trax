import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { and, asc, eq, gte, inArray, lt, or, isNull, ne, lte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  invoices,
  organizations,
  statementSchedules,
  statementSendRuns,
} from "@workspace/db";
import { logger } from "./logger";

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

export interface PracticeStatementData {
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
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
  }>;
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

export async function buildPracticeStatements(
  labOrganizationId: string,
  periodStart: Date,
  periodEnd: Date
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

  const practiceIds = Array.from(
    new Set(rows.map((r) => r.providerOrganizationId))
  );
  const practiceRows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, practiceIds));
  type OrgRow = (typeof practiceRows)[number];
  const byId = new Map<string, OrgRow>(
    practiceRows.map((o) => [o.id, o] as const)
  );

  const grouped = new Map<string, PracticeStatementData>();
  for (const inv of rows) {
    const id = inv.providerOrganizationId;
    const org = byId.get(id);
    const cur =
      grouped.get(id) ||
      ({
        practiceId: id,
        practiceName: org?.displayName || org?.name || "Unknown practice",
        practiceEmail: org?.billingEmail || null,
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
    cur.invoices.push({
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
      dueAt: inv.dueAt ?? null,
      status: inv.status,
      total: String(inv.total ?? "0"),
      balanceDue: String(inv.balanceDue ?? "0"),
    });
    grouped.set(id, cur);
  }
  return Array.from(grouped.values());
}

export async function generateStatementPdfBuffer(
  labName: string,
  data: PracticeStatementData,
  periodLabel: string
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

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
    const colWidths = [110, 90, 90, 90, 80, 80];
    const headers = ["Invoice", "Issued", "Due", "Status", "Total", "Balance"];
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
    let x = startX;
    headers.forEach((h, i) => {
      doc.text(h, x, y, { width: colWidths[i], align: i >= 4 ? "right" : "left" });
      x += colWidths[i]!;
    });
    doc.fillColor("#000");
    y += 14;
    doc
      .moveTo(startX, y - 2)
      .lineTo(startX + colWidths.reduce((a, b) => a + b!, 0), y - 2)
      .strokeColor("#ccc")
      .stroke();

    doc.font("Helvetica").fontSize(9);
    for (const inv of data.invoices) {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = doc.y;
      }
      const cells = [
        inv.invoiceNumber,
        fmtDate(inv.issuedAt),
        fmtDate(inv.dueAt),
        inv.status,
        fmtMoney(Number(inv.total)),
        fmtMoney(Number(inv.balanceDue)),
      ];
      x = startX;
      cells.forEach((c, i) => {
        doc.text(c, x, y, { width: colWidths[i], align: i >= 4 ? "right" : "left" });
        x += colWidths[i]!;
      });
      y += 16;
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

export async function sendStatementEmail(opts: {
  to: string;
  fromName: string;
  practiceName: string;
  periodLabel: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  totals: { billed: number; open: number };
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
  await transporter.sendMail({
    from: `${opts.fromName} <${smtp.from}>`,
    to: opts.to,
    subject: `Statement for ${opts.practiceName} — ${opts.periodLabel}`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px;">
        <p>Hello,</p>
        <p>Please find attached the statement for <strong>${opts.practiceName}</strong> covering ${opts.periodLabel}.</p>
        <p>Total billed: <strong>${fmtMoney(opts.totals.billed)}</strong><br/>
           Open balance: <strong>${fmtMoney(opts.totals.open)}</strong></p>
        <p>Thank you,<br/>${opts.fromName}</p>
      </div>`,
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
  status: "sent" | "failed" | "skipped_no_email";
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

  const statements = await buildPracticeStatements(
    opts.labOrganizationId,
    start,
    end
  );

  const results: RunResultRow[] = [];
  for (const s of statements) {
    const safeName = s.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    const filename = `statement-${safeName}-${periodMonth}.pdf`;
    let status: RunResultRow["status"] = "sent";
    let errorMessage: string | undefined;

    try {
      if (!s.practiceEmail) {
        status = "skipped_no_email";
        errorMessage = "Practice has no billing email on file";
      } else {
        const pdfBuffer = await generateStatementPdfBuffer(
          labName,
          s,
          periodLabel(periodMonth)
        );
        const result = await sendStatementEmail({
          to: s.practiceEmail,
          fromName: labName,
          practiceName: s.practiceName,
          periodLabel: periodLabel(periodMonth),
          pdfBuffer,
          pdfFilename: filename,
          totals: { billed: s.totalBilled, open: s.openBalance },
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
  status: "sent" | "failed" | "skipped_no_email";
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

  // Re-resolve the practice's billing email — it may have been corrected
  // between the original failed attempt and the retry.
  let practiceEmail = run.practiceEmail;
  let practiceName = run.practiceName;
  if (run.practiceOrganizationId) {
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, run.practiceOrganizationId),
    });
    if (practice) {
      practiceEmail = practice.billingEmail || null;
      practiceName = practice.displayName || practice.name || practiceName;
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
    if (!practiceEmail) {
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
        periodLabel(run.periodMonth)
      );
      const result = await sendStatementEmail({
        to: practiceEmail,
        fromName: labName,
        practiceName,
        periodLabel: periodLabel(run.periodMonth),
        pdfBuffer,
        pdfFilename: filename,
        totals: { billed: data.totalBilled, open: data.openBalance },
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
    // Clamp the chosen day to the current month's last day so admins picking
    // 31 still get sent on Feb 28/29, Apr 30, etc.
    const target = Math.min(Math.max(1, sched.dayOfMonth), lastDay);
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
      logger.info(
        {
          labOrganizationId: sched.labOrganizationId,
          periodMonth,
          sent,
          failed,
          skipped,
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
