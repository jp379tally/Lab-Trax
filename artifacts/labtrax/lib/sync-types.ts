export type SyncResult = boolean;

export function isSyncSuccess(result: SyncResult): boolean {
  return result === true;
}
