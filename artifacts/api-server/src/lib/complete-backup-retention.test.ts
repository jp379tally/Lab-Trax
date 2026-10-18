import { describe, expect, it } from "vitest";
import { selectOneDriveBackupsToPrune, type OneDriveBackupFile } from "./onedrive";
const now = Date.parse("2026-10-13T12:00:00Z");
const file = (id: string, ageHours: number): OneDriveBackupFile => ({
  id, name: `labtrax-backup-2026-10-13-${id}-full.zip.enc`, size: 100,
  createdDateTime: new Date(now - ageHours * 3_600_000).toISOString(), webUrl: null,
});
describe("verified complete recovery retention", () => {
  it("keeps a verified complete point when newer narrower or partial copies fill the ordinary floor", () => {
    const complete = file("verified", 50);
    const files = [file("partial-1", 1), file("partial-2", 2), complete];
    const pruned = selectOneDriveBackupsToPrune(files, {
      keepAllWithinHours: 0, keepHourlyWithinDays: 0, keepDailyWithinDays: 0,
      maxFiles: 1, keepNewestCount: 1, completeItemIds: [complete.id],
    }, now);
    expect(pruned.map(item => item.id)).not.toContain(complete.id);
    expect(pruned.map(item => item.id)).toContain("partial-2");
  });
});
