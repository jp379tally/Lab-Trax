/** Share successful/in-flight initialization, but permit retry after rejection. */
export function createRetryableResource<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      const attempt = Promise.resolve().then(load);
      cached = attempt;
      void attempt.catch(() => {
        if (cached === attempt) cached = null;
      });
    }
    return cached;
  };
}
