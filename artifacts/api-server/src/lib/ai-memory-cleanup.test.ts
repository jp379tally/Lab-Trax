/**
 * Unit tests for the pure config layer of AI memory candidate cleanup.
 *
 * parseAiMemoryCandidateCleanupConfig depends only on env vars and does no DB
 * work, so these run without DATABASE_URL.
 *
 * Coverage:
 *  - defaults when env is unset (90 days retention, 500 pending per lab)
 *  - reads valid env overrides
 *  - clamps non-positive / non-numeric values up to the minimum of 1
 */
import { describe, expect, it } from "vitest";
import { parseAiMemoryCandidateCleanupConfig } from "./ai-memory-cleanup";

describe("parseAiMemoryCandidateCleanupConfig (pure)", () => {
  it("defaults when env is unset", () => {
    expect(parseAiMemoryCandidateCleanupConfig({})).toEqual({
      retentionDays: 90,
      maxPendingPerLab: 500,
    });
  });

  it("reads valid env overrides", () => {
    const cfg = parseAiMemoryCandidateCleanupConfig({
      AI_MEMORY_CANDIDATE_RETENTION_DAYS: "30",
      AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB: "100",
    });
    expect(cfg).toEqual({ retentionDays: 30, maxPendingPerLab: 100 });
  });

  it("falls back to defaults for zero / negative / non-numeric values", () => {
    expect(
      parseAiMemoryCandidateCleanupConfig({
        AI_MEMORY_CANDIDATE_RETENTION_DAYS: "0",
        AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB: "-5",
      }),
    ).toEqual({ retentionDays: 90, maxPendingPerLab: 500 });

    expect(
      parseAiMemoryCandidateCleanupConfig({
        AI_MEMORY_CANDIDATE_RETENTION_DAYS: "abc",
        AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB: "xyz",
      }),
    ).toEqual({ retentionDays: 90, maxPendingPerLab: 500 });
  });
});
