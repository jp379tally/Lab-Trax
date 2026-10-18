import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db, cases, caseAttachments, caseEvents, legacyCaseMedia } from "@workspace/db";
import { HttpError } from "./http";
import { caseMediaDir, extractMediaFileName } from "./case-media";
import { openCaseMediaObjectStream } from "./case-media-object-storage";
import { getAiClient } from "./ai-openai-client";
import { normalizeCaseHierarchy } from "./case-category";
import { mapAiRemovableSubtype, isAmbiguousRemovableSubtype } from "./ai-removable-subtype";
import { recoveryFingerprint, recoveryWorkSchema } from "./recovery-billing";
import { assertRecoveryDataAvailable, RECOVERY_LAB_ID, RECOVERY_TAG, recoveryScope } from "./recovery-billing-scope";
import type { ExtractedRxFields } from "../routes/cases";
import { BILLING_ROLES, requireAnyRole } from "./rbac";
import { recoveryAnalysisStage } from "./recovery-analysis-errors";

const MAX_PRESCRIPTION_BYTES = 25 * 1024 * 1024;

async function boundedPrescriptionStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PRESCRIPTION_BYTES) {
      (stream as { destroy?: () => void }).destroy?.();
      throw new HttpError(413, "Prescription is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** No inferred ranges or unspecified teeth: ambiguity remains an exception. */
export function recoveredRxWork(extracted: ExtractedRxFields) {
  const exceptions: string[] = [];
  const work: Array<ReturnType<typeof recoveryWorkSchema.parse>> = [];
  if (isAmbiguousRemovableSubtype(extracted.removableSubtype)) {
    exceptions.push("Prescription does not identify the removable repair subtype.");
  }
  const removable = extracted.caseType === "Removable";
  if (removable) {
    const subtype = mapAiRemovableSubtype(extracted.removableSubtype);
    const arch = extracted.arch?.toLowerCase();
    if (!subtype || !["upper", "lower", "upper_lower"].includes(arch ?? "")) {
      exceptions.push("Removable prescription requires an explicit supported subtype and arch.");
    } else {
      for (const side of arch === "upper_lower" ? ["upper", "lower"] : [arch!]) {
        work.push(recoveryWorkSchema.parse({
          toothNumber: extracted.teeth ?? "", restorationType: "Removable",
          restorationSubtype: subtype, material: extracted.material ?? null,
          shade: extracted.shade ?? null, quantity: 1, arch: side,
        }));
      }
    }
  } else {
    const groups = extracted.restorations;
    if (!Array.isArray(groups) || !groups.length) {
      exceptions.push("No explicit per-tooth prescription work was extracted; a summary is not a billable order.");
    } else {
      for (const group of groups) {
        if (!group || typeof group.teeth !== "string" || typeof group.type !== "string") {
          exceptions.push("Unusable prescription work group."); continue;
        }
        const teeth = group.teeth.split(/[,\s]+/).filter(Boolean);
        if (!teeth.length || teeth.some((tooth) => !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(tooth))) {
          exceptions.push("Tooth numbers/ranges need explicit review."); continue;
        }
        // Bridge topology must be reviewed against the Rx, not manufactured by
        // assuming every adjacent pair of prescribed teeth is a bridge.
        if (group.isBridge) exceptions.push("Bridge/pontic topology needs an explicit reviewed connector map.");
        const material = group.material ?? extracted.material ?? null;
        if (!material || !/^(crown|pontic|veneer|inlay|onlay|crown & bridge)$/i.test(group.type)) {
          exceptions.push("Unsupported or unspecified restoration type/material."); continue;
        }
        const { restorationSubtype } = normalizeCaseHierarchy({ caseType: "Crown & Bridge", material });
        for (const toothNumber of teeth) {
          work.push(recoveryWorkSchema.parse({
            toothNumber, restorationType: /^(crown|crown & bridge)$/i.test(group.type) ? "Crown & Bridge" : group.type,
            restorationSubtype, material, shade: extracted.perToothShades?.[toothNumber] ?? extracted.shade ?? null,
            arch: null, quantity: 1,
          }));
        }
      }
    }
  }
  return { restorations: work, exceptions: [...new Set(exceptions)] };
}

async function prescriptionBytes(filename: string): Promise<Buffer> {
  const resolved = path.resolve(caseMediaDir, filename);
  if (!resolved.startsWith(path.resolve(caseMediaDir) + path.sep) || path.basename(filename) !== filename) {
    throw new HttpError(400, "Invalid prescription filename.");
  }
  try {
    const file = await fs.open(resolved, "r");
    try {
      const stat = await file.stat();
      if (stat.size > MAX_PRESCRIPTION_BYTES) throw new HttpError(413, "Prescription is too large.");
      return await boundedPrescriptionStream(file.createReadStream({ autoClose: false }));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const object = await openCaseMediaObjectStream(filename);
  if (!object) throw new HttpError(404, "Prescription evidence is unavailable; no work inferred.");
  return boundedPrescriptionStream(object.stream);
}

export async function analyzeRecoveredPrescription(caseId: string, attachmentId: string, actorUserId: string, previewOnly = false) {
  await requireAnyRole(actorUserId, RECOVERY_LAB_ID, BILLING_ROLES);
  assertRecoveryDataAvailable();
  const source = recoveryScope.get(caseId);
  if (!source?.inWindow) throw new HttpError(409, "Outside verified recovery scope.");
  const row = await recoveryAnalysisStage("evidence_lookup", () => db.query.cases.findFirst({ where: and(
    eq(cases.id, caseId), eq(cases.labOrganizationId, RECOVERY_LAB_ID),
    eq(cases.aiImportSource, RECOVERY_TAG), isNull(cases.deletedAt),
  ) }));
  if (!row) throw new HttpError(404, "Recovered case not found.");
  const attachment = await recoveryAnalysisStage("evidence_lookup", () => db.query.caseAttachments.findFirst({ where: and(
    eq(caseAttachments.id, attachmentId), eq(caseAttachments.caseId, caseId), isNull(caseAttachments.deletedAt),
  ) }));
  const filename = attachment && extractMediaFileName(attachment.storageKey);
  if (!attachment || !filename || !source.prescriptions.includes(filename)) {
    throw new HttpError(400, "Select the verified prescription belonging to this case.");
  }
  const binding = await recoveryAnalysisStage("evidence_lookup", () =>
    db.query.legacyCaseMedia.findFirst({ where: eq(legacyCaseMedia.fileName, filename) }));
  if (binding && binding.organizationId !== RECOVERY_LAB_ID) throw new HttpError(403, "Prescription ownership does not match the repair lab.");
  const client = getAiClient();
  if (!client) throw new HttpError(503, "Prescription analysis is unavailable. Retry later or review the prescription manually.");
  const bytes = await recoveryAnalysisStage("evidence_read", () => prescriptionBytes(filename));
  if (!bytes.length) throw new HttpError(422, "Prescription evidence is empty. Open and check the file; no work was inferred.");
  const extracted = await recoveryAnalysisStage("extraction", async () => {
    const { extractRxFieldsFromBuffer } = await import("../routes/cases");
    return extractRxFieldsFromBuffer(client, bytes, attachment.fileType ?? "", attachment.fileName);
  });
  const proposed = await recoveryAnalysisStage("normalization", async () => recoveredRxWork(extracted));
  const evidenceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (previewOnly) return { analysisId: null, ...proposed, extracted, evidenceSha256 };
  const event = await recoveryAnalysisStage("audit", async () => {
    const [saved] = await db.insert(caseEvents).values({
      caseId, eventType: "billing_recovery_analyzed", actorUserId, actorOrganizationId: RECOVERY_LAB_ID,
      metadataJson: { evidenceAttachmentId: attachmentId, evidenceSha256,
        caseFingerprint: recoveryFingerprint(row), extracted, ...proposed, model: "existing_prescription_intake" },
    }).returning();
    if (!saved) throw new Error("Analysis audit was not saved.");
    return saved;
  });
  return { analysisId: event.id, ...proposed, extracted };
}
