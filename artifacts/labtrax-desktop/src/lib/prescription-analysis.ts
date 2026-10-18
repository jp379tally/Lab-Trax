const TIMEOUT_MESSAGE = "Prescription analysis took too long. Try again or enter the details manually. Your original file has not been changed.";
let pending: Promise<unknown> | null = null;
export const MAX_PRESCRIPTION_PAGES = 10;
export function validatePrescriptionPageCount(pages: number): void {
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PRESCRIPTION_PAGES) {
    throw new Error("AI analysis accepts at most 10 prescription pages. Split this PDF into smaller files or enter the details manually; keep the original as an attachment.");
  }
}

/** Stateless analysis only. Never use this retry/cancellation policy for saves. */
export async function runPrescriptionAnalysis<T>(
  prepare: (signal: AbortSignal) => Promise<string[]>,
  send: (images: string[], signal: AbortSignal) => Promise<T>,
  report: (stage: "preparation" | "request", milliseconds: number, payloadChars?: number) => void,
  waitMs = 120_000,
): Promise<T> {
  if (pending) throw new Error("The previous analysis is still stopping. Please wait before trying again, or enter the details manually.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new Error(TIMEOUT_MESSAGE));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const start = performance.now();
  const operation = (async () => {
    const images = await prepare(controller.signal);
    report("preparation", Math.round(performance.now() - start), images.reduce((sum, img) => sum + img.length, 0));
    if (controller.signal.aborted) throw new Error(TIMEOUT_MESSAGE);
    validatePrescriptionPageCount(images.length);
    // JSON envelope must fit the server's existing 12 MB limit. All pages or
    // an explicit failure, never silently dropping pages to fit.
    if (images.reduce((sum, img) => sum + img.length, 0) > 11.5 * 1024 * 1024) {
      throw new Error("This prescription is too large for AI analysis. Split it into smaller files or enter the details manually; retain the original as an attachment.");
    }
    const requestStart = performance.now();
    try { return await send(images, controller.signal); }
    finally { report("request", Math.round(performance.now() - requestStart)); }
  })();
  pending = operation;
  void operation.then(
    () => { if (pending === operation) pending = null; },
    () => { if (pending === operation) pending = null; },
  );
  try { return await Promise.race([operation, aborted]); }
  finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", rejectAbort!);
  }
}
