import { HttpError } from "./http";
import { PdfConversionError } from "./pdf-to-images";
import { logger } from "./logger";

export type RecoveryAnalysisStage = "evidence_lookup" | "evidence_read" | "extraction" | "normalization" | "audit";

/** Only allowlisted categories reach logs; raw SDK/SQL/PDF errors may contain PHI. */
export async function recoveryAnalysisStage<T>(stage: RecoveryAnalysisStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) {
      logger.warn({ stage, reason: "rejected", statusCode: error.statusCode }, "Recovery prescription analysis rejected");
      throw error;
    }
    const reason = error instanceof PdfConversionError ? error.reason : "failed";
    logger.warn({ stage, reason }, "Recovery prescription analysis failed");
    if (error instanceof PdfConversionError) {
      if (reason === "unavailable") throw new HttpError(503,
        "PDF analysis is unavailable. Ask an administrator to check the PDF converter, or review the prescription manually.");
      if (reason === "timeout") throw new HttpError(422,
        "The PDF could not be processed in time. Use a smaller readable copy or review the prescription manually.");
      throw new HttpError(422, "The PDF is unreadable or protected. Open and check the file, or review the prescription manually.");
    }
    const messages: Record<RecoveryAnalysisStage, string> = {
      evidence_lookup: "Prescription verification is temporarily unavailable. Retry shortly; no work was inferred.",
      evidence_read: "Prescription storage is temporarily unavailable. Retry shortly or review the prescription manually.",
      extraction: "Prescription analysis is temporarily unavailable. Retry shortly or review the prescription manually.",
      normalization: "Extracted work could not be safely interpreted. Review the prescription and enter work manually.",
      audit: "Analysis could not be recorded. Retry shortly; no analyzed work or billing changes were saved.",
    };
    throw new HttpError(stage === "normalization" ? 422 : 503, messages[stage]);
  }
}
