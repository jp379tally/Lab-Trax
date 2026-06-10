export type SyncFailureCategory =
  | "network"
  | "server"
  | "rejected"
  | "validation";

export type SyncFailure = {
  ok: false;
  category: SyncFailureCategory;
  message?: string;
};

export type SyncResult = boolean | SyncFailure;

const CATEGORY_MESSAGES: Record<SyncFailureCategory, string> = {
  network: "Lost connection — will keep trying",
  server: "The server had a problem — will keep trying",
  rejected: "Upload failed — case may no longer exist",
  validation: "Invalid data — tap Discard to remove",
};

export function messageForCategory(category: SyncFailureCategory): string {
  return CATEGORY_MESSAGES[category];
}

export function categorizeSyncStatus(status: number): SyncFailureCategory {
  if (status >= 500 || status === 408 || status === 429) return "server";
  if (status === 400 || status === 422) return "validation";
  if (status >= 400) return "rejected";
  return "network";
}

export function syncFailureFromStatus(status: number): SyncFailure {
  return { ok: false, category: categorizeSyncStatus(status) };
}

export function isSyncSuccess(result: SyncResult): boolean {
  return result === true;
}

export type StuckQueueItem = {
  id: string;
  caseId: string;
  type: "photo" | "note" | "status";
  attempts: number;
  lastError?: string;
  lastErrorCategory?: SyncFailureCategory;
};
