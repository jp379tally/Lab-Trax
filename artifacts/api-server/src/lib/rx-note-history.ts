import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { caseRxNoteEntries, cases } from "@workspace/db";
import { HttpError } from "./http";

export type RxNoteProvenance =
  | "legacy"
  | "ai_reader"
  | "itero_import"
  | "case_intake";

function normalizedNote(noteText: string): string {
  return noteText;
}

function hashNote(noteText: string): string {
  return createHash("sha256").update(noteText, "utf8").digest("hex");
}

/** Serialize scanner appends and manual edits on the same case. */
export async function lockRxNoteCase(tx: any, caseId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(1742068891, hashtext(${caseId}))`,
  );
}

async function ensureLegacyBaseline(
  tx: any,
  caseId: string,
  currentNotes: string | null | undefined,
  existingCount: number,
): Promise<void> {
  const legacyText = normalizedNote(currentNotes ?? "");
  if (existingCount || !legacyText.trim()) return;
  await tx.insert(caseRxNoteEntries).values({
    caseId,
    noteText: legacyText,
    scannedAt: null,
    provenance: "legacy",
  });
}

/**
 * Append one accepted prescription scan. The submission key is unique per
 * case; replaying the same key and payload returns the original row, while
 * reusing it for changed text is rejected.
 */
export async function appendRxNoteEntry(
  tx: any,
  input: {
    caseId: string;
    submissionId: string;
    noteText: string;
    provenance: Exclude<RxNoteProvenance, "legacy">;
    scannedAt?: Date;
    preserveCurrentAsLegacy?: boolean;
  },
) {
  const noteText = normalizedNote(input.noteText);
  if (!noteText.trim()) throw new HttpError(400, "Prescription notes cannot be blank.");
  await lockRxNoteCase(tx, input.caseId);

  const payloadHash = hashNote(noteText);
  const existing = await tx
    .select()
    .from(caseRxNoteEntries)
    .where(
      and(
        eq(caseRxNoteEntries.caseId, input.caseId),
        eq(caseRxNoteEntries.submissionId, input.submissionId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].payloadHash !== payloadHash) {
      throw new HttpError(
        409,
        "This prescription submission was already saved with different notes.",
      );
    }
    return existing[0];
  }

  const current = await tx
    .select({ rxNotes: cases.rxNotes })
    .from(cases)
    .where(eq(cases.id, input.caseId))
    .limit(1);
  if (!current[0]) throw new HttpError(404, "Case not found.");
  const history = await tx
    .select({ id: caseRxNoteEntries.id })
    .from(caseRxNoteEntries)
    .where(eq(caseRxNoteEntries.caseId, input.caseId));
  if (input.preserveCurrentAsLegacy !== false) {
    await ensureLegacyBaseline(
      tx,
      input.caseId,
      current[0].rxNotes,
      history.length,
    );
  }

  const [entry] = await tx
    .insert(caseRxNoteEntries)
    .values({
      caseId: input.caseId,
      noteText,
      scannedAt: input.scannedAt ?? new Date(),
      provenance: input.provenance,
      submissionId: input.submissionId,
      payloadHash,
    })
    .returning();
  await tx
    .update(cases)
    .set({ rxNotes: noteText })
    .where(eq(cases.id, input.caseId));
  return entry;
}

/**
 * Save the compatibility editor's current value in place. This does not
 * create a scan submission or change an existing scan timestamp.
 */
export async function saveActiveRxNote(
  tx: any,
  caseId: string,
  noteText: string | null,
): Promise<void> {
  await lockRxNoteCase(tx, caseId);
  const current = await tx
    .select({ rxNotes: cases.rxNotes })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!current[0]) throw new HttpError(404, "Case not found.");
  const history = await tx
    .select()
    .from(caseRxNoteEntries)
    .where(eq(caseRxNoteEntries.caseId, caseId))
    .orderBy(
      sql`${caseRxNoteEntries.scannedAt} DESC NULLS LAST`,
      sql`${caseRxNoteEntries.createdAt} DESC`,
      sql`${caseRxNoteEntries.id} DESC`,
    );
  await ensureLegacyBaseline(tx, caseId, current[0].rxNotes, history.length);
  const active =
    history[0] ??
    (await tx
      .select()
      .from(caseRxNoteEntries)
      .where(eq(caseRxNoteEntries.caseId, caseId))
      .orderBy(
        sql`${caseRxNoteEntries.scannedAt} DESC NULLS LAST`,
        sql`${caseRxNoteEntries.createdAt} DESC`,
        sql`${caseRxNoteEntries.id} DESC`,
      )
      .limit(1))[0];
  const submittedText = noteText ?? "";
  const cleanText = submittedText.trim() ? submittedText : "";
  if (active) {
    await tx
      .update(caseRxNoteEntries)
      .set({ noteText: cleanText })
      .where(eq(caseRxNoteEntries.id, active.id));
  } else if (cleanText) {
    await tx.insert(caseRxNoteEntries).values({
      caseId,
      noteText: cleanText,
      scannedAt: null,
      provenance: "legacy",
    });
  }
  await tx
    .update(cases)
    .set({ rxNotes: cleanText || null })
    .where(eq(cases.id, caseId));
}

export async function listRxNoteEntries(tx: any, caseIds: string[]) {
  if (!caseIds.length) return [];
  const rows = await tx
    .select()
    .from(caseRxNoteEntries)
    .where(inArray(caseRxNoteEntries.caseId, caseIds));
  const rank = new Map(caseIds.map((id, index) => [id, index]));
  return rows.sort((a: any, b: any) => {
    const caseOrder = (rank.get(a.caseId) ?? 0) - (rank.get(b.caseId) ?? 0);
    if (caseOrder) return caseOrder;
    if (a.scannedAt == null && b.scannedAt != null) return -1;
    if (a.scannedAt != null && b.scannedAt == null) return 1;
    const dateOrder =
      a.scannedAt && b.scannedAt
        ? new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime()
        : 0;
    return (
      dateOrder ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      String(a.id).localeCompare(String(b.id))
    );
  });
}
