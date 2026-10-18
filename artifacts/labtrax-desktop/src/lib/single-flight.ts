/** Deduplicate only in-flight reads. No TTL and no reuse after settlement. */
export function createSingleFlight<T>() {
  let current: { key: string; promise: Promise<T> } | null = null;
  return (key: string, load: () => Promise<T>): Promise<T> => {
    if (current?.key === key) return current.promise;
    const promise = load();
    const entry = { key, promise };
    current = entry;
    void promise.then(
      () => { if (current === entry) current = null; },
      () => { if (current === entry) current = null; },
    );
    return promise;
  };
}
