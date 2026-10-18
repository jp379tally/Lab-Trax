/**
 * Module resolution hook that swaps the real database pool for a stub.
 *
 * `check-schema-columns.ts` is the command the deployment build runs, so the
 * only honest way to test its exit code is to run the file itself. The one
 * thing a test cannot supply is a live PostgreSQL server holding the lab's
 * data, so the `@workspace/db` connection pool — and nothing else — is
 * redirected to `stub-database.mjs`. Everything the gate decides with (the
 * declared Drizzle schema, the fingerprint comparison, the committed
 * baseline, the reporting and the exit code) stays the real module.
 *
 * `@workspace/db/schema` is deliberately left alone: it is pure table
 * metadata, and the gate must be measured against the real schema.
 */

const STUB_URL = new URL("./stub-database.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@workspace/db") {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
