import { describe, expect, it } from "vitest";
import { includedBackupStagingObjectSizes, planCompleteBackupStaging } from "./complete-backup";

describe("generation-pinned stream capacity", () => {
  it("does not reserve whole-object disk copies for direct archive streams", () => {
    const sizes = includedBackupStagingObjectSizes([
      { relativeName: "case-media/scan.bin", size: 33_000_000_000, openStream: () => null },
      { relativeName: "documents/retained.pdf", size: 512 },
    ]);
    expect(sizes).toEqual([512]);
    const plan = planCompleteBackupStaging(1_000_000_000, 33_000_000_512, sizes, 73_000_000, "cloud");
    expect(plan.stagedBytes).toBe(512);
    expect(plan.requiredBytes).toBeLessThan(1_000_000_000);
  });
});
