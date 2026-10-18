import { Router } from "express";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import {
  db,
  scanJobs,
  scanOutputs,
  users,
  organizations,
  organizationMemberships,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { openCaseMediaObjectStream } from "../lib/case-media-object-storage";

const router = Router();

// This is deliberately the only scanner route retained after capture removal:
// old pending-file records can continue resolving their completed output.
async function activeLabMember(userId: string, labId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationMemberships.id, userType: users.userType })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.labId, labId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
        eq(organizations.type, "lab"),
      ),
    )
    .limit(1);
  return Boolean(row && row.userType !== "provider");
}

router.get("/labtrax/scans/:id/outputs/:format", requireAuth, async (req: any, res) => {
  const format = req.params.format;
  if (format !== "ply" && format !== "stl") {
    return res.status(400).json({ ok: false, message: "Output format must be ply or stl." });
  }

  const [job] = await db
    .select()
    .from(scanJobs)
    .where(eq(scanJobs.id, req.params.id))
    .limit(1);
  if (!job || !(await activeLabMember(req.user.id, job.labOrganizationId))) {
    return res.status(404).json({ ok: false, message: "Scan not found." });
  }
  if (job.status !== "completed") {
    return res.status(409).json({ ok: false, message: "Scan outputs are not ready." });
  }

  const [output] = await db
    .select()
    .from(scanOutputs)
    .where(
      and(
        eq(scanOutputs.jobId, job.id),
        eq(scanOutputs.format, format),
        isNotNull(scanOutputs.readyAt),
      ),
    )
    .limit(1);
  if (!output) {
    return res.status(404).json({ ok: false, message: "Output not found." });
  }

  const stream = await openCaseMediaObjectStream(output.storageKey, output.mimeType);
  if (!stream) {
    return res.status(404).json({ ok: false, message: "Output object unavailable." });
  }
  res.setHeader("Content-Type", output.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="scan-${job.id}.${format}"`);
  stream.stream.pipe(res);
  return;
});

export default router;