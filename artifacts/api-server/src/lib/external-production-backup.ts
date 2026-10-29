/** Explicit operator path; HTTP callers cannot select a database binding. */
export function assertExternalProductionBinding(revision: string | undefined,
  databaseUrl = process.env.DATABASE_URL, productionUrl = process.env.PROD_DATABASE_URL): boolean {
  if (revision === undefined) return false;
  if (!/^[a-f0-9]{40}$/.test(revision) || !productionUrl || databaseUrl !== productionUrl) {
    throw new Error("External production backup requires a full source revision and the exact configured production binding.");
  }
  return true;
}
