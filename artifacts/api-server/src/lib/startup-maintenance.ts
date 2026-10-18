/**
 * Historical data repairs are opt-in to an explicitly identified development
 * process. A missing or unexpected NODE_ENV is not permission to rewrite
 * existing production records during a restart.
 */
export interface HistoricalStartupJob {
  name: string;
  schedule: () => void;
}

export interface HistoricalStartupRegistration {
  scheduled: string[];
  deferred: string[];
}

export function registerHistoricalStartupJobs(
  jobs: readonly HistoricalStartupJob[],
  nodeEnv: string | undefined = process.env.NODE_ENV,
): HistoricalStartupRegistration {
  if (nodeEnv !== "development") {
    return { scheduled: [], deferred: jobs.map((job) => job.name) };
  }

  for (const job of jobs) job.schedule();
  return { scheduled: jobs.map((job) => job.name), deferred: [] };
}

/** Shared guard for entry points that can schedule historical mutations. */
export function historicalStartupMaintenanceEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}
