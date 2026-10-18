import { db, supportReportAttachments, supportReports } from "@workspace/db";

type ReportIntake = typeof supportReports.$inferInsert;
type AttachmentIntake = Omit<typeof supportReportAttachments.$inferInsert, "reportId">;

export async function persistSupportReportIntake(
  report: ReportIntake,
  attachments: AttachmentIntake[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(supportReports).values(report)
      .onConflictDoNothing()
      .returning({ id: supportReports.id });
    if (!created) return false;
    if (attachments.length) {
      await tx.insert(supportReportAttachments).values(
        attachments.map((attachment) => ({ ...attachment, reportId: report.id! })),
      );
    }
    return true;
  });
}