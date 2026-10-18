type Query = (sql: string) => Promise<unknown>;

/** Additive only: duplicate data must fail, never be deleted to fit an index. */
export async function installAttachmentSubmissionIndexes(query: Query): Promise<void> {
  await query("CREATE UNIQUE INDEX IF NOT EXISTS case_attachments_submission_unique ON public.case_attachments (case_id, submission_id) WHERE case_id IS NOT NULL AND submission_id IS NOT NULL");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS case_attachments_legacy_submission_unique ON public.case_attachments (lab_case_id, submission_id) WHERE lab_case_id IS NOT NULL AND submission_id IS NOT NULL");
}
