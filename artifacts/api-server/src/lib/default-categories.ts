/**
 * Per-lab Accounts Receivable / Accounts Payable seeding & resolution.
 *
 * Every LabTrax lab gets two system-default transaction categories:
 *   - "Accounts Receivable" (kind: "income",  categoryType: "accounts_receivable")
 *   - "Accounts Payable"    (kind: "expense",  categoryType: "accounts_payable")
 *
 * ensureDefaultCategories() is idempotent — cheap SELECT on warm path,
 * one or two INSERTs only on the cold path. Call it from within an existing
 * DB transaction by passing the `tx` handle; omit it to use the module-level
 * `db` directly.
 */

import { db, transactionCategories } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export interface DefaultCategoryRow {
  id: string;
  labOrganizationId: string;
  name: string;
  kind: string;
  categoryType: string;
}

export interface DefaultCategories {
  accountsReceivable: DefaultCategoryRow;
  accountsPayable: DefaultCategoryRow;
}

const DEFAULT_DEFS = [
  {
    categoryType: "accounts_receivable" as const,
    name: "Accounts Receivable",
    kind: "income",
  },
  {
    categoryType: "accounts_payable" as const,
    name: "Accounts Payable",
    kind: "expense",
  },
] as const;

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ensure AR and AP categories exist for `orgId` and return both rows.
 * Pass a Drizzle transaction handle as `tx` to run the upsert inside it.
 *
 * Resilience rules:
 * 1. First look up rows by `categoryType` (fast warm path).
 * 2. For any still missing, try to adopt an existing same-name row by
 *    setting `categoryType` on it (handles labs created before this feature).
 * 3. Only if no same-name row exists do we INSERT a new row.
 */
export async function ensureDefaultCategories(
  orgId: string,
  tx?: DbOrTx,
): Promise<DefaultCategories> {
  const runner = tx ?? db;

  const SELECT_COLS = {
    id: transactionCategories.id,
    labOrganizationId: transactionCategories.labOrganizationId,
    name: transactionCategories.name,
    kind: transactionCategories.kind,
    categoryType: transactionCategories.categoryType,
  } as const;

  // ── Step 1: fast path — rows already tagged by categoryType ──────────────
  const tagged = await (runner as typeof db)
    .select(SELECT_COLS)
    .from(transactionCategories)
    .where(
      and(
        eq(transactionCategories.labOrganizationId, orgId),
        inArray(transactionCategories.categoryType, [
          "accounts_receivable",
          "accounts_payable",
        ]),
      ),
    );

  const byType = new Map(tagged.map((r) => [r.categoryType, r]));

  const needResolution = DEFAULT_DEFS.filter((d) => !byType.has(d.categoryType));
  if (needResolution.length === 0) {
    return {
      accountsReceivable: byType.get("accounts_receivable") as DefaultCategoryRow,
      accountsPayable: byType.get("accounts_payable") as DefaultCategoryRow,
    };
  }

  // ── Step 2: adopt existing same-name rows that lack categoryType ──────────
  for (const def of needResolution) {
    const [existing] = await (runner as typeof db)
      .select(SELECT_COLS)
      .from(transactionCategories)
      .where(
        and(
          eq(transactionCategories.labOrganizationId, orgId),
          eq(transactionCategories.name, def.name),
        ),
      )
      .limit(1);

    if (existing) {
      // Backfill categoryType on the existing row.
      const [updated] = await (runner as typeof db)
        .update(transactionCategories)
        .set({ categoryType: def.categoryType, updatedAt: new Date() })
        .where(eq(transactionCategories.id, existing.id))
        .returning(SELECT_COLS);
      if (updated) byType.set(def.categoryType, updated);
    }
  }

  // ── Step 3: INSERT any that are still missing after the adoption pass ─────
  const stillMissing = DEFAULT_DEFS.filter((d) => !byType.has(d.categoryType));
  if (stillMissing.length > 0) {
    const inserted = await (runner as typeof db)
      .insert(transactionCategories)
      .values(
        stillMissing.map((d) => ({
          labOrganizationId: orgId,
          name: d.name,
          kind: d.kind,
          categoryType: d.categoryType,
        })),
      )
      .onConflictDoNothing()
      .returning(SELECT_COLS);

    for (const r of inserted) {
      if (r.categoryType) byType.set(r.categoryType, r);
    }

    // onConflictDoNothing is silent on duplicate-name rows — re-read to be safe.
    if (stillMissing.some((d) => !byType.has(d.categoryType))) {
      const reread = await (runner as typeof db)
        .select(SELECT_COLS)
        .from(transactionCategories)
        .where(
          and(
            eq(transactionCategories.labOrganizationId, orgId),
            inArray(
              transactionCategories.categoryType,
              stillMissing.map((d) => d.categoryType as string),
            ),
          ),
        );
      for (const r of reread) {
        if (r.categoryType) byType.set(r.categoryType, r);
      }
    }
  }

  const ar = byType.get("accounts_receivable");
  const ap = byType.get("accounts_payable");

  if (!ar || !ap) {
    throw new Error(
      `ensureDefaultCategories: could not resolve AR/AP for org ${orgId}`,
    );
  }

  return {
    accountsReceivable: ar as DefaultCategoryRow,
    accountsPayable: ap as DefaultCategoryRow,
  };
}
