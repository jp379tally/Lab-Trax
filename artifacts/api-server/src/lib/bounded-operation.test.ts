import { describe, expect, it } from "vitest";
import { boundedOperation } from "./bounded-operation";
describe("bounded work", () => {
  it("releases the caller even when an adapter ignores cancellation", async () => {
    const controller = new AbortController();
    const request = boundedOperation(new Promise(() => {}), controller.signal);
    controller.abort(new Error("deadline"));
    await expect(request).rejects.toThrow("deadline");
  });
  it("returns successful work and refuses an already-expired operation", async () => {
    await expect(boundedOperation(Promise.resolve(5), new AbortController().signal)).resolves.toBe(5);
    const controller = new AbortController();
    controller.abort(new Error("expired"));
    await expect(boundedOperation(Promise.resolve(5), controller.signal)).rejects.toThrow("expired");
  });
});
