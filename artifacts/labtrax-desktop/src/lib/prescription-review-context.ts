/**
 * Optional, read-only matching must not leave a completed extraction behind
 * the AI spinner. One shared deadline, no retries, and no delayed state writes.
 * Callers still choose doctor memory before aliases; completion order is not
 * matching priority. These are not case-save requests.
 */
export async function prescriptionReviewContext<M, A, D>(
  memory: (signal: AbortSignal) => Promise<M>,
  alias: (signal: AbortSignal) => Promise<A>,
  doctor: (signal: AbortSignal) => Promise<D>,
  deadlineMs = 5_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  async function bounded<T>(lookup: (signal: AbortSignal) => Promise<T>) {
    let onAbort!: () => void;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Practice matching timed out"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return { value: await Promise.race([lookup(controller.signal), abort]), unavailable: false };
    } catch {
      return { value: null, unavailable: true };
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  try {
    const [remembered, aliased, resolvedDoctor] = await Promise.all([
      bounded(memory), bounded(alias), bounded(doctor),
    ]);
    return { remembered, aliased, resolvedDoctor };
  } finally {
    clearTimeout(timer);
  }
}
