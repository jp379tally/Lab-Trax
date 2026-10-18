import { and, asc, eq, inArray, isNull, like } from "drizzle-orm";
import { db, organizationJoinRequests, organizations, systemSettings, users } from "@workspace/db";
import { deliverInAppNotification } from "./in-app-notifications";
import { logger } from "./logger";

const PREFIX = "join_request_notification:";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The existing key/value store serves as a small durable outbox. Only the
 * request identity is stored; recipient authority is checked at delivery.
 * Insert alongside the request, never outside its creation transaction.
 */
export async function enqueueJoinRequestNotification(tx: Transaction, requestId: string): Promise<void> {
  await tx.insert(systemSettings).values({
    key: `${PREFIX}${requestId}`,
    value: "pending",
  }).onConflictDoNothing({ target: systemSettings.key });
}

/** Optional IDs keep tests/manual retries confined to their own events. */
export async function processJoinRequestNotifications(requestIds?: readonly string[]): Promise<number> {
  if (requestIds?.length === 0) return 0;
  const events = await db.select({ key: systemSettings.key }).from(systemSettings)
    .where(and(
      like(systemSettings.key, `${PREFIX}%`),
      eq(systemSettings.value, "pending"),
      ...(requestIds ? [inArray(systemSettings.key, requestIds.map((id) => `${PREFIX}${id}`))] : []),
    )).orderBy(asc(systemSettings.updatedAt), asc(systemSettings.key)).limit(50);
  let processed = 0;
  for (const event of events) {
    try {
      const delivered = await db.transaction(async (tx) => {
        // Lock the outbox, not the business row. Multiple instances can sweep
        // safely; notifications and completion commit together.
        const [claimed] = await tx.select().from(systemSettings)
          .where(and(eq(systemSettings.key, event.key), eq(systemSettings.value, "pending")))
          .for("update", { skipLocked: true });
        if (!claimed) return false;
        const requestId = event.key.slice(PREFIX.length);
        const [request] = await tx.select({
          id: organizationJoinRequests.id,
          labId: organizationJoinRequests.labId,
          status: organizationJoinRequests.status,
          username: users.username,
        }).from(organizationJoinRequests)
          .innerJoin(users, eq(users.id, organizationJoinRequests.userId))
          .innerJoin(organizations, eq(organizations.id, organizationJoinRequests.labId))
          .where(and(
            eq(organizationJoinRequests.id, requestId),
            inArray(organizations.type, ["lab", "dental_lab"]),
            eq(organizations.isActive, true),
            isNull(organizations.deletedAt),
          ));
        if (request?.status === "pending") {
          await deliverInAppNotification({
            labOrganizationId: request.labId,
            category: "doctor_practice_message",
            type: "join_request_pending",
            title: "New partnership or join request",
            body: `${request.username} has requested access to your lab. Review the pending request before granting access.`,
            dedupeKey: `join_request_pending:${request.id}`,
            dataJson: {
              joinRequestId: request.id,
              organizationId: request.labId,
              reviewUrl: "/settings?tab=profile",
            },
          }, { executor: tx, retryable: true });
        }
        // Retain a completion marker so repeated enqueue attempts cannot
        // notify newly added admins for the same historical event.
        await tx.update(systemSettings).set({ value: "delivered", updatedAt: new Date() })
          .where(eq(systemSettings.key, event.key));
        return true;
      });
      if (delivered) processed++;
    } catch (err) {
      logger.error({ err, eventKey: event.key }, "Join request notification delivery failed; will retry");
      // Move a failed event behind other pending events to avoid starvation.
      await db.update(systemSettings).set({ updatedAt: new Date() })
        .where(and(eq(systemSettings.key, event.key), eq(systemSettings.value, "pending")))
        .catch((retryErr) => logger.error({ err: retryErr }, "Join request retry timestamp update failed"));
    }
  }
  return processed;
}

export function startJoinRequestNotificationScheduler(): void {
  if (process.env.VITEST) return;
  const tick = async () => {
    try {
      await processJoinRequestNotifications();
    } catch (err) {
      logger.error({ err }, "Join request notification outbox sweep failed");
    } finally {
      setTimeout(tick, 30_000).unref();
    }
  };
  // Catch up after restarts; delivery failures are isolated from HTTP writes.
  void tick();
}
