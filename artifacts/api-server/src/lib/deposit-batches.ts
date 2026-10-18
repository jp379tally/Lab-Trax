import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bankDepositBatchMembers,
  bankTransactions,
  pool,
  statementPaymentSessions,
} from "@workspace/db";
import { HttpError } from "./http";
import { SessionAdvisoryLockBundle } from "./session-advisory-lock-bundle";

const DEPOSIT_BATCH_LOCK_NAME = "labtrax:deposit-batch-mutations";

/**
 * Release an unreconciled deposit batch while retaining its membership rows as
 * historical audit. Callers must invoke this inside their existing DB
 * transaction. The transaction advisory fence serializes batch creation,
 * release, and child correction before any row locks are taken.
 */
export async function lockDepositBatchMutations(
  tx: any,
  labOrganizationId: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(
      hashtext(${DEPOSIT_BATCH_LOCK_NAME}),
      hashtext(${labOrganizationId})
    )`,
  );
}

export async function acquireDepositBatchMutationLock(
  labOrganizationId: string,
  existingBundle?: SessionAdvisoryLockBundle,
) {
  const bundle = existingBundle ??
    new SessionAdvisoryLockBundle(await pool.connect());
  const { client } = bundle;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      [DEPOSIT_BATCH_LOCK_NAME, labOrganizationId],
    );
  } catch (error) {
    if (!existingBundle) await bundle.release();
    throw error;
  }
  const releaseLock = bundle.registerUnlock(async () => {
    await client.query(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
        [DEPOSIT_BATCH_LOCK_NAME, labOrganizationId],
    );
  });
  return existingBundle ? releaseLock : () => bundle.release();
}

type BatchLockOptions = {
  fenceHeld?: boolean;
  correctedChildIds?: string[];
};

export async function assertDepositBatchChildReversible(
  tx: any,
  labOrganizationId: string,
  childId: string,
  options: BatchLockOptions = {},
) {
  if (!options.fenceHeld) {
    await lockDepositBatchMutations(tx, labOrganizationId);
  }
  const [child] = await tx.select({
    id: bankTransactions.id,
    labOrganizationId: bankTransactions.labOrganizationId,
  }).from(bankTransactions)
    .where(eq(bankTransactions.id, childId))
    .for("update");
  if (child && child.labOrganizationId !== labOrganizationId) {
    throw new HttpError(404, "Deposit batch child not found.");
  }
  const [member] = await tx.select().from(bankDepositBatchMembers)
    .where(and(
      eq(bankDepositBatchMembers.childBankTransactionId, childId),
      isNull(bankDepositBatchMembers.releasedAt),
    ));
  if (!member) return null;
  const [parent] = await tx.select().from(bankTransactions)
    .where(eq(bankTransactions.id, member.aggregateBankTransactionId))
    .for("update");
  if (parent && parent.labOrganizationId !== labOrganizationId) {
    throw new HttpError(409, "Deposit batch organization mismatch.");
  }
  if (parent?.reconciled) {
    throw new HttpError(409, "A reconciled deposit batch cannot be released.");
  }
  return member;
}

export async function releaseDepositBatch(
  tx: any,
  labOrganizationId: string,
  aggregateId: string,
  options: BatchLockOptions = {},
) {
  if (!options.fenceHeld) {
    await lockDepositBatchMutations(tx, labOrganizationId);
  }
  const [parent] = await tx.select().from(bankTransactions)
    .where(eq(bankTransactions.id, aggregateId)).for("update");
  if (
    !parent ||
    parent.labOrganizationId !== labOrganizationId ||
    parent.source !== "deposit_batch"
  ) {
    throw new HttpError(404, "Deposit batch not found.");
  }
  if (parent.reconciled) {
    throw new HttpError(409, "A reconciled deposit batch cannot be released.");
  }
  const members = await tx.select().from(bankDepositBatchMembers)
    .where(and(
      eq(bankDepositBatchMembers.aggregateBankTransactionId, aggregateId),
      isNull(bankDepositBatchMembers.releasedAt),
    )).for("update");
  const childIds = members.map((m: any) => m.childBankTransactionId);
  if (childIds.length) {
    await tx.select({ id: bankTransactions.id }).from(bankTransactions)
      .where(inArray(bankTransactions.id, childIds))
      .orderBy(asc(bankTransactions.id))
      .for("update");
  }
  await tx.update(bankTransactions).set({ status: "void", updatedAt: new Date() })
    .where(eq(bankTransactions.id, aggregateId));
  if (!childIds.length) return members;
  const releasedAt = new Date();
  await tx.update(bankDepositBatchMembers).set({
    releasedAt,
    releaseOutcome: options.correctedChildIds?.length
      ? sql`CASE WHEN child_bank_transaction_id IN (${sql.join(
        options.correctedChildIds.map((id) => sql`${id}`),
        sql`, `,
      )}) THEN 'corrected' ELSE 'restored' END`
      : "restored",
  })
    .where(and(
      eq(bankDepositBatchMembers.aggregateBankTransactionId, aggregateId),
      isNull(bankDepositBatchMembers.releasedAt),
    ));
  await tx.update(bankTransactions).set({
    status: "posted",
    cleared: false,
    clearedAt: null,
    depositedByUserId: null,
    depositedAt: null,
    updatedAt: releasedAt,
  }).where(inArray(bankTransactions.id, childIds));
  await tx.update(statementPaymentSessions).set({
    status: "undeposited",
    updatedAt: releasedAt,
  }).where(inArray(statementPaymentSessions.bankTransactionId, childIds));
  return members;
}

/** Release every affected batch once, preserving all corrected children. */
export async function releaseBatchesForChildren(
  tx: any,
  labOrganizationId: string,
  childIds: string[],
  options: { fenceHeld?: boolean } = {},
) {
  const ids = [...new Set(childIds)];
  if (!ids.length) return [];
  if (!options.fenceHeld) {
    await lockDepositBatchMutations(tx, labOrganizationId);
  }
  const activeMembers = await tx
    .select({
      aggregateBankTransactionId: bankDepositBatchMembers.aggregateBankTransactionId,
      childBankTransactionId: bankDepositBatchMembers.childBankTransactionId,
    })
    .from(bankDepositBatchMembers)
    .innerJoin(
      bankTransactions,
      eq(bankTransactions.id, bankDepositBatchMembers.childBankTransactionId),
    )
    .where(and(
      inArray(bankDepositBatchMembers.childBankTransactionId, ids),
      isNull(bankDepositBatchMembers.releasedAt),
      eq(bankTransactions.labOrganizationId, labOrganizationId),
    ));
  const byAggregate = new Map<string, string[]>();
  for (const member of activeMembers) {
    const corrected = byAggregate.get(member.aggregateBankTransactionId) ?? [];
    corrected.push(member.childBankTransactionId);
    byAggregate.set(member.aggregateBankTransactionId, corrected);
  }
  const released = [];
  for (const [aggregateId, correctedChildIds] of byAggregate) {
    released.push(...await releaseDepositBatch(tx, labOrganizationId, aggregateId, {
      fenceHeld: true,
      correctedChildIds,
    }));
  }
  return released;
}

export async function releaseBatchForChild(
  tx: any,
  labOrganizationId: string,
  childId: string,
  options: BatchLockOptions = {},
) {
  const member = await assertDepositBatchChildReversible(
    tx,
    labOrganizationId,
    childId,
    options,
  );
  if (!member) return null;
  return releaseDepositBatch(tx, labOrganizationId, member.aggregateBankTransactionId, {
    fenceHeld: true,
    correctedChildIds: [childId],
  });
}
