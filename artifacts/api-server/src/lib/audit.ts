import type { Request } from "express";
import { db } from "@workspace/db";
import { auditLogs } from "@workspace/db";

type AuditInput = {
  req?: Request;
  userId?: string | null;
  organizationId?: string | null;
  /** Alias for organizationId — accepted so call sites can use either name. */
  labId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  metadataJson?: unknown;
  /** Alias for metadataJson — accepted so call sites can use either name. */
  details?: unknown;
};

export async function writeAuditLog(input: AuditInput) {
  try {
    await db.insert(auditLogs).values({
      userId: input.userId ?? (input.req as any)?.auth?.userId ?? null,
      organizationId: input.organizationId ?? input.labId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ipAddress: input.req?.ip ?? null,
      userAgent: input.req?.get("user-agent") ?? null,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      metadataJson:
        ((input.metadataJson ?? input.details) as Record<string, unknown>) ??
        {},
    });
  } catch (err) {
    console.error("[AUDIT] Failed to write audit log:", err);
  }
}
