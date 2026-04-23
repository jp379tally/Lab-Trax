import type { Request } from "express";
import { db } from "../db";
import { auditLogs } from "../../shared/schema";

type AuditInput = {
  req?: Request;
  userId?: string | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  metadataJson?: unknown;
};

export async function writeAuditLog(input: AuditInput) {
  try {
    await db.insert(auditLogs).values({
      userId: input.userId ?? (input.req as any)?.auth?.userId ?? null,
      organizationId: input.organizationId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ipAddress: input.req?.ip ?? null,
      userAgent: input.req?.get("user-agent") ?? null,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      metadataJson: (input.metadataJson as Record<string, unknown>) ?? {},
    });
  } catch (err) {
    console.error("[AUDIT] Failed to write audit log:", err);
  }
}
