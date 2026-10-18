import { describe, expect, it, vi } from "vitest";
import {
  recordSavedCardSetupOutcome,
  savedCardSetupOutcomeSchema,
} from "./saved-card-analytics";

describe("saved-card setup analytics contract", () => {
  it("accepts only fixed outcomes and rejects identifiers/free-form fields", () => {
    for (const outcome of ["started", "succeeded", "expired"]) {
      expect(savedCardSetupOutcomeSchema.safeParse({ outcome: outcome as "started" | "succeeded" | "expired" }).success).toBe(true);
    }
    expect(savedCardSetupOutcomeSchema.safeParse({ outcome: "cancelled" }).success).toBe(false);
    expect(savedCardSetupOutcomeSchema.safeParse({ outcome: "started", customerId: "secret" }).success).toBe(false);
    expect(savedCardSetupOutcomeSchema.safeParse({ outcome: "started", payload: "secret" }).success).toBe(false);
  });

  it("increments exactly the fixed aggregate bucket", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    await recordSavedCardSetupOutcome("succeeded", { insert } as never);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ outcome: "succeeded", count: 1 }));
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });

  it("allows the route to turn database failures into a non-fatal response", async () => {
    const insert = vi.fn().mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.reject(new Error("db down")) }),
    });
    await expect(recordSavedCardSetupOutcome("expired", { insert } as never)).rejects.toThrow("db down");
  });
});