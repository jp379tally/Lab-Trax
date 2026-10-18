export const MAX_RX_PDF_PAGES = 10;
export const MAX_RX_RENDERED_BYTES = 8 * 1024 * 1024;

export class PdfConversionError extends Error {
  constructor(public readonly reason: "unavailable" | "timeout" | "unreadable" | "oversized" | "cancelled") {
    super(reason === "oversized"
      ? "This PDF is too large for AI analysis (maximum 10 pages and 8 MB of rendered images). Split it into smaller files or enter the details manually; keep the original as an attachment."
      : `Prescription PDF conversion ${reason}.`);
    this.name = "PdfConversionError";
  }
}
