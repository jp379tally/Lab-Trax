/**
 * Duplicate-detection helper for AI bank-statement imports.
 *
 * For each extracted row, queries bank_transactions for existing entries
 * within a ±2-day window with the same debit/credit direction and exact
 * amount (and matching check number when present). Returns the input rows
 * annotated with duplicateCandidateId and duplicateScore (0–1).
 */

import { and, between, eq, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { bankTransactions } from "@workspace/db";

export interface ExtractedRow {
  rowIndex: number;
  txnDate: string;
  description: string;
  checkNumber: string | null;
  debit: number;
  credit: number;
  confidence: "high" | "medium" | "low";
}

export interface AnnotatedRow extends ExtractedRow {
  duplicateCandidateId: string | null;
  duplicateCandidateDate: string | null;
  duplicateCandidatePayee: string | null;
  duplicateCandidateAmount: number | null;
  duplicateScore: number;
}

export async function findDuplicateCandidates(
  orgId: string,
  accountId: string,
  rows: ExtractedRow[]
): Promise<AnnotatedRow[]> {
  if (!rows.length) return [];

  const MS_PER_DAY = 86_400_000;
  const WINDOW_DAYS = 2;

  const results: AnnotatedRow[] = [];

  for (const row of rows) {
    const base = new Date(row.txnDate).getTime();
    if (isNaN(base)) {
      results.push({ ...row, duplicateCandidateId: null, duplicateCandidateDate: null, duplicateCandidatePayee: null, duplicateCandidateAmount: null, duplicateScore: 0 });
      continue;
    }

    const windowStart = new Date(base - WINDOW_DAYS * MS_PER_DAY);
    const windowEnd = new Date(base + WINDOW_DAYS * MS_PER_DAY);

    const isDebit = row.debit > 0;
    const amount = isDebit ? row.debit : row.credit;

    const candidates = await db.query.bankTransactions.findMany({
      where: and(
        eq(bankTransactions.labOrganizationId, orgId),
        eq(bankTransactions.bankAccountId, accountId),
        isNull(bankTransactions.deletedAt),
        between(bankTransactions.txnDate, windowStart, windowEnd),
      ),
    });

    let best: (typeof candidates)[0] | null = null;
    let bestScore = 0;

    for (const c of candidates) {
      const cAmt = isDebit ? Number(c.debitAmount) : Number(c.creditAmount);
      if (Math.abs(cAmt - amount) > 0.001) continue;

      let score = 0.7;

      const cDate = new Date(c.txnDate).getTime();
      const daysDiff = Math.abs(cDate - base) / MS_PER_DAY;
      if (daysDiff === 0) score += 0.15;
      else if (daysDiff <= 1) score += 0.08;

      if (row.checkNumber && c.checkNumber && row.checkNumber.trim() === c.checkNumber.trim()) {
        score += 0.15;
      }

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    results.push({
      ...row,
      duplicateCandidateId: best?.id ?? null,
      duplicateCandidateDate: best?.txnDate ? (best.txnDate as unknown as Date).toISOString().slice(0, 10) : null,
      duplicateCandidatePayee: best?.payee ?? null,
      duplicateCandidateAmount: best ? (isDebit ? Number(best.debitAmount) : Number(best.creditAmount)) : null,
      duplicateScore: best ? Math.min(bestScore, 1) : 0,
    });
  }

  return results;
}
