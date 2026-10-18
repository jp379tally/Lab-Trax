/** A deadline must work even if a transport adapter ignores AbortSignal. */
export async function boundedOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", rejectAbort!); }
}
