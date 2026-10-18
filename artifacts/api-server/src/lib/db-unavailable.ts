/** Inspect a bounded cause chain without logging Drizzle SQL/parameters. */
export function isDbUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    if (/timeout.*connect|checkout.*timed|Client.*timed|ETIMEDOUT|Connection terminated due to connection timeout/i.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
