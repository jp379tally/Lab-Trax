import { apiUrl } from "./api";

// Memory only. Never use the current account's bearer/PIN, refresh authentication,
// store this credential, or put it in a URL. Only the already-authorized run.
export interface BackupContinuation {
  status<T>(): Promise<T>;
  download(): Promise<Response>;
  report<T>(body: Record<string, unknown>): Promise<T>;
}
const activeContinuations = new Map<string, BackupContinuation>();
export function getBackupContinuation(runId: string, ownerId?: string): BackupContinuation | undefined {
  return ownerId ? activeContinuations.get(ownerId + ":" + runId) : undefined;
}
export function createBackupContinuation(runId: string, token: string, sourceHeaders: Record<string, string>, ownerId?: string) {
  async function request(path: string, body?: unknown): Promise<Response> {
    const response = await fetch(apiUrl(path), {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { ...sourceHeaders, "X-LabTrax-Backup-Continuation": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error("Backup connection unavailable (" + response.status + "). Sign in and reconnect the existing backup.") as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return response;
  }
  const continuation = {
    status: async <T,>(): Promise<T> => (await request("/admin/backup/status/" + encodeURIComponent(runId))).json(),
    download: () => request("/admin/backup/download/" + encodeURIComponent(runId)),
    report: async <T,>(body: Record<string, unknown>): Promise<T> => (await request(
      "/admin/backup/desktop-run-report", { ...body, source: "manual", downloadRunId: runId },
    )).json(),
  };
  if (ownerId) activeContinuations.set(ownerId + ":" + runId, continuation);
  return continuation;
}
