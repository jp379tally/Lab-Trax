import { describe, expect, it, vi } from "vitest";
import { deliverInAppNotification } from "./in-app-notifications";
import type { db } from "@workspace/db";

const input = {
  labOrganizationId: "owning-lab",
  category: "doctor_practice_message" as const,
  type: "join_request_pending",
  title: "New request",
  body: "Review this request",
  dedupeKey: "request-identity",
};

function executor(failure: "membership" | "preferences" | "insert" | null) {
  let read = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: async () => {
        read++;
        if (failure === (read === 1 ? "membership" : "preferences")) throw new Error(failure);
        return read === 1 ? [{ userId: "admin" }] : [];
      },
    }),
  }));
  const conflict = vi.fn(async () => {
    if (failure === "insert") throw new Error("insert");
  });
  const values = vi.fn(() => ({ onConflictDoNothing: conflict }));
  return {
    db: { select, insert: vi.fn(() => ({ values })) } as unknown as Pick<typeof db, "select" | "insert">,
    values, conflict,
  };
}

describe("retryable in-app notification delivery", () => {
  it.each(["membership", "preferences", "insert"] as const)("propagates %s failures to the outbox transaction", async (failure) => {
    const mock = executor(failure);
    await expect(deliverInAppNotification(input, { executor: mock.db, retryable: true })).rejects.toThrow(failure);
  });

  it.each(["membership", "preferences", "insert"] as const)("preserves best-effort delivery for existing callers on %s failure", async (failure) => {
    await expect(deliverInAppNotification(input, { executor: executor(failure).db })).resolves.toBeUndefined();
  });

  it("uses the worker's executor and stable per-recipient dedupe key", async () => {
    const mock = executor(null);
    await deliverInAppNotification(input, { executor: mock.db, retryable: true });
    expect(mock.values).toHaveBeenCalledWith([expect.objectContaining({
      userId: "admin", dedupeKey: "request-identity:admin",
      dataJson: { inAppCategory: "doctor_practice_message", labOrganizationId: "owning-lab" },
    })]);
    expect(mock.conflict).toHaveBeenCalledOnce();
  });
});
